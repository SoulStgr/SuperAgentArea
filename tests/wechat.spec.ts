/**
 * The WeChat Source without WeChat: its configuration, Trigger translation (text and inbound pictures/files), the duplicate
 * set, Policy admission, the QR sign-in/poll loop over a fake `SourceContext` and fake iLink fetch, the attachment download
 * and storage over a fake `fetch` with a local AES fixture, and the reply path over the live credential.
 */
import { createCipheriv } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { key, threadKey, type OutboundMessage, type Thread, type Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { apply, rememberSeen, receiveWechat, watchWechat, wechatAttachmentDirectory, wechatKind, wechatTrigger,
  WEIXIN_SEEN_LIMIT, weixinCursor, weixinSeen, type WechatConfig, type WechatSavedAttachment,
  type WechatWatchOptions } from '../src/sources/wechat.ts'
import type { Health, SourceContext } from '../src/sources/host.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { clearWeixinLiveCredentials, liveWeixinCredential, normalizeWeixinInbound, registerWeixinCredential,
  splitWeixinText, WEIXIN_ATTACHMENT_BYTES, WEIXIN_ATTACHMENTS_PER_MESSAGE, WEIXIN_REPLY_CHARS, weixinClientId,
  type WeixinAttachmentRef, type WeixinMessage } from '../src/sources/im/weixin-transport.ts'
import { weixinToken, type WeixinCredential } from '../src/sources/im/weixin-login.ts'
import { testDeployment } from './fixtures/deployment.ts'

/** A validated configuration, as an operator saves it. */
const config = (overrides: Record<string, unknown> = {}): WechatConfig => wechatKind.schema.parse(overrides)
/** A signed-in credential record, as the QR sign-in writes it to KV. */
const credential = (overrides: Partial<WeixinCredential> = {}): WeixinCredential =>
  ({ token: 'bot-token-1', ilinkBotId: 'bot-1', at: '2026-11-26T00:00:00.000Z', ...overrides })
/** One normalized inbound message, a direct text message by default. */
const message = (overrides: Partial<WeixinMessage> = {}): WeixinMessage => ({ messageId: 'msg-1', clientId: 'client-1',
  text: 'please fix the typo', attachments: [], fromUserId: 'user-1', conversationKind: 'dm', addressed: true,
  contextToken: 'ctx-1', runId: 'run-1', createdAt: '2026-11-26T00:00:00.000Z', ...overrides })
/** One raw iLink message, as the fake fetch pushes it. */
const raw = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ message_id: 'msg-1',
  client_id: 'client-1', from_user_id: 'user-1', message_type: 1, context_token: 'ctx-1', run_id: 'run-1',
  create_time_ms: 1_764_115_200_000, item_list: [{ type: 1, text_item: { text: 'please fix the typo' } }], ...overrides })
const reply = (text: string, route: Record<string, string> = wechatTrigger(message(), 'wechat:ops').channel!.address): OutboundMessage =>
  ({ id: 'm-1', kind: 'reply', text, channel: { source: 'wechat:ops', thread: 'wechat:ops:user-1', address: route } })

/** The health reports one fake Source context received, in order. */
interface FakeSource { ctx: SourceContext; reports: { id: string; health: Health }[]; receive: ReturnType<typeof vi.fn>
  state: Map<string, unknown> }
function fakeSource(instances: { id: string; config: WechatConfig; enabled?: boolean }[],
  options: { configured?: boolean; stateDir?: string } = {}): FakeSource {
  const state = new Map<string, unknown>()
  const reports: { id: string; health: Health }[] = []
  const receive = vi.fn((_trigger: Trigger) => 'stored' as const)
  const stored = instances.map(item => ({ id: item.id, kind: 'wechat', enabled: item.enabled ?? true, config: item.config }))
  const ctx = {
    ready: Promise.resolve(),
    configured: () => options.configured ?? true,
    instances: () => stored,
    deployment: { stateDir: options.stateDir ?? join(tmpdir(), 'dsh-wechat-fake-state') },
    report: (id: string, health: Health) => { reports.push({ id, health }) },
    receive,
    threads: { describe: vi.fn() },
    state: {
      get: (name: string) => state.get(name),
      set: (name: string, value: unknown) => { if (value === undefined) state.delete(name); else state.set(name, value) },
      keys: () => [],
    },
  } as unknown as SourceContext
  return { ctx, reports, receive, state }
}
/** The AES-128 key and fixture iLink encrypts an inbound attachment with; the tests use it locally, never a network. */
const AES_KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
/** Encrypts bytes as iLink does: AES-128-ECB with PKCS#7 padding, so the ciphertext is whole blocks. */
function encryptAttachment(data: string | Buffer, key = AES_KEY): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()])
}
const base64Key = (key = AES_KEY): string => key.toString('base64')
/** One attachment reference the fake CDN answers with; a picture fetched by its encrypted query parameter. */
const ref = (overrides: Partial<WeixinAttachmentRef> = {}): WeixinAttachmentRef => ({ kind: 'image',
  media: { encryptQueryParam: 'encrypted-query', fullUrl: '', aesKey: '', aeskey: AES_KEY.toString('hex') }, name: '', bytes: 0,
  ...overrides })
/** One image_item or file_item as iLink pushes it on a raw message. */
const mediaItem = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  aeskey: AES_KEY.toString('hex'), media: { encrypt_query_param: 'encrypted-query' }, ...overrides })
/** One recorded attachment-download call: its URL, HTTP method and redirect mode. */
interface DownloadCall { url: string; method: string; redirect: RequestRedirect | undefined }
/** A fake `fetch` answering whole `Response` objects; `'network'` is a socket-level failure. */
function downloadStub(handler: (call: DownloadCall) => Response | 'network'): { impl: typeof fetch; calls: DownloadCall[] } {
  const calls: DownloadCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: DownloadCall = { url: String(input), method: init?.method ?? 'GET', redirect: init?.redirect }
    calls.push(call)
    const answer = handler(call)
    if (answer === 'network') throw new TypeError('fetch failed')
    return answer
  }) as unknown as typeof fetch
  return { impl, calls }
}
/** A binary answer carrying already-encrypted bytes, so the Source's transport must decrypt it. */
const encryptedResponse = (data: string | Buffer, type?: string, key = AES_KEY): Response =>
  new Response(new Uint8Array(encryptAttachment(data, key)),
    { status: 200, ...type ? { headers: { 'content-type': type } } : {} })
/** Runs one case with a fresh state directory, removed afterwards. */
async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-wechat-'))
  try { await run(stateDir) } finally { await rm(stateDir, { recursive: true, force: true }) }
}
/** A Source context that records the Triggers it receives and names one state directory for attachment downloads. */
function attachmentSource(stateDir: string): { ctx: SourceContext; received: Trigger[]; receive: ReturnType<typeof vi.fn> } {
  const received: Trigger[] = []
  const receive = vi.fn((trigger: Trigger) => { received.push(trigger); return 'stored' as const })
  const state = new Map<string, unknown>()
  const ctx = { deployment: { stateDir }, receive, state: {
    get: (name: string) => state.get(name),
    set: (name: string, value: unknown) => { if (value === undefined) state.delete(name); else state.set(name, value) },
  }, threads: { describe: vi.fn() } } as unknown as SourceContext
  return { ctx, received, receive }
}
/** The attachments a Trigger carries for its worker. */
const savedOf = (trigger: Trigger): WechatSavedAttachment[] => trigger.meta.attachments as WechatSavedAttachment[]
/** A fake fetch for one watch loop: update polls from the script, every attachment download answers the given response. */
function mixedFetch(batches: unknown[][], downloadAnswer: () => Response = () => new Response('', { status: 503 })):
  { fetchImpl: typeof fetch; downloads: string[] } {
  const updates = updatesFetch(batches)
  const downloads: string[] = []
  const fetchImpl = (async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.startsWith('https://novac2c.cdn.weixin.qq.com/')) { downloads.push(url); return downloadAnswer() }
    return updates.fetchImpl(input, init)
  }) as typeof fetch
  return { fetchImpl, downloads }
}
const lastHealth = (source: FakeSource, id = 'wechat'): Health | undefined =>
  source.reports.filter(report => report.id === id).at(-1)?.health
/** Runs one watch loop and always stops it, also when an assertion fails. */
async function watching(source: FakeSource, options: WechatWatchOptions, run: () => Promise<void>): Promise<void> {
  const controller = new AbortController()
  const running = watchWechat(source.ctx, controller.signal, options)
  try { await run() } finally { controller.abort(); await running }
}
interface UpdateFetch { fetchImpl: typeof fetch; calls: { body: unknown }[] }
/**
 * A fake iLink update endpoint: each call answers the next scripted batch, and once the script is spent it waits like the
 * real long poll until the request is aborted, which this transport reads as "no messages yet".
 */
function updatesFetch(batches: unknown[][]): UpdateFetch {
  const calls: { body: unknown }[] = []
  let index = 0
  const fetchImpl = (async (_url: URL | string, init?: RequestInit): Promise<Response> => {
    calls.push({ body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined })
    const batch = batches[index]
    index += 1
    if (!batch) {
      await new Promise<never>((_resolve, reject) => {
        const signal = init?.signal
        const fail = (): void => reject(new DOMException('The operation was aborted', 'AbortError'))
        if (signal?.aborted) { fail(); return }
        signal?.addEventListener('abort', fail, { once: true })
      })
    }
    return new Response(JSON.stringify({ ret: 0, msgs: batch, get_updates_buf: `cursor-${index - 1}` }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetchImpl, calls }
}

beforeEach(() => { clearWeixinLiveCredentials() })
afterEach(() => { vi.unstubAllGlobals() })

describe('configuration', () => {
  it('validates one bot type and refuses an unknown key or a non-numeric type', () => {
    expect(wechatKind.schema.parse({})).toEqual({ botType: '3' })
    expect(config({ botType: '7' }).botType).toBe('7')
    expect(() => config({ botType: 'abc' })).toThrow()
    expect(() => wechatKind.schema.parse({ appId: 'a', appSecret: 'b' })).toThrow()
    // The kind is a real one: order 6, one health entry, a Channel and a Policy, and no placeholder mark.
    expect(wechatKind).toMatchObject({ kind: 'wechat', order: 6, health: ['wechat'] })
    expect(wechatKind.placeholder).toBeUndefined()
    expect(wechatKind.channel).toBeDefined()
    expect(wechatKind.policy?.explicit.en).toBeTruthy()
    for (const field of wechatKind.fields) expect(field.label.zh && field.label.en, field.key).toBeTruthy()
  })
  it('scopes a Trigger to a direct message and names the account\'s one receiving row', () => {
    expect(wechatKind.scope!({ meta: { conversationKind: 'dm', addressed: true }, instance: 'wechat:ops' }, config()))
      .toEqual({ listened: true, observed: false, row: 'direct' })
    expect(wechatKind.scope!({ meta: { conversationKind: 'group', addressed: true }, instance: 'wechat:ops' }, config()))
      .toEqual({ listened: false, reason: 'group_not_supported' })
    expect(wechatKind.scope!({ meta: {}, instance: 'wechat:ops' }, config()))
      .toEqual({ listened: false, reason: 'group_not_supported' })
    expect(wechatKind.policy!.rows!({}, 'wechat:ops').map(row => row.id)).toEqual(['direct'])
    expect(wechatKind.channel!.allowed!(wechatTrigger(message(), 'wechat:ops').channel!.address, config())).toBe(true)
    expect(wechatKind.channel!.allowed!({ row: 'wechat:ops' }, config())).toBe(false)
    expect(wechatKind.channel!.link!(wechatTrigger(message(), 'wechat:ops').channel!.address, {}).label.zh).toContain('微信会话')
  })
})

describe('triggers', () => {
  it('names the message, the sender\'s direct thread and the reply route, and carries no token', () => {
    const trigger = wechatTrigger(message(), 'wechat:ops')
    expect(trigger).toMatchObject({ id: key('wechat', 'wechat:ops', 'msg-1'), source: 'wechat:ops',
      threads: [{ source: 'wechat:ops', id: 'user-1' }], actor: { source: 'wechat:ops', id: 'user-1' }, human: true,
      addressed: 'direct', at: '2026-11-26T00:00:00.000Z', text: 'please fix the typo' })
    expect(threadKey(trigger.threads[0]!)).toBe('wechat:ops:user-1')
    expect(trigger.channel).toMatchObject({ source: 'wechat:ops', thread: 'wechat:ops:user-1', address: {
      row: 'wechat:ops', fromUserId: 'user-1', messageId: 'msg-1', clientId: 'client-1', contextToken: 'ctx-1' } })
    expect(trigger.meta).toMatchObject({ row: 'wechat:ops', conversationKind: 'dm', addressed: true, fromUserId: 'user-1',
      messageId: 'msg-1', clientId: 'client-1', contextToken: 'ctx-1' })
    // The credential never reaches a Trigger: only the conversation ids and the message ids travel with it.
    expect(JSON.stringify(trigger)).not.toContain('bot-token-1')
    expect(JSON.stringify(trigger)).not.toContain('token":"')
    // A message without a time falls back to the receipt time.
    expect(wechatTrigger(message({ createdAt: '' }), 'wechat:ops').at).toEqual(expect.any(String))
  })
  it('receives one message once, keeps a redelivered id a duplicate, and passes a filtered receipt through', async () => {
    const received: Trigger[] = []
    const receive = vi.fn((trigger: Trigger) => { received.push(trigger); return 'stored' as const })
    const state = new Map<string, unknown>()
    const ctx = { receive, threads: { describe: vi.fn() }, state: {
      get: (name: string) => state.get(name),
      set: (name: string, value: unknown) => { state.set(name, value) },
    } } as unknown as SourceContext
    expect(await receiveWechat(ctx, 'wechat:ops', message())).toBe('received')
    expect(await receiveWechat(ctx, 'wechat:ops', message())).toBe('duplicate')
    expect(receive).toHaveBeenCalledTimes(1)
    expect(state.get(weixinSeen('wechat:ops'))).toMatchObject({ 'msg-1': expect.any(Number) })
    expect(ctx.threads.describe).toHaveBeenCalledWith('wechat:ops:user-1', expect.any(Object))
    // A second message is new work; an Engine that filters it reports that rather than a receipt.
    const filtering = vi.fn(() => 'filtered' as const)
    const filtered = { receive: filtering, threads: { describe: vi.fn() }, state: {
      get: () => undefined, set: () => {} } } as unknown as SourceContext
    expect(await receiveWechat(filtered, 'wechat:ops', message({ messageId: 'msg-9' }))).toBe('filtered')
  })
  it('forgets duplicate ids after seven days and keeps the newest ones under the size cap', () => {
    const seen = rememberSeen({ old: Date.now() - 8 * 24 * 60 * 60_000, recent: Date.now() }, 'new', Date.now())
    expect(seen).toMatchObject({ recent: expect.any(Number), new: expect.any(Number) })
    expect(seen.old).toBeUndefined()
    const many = Object.fromEntries(Array.from({ length: WEIXIN_SEEN_LIMIT + 5 },
      (_value, index) => [`m${index}`, Date.now() - index]))
    const capped = rememberSeen(many, 'newest', Date.now())
    expect(Object.keys(capped)).toHaveLength(WEIXIN_SEEN_LIMIT)
    expect(capped.newest).toBeDefined()
  })
  it('lets only the Policy\'s allowed WeChat users originate work', () => {
    const settings = SettingsSchema.parse({ sources: { 'wechat:ops': { kind: 'wechat', enabled: true, config: {} } },
      policy: { sources: { 'wechat:ops': { allowed: [{ id: 'user-1' }] } } } })
    const sources = new SourceRegistry(() => settings)
    sources.register(wechatKind)
    const policy = settingsPolicy(settings, sources)
    const thread: Thread = { key: 'wechat:ops:user-1', ref: { source: 'wechat:ops', id: 'user-1' }, createdAt: '',
      subscriptions: [], correlated: [], pending: [], meta: {} }
    expect(policy.gate(wechatTrigger(message(), 'wechat:ops'), thread, [])).toMatchObject({ admissible: true,
      strength: 'explicit', basis: { via: 'addressed', sender: 'user-1', addressed: 'direct', row: 'direct' } })
    expect(policy.gate(wechatTrigger(message({ fromUserId: 'user-2' }), 'wechat:ops'), thread, []))
      .toEqual({ admissible: false, reason: 'not_a_member' })
    // A group message never reaches the gate: the Source's own scope filters it before intake.
    expect(sources.scope({ source: 'wechat:ops', meta: { conversationKind: 'group', addressed: true } }))
      .toEqual({ listened: false, reason: 'group_not_supported' })
  })
})

describe('inbound attachments', () => {
  it('saves an inbound picture under the state directory and names its absolute path in the Trigger', async () => {
    await withStateDir(async stateDir => {
      const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5])
      const stub = downloadStub(() => encryptedResponse(image, 'image/png'))
      const source = attachmentSource(stateDir)
      expect(await receiveWechat(source.ctx, 'wechat:ops', message({ text: '', attachments: [ref()] }),
        { fetchImpl: stub.impl })).toBe('received')
      expect(source.receive).toHaveBeenCalledTimes(1)
      const trigger = source.received[0]!
      const attachment = savedOf(trigger)[0]!
      expect(attachment).toMatchObject({ kind: 'image', name: 'image.png', mime: 'image/png', bytes: image.byteLength })
      expect(attachment.path).toBe(join(wechatAttachmentDirectory(stateDir, 'wechat:ops', 'msg-1'), 'image.png'))
      expect(relative(stateDir, attachment.path).startsWith('..')).toBe(false)
      expect(await readFile(attachment.path)).toEqual(image)
      // A message with no text is work: its Trigger names the one saved file, and the reply route is unchanged.
      expect(trigger.text).toBe(`收到图片/文件：${attachment.path}`)
      expect(trigger.channel!.address).toMatchObject({ fromUserId: 'user-1', messageId: 'msg-1', contextToken: 'ctx-1' })
      // The signed address alone is fetched, as a GET that never follows a redirect.
      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0]).toMatchObject({ method: 'GET', redirect: 'error' })
      expect(stub.calls[0]!.url).toContain('encrypted_query_param=encrypted-query')
      // The signed query string and the AES key never reach the Trigger or its meta.
      expect(JSON.stringify(trigger)).not.toContain('encrypted-query')
      expect(JSON.stringify(trigger)).not.toContain(AES_KEY.toString('hex'))
      expect((await stat(attachment.path)).isFile()).toBe(true)
      // The other key encoding iLink uses, media.aes_key base64, decrypts the same fixture through the Source too.
      expect(await receiveWechat(source.ctx, 'wechat:ops', message({ messageId: 'msg-2', text: '',
        attachments: [ref({ media: { encryptQueryParam: 'encrypted-query', fullUrl: '', aesKey: base64Key(), aeskey: '' } })] }),
      { fetchImpl: stub.impl })).toBe('received')
      expect(await readFile(savedOf(source.received[1]!)[0]!.path)).toEqual(image)
    })
  })
  it('names a picture from its decrypted bytes, sanitizes a file path and keeps its display name', async () => {
    await withStateDir(async stateDir => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
      const stub = downloadStub(call => call.url.includes('second')
        ? encryptedResponse('%PDF-1.4', 'application/pdf')
        : encryptedResponse(png, 'application/octet-stream'))
      const source = attachmentSource(stateDir)
      // The picture's MIME type comes from its bytes, not from the answer or a file name.
      expect(await receiveWechat(source.ctx, 'wechat:ops', message({ text: 'see it', attachments: [ref()] }),
        { fetchImpl: stub.impl })).toBe('received')
      expect(await receiveWechat(source.ctx, 'wechat:ops', message({ messageId: 'msg-2', text: '',
        attachments: [ref({ kind: 'file', name: '../../etc/报告.pdf',
          media: { encryptQueryParam: 'second', fullUrl: '', aesKey: '', aeskey: AES_KEY.toString('hex') } })] }),
      { fetchImpl: stub.impl })).toBe('received')
      expect(await receiveWechat(source.ctx, 'wechat:ops', message({ messageId: 'msg-3', text: '',
        attachments: [ref({ kind: 'file', name: '../../etc/passwd',
          media: { encryptQueryParam: 'second', fullUrl: '', aesKey: '', aeskey: AES_KEY.toString('hex') } })] }),
      { fetchImpl: stub.impl })).toBe('received')
      expect(savedOf(source.received[0]!)[0]).toMatchObject({ name: 'image.png', mime: 'image/png' })
      // A provider name is never a path: its base name is sanitized for disk and its display name stays readable.
      const file = savedOf(source.received[1]!)[0]!
      expect(file).toMatchObject({ kind: 'file', name: '报告.pdf', mime: 'application/pdf',
        bytes: Buffer.byteLength('%PDF-1.4') })
      expect(relative(wechatAttachmentDirectory(stateDir, 'wechat:ops', 'msg-2'), file.path)).toBe('file-msg-2.pdf')
      expect(await readFile(file.path, 'utf8')).toBe('%PDF-1.4')
      expect(savedOf(source.received[2]!)[0]).toMatchObject({ kind: 'file', name: 'passwd', mime: 'application/pdf' })
      expect(relative(wechatAttachmentDirectory(stateDir, 'wechat:ops', 'msg-3'), savedOf(source.received[2]!)[0]!.path))
        .toBe('passwd')
    })
  })
  it('lists the original text and every attachment of a message, numbering a clashing file name', async () => {
    await withStateDir(async stateDir => {
      const stub = downloadStub(() => encryptedResponse('png-bytes', 'image/png'))
      const source = attachmentSource(stateDir)
      const mediaKey = AES_KEY.toString('hex')
      const attachments = [
        ref({ media: { encryptQueryParam: 'first', fullUrl: '', aesKey: '', aeskey: mediaKey } }),
        ref({ media: { encryptQueryParam: 'second', fullUrl: '', aesKey: '', aeskey: mediaKey } }),
      ]
      expect(await receiveWechat(source.ctx, 'wechat:ops', message({ text: 'see the two pictures', attachments }),
        { fetchImpl: stub.impl })).toBe('received')
      const trigger = source.received[0]!
      const saved = savedOf(trigger)
      // Both are PNGs, so the second file keeps the same base name with a sequence number.
      expect(saved.map(attachment => attachment.name)).toEqual(['image.png', 'image-1.png'])
      expect(await readFile(saved[0]!.path, 'utf8')).toBe('png-bytes')
      expect(await readFile(saved[1]!.path, 'utf8')).toBe('png-bytes')
      expect(trigger.text).toBe(`see the two pictures\n附件：${saved[0]!.path}（image/image/png）\n附件：${saved[1]!.path}（image/image/png）`)
      expect(trigger.meta.attachments).toEqual(saved)
      // The reply route keeps the conversation ids the inbound message carried.
      expect(trigger.channel!.address).toMatchObject({ row: 'wechat:ops', fromUserId: 'user-1', messageId: 'msg-1' })
    })
  })
  it('receives a text message as before, without an attachment directory', async () => {
    await withStateDir(async stateDir => {
      const source = attachmentSource(stateDir)
      expect(await receiveWechat(source.ctx, 'wechat:ops', message())).toBe('received')
      expect(source.received[0]!.text).toBe('please fix the typo')
      expect(source.received[0]!.meta.attachments).toBeUndefined()
      await expect(stat(join(stateDir, 'area'))).rejects.toThrow()
    })
  })
  it('skips a message with more than five attachments instead of receiving part of it', async () => {
    await withStateDir(async stateDir => {
      const stub = downloadStub(() => encryptedResponse('x', 'image/png'))
      const source = attachmentSource(stateDir)
      const attachments = Array.from({ length: WEIXIN_ATTACHMENTS_PER_MESSAGE + 1 }, () => ref())
      expect(await receiveWechat(source.ctx, 'wechat:ops', message({ text: '', attachments }), { fetchImpl: stub.impl }))
        .toBe('attachment-count')
      expect(source.receive).not.toHaveBeenCalled()
      expect(stub.calls).toEqual([])
      await expect(stat(wechatAttachmentDirectory(stateDir, 'wechat:ops', 'msg-1'))).rejects.toThrow()
    })
  })
  it('never fetches an attachment outside the WeChat CDN', async () => {
    await withStateDir(async stateDir => {
      for (const [index, url] of ['http://novac2c.cdn.weixin.qq.com/c2c/x', 'https://evil.example/c2c/x',
        'https://novac2c.cdn.weixin.qq.com.evil.example/c2c/x', 'https://127.0.0.1/c2c/x'].entries()) {
        const stub = downloadStub(() => encryptedResponse('x', 'image/png'))
        const source = attachmentSource(stateDir)
        expect(await receiveWechat(source.ctx, 'wechat:ops', message({ messageId: `msg-evil-${index}`, text: '',
          attachments: [ref({ media: { encryptQueryParam: '', fullUrl: url, aesKey: '', aeskey: AES_KEY.toString('hex') } })] }),
        { fetchImpl: stub.impl })).toBe('attachment-untrusted')
        expect(source.receive).not.toHaveBeenCalled()
        expect(stub.calls).toEqual([])
        await expect(stat(wechatAttachmentDirectory(stateDir, 'wechat:ops', `msg-evil-${index}`))).rejects.toThrow()
      }
    })
  })
  it('refuses a redirected download and keeps no partial directory when a download fails', async () => {
    await withStateDir(async stateDir => {
      const redirected = downloadStub(() => 'network')
      const first = attachmentSource(stateDir)
      expect(await receiveWechat(first.ctx, 'wechat:ops', message({ text: '', attachments: [ref()] }),
        { fetchImpl: redirected.impl })).toBe('attachment-download-failed')
      expect(first.receive).not.toHaveBeenCalled()
      expect(redirected.calls[0]).toMatchObject({ method: 'GET', redirect: 'error' })
      await expect(stat(wechatAttachmentDirectory(stateDir, 'wechat:ops', 'msg-1'))).rejects.toThrow()
      const failed = downloadStub(() => new Response('', { status: 503 }))
      const second = attachmentSource(stateDir)
      expect(await receiveWechat(second.ctx, 'wechat:ops', message({ messageId: 'msg-2', text: '', attachments: [ref()] }),
        { fetchImpl: failed.impl })).toBe('attachment-download-failed')
      expect(second.receive).not.toHaveBeenCalled()
      await expect(stat(wechatAttachmentDirectory(stateDir, 'wechat:ops', 'msg-2'))).rejects.toThrow()
    })
  })
  it('refuses a streamed body over 20 MiB and a file whose declared size already exceeds it', async () => {
    await withStateDir(async stateDir => {
      const huge = downloadStub(() => new Response(new Uint8Array(WEIXIN_ATTACHMENT_BYTES + 17)))
      const source = attachmentSource(stateDir)
      expect(await receiveWechat(source.ctx, 'wechat:ops',
        message({ text: '', attachments: [ref({ kind: 'file', name: 'big.bin' })] }), { fetchImpl: huge.impl }))
        .toBe('attachment-too-large')
      expect(source.receive).not.toHaveBeenCalled()
      const declared = downloadStub(() => encryptedResponse('x', 'application/pdf'))
      expect(await receiveWechat(source.ctx, 'wechat:ops', message({ messageId: 'msg-2', text: '',
        attachments: [ref({ kind: 'file', name: 'big.bin', bytes: WEIXIN_ATTACHMENT_BYTES + 1 })] }),
      { fetchImpl: declared.impl })).toBe('attachment-too-large')
      expect(declared.calls).toEqual([])
      await expect(stat(wechatAttachmentDirectory(stateDir, 'wechat:ops', 'msg-1'))).rejects.toThrow()
    })
  })
  it('skips a message whose key is invalid or whose body does not decrypt', async () => {
    await withStateDir(async stateDir => {
      const noKey = attachmentSource(stateDir)
      expect(await receiveWechat(noKey.ctx, 'wechat:ops', message({ text: '', attachments: [
        ref({ media: { encryptQueryParam: 'encrypted-query', fullUrl: '', aesKey: '', aeskey: '' } })] })))
        .toBe('attachment-key')
      expect(noKey.receive).not.toHaveBeenCalled()
      const broken = downloadStub(() => new Response('not-an-aes-block'))
      const undecryptable = attachmentSource(stateDir)
      expect(await receiveWechat(undecryptable.ctx, 'wechat:ops', message({ messageId: 'msg-2', text: '',
        attachments: [ref()] }), { fetchImpl: broken.impl })).toBe('attachment-decrypt')
      expect(undecryptable.receive).not.toHaveBeenCalled()
      await expect(stat(wechatAttachmentDirectory(stateDir, 'wechat:ops', 'msg-2'))).rejects.toThrow()
    })
  })
})

describe('the sign-in and poll loop', () => {
  it('waits for setup and reports paused with the missing sign-in, and a disabled instance as off', async () => {
    const source = fakeSource([{ id: 'wechat', config: config() }], { configured: false })
    await watchWechat(source.ctx, new AbortController().signal, {})
    expect(lastHealth(source)).toMatchObject({ state: 'paused', code: 'setupPending' })
    const unset = fakeSource([{ id: 'wechat', config: config() }])
    await watching(unset, { fetchImpl: updatesFetch([]).fetchImpl, pollTimeoutMs: 5, reconcileSeconds: 0.02 }, async () => {
      await vi.waitFor(() => expect(lastHealth(unset)).toMatchObject({ state: 'paused', code: 'wechatLogin' }))
      expect(lastHealth(unset)!.detail).toBe('Needs a WeChat QR sign-in')
    })
    const disabled = fakeSource([{ id: 'wechat', config: config(), enabled: false }])
    disabled.state.set(weixinToken('wechat'), credential())
    await watching(disabled, { fetchImpl: updatesFetch([]).fetchImpl, pollTimeoutMs: 5, reconcileSeconds: 0.02 }, async () => {
      await vi.waitFor(() => expect(lastHealth(disabled)).toMatchObject({ state: 'paused', code: 'sourceOff' }))
    })
  })
  it('polls the signed-in instance, receives direct messages and skips groups, its own messages and empty ones', async () => {
    const source = fakeSource([{ id: 'wechat', config: config() }])
    source.state.set(weixinToken('wechat'), credential())
    const updates = updatesFetch([[
      raw(),
      raw({ message_id: 'msg-2', from_user_id: 'user-2' }),
      raw({ message_id: 'msg-3', chatroom_id: 'room-1' }),
      raw({ message_id: 'msg-4', message_type: 2 }),
      // An image item whose key and address this client cannot read: the message becomes work, then a counted skip.
      raw({ message_id: 'msg-5', item_list: [{ type: 2, image_item: {} }] }),
      raw({ message_id: 'msg-6', item_list: [{ type: 5, video_item: {} }] }),
    ]])
    await watching(source, { fetchImpl: updates.fetchImpl, pollTimeoutMs: 5, reconcileSeconds: 0.02 }, async () => {
      await vi.waitFor(() => expect(source.receive).toHaveBeenCalledTimes(2))
      expect(source.receive.mock.calls.map(([trigger]) => (trigger as Trigger).actor.id)).toEqual(['user-1', 'user-2'])
      await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'ready' }))
      expect(lastHealth(source)!.detail)
        .toBe('Connected to WeChat; 2 messages received; 4 skipped (attachment-key 1, group 1, non-text 1, self 1)')
      // The cursor is kept for the next run of the instance, and the token appears in no health detail.
      expect(source.state.get(weixinCursor('wechat'))).toBe('cursor-0')
      expect(JSON.stringify(source.reports)).not.toContain('bot-token-1')
      expect(updates.calls[0]!.body).toMatchObject({ get_updates_buf: '' })
    })
  })
  it('counts a message whose attachment download fails in the health detail, without a Ticket', async () => {
    await withStateDir(async stateDir => {
      const source = fakeSource([{ id: 'wechat', config: config() }], { stateDir })
      source.state.set(weixinToken('wechat'), credential())
      const mixed = mixedFetch([[raw({ item_list: [{ type: 2, image_item: mediaItem() }] })]])
      await watching(source, { fetchImpl: mixed.fetchImpl, pollTimeoutMs: 5, reconcileSeconds: 0.02 }, async () => {
        await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'ready' }))
        await vi.waitFor(() => expect(lastHealth(source)!.detail).toContain('skipped (attachment-download-failed 1)'))
        expect(source.receive).not.toHaveBeenCalled()
        expect(mixed.downloads).toHaveLength(1)
      })
    })
  })
  it('counts a message the duplicate set already holds instead of receiving it again', async () => {
    const source = fakeSource([{ id: 'wechat', config: config() }])
    source.state.set(weixinToken('wechat'), credential())
    source.state.set(weixinSeen('wechat'), { 'msg-1': Date.now() })
    const updates = updatesFetch([[raw()]])
    await watching(source, { fetchImpl: updates.fetchImpl, pollTimeoutMs: 5, reconcileSeconds: 0.02 }, async () => {
      await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'ready' }))
      expect(source.receive).not.toHaveBeenCalled()
      expect(lastHealth(source)!.detail).toContain('1 duplicate messages')
    })
  })
  it('reports an expired sign-in as an error and stops polling until a new sign-in restarts the instance', async () => {
    const source = fakeSource([{ id: 'wechat', config: config() }])
    source.state.set(weixinToken('wechat'), credential())
    const stale = (async () => new Response(JSON.stringify({ ret: -14 }), { status: 200 })) as typeof fetch
    await watching(source, { fetchImpl: stale, pollTimeoutMs: 5, reconcileSeconds: 0.02 }, async () => {
      await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'error', code: 'wechatSignInExpired' }))
      expect(lastHealth(source)!.detail).toBe('The WeChat sign-in expired; sign in again')
    })
  })
  it('reports an error only after three consecutive failed polls, and keeps retrying', async () => {
    const source = fakeSource([{ id: 'wechat', config: config() }])
    source.state.set(weixinToken('wechat'), credential())
    let attempts = 0
    const failing = (async () => { attempts += 1; throw new Error('socket closed') }) as typeof fetch
    await watching(source, { fetchImpl: failing, backoffMs: [1], reconcileSeconds: 0.02 }, async () => {
      await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'error' }))
      expect(source.reports.some(report => report.health.detail.includes('failed 3 times'))).toBe(true)
      expect(source.reports.some(report => report.health.detail.includes('WeChat could not be reached'))).toBe(true)
      await vi.waitFor(() => expect(attempts).toBeGreaterThan(3))
    })
  })
  it('registers the kind and starts its loop from the plugin entry', async () => {
    const source = fakeSource([{ id: 'wechat', config: config() }])
    source.state.set(weixinToken('wechat'), credential())
    const updates = updatesFetch([[raw()]])
    const registered: SourceKind[] = []
    const disposers: (() => unknown)[] = []
    const host = {
      orchestrator: {
        sources: { register: (kind: SourceKind) => { registered.push(kind); return (): void => {} } },
        context: () => source.ctx,
      },
      effect: (effect: () => () => unknown) => { disposers.push(effect()) },
    }
    apply(host as never, { fetchImpl: updates.fetchImpl, pollTimeoutMs: 5, reconcileSeconds: 0.02 })
    expect(registered).toEqual([wechatKind])
    await vi.waitFor(() => expect(source.receive).toHaveBeenCalledTimes(1))
    for (const dispose of disposers.reverse()) await dispose()
    expect(liveWeixinCredential('wechat')).toBeUndefined()
  })
})

describe('replies', () => {
  /** A fake iLink send endpoint: answers with the given status and body, and records the request bodies. */
  function sendFetch(answer: { status?: number; body: unknown } = { body: { ret: 0 } }): { fetchImpl: typeof fetch
    calls: { url: string; body: unknown }[] } {
    const calls: { url: string; body: unknown }[] = []
    const fetchImpl = (async (input: URL | string, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined })
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { fetchImpl, calls }
  }
  it('sends through the live credential with the recipient, the conversation token and the run id, split at 1,800 characters', async () => {
    registerWeixinCredential('wechat:ops', 'bot-token-1')
    const { fetchImpl, calls } = sendFetch()
    vi.stubGlobal('fetch', fetchImpl)
    const trigger = wechatTrigger(message(), 'wechat:ops')
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const scoped = wechatKind.commands!(config(), commands)
    const long = `${'a'.repeat(WEIXIN_REPLY_CHARS)}\n${'b'.repeat(60)}`
    expect(await wechatKind.channel!.send({ commands: scoped }, reply(long, trigger.channel!.address))).toBe('sent')
    expect(calls).toHaveLength(2)
    const first = calls[0]!.body as { msg: Record<string, unknown> }
    expect(first.msg).toMatchObject({ from_user_id: '', to_user_id: 'user-1', message_type: 2, message_state: 2,
      context_token: 'ctx-1', run_id: 'msg-1', item_list: [{ type: 1, text_item: { text: 'a'.repeat(WEIXIN_REPLY_CHARS) } }] })
    expect(first.msg.client_id).toBe(weixinClientId('m-1', 0))
    expect(calls[1]!.body).toMatchObject({ msg: { client_id: weixinClientId('m-1', 1) } })
    expect(splitWeixinText(long)).toHaveLength(2)
  })
  it('retries a failed reply rather than dropping it, and drops a route that can never receive', async () => {
    registerWeixinCredential('wechat:ops', 'bot-token-1')
    const trigger = wechatTrigger(message(), 'wechat:ops')
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const scoped = wechatKind.commands!(config(), commands)
    vi.stubGlobal('fetch', sendFetch({ status: 500, body: {} }).fetchImpl)
    await expect(wechatKind.channel!.send({ commands: scoped }, reply('Done.', trigger.channel!.address)))
      .rejects.toMatchObject({ code: 'network' })
    vi.stubGlobal('fetch', sendFetch({ status: 401, body: {} }).fetchImpl)
    await expect(wechatKind.channel!.send({ commands: scoped }, reply('Done.', trigger.channel!.address)))
      .rejects.toMatchObject({ code: 'auth' })
    vi.stubGlobal('fetch', sendFetch({ body: { ret: 7 } }).fetchImpl)
    await expect(wechatKind.channel!.send({ commands: scoped }, reply('Done.', trigger.channel!.address)))
      .rejects.toMatchObject({ code: 'rejected' })
    // A route without its sender is gone; an unscoped Commands is refused; a signed-out instance waits for the Outbox.
    expect(await wechatKind.channel!.send({ commands: scoped }, reply('Done.', { row: 'wechat:ops' }))).toBe('gone')
    await expect(wechatKind.channel!.send({ commands }, reply('Done.'))).rejects.toThrow('no configuration')
    clearWeixinLiveCredentials()
    await expect(wechatKind.channel!.send({ commands: scoped }, reply('Done.', trigger.channel!.address)))
      .rejects.toThrow('not signed in')
  })
  it('turns an inbound iLink message into the same Trigger shape the loop hands over', () => {
    const inbound = normalizeWeixinInbound(raw())
    if (!('message' in inbound)) throw new Error('expected a message')
    expect(wechatTrigger(inbound.message, 'wechat:ops')).toMatchObject({ id: key('wechat', 'wechat:ops', 'msg-1'),
      threads: [{ source: 'wechat:ops', id: 'user-1' }], text: 'please fix the typo' })
  })
})
