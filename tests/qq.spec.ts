/**
 * The QQ Source without QQ: message normalization, the passive reply path over a fake bot, gateway normalization of the
 * attachment references and their download and storage over a fake `fetch`, the outbound file path over a fake bot and a
 * temporary directory, the gateway connection over a fake SDK client, and the watch loop's health over a fake
 * `SourceContext`. Nothing here opens a socket, calls the QQ API or fetches a real attachment.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { key, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { apply, clearQqSentAttachmentFailures, qqAttachmentDirectory, qqKind, qqSentAttachmentFailures, qqTrigger,
  receiveQq, watchQq, type QqConfig, type QqSavedAttachment, type QqWatchOptions } from '../src/sources/qq.ts'
import type { Health, SourceContext } from '../src/sources/host.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { clearQqLiveBots, liveQqBot, normalizeQqInbound, QqApiError, QqConnection, QQ_ATTACHMENT_BYTES,
  QQ_ATTACHMENTS_PER_MESSAGE, QQ_PASSIVE_REPLY_LIMIT, QQ_REPLY_CHARS, QQ_SENT_ATTACHMENT_BYTES,
  QQ_SENT_ATTACHMENTS_PER_MESSAGE, QQ_TEXT_CHARS, QQ_TRUNCATION_NOTICE, qqMention, replySeqOf, replyTargetOf, replyWindowOpen,
  sendQqAttachment, sendQqMessage, sendQqReply, splitQqText, trustedQqDownloadUrl, type QqAttachmentRef,
  type QqBotClient, type QqBotFactory, type QqMessage, type QqRawInbound, type QqReplyTarget, type QqSendOptions,
  type QqSender, type QqSkipEvent } from '../src/sources/im/qq-transport.ts'
import { testDeployment } from './fixtures/deployment.ts'

/** A validated configuration with both credentials filled, as an operator would save it. */
const config = (overrides: Record<string, unknown> = {}): QqConfig => qqKind.schema.parse({
  appId: 'app-1', appSecret: 'secret-1', ...overrides })
const future = (): number => Date.now() - 10_000
const past = (): number => Date.now() - 2 * 60 * 60_000
/** One normalized message, a group mention by default. */
const message = (overrides: Partial<QqMessage> = {}): QqMessage => ({ messageId: 'msg-1', text: 'please fix the typo',
  attachments: [], senderId: 'user-1', senderNick: 'Alice', kind: 'group', conversationId: 'group-1', groupId: 'group-1',
  addressed: true, createdAt: '2026-11-26T00:00:00.000Z', rawEventType: 'GROUP_AT_MESSAGE_CREATE', ...overrides })
/** One gateway message as the SDK normalizes it, a group mention by default; tests change one field to exercise a skip. */
const rawInbound = (overrides: Partial<QqRawInbound> = {}): QqRawInbound => ({ rawEventType: 'GROUP_AT_MESSAGE_CREATE', kind: 'group',
  senderId: 'user-1', senderName: 'Alice', content: 'please fix the typo', messageId: 'msg-1',
  timestamp: '2026-11-26T08:00:00+08:00', groupOpenid: 'group-1', msgType: 0,
  mentions: [{ is_you: true, member_openid: 'bot-user' }], ...overrides })
/** One signed attachment address QQ hands out; its query string is a credential no health detail or Trigger may carry. */
const SIGNED_URL = 'https://gchat.qpic.cn/gchatpic_new/0/0-0/0?term=2&rkey=secret-query'
/** One attachment reference QQ named on a message, a picture at SIGNED_URL by default. */
const ref = (overrides: Partial<QqAttachmentRef> = {}): QqAttachmentRef => ({ kind: 'image', url: SIGNED_URL, name: '',
  mime: '', bytes: 0, ...overrides })
/** The two ids the connection learns from READY and from the AppID, naming the bot in self mentions. */
const BOT_IDS = new Set(['app-1', 'bot-user'])
const target = (overrides: Partial<QqReplyTarget> = {}): QqReplyTarget => ({ scope: 'group', targetId: 'group-1', msgId: 'msg-1',
  senderId: 'user-1', receivedAt: future(), ...overrides })
const address = (): Record<string, string> => qqTrigger(message(), 'qq:ops', config()).channel!.address
const reply = (text: string, route: Record<string, string> = address()): OutboundMessage =>
  ({ id: 'm-1', kind: 'reply', text, channel: { source: 'qq:ops', thread: 'qq:ops:group-1', address: route } })
/** One recorded media send: its route, QQ's media type (1 picture, 4 file), the bytes and the display name. */
interface FakeMediaSend { target: QqSendOptions['target']; fileType: 1 | 4 | undefined; buffer: Buffer
  fileName: string | undefined }
/** A fake bot that records its text sends, its media sends and the order of both; a reply path unit test needs only these. */
interface FakeSender extends QqSender {
  sent: QqSendOptions[]
  media: FakeMediaSend[]
  /** The order of the calls it served, `text` or `media`, so a test can prove the text went first. */
  events: string[]
}
function fakeSender(answer?: (options: QqSendOptions) => void,
  mediaAnswer?: (call: FakeMediaSend) => void): FakeSender {
  const sent: QqSendOptions[] = []
  const media: FakeMediaSend[] = []
  const events: string[] = []
  return { sent, media, events,
    send: async options => { sent.push(options); events.push('text'); answer?.(options); return { id: `sent-${sent.length}` } },
    sendMedia: async options => {
      const call: FakeMediaSend = { target: options.target, fileType: options.fileType, buffer: options.buffer,
        fileName: options.fileName }
      media.push(call)
      events.push('media')
      mediaAnswer?.(call)
      return { upload: {}, message: undefined }
    } }
}
/** QQ's own API error shape as the SDK throws it, for the classification tests. */
const apiFailure = (httpStatus: number, bizCode?: number): Error => Object.assign(new Error(`QQ answered HTTP ${httpStatus}`),
  { name: 'ApiError', httpStatus, bizCode })

/** A fake SDK bot: recorded handlers, text and media sends, a start that settles on stop, and a way to push events. */
interface FakeBot extends QqBotClient {
  handlers: Map<string, ((...args: unknown[]) => unknown)[]>
  sent: QqSendOptions[]
  media: FakeMediaSend[]
  stops: number
  finishStart: () => void
  emit(event: string, ...args: unknown[]): void
}
function fakeBot(options: { ready?: boolean; startError?: Error; connectTimeout?: boolean; mediaError?: Error } = {}): FakeBot {
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>()
  const sent: QqSendOptions[] = []
  const media: FakeMediaSend[] = []
  const mediaError = options.mediaError
  let finishStart = (): void => {}
  const bot: FakeBot = {
    handlers, sent, media, stops: 0,
    finishStart: () => finishStart(),
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return bot },
    start(signal) {
      return new Promise<void>(resolve => {
        finishStart = resolve
        signal?.addEventListener('abort', () => resolve(), { once: true })
        if (options.startError) { queueMicrotask(() => { bot.emit('error', options.startError) }); return }
        if (options.connectTimeout) return
        queueMicrotask(() => {
          if (options.ready === false) bot.emit('error', new Error('gateway refused'))
          else bot.emit('ready', { user: { id: 'bot-user' } })
        })
      })
    },
    stop() { bot.stops += 1; finishStart() },
    async send(options) { sent.push(options); return { id: `sent-${sent.length}` } },
    async sendMedia(mediaOptions) {
      if (mediaError) throw mediaError
      media.push({ target: mediaOptions.target, fileType: mediaOptions.fileType, buffer: mediaOptions.buffer,
        fileName: mediaOptions.fileName })
      return { upload: {}, message: undefined }
    },
    emit(event, ...args) { for (const handler of handlers.get(event) ?? []) handler(...args) },
  }
  return bot
}
/** A bot factory handing out fake clients and recording them, as the watch loop's reconnect creates new ones. */
function factoryOf(bots: FakeBot[]): QqBotFactory {
  return (async () => { const bot = fakeBot(); bots.push(bot); return bot }) as QqBotFactory
}

/** The health reports one fake Source context received, in order. */
interface FakeSource { ctx: SourceContext; reports: { id: string; health: Health }[]; receive: ReturnType<typeof vi.fn> }
function fakeSource(configs: QqConfig[], options: { configured?: boolean; enabled?: boolean; stateDir?: string } = {}): FakeSource {
  const reports: { id: string; health: Health }[] = []
  const receive = vi.fn((_trigger: Trigger) => 'stored' as const)
  const instances = configs.map((value, index) => ({ id: index ? `qq:ops-${index}` : 'qq:ops', kind: 'qq',
    enabled: options.enabled ?? true, config: value }))
  const ctx = {
    ready: Promise.resolve(),
    configured: () => options.configured ?? true,
    instances: () => instances,
    deployment: { stateDir: options.stateDir ?? join(tmpdir(), 'dsh-qq-fake-state') },
    report: (id: string, health: Health) => { reports.push({ id, health }) },
    receive,
    threads: { describe: vi.fn() },
  } as unknown as SourceContext
  return { ctx, reports, receive }
}
const lastHealth = (source: FakeSource, id = 'qq:ops'): Health | undefined =>
  source.reports.filter(report => report.id === id).at(-1)?.health
/** Runs the watch loop and always stops it, also when an assertion fails. */
async function watching(source: FakeSource, options: QqWatchOptions, run: () => Promise<void>): Promise<void> {
  const controller = new AbortController()
  const running = watchQq(source.ctx, controller.signal, options)
  try { await run() } finally { controller.abort(); await running }
}

/** Runs one case with a fresh state directory, removed afterwards. */
async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-qq-'))
  try { await run(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}
/** A Source context that records the Triggers it receives and names one state directory for attachment downloads. */
function attachmentSource(stateDir: string): { ctx: SourceContext; received: Trigger[]; receive: ReturnType<typeof vi.fn> } {
  const received: Trigger[] = []
  const receive = vi.fn((trigger: Trigger) => { received.push(trigger); return 'stored' as const })
  const ctx = { deployment: { stateDir }, receive, threads: { describe: vi.fn() } } as unknown as SourceContext
  return { ctx, received, receive }
}
/** One recorded attachment-download call: its URL, HTTP method, redirect mode and headers. */
interface DownloadCall { url: string; method: string; redirect: RequestRedirect | undefined; headers: Headers }
/** A fake `fetch` answering whole `Response` objects, so a download can carry real bytes and a binary Content-Type. */
function responseStub(handler: (call: DownloadCall) => Response | 'network'): { impl: typeof fetch; calls: DownloadCall[] } {
  const calls: DownloadCall[] = []
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: DownloadCall = { url: String(input), method: init?.method ?? 'GET', redirect: init?.redirect,
      headers: new Headers(init?.headers) }
    calls.push(call)
    const answer = handler(call)
    if (answer === 'network') throw new TypeError('fetch failed')
    return answer
  })
  return { impl: spy as unknown as typeof fetch, calls }
}
/** A binary answer with an optional Content-Type; a missing one leaves the body untyped, like a CDN answer could be. */
const binaryResponse = (data: string | Uint8Array<ArrayBuffer>, type?: string): Response =>
  new Response(data, { status: 200, ...type ? { headers: { 'content-type': type } } : {} })
/** The attachments a Trigger carries for its worker. */
const attachmentsOf = (trigger: Trigger): QqSavedAttachment[] => trigger.meta.attachments as QqSavedAttachment[]

beforeEach(() => { clearQqLiveBots(); clearQqSentAttachmentFailures() })

describe('configuration', () => {
  it('validates the two credentials and the optional allow-list and sandbox switch, and refuses an unknown key', () => {
    expect(qqKind.schema.parse({})).toEqual({ appId: '', appSecret: '', allowedUserIds: [], sandbox: false })
    expect(config({ allowedUserIds: 'user-1, user-2' }).allowedUserIds).toEqual(['user-1', 'user-2'])
    expect(config({ allowedUserIds: ['user-9'] }).allowedUserIds).toEqual(['user-9'])
    expect(config({ sandbox: true }).sandbox).toBe(true)
    // Once one credential is set, the other is required: a half-filled bot is refused at save time, without a network.
    expect(() => qqKind.schema.parse({ appId: 'app-1' })).toThrow()
    expect(() => qqKind.schema.parse({ appSecret: 'secret-1' })).toThrow()
    expect(() => qqKind.schema.parse({ appId: ' ', appSecret: 's' })).toThrow()
    expect(() => qqKind.schema.parse({ appId: 'a', appSecret: 'b', unexpected: 1 })).toThrow()
    // The kind is a real one: order 4, one health entry, a Channel and a Policy, and no placeholder mark.
    expect(qqKind).toMatchObject({ kind: 'qq', order: 4, health: ['qq'] })
    expect(qqKind.placeholder).toBeUndefined()
    expect(qqKind.channel).toBeDefined()
    expect(qqKind.policy?.explicit.en).toBeTruthy()
    for (const field of qqKind.fields) expect(field.label.zh && field.label.en, field.key).toBeTruthy()
  })
  it('names the two receiving scopes of an instance, the people its allow-list knows, and the address of a reply', () => {
    expect(qqKind.policy!.rows!({}, 'qq:ops').map(row => row.id)).toEqual(['group', 'direct'])
    expect(qqKind.people!(config({ allowedUserIds: 'user-1,user-2' }), 'qq:ops')).toEqual([{ id: 'user-1' }, { id: 'user-2' }])
    expect(qqKind.people!(config(), 'qq:ops')).toEqual([])
    const trigger = qqTrigger(message(), 'qq:ops', config())
    expect(replyTargetOf(trigger.channel!.address)).toMatchObject({ scope: 'group', targetId: 'group-1', msgId: 'msg-1',
      senderId: 'user-1' })
    expect(replyTargetOf({ ...trigger.channel!.address, msgId: '' })).toBeUndefined()
    expect(replyTargetOf({ ...trigger.channel!.address, conversationType: 'channel' })).toBeUndefined()
    // A stored address is still only a route; the instance's own App ID and a connected bot are required to send.
    expect(qqKind.channel!.allowed!(trigger.channel!.address, config())).toBe(true)
    expect(qqKind.channel!.allowed!(trigger.channel!.address, { ...config(), appId: '' })).toBe(false)
    expect(qqKind.channel!.link!(trigger.channel!.address, {}).label.zh).toContain('qq:ops')
    expect(qqKind.channel!.mention!({ source: 'qq:ops', id: 'user-1', name: 'Alice' })).toBe('<@user-1>')
  })
  it('scopes a Trigger to the conversation it came from and to a sender on the instance allow-list', () => {
    expect(qqKind.scope!({ meta: { conversationType: 'group', addressed: true, userId: 'user-1' }, instance: 'qq:ops' }, config()))
      .toEqual({ listened: true, observed: false, row: 'group' })
    expect(qqKind.scope!({ meta: { conversationType: 'direct', addressed: true, userId: 'user-1' }, instance: 'qq:ops' }, config()))
      .toEqual({ listened: true, observed: false, row: 'direct' })
    expect(qqKind.scope!({ meta: { conversationType: 'group', addressed: false, userId: 'user-1' }, instance: 'qq:ops' }, config()))
      .toEqual({ listened: false, reason: 'no_mention' })
    expect(qqKind.scope!({ meta: { conversationType: 'direct', addressed: true, userId: 'user-2' }, instance: 'qq:ops' },
      config({ allowedUserIds: 'user-1' }))).toEqual({ listened: false, reason: 'not_a_member' })
  })
})

describe('normalization', () => {
  it('turns a direct text message into a message that addresses the bot', () => {
    const inbound = normalizeQqInbound(rawInbound({ rawEventType: 'C2C_MESSAGE_CREATE', kind: 'c2c', content: 'please fix the typo',
      groupOpenid: undefined, mentions: undefined }), BOT_IDS)
    expect(inbound).toMatchObject({ message: { messageId: 'msg-1', senderId: 'user-1', senderNick: 'Alice', kind: 'c2c',
      conversationId: 'user-1', groupId: '', addressed: true, text: 'please fix the typo',
      createdAt: '2026-11-26T00:00:00.000Z', rawEventType: 'C2C_MESSAGE_CREATE' } })
  })
  it('turns a group message that mentions the bot into a message whose conversation is the group', () => {
    expect(normalizeQqInbound(rawInbound(), BOT_IDS)).toMatchObject({ message: { kind: 'group', conversationId: 'group-1',
      groupId: 'group-1', addressed: true, text: 'please fix the typo' } })
    // The inline self-mention marker and an `is_you` mention both make a group message addressed.
    expect(normalizeQqInbound(rawInbound({ mentions: undefined, rawEventType: 'GROUP_MESSAGE_CREATE',
      content: '<@bot-user> hello' }), BOT_IDS)).toMatchObject({ message: { addressed: true, text: 'hello' } })
    expect(normalizeQqInbound(rawInbound({ rawEventType: 'GROUP_AT_MESSAGE_CREATE', content: 'hello' }), BOT_IDS))
      .toMatchObject({ message: { addressed: true } })
  })
  it('skips an unmentioned group message, the bot\'s own message, a message with neither text nor attachment, and malformed events', () => {
    const skipped = (payload: QqRawInbound): unknown => normalizeQqInbound(payload, BOT_IDS)
    expect(skipped(rawInbound({ rawEventType: 'GROUP_MESSAGE_CREATE', content: 'hello all', mentions: [] })))
      .toEqual({ skipped: { reason: 'not-addressed', messageId: 'msg-1', kind: 'group' } })
    expect(skipped(rawInbound({ senderIsBot: true }))).toEqual({ skipped: { reason: 'self', messageId: 'msg-1', kind: 'group' } })
    expect(skipped(rawInbound({ senderId: 'bot-user', mentions: [] })))
      .toEqual({ skipped: { reason: 'self', messageId: 'msg-1', kind: 'group' } })
    // A message with neither text nor an attachment is the only non-text skip left.
    expect(skipped(rawInbound({ content: '' }))).toEqual({ skipped: { reason: 'non-text', messageId: 'msg-1', kind: 'group' } })
    // A media-only message now becomes work: its attachments are references the Source fetches.
    expect(normalizeQqInbound(rawInbound({ content: '', attachments: [{ url: 'https://gchat.qpic.cn/i.png' }] }), BOT_IDS))
      .toMatchObject({ message: { text: '', attachments: [{ kind: 'file', url: 'https://gchat.qpic.cn/i.png' }] } })
    // A message with only the bot's mention marker left and an attachment is work too.
    expect(normalizeQqInbound(rawInbound({ content: '<@bot-user>', attachments: [{ url: 'x' }] }), BOT_IDS))
      .toMatchObject({ message: { text: '', attachments: [{ kind: 'file', url: 'x' }] } })
    // An unmentioned group message is dropped before its attachment is ever looked at.
    expect(normalizeQqInbound(rawInbound({ rawEventType: 'GROUP_MESSAGE_CREATE', mentions: [],
      attachments: [{ url: 'https://gchat.qpic.cn/i.png' }] }), BOT_IDS))
      .toEqual({ skipped: { reason: 'not-addressed', messageId: 'msg-1', kind: 'group' } })
    expect(skipped(rawInbound({ messageId: undefined }))).toEqual({ skipped: { reason: 'invalid', kind: 'group' } })
    expect(skipped(rawInbound({ kind: 'guild' }))).toMatchObject({ skipped: { reason: 'unsupported' } })
    expect(skipped(rawInbound({ groupOpenid: undefined }))).toEqual({ skipped: { reason: 'invalid', messageId: 'msg-1', kind: 'group' } })
    expect(normalizeQqInbound(null)).toEqual({ skipped: { reason: 'invalid' } })
  })
  it('turns a picture and a file attachment into the references the Source downloads', () => {
    const inbound = normalizeQqInbound(rawInbound({ attachments: [
      { url: 'https://gchat.qpic.cn/a', filename: 'photo.png', content_type: 'image/png', size: 12 },
      { url: '//gchat.qpic.cn/b', filename: 'report.pdf', content_type: 'application/pdf' },
      { url: 'https://multimedia.nt.qq.com.cn/c', filename: 'note.JPG' },
    ] }), BOT_IDS)
    expect(inbound).toMatchObject({ message: { text: 'please fix the typo', attachments: [
      { kind: 'image', url: 'https://gchat.qpic.cn/a', name: 'photo.png', mime: 'image/png', bytes: 12 },
      { kind: 'file', url: 'https://gchat.qpic.cn/b', name: 'report.pdf', mime: 'application/pdf', bytes: 0 },
      { kind: 'image', url: 'https://multimedia.nt.qq.com.cn/c', name: 'note.JPG', mime: '', bytes: 0 },
    ] } })
    // The camelCase fields are read too, an audio attachment is a file, and a malformed entry names no attachment.
    expect(normalizeQqInbound(rawInbound({ attachments: [
      { url: 'https://gchat.qpic.cn/d', contentType: 'image/webp' },
      { url: 'https://gchat.qpic.cn/e', content_type: 'audio/silk', fileName: 'voice.silk', size: '7' },
      'not an attachment',
    ] }), BOT_IDS)).toMatchObject({ message: { attachments: [
      { kind: 'image', url: 'https://gchat.qpic.cn/d', mime: 'image/webp' },
      { kind: 'file', name: 'voice.silk', mime: 'audio/silk', bytes: 7 },
    ] } })
  })
  it('accepts an HTTPS attachment address on a QQ media host and refuses every other address', () => {
    expect(trustedQqDownloadUrl('https://gchat.qpic.cn/a?rkey=1')).toBe('https://gchat.qpic.cn/a?rkey=1')
    expect(trustedQqDownloadUrl('https://qpic.cn/a')).toBe('https://qpic.cn/a')
    expect(trustedQqDownloadUrl('https://multimedia.nt.qq.com.cn/a')).toBe('https://multimedia.nt.qq.com.cn/a')
    expect(trustedQqDownloadUrl('https://x.myqcloud.com/a')).toBe('https://x.myqcloud.com/a')
    expect(trustedQqDownloadUrl('https://x.tencentcos.com/a')).toBe('https://x.tencentcos.com/a')
    expect(trustedQqDownloadUrl('https://x.ugcimg.cn/a')).toBe('https://x.ugcimg.cn/a')
    // Protocol-relative addresses QQ sometimes sends are completed to HTTPS.
    expect(trustedQqDownloadUrl('//gchat.qpic.cn/a')).toBe('https://gchat.qpic.cn/a')
    // Plain HTTP, a foreign host, a look-alike host, credentials, a non-443 port and an IP literal are all refused.
    expect(trustedQqDownloadUrl('http://gchat.qpic.cn/a')).toBe('')
    expect(trustedQqDownloadUrl('https://evil.example/a')).toBe('')
    expect(trustedQqDownloadUrl('https://qq.com.evil.example/a')).toBe('')
    expect(trustedQqDownloadUrl('https://evilqq.com/a')).toBe('')
    expect(trustedQqDownloadUrl('https://user:pass@gchat.qpic.cn/a')).toBe('')
    expect(trustedQqDownloadUrl('https://gchat.qpic.cn:8443/a')).toBe('')
    expect(trustedQqDownloadUrl('https://127.0.0.1/a')).toBe('')
    expect(trustedQqDownloadUrl('https://[::1]/a')).toBe('')
    expect(trustedQqDownloadUrl('not a url')).toBe('')
  })
  it('cuts a long message text at the Trigger limit and strips only the bot\'s own mentions', () => {
    const long = normalizeQqInbound(rawInbound({ content: `${'x'.repeat(9_000)}` }), BOT_IDS)
    expect(long).toMatchObject({ message: { text: 'x'.repeat(QQ_TEXT_CHARS) } })
    // A mention of someone else stays in the text the worker reads.
    expect(normalizeQqInbound(rawInbound({ content: '<@bot-user> <@user-2> look' }), BOT_IDS))
      .toMatchObject({ message: { text: '<@user-2> look' } })
  })
})

describe('triggers', () => {
  it('names the message, its conversation thread, its reporter and the route a reply may take', () => {
    const trigger = qqTrigger(message(), 'qq:ops', config())
    expect(trigger).toMatchObject({ id: key('qq', 'qq:ops', 'msg-1'), source: 'qq:ops',
      threads: [{ source: 'qq:ops', id: 'group-1' }], actor: { source: 'qq:ops', id: 'user-1' }, human: true,
      addressed: 'mention', at: '2026-11-26T00:00:00.000Z', text: 'please fix the typo' })
    expect(trigger.channel).toMatchObject({ source: 'qq:ops', thread: 'qq:ops:group-1', address: {
      row: 'qq:ops', conversationType: 'group', conversationId: 'group-1', groupId: 'group-1', userId: 'user-1',
      senderId: 'user-1', messageId: 'msg-1', msgId: 'msg-1', eventId: 'msg-1' } })
    expect(trigger.meta).toMatchObject({ row: 'qq:ops', conversationType: 'group', conversationId: 'group-1',
      groupId: 'group-1', userId: 'user-1', senderId: 'user-1', senderNick: 'Alice', messageId: 'msg-1', msgId: 'msg-1',
      eventId: 'msg-1', addressed: true, sandbox: false })
    // The route's received-at is the message time in epoch milliseconds, which the reply window reads.
    expect(Number(trigger.channel!.address.receivedAt)).toBe(Date.parse('2026-11-26T00:00:00.000Z'))
    // A direct message is addressed directly and answers the user's openid conversation.
    const direct = qqTrigger(message({ kind: 'c2c', conversationId: 'user-1', groupId: '' }), 'qq:ops', config())
    expect(direct).toMatchObject({ addressed: 'direct', threads: [{ source: 'qq:ops', id: 'user-1' }],
      channel: { address: { conversationType: 'direct', groupId: '', conversationId: 'user-1' } } })
  })
  it('never puts the AppSecret in a Trigger', () => {
    const trigger = qqTrigger(message(), 'qq:ops', config({ appSecret: 'top-secret-value' }))
    const stored = JSON.stringify(trigger)
    expect(stored).not.toContain('top-secret-value')
    expect(stored).not.toContain('appSecret')
  })
  it('receives a message once, keeps a duplicate from becoming work, and drops a sender the instance does not allow', async () => {
    const received: Trigger[] = []
    const receive = vi.fn((trigger: Trigger) => { received.push(trigger); return received.length > 1 ? 'duplicate' as const : 'stored' as const })
    const ctx = { receive, threads: { describe: vi.fn() } } as unknown as SourceContext
    expect(await receiveQq(ctx, 'qq:ops', config(), message())).toBe('received')
    expect(await receiveQq(ctx, 'qq:ops', config(), message())).toBe('duplicate')
    expect(receive).toHaveBeenCalledTimes(2)
    expect(await receiveQq(ctx, 'qq:ops', config({ allowedUserIds: 'user-2' }), message())).toBe('not-allowed')
    expect(receive).toHaveBeenCalledTimes(2)
  })
})

describe('inbound attachments', () => {
  it('saves an inbound picture under the state directory and names its absolute path in the Trigger', async () => {
    await withStateDir(async stateDir => {
      const stub = responseStub(() => binaryResponse('png-bytes', 'image/png'))
      const source = attachmentSource(stateDir)
      expect(await receiveQq(source.ctx, 'qq:ops', config(), message({ text: '', attachments: [ref()] }),
        { fetchImpl: stub.impl })).toBe('received')
      expect(source.received).toHaveLength(1)
      const trigger = source.received[0]!
      const attachment = attachmentsOf(trigger)[0]!
      expect(attachment).toMatchObject({ kind: 'image', name: 'image.png', mime: 'image/png', bytes: 9 })
      expect(attachment.path).toBe(join(qqAttachmentDirectory(stateDir, 'qq:ops', 'msg-1'), 'image.png'))
      expect(relative(stateDir, attachment.path).startsWith('..')).toBe(false)
      expect(await readFile(attachment.path, 'utf8')).toBe('png-bytes')
      expect(trigger.text).toBe(`收到图片/文件：${attachment.path}`)
      // The signed address alone is fetched, as a GET that never follows a redirect; the reply route is unchanged.
      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0]).toMatchObject({ url: SIGNED_URL, method: 'GET', redirect: 'error' })
      expect(trigger.channel!.address).toMatchObject({ conversationType: 'group', conversationId: 'group-1', msgId: 'msg-1' })
      // The signed query string is a download credential: it never reaches the Trigger or its meta.
      expect(JSON.stringify(trigger)).not.toContain('rkey=secret-query')
    })
  })
  it('names a picture from its Content-Type and keeps an unknown type as .bin', async () => {
    await withStateDir(async stateDir => {
      let type: string | undefined = 'image/jpeg; charset=binary'
      // A missing answer Content-Type leaves the body untyped; a string body would get one from `Response` itself.
      const stub = responseStub(() => type === undefined ? new Response(new Uint8Array([120])) : binaryResponse('x', type))
      const source = attachmentSource(stateDir)
      await receiveQq(source.ctx, 'qq:ops', config(), message({ text: '', attachments: [ref()] }), { fetchImpl: stub.impl })
      type = 'image/tiff'
      await receiveQq(source.ctx, 'qq:ops', config(), message({ messageId: 'msg-2', text: '', attachments: [ref()] }),
        { fetchImpl: stub.impl })
      expect(attachmentsOf(source.received[0]!)[0]).toMatchObject({ name: 'image.jpg', mime: 'image/jpeg' })
      expect(attachmentsOf(source.received[1]!)[0]).toMatchObject({ name: 'image.bin', mime: 'image/tiff' })
      // The declared Content-Type is only the fallback when the answer carries none.
      type = undefined
      await receiveQq(source.ctx, 'qq:ops', config(), message({ messageId: 'msg-3', text: '',
        attachments: [ref({ mime: 'image/webp' })] }), { fetchImpl: stub.impl })
      expect(attachmentsOf(source.received[2]!)[0]).toMatchObject({ name: 'image.webp', mime: 'image/webp' })
    })
  })
  it('saves a file under the name QQ sent, sanitized, and falls back to the message id', async () => {
    await withStateDir(async stateDir => {
      const stub = responseStub(() => binaryResponse('%PDF-1.4', 'application/pdf'))
      const source = attachmentSource(stateDir)
      expect(await receiveQq(source.ctx, 'qq:ops', config(), message({ text: '',
        attachments: [ref({ kind: 'file', name: '../../etc/passwd' })] }), { fetchImpl: stub.impl })).toBe('received')
      expect(await receiveQq(source.ctx, 'qq:ops', config(), message({ messageId: 'msg-2', text: '',
        attachments: [ref({ kind: 'file', name: '' })] }), { fetchImpl: stub.impl })).toBe('received')
      const first = attachmentsOf(source.received[0]!)[0]!
      expect(first).toMatchObject({ kind: 'file', mime: 'application/pdf', bytes: 8 })
      // The provider name is not trusted as a path: the saved name has no directory part and stays in its directory.
      expect(first.name).toBe('etc-passwd')
      expect(relative(qqAttachmentDirectory(stateDir, 'qq:ops', 'msg-1'), first.path)).toBe(first.name)
      expect(await readFile(first.path, 'utf8')).toBe('%PDF-1.4')
      expect(attachmentsOf(source.received[1]!)[0]!.name).toBe('file-msg-2')
    })
  })
  it('lists the original text and every attachment of a message, naming clashing files apart', async () => {
    await withStateDir(async stateDir => {
      const stub = responseStub(call => binaryResponse(call.url.split('/').at(-1) ?? '', 'image/png'))
      const source = attachmentSource(stateDir)
      const attachments = [ref({ url: 'https://gchat.qpic.cn/media/a' }), ref({ url: 'https://gchat.qpic.cn/media/b' })]
      expect(await receiveQq(source.ctx, 'qq:ops', config(), message({ text: 'see the two pictures', attachments }),
        { fetchImpl: stub.impl })).toBe('received')
      const trigger = source.received[0]!
      const saved = attachmentsOf(trigger)
      // Both are PNGs, so the second file keeps the same base name with a sequence number.
      expect(saved.map(attachment => attachment.name)).toEqual(['image.png', 'image-1.png'])
      expect(await readFile(saved[0]!.path, 'utf8')).toBe('a')
      expect(await readFile(saved[1]!.path, 'utf8')).toBe('b')
      expect(saved).toEqual([
        { path: join(qqAttachmentDirectory(stateDir, 'qq:ops', 'msg-1'), 'image.png'), kind: 'image',
          name: 'image.png', mime: 'image/png', bytes: 1 },
        { path: join(qqAttachmentDirectory(stateDir, 'qq:ops', 'msg-1'), 'image-1.png'), kind: 'image',
          name: 'image-1.png', mime: 'image/png', bytes: 1 },
      ])
      expect(trigger.text).toBe(`see the two pictures\n附件：${saved[0]!.path}（image/image/png）\n附件：${saved[1]!.path}（image/image/png）`)
    })
  })
  it('receives a text message as before, without an attachment directory', async () => {
    await withStateDir(async stateDir => {
      const source = attachmentSource(stateDir)
      expect(await receiveQq(source.ctx, 'qq:ops', config(), message())).toBe('received')
      expect(source.received[0]!.text).toBe('please fix the typo')
      expect(source.received[0]!.meta.attachments).toBeUndefined()
      await expect(stat(join(stateDir, 'area'))).rejects.toThrow()
    })
  })
  it('skips an attachment with no download address without contacting QQ', async () => {
    await withStateDir(async stateDir => {
      const stub = responseStub(() => binaryResponse('x', 'image/png'))
      const source = attachmentSource(stateDir)
      expect(await receiveQq(source.ctx, 'qq:ops', config(), message({ text: '', attachments: [ref({ url: '' })] }),
        { fetchImpl: stub.impl })).toBe('attachment-unavailable')
      expect(source.receive).not.toHaveBeenCalled()
      expect(stub.calls).toEqual([])
      await expect(stat(qqAttachmentDirectory(stateDir, 'qq:ops', 'msg-1'))).rejects.toThrow()
    })
  })
  it('skips a message with more than five attachments instead of receiving part of it', async () => {
    await withStateDir(async stateDir => {
      const stub = responseStub(() => binaryResponse('x', 'image/png'))
      const source = attachmentSource(stateDir)
      const attachments = Array.from({ length: QQ_ATTACHMENTS_PER_MESSAGE + 1 }, () => ref())
      expect(await receiveQq(source.ctx, 'qq:ops', config(), message({ text: '', attachments }), { fetchImpl: stub.impl }))
        .toBe('attachment-count')
      expect(source.receive).not.toHaveBeenCalled()
      expect(stub.calls).toEqual([])
      await expect(stat(qqAttachmentDirectory(stateDir, 'qq:ops', 'msg-1'))).rejects.toThrow()
    })
  })
  it('never fetches an attachment outside the QQ media hosts', async () => {
    await withStateDir(async stateDir => {
      for (const [index, url] of ['http://gchat.qpic.cn/x', 'https://evil.example/x', 'https://qq.com.evil.example/x',
        'https://127.0.0.1/x'].entries()) {
        const stub = responseStub(() => binaryResponse('x', 'image/png'))
        const source = attachmentSource(stateDir)
        expect(await receiveQq(source.ctx, 'qq:ops', config(), message({ messageId: `msg-evil-${index}`, text: '',
          attachments: [ref({ url })] }), { fetchImpl: stub.impl })).toBe('attachment-untrusted')
        expect(source.receive).not.toHaveBeenCalled()
        expect(stub.calls).toEqual([])
        await expect(stat(qqAttachmentDirectory(stateDir, 'qq:ops', `msg-evil-${index}`))).rejects.toThrow()
      }
    })
  })
  it('refuses a redirected download instead of following it', async () => {
    await withStateDir(async stateDir => {
      const stub = responseStub(() => new Response('', { status: 302, headers: { location: 'https://evil.example/x' } }))
      const source = attachmentSource(stateDir)
      expect(await receiveQq(source.ctx, 'qq:ops', config(), message({ text: '', attachments: [ref()] }),
        { fetchImpl: stub.impl })).toBe('attachment-download-failed')
      expect(source.receive).not.toHaveBeenCalled()
      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0]!.redirect).toBe('error')
      expect(stub.calls.some(call => call.url === 'https://evil.example/x')).toBe(false)
      await expect(stat(qqAttachmentDirectory(stateDir, 'qq:ops', 'msg-1'))).rejects.toThrow()
    })
  })
  it('skips a message whose download fails, keeping no partial directory', async () => {
    await withStateDir(async stateDir => {
      const stub = responseStub(() => new Response('', { status: 503 }))
      const source = attachmentSource(stateDir)
      expect(await receiveQq(source.ctx, 'qq:ops', config(), message({ text: '', attachments: [ref()] }),
        { fetchImpl: stub.impl })).toBe('attachment-download-failed')
      expect(source.receive).not.toHaveBeenCalled()
      expect(stub.calls).toHaveLength(1)
      await expect(stat(qqAttachmentDirectory(stateDir, 'qq:ops', 'msg-1'))).rejects.toThrow()
    })
  })
  it('refuses an attachment whose declared size exceeds 20 MiB before any request', async () => {
    await withStateDir(async stateDir => {
      const stub = responseStub(() => binaryResponse('x', 'image/png'))
      const source = attachmentSource(stateDir)
      expect(await receiveQq(source.ctx, 'qq:ops', config(), message({ text: '',
        attachments: [ref({ bytes: QQ_ATTACHMENT_BYTES + 1 })] }), { fetchImpl: stub.impl })).toBe('attachment-too-large')
      expect(source.receive).not.toHaveBeenCalled()
      expect(stub.calls).toEqual([])
      await expect(stat(qqAttachmentDirectory(stateDir, 'qq:ops', 'msg-1'))).rejects.toThrow()
    })
  })
  it('stops a streamed body larger than 20 MiB and keeps none of it', async () => {
    await withStateDir(async stateDir => {
      const stub = responseStub(() => new Response(new Uint8Array(QQ_ATTACHMENT_BYTES + 1),
        { headers: { 'content-type': 'application/octet-stream' } }))
      const source = attachmentSource(stateDir)
      expect(await receiveQq(source.ctx, 'qq:ops', config(), message({ text: '',
        attachments: [ref({ kind: 'file' })] }), { fetchImpl: stub.impl })).toBe('attachment-too-large')
      expect(source.receive).not.toHaveBeenCalled()
      await expect(stat(qqAttachmentDirectory(stateDir, 'qq:ops', 'msg-1'))).rejects.toThrow()
    })
  })
})

describe('replies', () => {
  it('sends a passive reply with the inbound msg_id, markdown, and a stable msg_seq', async () => {
    const sender = fakeSender()
    expect(await sendQqReply(reply('Done.'), { sender, target: target() })).toBe('sent')
    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0]).toMatchObject({ target: { scope: 'group', targetId: 'group-1', msgId: 'msg-1' }, msgType: 2,
      markdown: { content: 'Done.' } })
    expect(sender.sent[0]!.extra).toEqual({ msg_seq: replySeqOf('m-1', 0) })
    // The same outbound message retried reuses its msg_seq, so QQ deduplicates a delivery whose answer was lost.
    const retry = fakeSender()
    await sendQqReply(reply('Done.'), { sender: retry, target: target() })
    expect(retry.sent[0]!.extra).toEqual(sender.sent[0]!.extra)
    expect(replySeqOf('m-1', 0)).not.toBe(replySeqOf('m-2', 0))
  })
  it('carries a group mention in markdown, and falls back to plain text without it when QQ refuses markdown', async () => {
    const sender = fakeSender()
    await sendQqReply(reply(`${qqMention('user-1')} Done.`), { sender, target: target() })
    expect(sender.sent[0]).toMatchObject({ msgType: 2, markdown: { content: '<@user-1> Done.' } })
    // A definite markdown rejection is safe to retry as plain text: nothing was delivered, so the same msg_seq stays.
    let call = 0
    const refused = fakeSender(() => { if (++call === 1) throw apiFailure(400, 304036) })
    expect(await sendQqReply(reply(`${qqMention('user-1')} Done.`), { sender: refused, target: target() })).toBe('sent')
    // The rejected markdown attempt is followed by one plain text send with the mention markup stripped.
    expect(refused.sent).toHaveLength(2)
    expect(refused.sent[0]).toMatchObject({ msgType: 2, markdown: { content: '<@user-1> Done.' } })
    expect(refused.sent[1]).toMatchObject({ msgType: 0, content: 'Done.' })
    expect(refused.sent[1]!.extra).toEqual({ msg_seq: replySeqOf('m-1', 0) })
  })
  it('reports gone for a closed window without a call, and for QQ\'s expired msg_id answer', async () => {
    const sender = fakeSender()
    expect(await sendQqReply(reply('Too late.'), { sender, target: target({ receivedAt: past() }) })).toBe('gone')
    expect(sender.sent).toHaveLength(0)
    const expired = fakeSender(() => { throw apiFailure(400, 40034005) })
    expect(await sendQqReply(reply('Too late.'), { sender: expired, target: target() })).toBe('gone')
    // A route with no message id can never receive a passive reply.
    expect(await sendQqReply(reply('Done.'), { sender, target: target({ msgId: '' }) })).toBe('gone')
  })
  it('throws a retryable classification for network, authentication and rate-limit failures', async () => {
    const failing = (status: number): FakeSender => fakeSender(() => { throw apiFailure(status) })
    await expect(sendQqReply(reply('Done.'), { sender: failing(500), target: target() })).rejects.toMatchObject({ code: 'network' })
    await expect(sendQqReply(reply('Done.'), { sender: failing(401), target: target() })).rejects.toMatchObject({ code: 'auth' })
    await expect(sendQqReply(reply('Done.'), { sender: failing(429), target: target() })).rejects.toMatchObject({ code: 'rate-limit' })
    await expect(sendQqReply(reply('Done.'), { sender: fakeSender(() => { throw new Error('socket closed') }), target: target() }))
      .rejects.toMatchObject({ code: 'network' })
  })
  it('treats QQ\'s already-delivered answer as sent instead of resending, and never falls back after an uncertain failure', async () => {
    const duplicate = fakeSender(() => { throw apiFailure(400, 40054005) })
    expect(await sendQqReply(reply('Done.'), { sender: duplicate, target: target() })).toBe('sent')
    expect(duplicate.sent).toHaveLength(1)
    expect(duplicate.sent[0]).toMatchObject({ msgType: 2 })
    // A markdown send that failed for an uncertain reason is thrown, not retried as plain text in the same call.
    const uncertain = fakeSender(() => { throw apiFailure(500) })
    await expect(sendQqReply(reply('Done.'), { sender: uncertain, target: target() })).rejects.toMatchObject({ code: 'network' })
    expect(uncertain.sent).toHaveLength(1)
  })
  it('splits a long reply into several QQ-sized messages and cuts it at the passive budget', async () => {
    const sender = fakeSender()
    const long = `${'a'.repeat(QQ_REPLY_CHARS)}\n${'b'.repeat(QQ_REPLY_CHARS)}`
    await sendQqReply(reply(long), { sender, target: target() })
    expect(sender.sent).toHaveLength(2)
    for (const sent of sender.sent) expect((sent.markdown?.content ?? '').length).toBeLessThanOrEqual(QQ_REPLY_CHARS)
    expect(splitQqText('one line')).toEqual(['one line'])
    expect(splitQqText('   ')).toEqual([])
    // A reply larger than the passive budget spends the last slot on a truncation notice instead of a proactive send.
    const limit = QQ_PASSIVE_REPLY_LIMIT.group
    const huge = Array.from({ length: limit + 2 }, (_, index) => `${index}`.repeat(QQ_REPLY_CHARS)).join('\n')
    const capped = fakeSender()
    expect(await sendQqReply(reply(huge), { sender: capped, target: target() })).toBe('sent')
    expect(capped.sent).toHaveLength(limit)
    expect(capped.sent.at(-1)!.markdown).toEqual({ content: QQ_TRUNCATION_NOTICE })
  })
  it('knows whether a route\'s passive window is still open', () => {
    expect(replyWindowOpen(target(), Date.now())).toBe(true)
    expect(replyWindowOpen(target({ receivedAt: Date.now() }), Date.now())).toBe(true)
    expect(replyWindowOpen(target({ receivedAt: past() }), Date.now())).toBe(false)
    expect(replyWindowOpen(target({ receivedAt: Number.NaN }), Date.now())).toBe(true)
  })
  it('sends through the Channel only while the instance\'s bot is connected, and refuses an unscoped Commands', async () => {
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    // The route's message must be recent for QQ's passive window to be open.
    const trigger = qqTrigger(message({ createdAt: new Date().toISOString() }), 'qq:ops', config())
    await expect(qqKind.channel!.send({ commands }, reply('Done.', trigger.channel!.address)))
      .rejects.toThrow('no configuration')
    const bot = fakeBot()
    const connection = new QqConnection({ appId: 'app-1', appSecret: 'secret-1', onMessage: () => {},
      botFactory: (async () => bot) as QqBotFactory })
    await connection.connect()
    try {
      const scoped = qqKind.commands!(config(), commands)
      expect(await qqKind.channel!.send({ commands: scoped }, reply('Done.', trigger.channel!.address))).toBe('sent')
      expect(bot.sent).toHaveLength(1)
      expect(bot.sent[0]).toMatchObject({ target: { scope: 'group', targetId: 'group-1', msgId: 'msg-1' } })
    } finally { await connection.close() }
    // With the connection closed the reply waits for the Outbox's retry instead of failing as gone.
    await expect(qqKind.channel!.send({ commands: qqKind.commands!(config(), commands), }, reply('Done.')))
      .rejects.toThrow('not connected')
  })
})

/** One outbound attachment on disk: its display name, absolute path, MIME type and size. */
async function outboundFile(stateDir: string, name: string, content: string | Uint8Array,
  mime = 'application/octet-stream') {
  const path = join(stateDir, name)
  await writeFile(path, content)
  return { name, path, mime, bytes: Buffer.byteLength(content) }
}
/** The reply of the default outbound message, carrying `attachments` beside its text. */
const withFiles = (attachments: OutboundMessage['attachments']): OutboundMessage =>
  ({ ...reply('Artifacts delivered'), attachments })

describe('outbound attachments', () => {
  it('delivers the text first, then each file as a picture or a file under its own name', async () => {
    await withStateDir(async stateDir => {
      const sender = fakeSender()
      const files = [await outboundFile(stateDir, 'chart.png', 'png-bytes', 'image/png'),
        await outboundFile(stateDir, 'report.pdf', 'pdf-bytes', 'application/pdf')]
      expect(await sendQqMessage(withFiles(files), { sender, target: target() }))
        .toEqual({ result: 'sent', sentFiles: 2, failedFiles: 0 })
      // The text goes out before the first file; the files follow in their own order.
      expect(sender.events).toEqual(['text', 'media', 'media'])
      expect(sender.sent[0]).toMatchObject({ msgType: 2, markdown: { content: 'Artifacts delivered' },
        target: { scope: 'group', targetId: 'group-1', msgId: 'msg-1' } })
      expect(sender.media.map(call => ({ fileType: call.fileType, name: call.fileName, route: call.target }))).toEqual([
        { fileType: 1, name: 'chart.png', route: { scope: 'group', targetId: 'group-1', msgId: 'msg-1' } },
        { fileType: 4, name: 'report.pdf', route: { scope: 'group', targetId: 'group-1', msgId: 'msg-1' } }])
      expect(sender.media.map(call => call.buffer.toString('utf8'))).toEqual(['png-bytes', 'pdf-bytes'])
    })
  })
  it('sends to an active route without an inbound message as a proactive message with no msg_seq', async () => {
    await withStateDir(async stateDir => {
      const sender = fakeSender()
      expect(await sendQqMessage(withFiles([await outboundFile(stateDir, 'notes.txt', 'note', 'text/plain')]),
        { sender, target: { scope: 'c2c', targetId: 'user-1' } }))
        .toEqual({ result: 'sent', sentFiles: 1, failedFiles: 0 })
      expect(sender.sent).toHaveLength(1)
      expect(sender.sent[0]).toMatchObject({ target: { scope: 'c2c', targetId: 'user-1' }, msgType: 2 })
      expect(sender.sent[0]!.extra).toBeUndefined()
      expect(sender.media[0]).toMatchObject({ target: { scope: 'c2c', targetId: 'user-1' }, fileType: 4,
        fileName: 'notes.txt' })
    })
  })
  it('delivers at most ten files per reply and counts the rest, keeping the text delivered', async () => {
    await withStateDir(async stateDir => {
      const sender = fakeSender()
      const attachments = []
      for (let index = 0; index < QQ_SENT_ATTACHMENTS_PER_MESSAGE + 2; index += 1) {
        attachments.push(await outboundFile(stateDir, `file-${index}.txt`, `file ${index}`, 'text/plain'))
      }
      expect(await sendQqMessage(withFiles(attachments), { sender, target: target() }))
        .toEqual({ result: 'sent', sentFiles: QQ_SENT_ATTACHMENTS_PER_MESSAGE, failedFiles: 2 })
      expect(sender.sent).toHaveLength(1)
      expect(sender.media).toHaveLength(QQ_SENT_ATTACHMENTS_PER_MESSAGE)
    })
  })
  it('skips a file over 20 MiB, a relative path and a missing file, counting each', async () => {
    await withStateDir(async stateDir => {
      const sender = fakeSender()
      const big = await outboundFile(stateDir, 'big.bin', Buffer.alloc(QQ_SENT_ATTACHMENT_BYTES + 1))
      const ok = await outboundFile(stateDir, 'ok.txt', 'ok', 'text/plain')
      expect(await sendQqMessage(withFiles([big, ok,
        { name: 'relative.txt', path: join('relative', 'relative.txt'), mime: 'text/plain' },
        { name: 'gone.txt', path: join(stateDir, 'missing.txt'), mime: 'text/plain' }]),
      { sender, target: target() })).toEqual({ result: 'sent', sentFiles: 1, failedFiles: 3 })
      // The oversized file is refused before it is read, and only the usable one reaches the bot.
      expect(sender.media.map(call => call.fileName)).toEqual(['ok.txt'])
    })
  })
  it('counts a failed file and keeps the delivered text, never sending it again', async () => {
    await withStateDir(async stateDir => {
      const sender = fakeSender(undefined, call => {
        if (call.fileName === 'second.png') throw apiFailure(500)
      })
      const files = [await outboundFile(stateDir, 'first.png', 'a', 'image/png'),
        await outboundFile(stateDir, 'second.png', 'b', 'image/png'),
        await outboundFile(stateDir, 'third.png', 'c', 'image/png')]
      expect(await sendQqMessage(withFiles(files), { sender, target: target() }))
        .toEqual({ result: 'sent', sentFiles: 2, failedFiles: 1 })
      expect(sender.events).toEqual(['text', 'media', 'media', 'media'])
      expect(sender.sent).toHaveLength(1)
    })
  })
  it('sends no file when the passive reply is gone or the route names no conversation', async () => {
    await withStateDir(async stateDir => {
      const sender = fakeSender()
      const files = [await outboundFile(stateDir, 'late.txt', 'x', 'text/plain')]
      expect(await sendQqMessage(withFiles(files), { sender, target: target({ receivedAt: past() }) }))
        .toEqual({ result: 'gone', sentFiles: 0, failedFiles: 0 })
      expect(await sendQqMessage(withFiles(files), { sender, target: { scope: 'group', targetId: '' } }))
        .toEqual({ result: 'gone', sentFiles: 0, failedFiles: 0 })
      expect(sender.events).toEqual([])
    })
  })
  it('keeps the passive msg_seq and the plain fallback when a reply carries files', async () => {
    await withStateDir(async stateDir => {
      let calls = 0
      const sender = fakeSender(() => { if (++calls === 1) throw apiFailure(400, 304036) })
      expect(await sendQqMessage(withFiles([await outboundFile(stateDir, 'chart.png', 'x', 'image/png')]),
        { sender, target: target() })).toEqual({ result: 'sent', sentFiles: 1, failedFiles: 0 })
      expect(sender.sent).toHaveLength(2)
      expect(sender.sent[0]).toMatchObject({ msgType: 2 })
      expect(sender.sent[1]).toMatchObject({ msgType: 0, content: 'Artifacts delivered' })
      expect(sender.sent[1]!.extra).toEqual({ msg_seq: replySeqOf('m-1', 0) })
      expect(sender.media).toHaveLength(1)
    })
  })
  it('uses sendMedia when the bot offers it and sendImage/sendFile when it does not', async () => {
    const media = fakeSender()
    await sendQqAttachment({ name: 'a.png', mime: 'image/png', data: Buffer.from('x') },
      { sender: media, target: { scope: 'group', targetId: 'group-1' } })
    expect(media.media).toEqual([{ target: { scope: 'group', targetId: 'group-1' }, fileType: 1,
      buffer: Buffer.from('x'), fileName: 'a.png' }])
    // The convenience methods of a client without sendMedia: a picture through sendImage, a file through sendFile.
    const calls: string[] = []
    const convenience: QqSender = { send: async () => ({}),
      sendImage: async () => { calls.push('image'); return {} },
      sendFile: async (_target, _source, options) => { calls.push(`file:${options?.fileName}`); return {} } }
    await sendQqAttachment({ name: 'b.png', mime: 'image/png', data: Buffer.from('x') },
      { sender: convenience, target: { scope: 'c2c', targetId: 'user-1' } })
    await sendQqAttachment({ name: 'c.pdf', mime: 'application/pdf', data: Buffer.from('x') },
      { sender: convenience, target: { scope: 'c2c', targetId: 'user-1' } })
    expect(calls).toEqual(['image', 'file:c.pdf'])
    // A client with no media operation at all, a route without a conversation, and QQ's own refusal are all classified.
    const noMedia: QqSender = { send: async () => ({}) }
    await expect(sendQqAttachment({ name: 'd.txt', mime: 'text/plain', data: Buffer.from('x') },
      { sender: noMedia, target: { scope: 'c2c', targetId: 'user-1' } })).rejects.toMatchObject({ code: 'rejected' })
    await expect(sendQqAttachment({ name: 'e.txt', mime: 'text/plain', data: Buffer.from('x') },
      { sender: media, target: { scope: 'group', targetId: '' } })).rejects.toMatchObject({ code: 'invalid-route' })
    const refused = fakeSender(undefined, () => { throw apiFailure(429) })
    await expect(sendQqAttachment({ name: 'f.txt', mime: 'text/plain', data: Buffer.from('x') },
      { sender: refused, target: { scope: 'c2c', targetId: 'user-1' } })).rejects.toMatchObject({ code: 'rate-limit' })
  })
  it('delivers a reply\'s files through the Channel after its text, and counts what it cannot deliver', async () => {
    await withStateDir(async stateDir => {
      const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
      const trigger = qqTrigger(message({ createdAt: new Date().toISOString() }), 'qq:ops', config())
      const bot = fakeBot()
      const connection = new QqConnection({ appId: 'app-1', appSecret: 'secret-1', onMessage: () => {},
        botFactory: (async () => bot) as QqBotFactory })
      await connection.connect()
      try {
        expect(await qqKind.channel!.send({ commands: qqKind.commands!(config(), commands) },
          { ...reply('Artifacts delivered', trigger.channel!.address),
            attachments: [await outboundFile(stateDir, 'chart.png', 'png-bytes', 'image/png'),
              await outboundFile(stateDir, 'report.pdf', 'pdf-bytes', 'application/pdf')] })).toBe('sent')
        expect(bot.sent).toHaveLength(1)
        expect(bot.media.map(call => call.fileName)).toEqual(['chart.png', 'report.pdf'])
        expect(bot.media.map(call => call.fileType)).toEqual([1, 4])
        expect(bot.media.every(call => call.target.targetId === 'group-1' && call.target.msgId === 'msg-1')).toBe(true)
        expect(qqSentAttachmentFailures('qq:ops')).toBe(0)
      } finally { await connection.close() }
    })
  })
  it('counts a reply file the Channel cannot deliver per instance, keeping the text delivered', async () => {
    await withStateDir(async stateDir => {
      const failing = fakeBot({ mediaError: apiFailure(500) })
      const connection = new QqConnection({ appId: 'app-1', appSecret: 'secret-1', onMessage: () => {},
        botFactory: (async () => failing) as QqBotFactory })
      await connection.connect()
      try {
        const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
        const trigger = qqTrigger(message({ createdAt: new Date().toISOString() }), 'qq:ops', config())
        expect(await qqKind.channel!.send({ commands: qqKind.commands!(config(), commands) },
          { ...reply('Artifacts delivered', trigger.channel!.address),
            attachments: [await outboundFile(stateDir, 'report.pdf', 'pdf', 'application/pdf')] })).toBe('sent')
        expect(failing.sent).toHaveLength(1)
        expect(failing.media).toHaveLength(0)
        expect(qqSentAttachmentFailures('qq:ops')).toBe(1)
      } finally { await connection.close() }
    })
  })
})

describe('the gateway connection', () => {
  it('registers the handlers, becomes ready, registers the live sender and dispatches a message', async () => {
    const bot = fakeBot()
    const messages: QqMessage[] = []
    const skips: QqSkipEvent[] = []
    const connection = new QqConnection({ appId: 'app-1', appSecret: 'secret-1', botFactory: (async () => bot) as QqBotFactory,
      onMessage: message => { messages.push(message) }, onSkip: skip => { skips.push(skip) } })
    await connection.connect()
    expect(connection.connected).toBe(true)
    expect([...bot.handlers.keys()].sort()).toEqual(['error', 'message', 'ready', 'resumed'])
    expect(liveQqBot('app-1')).toBe(bot)
    bot.emit('message', undefined, rawInbound())
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]).toMatchObject({ messageId: 'msg-1', kind: 'group', conversationId: 'group-1' })
    bot.emit('message', undefined, rawInbound({ senderIsBot: true }))
    expect(skips.map(skip => skip.reason)).toEqual(['self'])
    await connection.close()
    expect(bot.stops).toBe(1)
    expect(connection.connected).toBe(false)
    expect(liveQqBot('app-1')).toBeUndefined()
  })
  it('reports the stage and reason of a failed start without the secret', async () => {
    const refusing = new QqConnection({ appId: 'app-1', appSecret: 'secret-1', onMessage: () => {},
      botFactory: (async () => fakeBot({ startError: new Error('bad credential secret-1') })) as QqBotFactory })
    const failure = await refusing.connect().catch((error: unknown) => error) as Error
    expect(failure.name).toBe('QqConnectError')
    expect(failure).toMatchObject({ stage: 'connect' })
    expect(failure.message).toContain('[redacted]')
    expect(failure.message).not.toContain('secret-1')
    const load = new QqConnection({ appId: 'app-1', appSecret: 'secret-1', onMessage: () => {},
      botFactory: (async () => { throw new Error('not installed') }) as QqBotFactory })
    await expect(load.connect()).rejects.toMatchObject({ stage: 'load' })
    const unusable = new QqConnection({ appId: 'app-1', appSecret: 'secret-1', onMessage: () => {},
      botFactory: (async () => ({}) as QqBotClient) as QqBotFactory })
    await expect(unusable.connect()).rejects.toMatchObject({ stage: 'load' })
  })
  it('times out when the gateway never becomes ready', async () => {
    const connection = new QqConnection({ appId: 'app-1', appSecret: 'secret-1', onMessage: () => {},
      botFactory: (async () => fakeBot({ connectTimeout: true })) as QqBotFactory, connectTimeoutMs: 30 })
    await expect(connection.connect()).rejects.toMatchObject({ stage: 'ready' })
  })
  it('fails a live connection after three consecutive errors but survives two', async () => {
    const bot = fakeBot()
    const connection = new QqConnection({ appId: 'app-1', appSecret: 'secret-1', botFactory: (async () => bot) as QqBotFactory,
      onMessage: () => {} })
    await connection.connect()
    const closed = connection.waitForClose()
    bot.emit('error', new Error('gateway 1'))
    bot.emit('error', new Error('gateway 2'))
    let settled = false
    void closed.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    bot.emit('error', new Error('gateway 3'))
    await expect(closed).resolves.toMatchObject({ closed: 'failed' })
    expect(connection.failure).toContain('gateway 3')
    await connection.close()
  })
  it('resolves waitForClose when the SDK stops the gateway and when the caller aborts, and waits for handlers on close', async () => {
    const bot = fakeBot()
    const connection = new QqConnection({ appId: 'app-1', appSecret: 'secret-1', botFactory: (async () => bot) as QqBotFactory,
      onMessage: async () => { await new Promise(resolve => setTimeout(resolve, 20)) } })
    await connection.connect()
    const closed = connection.waitForClose()
    bot.finishStart()
    await expect(closed).resolves.toMatchObject({ closed: 'closed' })
    await connection.close()
    const aborted = new AbortController()
    const second = fakeBot()
    const other = new QqConnection({ appId: 'app-1', appSecret: 'secret-1', onMessage: () => {},
      botFactory: (async () => second) as QqBotFactory })
    await other.connect()
    const waiting = other.waitForClose(aborted.signal)
    aborted.abort()
    await expect(waiting).resolves.toMatchObject({ closed: 'aborted' })
    await other.close()
  })
})

describe('the plugin loop', () => {
  it('waits for setup and reports paused when setup is not done', async () => {
    const source = fakeSource([config()], { configured: false })
    await watchQq(source.ctx, new AbortController().signal, {})
    expect(lastHealth(source)).toMatchObject({ state: 'paused', code: 'setupPending' })
  })
  it('reports paused with the missing credentials instead of failing, and a disabled instance as off', async () => {
    const source = fakeSource([qqKind.schema.parse({})])
    await watching(source, { botFactory: factoryOf([]) }, async () => {
      await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'paused',
        detail: 'The QQ bot is not configured: appId, appSecret' }))
    })
    const disabled = fakeSource([config()], { enabled: false })
    await watching(disabled, { botFactory: factoryOf([]) }, async () => {
      await vi.waitFor(() => expect(lastHealth(disabled)).toMatchObject({ state: 'paused', code: 'sourceOff' }))
    })
  })
  it('reports ready once connected, counts messages, and reconnects after the gateway closes', async () => {
    const bots: FakeBot[] = []
    const source = fakeSource([config()])
    await watching(source, { botFactory: factoryOf(bots), backoffMs: [1], reconcileSeconds: 0.05 }, async () => {
      await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'ready' }))
      expect(lastHealth(source)!.detail).toBe('Connected to the QQ bot gateway; 0 messages received')
      expect(bots).toHaveLength(1)
      // A message the bot receives becomes a Trigger and is counted in the health detail.
      bots[0]!.emit('message', undefined, rawInbound())
      await vi.waitFor(() => expect(lastHealth(source)!.detail).toContain('1 messages received'))
      expect(source.receive).toHaveBeenCalledTimes(1)
      // The SDK stopping the gateway is reported with the reconnect delay and followed by a second connection.
      bots[0]!.finishStart()
      await vi.waitFor(() => expect(bots).toHaveLength(2))
      expect(source.reports.some(report => report.health.detail === 'The QQ bot gateway connection closed; reconnecting in 1 s'))
        .toBe(true)
      await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'ready' }))
    })
  }, 20_000)
  it('reports an error only after three consecutive failed connections, and keeps retrying', async () => {
    const source = fakeSource([config()])
    let attempts = 0
    const factory = (async () => { attempts += 1; throw new Error('gateway down') }) as unknown as QqBotFactory
    await watching(source, { botFactory: factory, backoffMs: [1, 1, 1], reconcileSeconds: 0.05 }, async () => {
      await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'error' }))
      expect(source.reports.some(report => report.health.state === 'error' && report.health.detail.includes('failed 3 times')))
        .toBe(true)
      expect(source.reports.some(report => report.health.detail.includes('gateway down'))).toBe(true)
      await vi.waitFor(() => expect(attempts).toBeGreaterThan(3))
    })
  }, 20_000)
  it('serves several instances on their own connections and reports each one separately', async () => {
    const bots: FakeBot[] = []
    const source = fakeSource([config(), config({ appId: 'app-2' })])
    await watching(source, { botFactory: factoryOf(bots), backoffMs: [1], reconcileSeconds: 0.05 }, async () => {
      await vi.waitFor(() => expect(lastHealth(source, 'qq:ops')).toMatchObject({ state: 'ready' }))
      await vi.waitFor(() => expect(lastHealth(source, 'qq:ops-1')).toMatchObject({ state: 'ready' }))
      expect(bots).toHaveLength(2)
    })
  }, 20_000)
  it('counts a message whose attachments cannot be downloaded in the health detail, without a Ticket', async () => {
    await withStateDir(async stateDir => {
      const bots: FakeBot[] = []
      const source = fakeSource([config()], { stateDir })
      const stub = responseStub(() => new Response('', { status: 503 }))
      await watching(source, { botFactory: factoryOf(bots), fetchImpl: stub.impl, backoffMs: [1], reconcileSeconds: 0.05 },
        async () => {
          await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'ready' }))
          bots[0]!.emit('message', undefined, rawInbound({ content: '', attachments: [{ url: 'https://gchat.qpic.cn/x' }] }))
          await vi.waitFor(() => expect(lastHealth(source)!.detail).toContain('skipped (attachment-download-failed 1)'))
          expect(source.receive).not.toHaveBeenCalled()
        })
    })
  }, 20_000)
  it('counts a reply file it cannot deliver in the instance\'s health detail', async () => {
    await withStateDir(async stateDir => {
      const bots: FakeBot[] = []
      const source = fakeSource([config()], { stateDir })
      const factory = (async () => {
        const bot = fakeBot({ mediaError: apiFailure(500) })
        bots.push(bot)
        return bot
      }) as QqBotFactory
      await watching(source, { botFactory: factory, backoffMs: [1], reconcileSeconds: 0.05 }, async () => {
        await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'ready' }))
        // The Channel sends through the live bot the watch loop registered; its file delivery fails there.
        const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
        const trigger = qqTrigger(message({ createdAt: new Date().toISOString() }), 'qq:ops', config())
        expect(await qqKind.channel!.send({ commands: qqKind.commands!(config(), commands) },
          { ...reply('Artifacts delivered', trigger.channel!.address),
            attachments: [await outboundFile(stateDir, 'report.md', 'done', 'text/markdown')] })).toBe('sent')
        // The next report names the file it could not deliver, without its path and without the AppSecret.
        bots[0]!.emit('message', undefined, rawInbound())
        await vi.waitFor(() => expect(lastHealth(source)!.detail).toContain('1 reply attachments could not be delivered'))
        expect(lastHealth(source)!.detail).not.toContain(stateDir)
        expect(lastHealth(source)!.detail).not.toContain('secret-1')
      })
    })
  }, 20_000)
  it('registers the kind and starts its loop from the plugin entry', async () => {
    const bots: FakeBot[] = []
    const source = fakeSource([config()])
    const registered: SourceKind[] = []
    const disposers: (() => unknown)[] = []
    const host = {
      orchestrator: {
        sources: { register: (kind: SourceKind) => { registered.push(kind); return (): void => {} } },
        context: () => source.ctx,
      },
      effect: (effect: () => () => unknown) => { disposers.push(effect()) },
    }
    apply(host as never, { botFactory: factoryOf(bots), backoffMs: [1], reconcileSeconds: 0.05 })
    expect(registered).toEqual([qqKind])
    await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'ready' }))
    for (const dispose of disposers.reverse()) await dispose()
  }, 20_000)
  it('reports a credential-free failure reason from the transport classification', () => {
    const failure = new QqApiError('auth', 'QQ answered HTTP 401', { status: 401, bizCode: 401 })
    expect(failure.code).toBe('auth')
    expect(new QqApiError('expired', 'The passive reply window closed').code).toBe('expired')
  })
})
