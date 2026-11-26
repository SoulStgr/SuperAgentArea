/**
 * The DingTalk Source without DingTalk: message normalization, the token cache, the two reply transports over a fake
 * `fetch`, the Stream connection over a fake client, and the watch loop's health over a fake `SourceContext`. Nothing here
 * opens a socket or calls api.dingtalk.com.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { key, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { apply, dingtalkKind, dingtalkTrigger, receiveDingtalk, watchDingtalk, type DingtalkConfig,
  type DingtalkWatchOptions } from '../src/sources/dingtalk.ts'
import type { Health, SourceContext } from '../src/sources/host.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { clearDingtalkTokens, dingtalkAccessToken, dingtalkFailureText, DingtalkApiError, DingtalkConnection,
  DINGTALK_REPLY_CHARS, DINGTALK_TOPIC_ROBOT, DingtalkStreamError, normalizeDingtalkCallback, replyTargetOf,
  sendDingtalkReply, splitDingtalkText, webhookExpired, type DingtalkMessage, type DingtalkReplyTarget, type DingtalkSkipEvent,
  type DingtalkStream, type DingtalkStreamClient, type DingtalkStreamEnvelope, type DingtalkStreamFactory } from '../src/sources/im/dingtalk-transport.ts'
import { testDeployment } from './fixtures/deployment.ts'

const WEBHOOK = 'https://oapi.dingtalk.com/robot/sendBySession?session=abc'
const credentials = { clientId: 'client-1', clientSecret: 'secret-1' }
/** A validated configuration with every credential filled, as an operator would save it. */
const config = (overrides: Record<string, unknown> = {}): DingtalkConfig => dingtalkKind.schema.parse({
  clientId: 'client-1', clientSecret: 'secret-1', robotCode: 'robot-1', ...overrides })
const future = (): string => new Date(Date.now() + 3_600_000).toISOString()
const past = (): string => new Date(Date.now() - 3_600_000).toISOString()
/** One normalized message, a group mention by default. */
const message = (overrides: Partial<DingtalkMessage> = {}): DingtalkMessage => ({ messageId: 'msg-1', text: 'please fix the typo',
  senderStaffId: 'staff-1', senderNick: 'Alice', conversationId: 'cid-1', conversationType: 'group', conversationTitle: 'Ops',
  addressed: true, sessionWebhook: WEBHOOK, sessionWebhookExpiresAt: future(), robotCode: 'robot-1',
  openConversationId: 'cid-1', createdAt: '2026-11-26T00:00:00.000Z', ...overrides })
/** One raw Stream callback payload, a group mention by default; tests change one field to exercise a skip. */
const callback = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ msgId: 'msg-1', senderStaffId: 'staff-1',
  senderId: 'sender-1', senderNick: 'Alice', chatbotUserId: 'bot-user', conversationId: 'cid-1', conversationType: '2',
  conversationTitle: 'Ops', msgtype: 'text', text: { content: 'please fix the typo' }, isInAtList: true, sessionWebhook: WEBHOOK,
  sessionWebhookExpiredTime: Date.now() + 3_600_000, robotCode: 'robot-1', createAt: Date.parse('2026-11-26T00:00:00.000Z'),
  ...overrides })
const target = (overrides: Partial<DingtalkReplyTarget> = {}): DingtalkReplyTarget => ({ conversationType: 'group',
  openConversationId: 'cid-1', userId: '', senderStaffId: 'staff-1', robotCode: 'robot-1', sessionWebhook: WEBHOOK,
  sessionWebhookExpiresAt: future(), ...overrides })
const reply = (text: string, address: Record<string, string> = dingtalkTrigger(message(), 'dingtalk:ops', config()).channel!.address):
  OutboundMessage => ({ id: 'm-1', kind: 'reply', text, channel: { source: 'dingtalk:ops', thread: 'dingtalk:ops:cid-1', address } })

/** One recorded fake-`fetch` call: its URL, parsed JSON body and headers. */
interface FetchCall { url: string; body: unknown; headers: Record<string, string> }
type FetchHandler = (call: FetchCall) => { status?: number; body: unknown } | 'network'
const defaultAnswer: FetchHandler = call => {
  if (call.url.includes('oauth2/accessToken')) return { body: { accessToken: 'token-1', expireIn: 7_200 } }
  if (call.url.includes('/robot/')) return { body: { processQueryKey: 'pq-1' } }
  return { body: { errcode: 0 } }
}
/** A fake `fetch` that records every call and answers through `handler`; `'network'` throws like a broken connection. */
function fetchStub(handler: FetchHandler = defaultAnswer): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
      headers: Object.fromEntries(new Headers(init?.headers).entries()) }
    calls.push(call)
    const answer = handler(call)
    if (answer === 'network') throw new TypeError('fetch failed')
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
  })
  return { impl: spy as unknown as typeof fetch, calls }
}
const tokenCalls = (calls: FetchCall[]): FetchCall[] => calls.filter(call => call.url.includes('oauth2/accessToken'))
const webhookCalls = (calls: FetchCall[]): FetchCall[] => calls.filter(call => call.url === WEBHOOK)

/** A fake Stream client: a connect flag, one listener per topic, recorded acks and disconnects, and a way to push a callback. */
interface FakeClient extends DingtalkStreamClient {
  listeners: Map<string, (envelope: DingtalkStreamEnvelope) => void>
  acks: { messageId: string; result: unknown }[]
  disconnects: number
  connectError?: Error
  push(envelope: DingtalkStreamEnvelope): void
}
function fakeStreamClient(): FakeClient {
  const client: FakeClient = {
    connected: false, listeners: new Map(), acks: [], disconnects: 0,
    registerCallbackListener(topic, callback) { client.listeners.set(topic, callback); return client },
    async connect() { if (client.connectError) throw client.connectError; client.connected = true },
    disconnect() { client.disconnects += 1; client.connected = false },
    socketCallBackResponse(messageId, result) { client.acks.push({ messageId, result }) },
    push(envelope) { client.listeners.get(DINGTALK_TOPIC_ROBOT)?.(envelope) },
  }
  return client
}
/** A Stream factory handing out fake clients and recording them, as the watch loop's reconnect creates new ones. */
function streamFactoryOf(clients: FakeClient[]): DingtalkStreamFactory {
  return (async (): Promise<DingtalkStream> => {
    const client = fakeStreamClient()
    clients.push(client)
    return { client, topic: DINGTALK_TOPIC_ROBOT }
  }) as DingtalkStreamFactory
}
/** A Stream factory that always hands back one prepared client, for one connection's tests. */
function clientFactory(client: FakeClient): DingtalkStreamFactory {
  return (async (): Promise<DingtalkStream> => ({ client, topic: DINGTALK_TOPIC_ROBOT })) as DingtalkStreamFactory
}

/** The health reports one fake Source context received, in order. */
interface FakeSource { ctx: SourceContext; reports: { id: string; health: Health }[]; receive: ReturnType<typeof vi.fn> }
function fakeSource(configs: DingtalkConfig[], options: { configured?: boolean; enabled?: boolean } = {}): FakeSource {
  const reports: { id: string; health: Health }[] = []
  const receive = vi.fn((_trigger: Trigger) => 'stored' as const)
  const instances = configs.map((value, index) => ({ id: index ? `dingtalk:ops-${index}` : 'dingtalk:ops', kind: 'dingtalk',
    enabled: options.enabled ?? true, config: value }))
  const ctx = {
    ready: Promise.resolve(),
    configured: () => options.configured ?? true,
    instances: () => instances,
    report: (id: string, health: Health) => { reports.push({ id, health }) },
    receive,
    threads: { describe: vi.fn() },
  } as unknown as SourceContext
  return { ctx, reports, receive }
}
const lastHealth = (source: FakeSource, id = 'dingtalk:ops'): Health | undefined =>
  source.reports.filter(report => report.id === id).at(-1)?.health
/** Runs the watch loop and always stops it, also when an assertion fails. */
async function watching(source: FakeSource, options: DingtalkWatchOptions, run: () => Promise<void>): Promise<void> {
  const controller = new AbortController()
  const running = watchDingtalk(source.ctx, controller.signal, options)
  try { await run() } finally { controller.abort(); await running }
}

beforeEach(() => {
  clearDingtalkTokens()
  vi.unstubAllGlobals()
})

describe('configuration', () => {
  it('validates the three credentials, accepts the allow-list as text or array, and refuses an unknown key', () => {
    expect(dingtalkKind.schema.parse({})).toEqual({ clientId: '', clientSecret: '', robotCode: '', allowedUserIds: [] })
    expect(config({ allowedUserIds: 'staff-1, staff-2' }).allowedUserIds).toEqual(['staff-1', 'staff-2'])
    expect(config({ allowedUserIds: ['staff-9'] }).allowedUserIds).toEqual(['staff-9'])
    // Once one credential is set, the other two are required: a half-filled bot is refused at save time, without a network.
    expect(() => dingtalkKind.schema.parse({ clientId: 'client-1' })).toThrow()
    expect(() => dingtalkKind.schema.parse({ clientId: 'client-1', clientSecret: 'secret-1' })).toThrow()
    expect(() => dingtalkKind.schema.parse({ clientId: ' ', clientSecret: 's', robotCode: 'r' })).toThrow()
    expect(() => dingtalkKind.schema.parse({ clientId: 'c', clientSecret: 's', robotCode: 'r', unexpected: 1 })).toThrow()
    // The kind is a real one: order 4, one health entry, a Channel and a Policy, and no placeholder mark.
    expect(dingtalkKind).toMatchObject({ kind: 'dingtalk', order: 4, health: ['dingtalk'] })
    expect(dingtalkKind.placeholder).toBeUndefined()
    expect(dingtalkKind.channel).toBeDefined()
    expect(dingtalkKind.policy?.explicit.en).toBeTruthy()
    for (const field of dingtalkKind.fields) expect(field.label.zh && field.label.en, field.key).toBeTruthy()
  })
  it('names the two receiving scopes of an instance, the people its allow-list knows, and the address of a reply', () => {
    expect(dingtalkKind.policy!.rows!({}, 'dingtalk:ops').map(row => row.id)).toEqual(['group', 'direct'])
    expect(dingtalkKind.people!(config({ allowedUserIds: 'staff-1,staff-2' }), 'dingtalk:ops')).toEqual([{ id: 'staff-1' }, { id: 'staff-2' }])
    expect(dingtalkKind.people!(config(), 'dingtalk:ops')).toEqual([])
    const trigger = dingtalkTrigger(message(), 'dingtalk:ops', config())
    const route = replyTargetOf(trigger.channel!.address)!
    expect(route).toMatchObject({ conversationType: 'group', openConversationId: 'cid-1', senderStaffId: 'staff-1', robotCode: 'robot-1' })
    expect(replyTargetOf({ ...trigger.channel!.address, openConversationId: '' })).toBeUndefined()
    // A stored address that points at another robot, or at no webhook, is still only a route; the robot code must match the instance.
    expect(dingtalkKind.channel!.allowed!(trigger.channel!.address, config())).toBe(true)
    expect(dingtalkKind.channel!.allowed!(trigger.channel!.address, config({ robotCode: 'robot-2' }))).toBe(false)
    expect(dingtalkKind.channel!.allowed!({ ...trigger.channel!.address, robotCode: '' }, config())).toBe(false)
    expect(dingtalkKind.channel!.link!(trigger.channel!.address, {}).label.zh).toContain('dingtalk:ops')
    expect(dingtalkKind.channel!.mention!({ source: 'dingtalk:ops', id: 'staff-1', name: 'Alice' })).toBe('@Alice')
  })
  it('scopes a Trigger to the conversation it came from and to a sender on the instance allow-list', () => {
    expect(dingtalkKind.scope!({ meta: { conversationType: 'group', addressed: true, senderStaffId: 'staff-1' }, instance: 'dingtalk:ops' }, config()))
      .toEqual({ listened: true, observed: false, row: 'group' })
    expect(dingtalkKind.scope!({ meta: { conversationType: 'direct', addressed: true, senderStaffId: 'staff-1' }, instance: 'dingtalk:ops' }, config()))
      .toEqual({ listened: true, observed: false, row: 'direct' })
    expect(dingtalkKind.scope!({ meta: { conversationType: 'group', addressed: false, senderStaffId: 'staff-1' }, instance: 'dingtalk:ops' }, config()))
      .toEqual({ listened: false, reason: 'no_mention' })
    expect(dingtalkKind.scope!({ meta: { conversationType: 'direct', addressed: true, senderStaffId: 'staff-2' }, instance: 'dingtalk:ops' },
      config({ allowedUserIds: 'staff-1' }))).toEqual({ listened: false, reason: 'not_a_member' })
  })
})

describe('normalization', () => {
  it('turns a direct text message into a message that addresses the bot', () => {
    const inbound = normalizeDingtalkCallback(callback({ conversationType: '1' }))
    expect(inbound).toMatchObject({ message: { messageId: 'msg-1', senderStaffId: 'staff-1', senderNick: 'Alice',
      conversationId: 'cid-1', conversationType: 'direct', conversationTitle: 'Ops', addressed: true, robotCode: 'robot-1',
      openConversationId: '', sessionWebhook: WEBHOOK } })
  })
  it('turns a group message that mentions the bot into a message whose thread is the group conversation', () => {
    const inbound = normalizeDingtalkCallback(callback())
    expect(inbound).toMatchObject({ message: { conversationType: 'group', addressed: true, openConversationId: 'cid-1',
      sessionWebhook: WEBHOOK } })
    const byAtUser = normalizeDingtalkCallback(callback({ isInAtList: false,
      atUsers: [{ dingtalkId: 'bot-user', staffId: 'staff-1' }] }))
    expect(byAtUser).toMatchObject({ message: { addressed: true } })
  })
  it('skips a group message that does not mention the bot, the bot\'s own message, non-text and malformed callbacks', () => {
    const skipped = (payload: Record<string, unknown>): unknown => normalizeDingtalkCallback(payload)
    expect(skipped(callback({ isInAtList: false }))).toEqual({ skipped: { reason: 'not-addressed', messageId: 'msg-1', messageType: 'text' } })
    expect(skipped(callback({ senderStaffId: undefined, senderId: 'bot-user' }))).toEqual({ skipped: { reason: 'self', messageId: 'msg-1',
      messageType: 'text' } })
    expect(skipped(callback({ msgtype: 'picture', text: undefined }))).toEqual({ skipped: { reason: 'non-text', messageId: 'msg-1',
      messageType: 'picture' } })
    expect(skipped(callback({ msgId: undefined }))).toEqual({ skipped: { reason: 'invalid', messageType: 'text' } })
    expect(normalizeDingtalkCallback('not an object')).toEqual({ skipped: { reason: 'invalid' } })
  })
  it('drops a reply address that is not a trusted DingTalk URL, and keeps DingTalk\'s expiry time', () => {
    const inbound = normalizeDingtalkCallback(callback({ sessionWebhook: 'http://evil.example/steal', sessionWebhookExpiredTime: 1_700_000_000_000 }))
    expect(inbound).toMatchObject({ message: { sessionWebhook: '', sessionWebhookExpiresAt: new Date(1_700_000_000_000).toISOString() } })
    expect(normalizeDingtalkCallback(callback({ sessionWebhook: 'https://dingtalk.com.evil.example/x' })))
      .toMatchObject({ message: { sessionWebhook: '' } })
  })
})

describe('triggers', () => {
  it('names the message, its conversation thread, its reporter and the route a reply may take', () => {
    const trigger = dingtalkTrigger(message(), 'dingtalk:ops', config())
    expect(trigger).toMatchObject({ id: key('dingtalk', 'dingtalk:ops', 'msg-1'), source: 'dingtalk:ops',
      threads: [{ source: 'dingtalk:ops', id: 'cid-1' }], actor: { source: 'dingtalk:ops', id: 'staff-1' }, human: true,
      addressed: 'mention', at: '2026-11-26T00:00:00.000Z', text: 'please fix the typo' })
    expect(trigger.channel).toMatchObject({ source: 'dingtalk:ops', thread: 'dingtalk:ops:cid-1', address: {
      row: 'dingtalk:ops', conversationType: 'group', conversationId: 'cid-1', openConversationId: 'cid-1', userId: '',
      senderStaffId: 'staff-1', robotCode: 'robot-1', sessionWebhook: WEBHOOK } })
    expect(trigger.meta).toMatchObject({ row: 'dingtalk:ops', messageId: 'msg-1', conversationId: 'cid-1', conversationType: 'group',
      conversationTitle: 'Ops', senderStaffId: 'staff-1', senderNick: 'Alice', sessionWebhook: WEBHOOK, openConversationId: 'cid-1',
      robotCode: 'robot-1', addressed: true })
    // A direct message is addressed directly and replies to the sender, not to a group conversation.
    const direct = dingtalkTrigger(message({ conversationType: 'direct', openConversationId: '' }), 'dingtalk:ops', config())
    expect(direct).toMatchObject({ addressed: 'direct', channel: { address: { openConversationId: '', userId: 'staff-1' } } })
  })
  it('truncates the text at 8000 characters and never puts the Client Secret in a Trigger', () => {
    const long = dingtalkTrigger(message({ text: 'x'.repeat(9_000) }), 'dingtalk:ops', config({ clientSecret: 'top-secret-value' }))
    expect(long.text).toHaveLength(8_000)
    const stored = JSON.stringify(long)
    expect(stored).not.toContain('top-secret-value')
    expect(stored).not.toContain('clientSecret')
  })
  it('receives a message once, keeps a duplicate from becoming work, and drops a sender the instance does not allow', async () => {
    const received: Trigger[] = []
    const receive = vi.fn((trigger: Trigger) => { received.push(trigger); return received.length > 1 ? 'duplicate' as const : 'stored' as const })
    const ctx = { receive, threads: { describe: vi.fn() } } as unknown as SourceContext
    expect(await receiveDingtalk(ctx, 'dingtalk:ops', config(), message())).toBe('received')
    expect(await receiveDingtalk(ctx, 'dingtalk:ops', config(), message())).toBe('duplicate')
    expect(receive).toHaveBeenCalledTimes(2)
    expect(await receiveDingtalk(ctx, 'dingtalk:ops', config({ allowedUserIds: 'staff-2' }), message())).toBe('not-allowed')
    expect(receive).toHaveBeenCalledTimes(2)
  })
})

describe('the token cache and the access token request', () => {
  it('fetches one token per Client ID and refreshes it five minutes before DingTalk would expire it', async () => {
    let now = 0
    const stub = fetchStub()
    expect(await dingtalkAccessToken(credentials, { fetchImpl: stub.impl, now: () => now })).toBe('token-1')
    expect(await dingtalkAccessToken(credentials, { fetchImpl: stub.impl, now: () => now })).toBe('token-1')
    expect(tokenCalls(stub.calls)).toHaveLength(1)
    expect(tokenCalls(stub.calls)[0]!.body).toEqual({ appKey: 'client-1', appSecret: 'secret-1' })
    expect(tokenCalls(stub.calls)[0]!.url).toBe('https://api.dingtalk.com/v1.0/oauth2/accessToken')
    // expireIn 7200 s, refreshed at 6900 s.
    now = 6_950_000
    await dingtalkAccessToken(credentials, { fetchImpl: stub.impl, now: () => now })
    expect(tokenCalls(stub.calls)).toHaveLength(2)
  })
  it('shares one in-flight token request and classifies a refused one', async () => {
    const stub = fetchStub(call => call.url.includes('oauth2/accessToken') ? { body: { accessToken: 'token-2', expireIn: 7_200 } }
      : { body: { errcode: 0 } })
    const [first, second] = await Promise.all([dingtalkAccessToken({ clientId: 'client-2', clientSecret: 'secret-2' }, { fetchImpl: stub.impl }),
      dingtalkAccessToken({ clientId: 'client-2', clientSecret: 'secret-2' }, { fetchImpl: stub.impl })])
    expect([first, second]).toEqual(['token-2', 'token-2'])
    expect(tokenCalls(stub.calls)).toHaveLength(1)
    const refused = fetchStub(() => ({ status: 401, body: { code: 'InvalidAuthentication' } }))
    await expect(dingtalkAccessToken({ clientId: 'client-3', clientSecret: 'secret-3' }, { fetchImpl: refused.impl }))
      .rejects.toMatchObject({ code: 'auth' })
    await expect(dingtalkAccessToken({ clientId: '', clientSecret: '' })).rejects.toThrow('Client ID')
  })
})

describe('replies', () => {
  it('sends through the sessionWebhook first, with the token and the native @ of the sender', async () => {
    const stub = fetchStub()
    expect(await sendDingtalkReply(reply('Done.'), { credentials, target: target(), fetchImpl: stub.impl })).toBe('sent')
    const webhook = webhookCalls(stub.calls)
    expect(webhook).toHaveLength(1)
    expect(webhook[0]!.body).toEqual({ msgtype: 'text', text: { content: 'Done.' }, at: { atUserIds: ['staff-1'] } })
    expect(webhook[0]!.headers['x-acs-dingtalk-access-token']).toBe('token-1')
    expect(stub.calls.some(call => call.url.includes('groupMessages'))).toBe(false)
  })
  it('mentions nobody in a direct message and answers the sender through the person route', async () => {
    const stub = fetchStub()
    await sendDingtalkReply(reply('Done.', { row: 'dingtalk:ops', conversationType: 'direct', conversationId: 'cid-1',
      openConversationId: '', userId: 'staff-1', senderStaffId: 'staff-1', robotCode: 'robot-1', sessionWebhook: WEBHOOK,
      sessionWebhookExpiresAt: future() }), { credentials, target: target({ conversationType: 'direct', openConversationId: '',
      userId: 'staff-1' }), fetchImpl: stub.impl })
    expect(webhookCalls(stub.calls)[0]!.body).toEqual({ msgtype: 'text', text: { content: 'Done.' } })
  })
  it('falls back to the robot group API once the webhook expired', async () => {
    const stub = fetchStub()
    expect(await sendDingtalkReply(reply('Late answer.'), { credentials, target: target({ sessionWebhookExpiresAt: past() }),
      fetchImpl: stub.impl })).toBe('sent')
    expect(webhookCalls(stub.calls)).toHaveLength(0)
    const robot = stub.calls.find(call => call.url.endsWith('/v1.0/robot/groupMessages/send'))!
    expect(robot.body).toEqual({ robotCode: 'robot-1', msgKey: 'sampleText',
      msgParam: JSON.stringify({ content: 'Late answer.' }), openConversationId: 'cid-1' })
    expect(robot.headers['x-acs-dingtalk-access-token']).toBe('token-1')
  })
  it('falls back to the robot API when DingTalk says the webhook is no longer valid', async () => {
    const stub = fetchStub(call => call.url === WEBHOOK
      ? { status: 400, body: { errcode: 40078, errmsg: 'invalid sessionWebhook' } } : defaultAnswer(call))
    expect(await sendDingtalkReply(reply('Late answer.'), { credentials, target: target(), fetchImpl: stub.impl })).toBe('sent')
    expect(webhookCalls(stub.calls)).toHaveLength(1)
    expect(stub.calls.some(call => call.url.endsWith('/v1.0/robot/groupMessages/send'))).toBe(true)
  })
  it('sends a direct reply that has no webhook through oToMessages/batchSend', async () => {
    const stub = fetchStub()
    expect(await sendDingtalkReply(reply('Done.'), { credentials, fetchImpl: stub.impl,
      target: target({ conversationType: 'direct', openConversationId: '', userId: 'staff-1', sessionWebhook: '',
        sessionWebhookExpiresAt: '' }) })).toBe('sent')
    const robot = stub.calls.find(call => call.url.endsWith('/v1.0/robot/oToMessages/batchSend'))!
    expect(robot.body).toEqual({ robotCode: 'robot-1', msgKey: 'sampleText',
      msgParam: JSON.stringify({ content: 'Done.' }), userIds: ['staff-1'] })
  })
  it('never falls back to another transport after an uncertain failure', async () => {
    const stub = fetchStub(call => call.url === WEBHOOK ? 'network' : defaultAnswer(call))
    await expect(sendDingtalkReply(reply('Done.'), { credentials, target: target(), fetchImpl: stub.impl }))
      .rejects.toMatchObject({ code: 'network' })
    expect(stub.calls.some(call => call.url.includes('api.dingtalk.com/v1.0/robot'))).toBe(false)
    const failing = fetchStub(call => call.url === WEBHOOK ? { status: 500, body: { message: 'boom' } } : defaultAnswer(call))
    await expect(sendDingtalkReply(reply('Done.'), { credentials, target: target(), fetchImpl: failing.impl }))
      .rejects.toMatchObject({ code: 'network' })
    expect(failing.calls.some(call => call.url.includes('api.dingtalk.com/v1.0/robot'))).toBe(false)
  })
  it('classifies refusals: a gone target, a refused robot call and a rate limit', async () => {
    const gone = fetchStub(call => call.url.includes('/robot/') ? { status: 400, body: { code: 'InvalidStaffId',
      message: 'staff not found' } } : defaultAnswer(call))
    expect(await sendDingtalkReply(reply('Done.'), { credentials, fetchImpl: gone.impl,
      target: target({ sessionWebhook: '', sessionWebhookExpiresAt: '' }) })).toBe('gone')
    const rejected = fetchStub(call => call.url.includes('/robot/') ? { status: 400, body: { code: 'BadRequest',
      message: 'rejected for another reason' } } : defaultAnswer(call))
    await expect(sendDingtalkReply(reply('Done.'), { credentials, fetchImpl: rejected.impl,
      target: target({ sessionWebhook: '', sessionWebhookExpiresAt: '' }) })).rejects.toMatchObject({ code: 'rejected' })
    const limited = fetchStub(() => ({ status: 429, body: {} }))
    await expect(sendDingtalkReply(reply('Done.'), { credentials, fetchImpl: limited.impl,
      target: target({ sessionWebhook: '', sessionWebhookExpiresAt: '' }) })).rejects.toMatchObject({ code: 'rate-limit' })
  })
  it('splits a long reply into several DingTalk-sized messages', async () => {
    const stub = fetchStub()
    const long = `${'a'.repeat(DINGTALK_REPLY_CHARS)}\n${'b'.repeat(DINGTALK_REPLY_CHARS)}`
    await sendDingtalkReply(reply(long), { credentials, target: target(), fetchImpl: stub.impl })
    expect(webhookCalls(stub.calls)).toHaveLength(2)
    for (const call of webhookCalls(stub.calls)) expect((call.body as { text: { content: string } }).text.content.length)
      .toBeLessThanOrEqual(DINGTALK_REPLY_CHARS)
    expect(splitDingtalkText('one line')).toEqual(['one line'])
    expect(splitDingtalkText('   ')).toEqual([])
  })
  it('knows whether a route\'s webhook is still fresh', () => {
    expect(webhookExpired(target(), Date.now())).toBe(false)
    expect(webhookExpired(target({ sessionWebhookExpiresAt: past() }), Date.now())).toBe(true)
    expect(webhookExpired(target({ sessionWebhook: '' }), Date.now())).toBe(true)
    expect(webhookExpired(target({ sessionWebhookExpiresAt: '' }), Date.now())).toBe(false)
  })
  it('sends through the Channel with the instance\'s own credentials, and refuses an unscoped Commands', async () => {
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const trigger = dingtalkTrigger(message(), 'dingtalk:ops', config())
    await expect(dingtalkKind.channel!.send({ commands }, reply('Done.', trigger.channel!.address)))
      .rejects.toThrow('no configuration')
    const stub = fetchStub()
    vi.stubGlobal('fetch', stub.impl)
    const scoped = dingtalkKind.commands!(config(), commands)
    expect(await dingtalkKind.channel!.send({ commands: scoped }, reply('Done.', trigger.channel!.address))).toBe('sent')
    expect(webhookCalls(stub.calls)).toHaveLength(1)
  })
})

describe('the Stream connection', () => {
  it('registers the bot topic, acknowledges the callback at once, then dispatches the message', async () => {
    const client = fakeStreamClient()
    const messages: DingtalkMessage[] = []
    const connection = new DingtalkConnection({ clientId: 'client-1', clientSecret: 'secret-1', streamFactory: clientFactory(client),
      onMessage: message => { messages.push(message) }, probeIntervalMs: 2, connectTimeoutMs: 100 })
    await connection.connect()
    expect(connection.connected).toBe(true)
    expect(connection.botTopic).toBe(DINGTALK_TOPIC_ROBOT)
    expect([...client.listeners.keys()]).toEqual([DINGTALK_TOPIC_ROBOT])
    client.push({ headers: { messageId: 'envelope-1' }, data: JSON.stringify(callback()) })
    expect(client.acks).toEqual([{ messageId: 'envelope-1', result: { success: true } }])
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    expect(messages[0]).toMatchObject({ messageId: 'msg-1', conversationType: 'group', senderStaffId: 'staff-1' })
    await connection.close()
    expect(client.disconnects).toBe(1)
    expect(connection.connected).toBe(false)
  })
  it('counts a skipped callback, ignores an unparsable one, and waits for an async handler on close', async () => {
    const client = fakeStreamClient()
    const skips: DingtalkSkipEvent[] = []
    let handled = false
    const connection = new DingtalkConnection({ clientId: 'client-1', clientSecret: 'secret-1', streamFactory: clientFactory(client),
      probeIntervalMs: 2, connectTimeoutMs: 100, onSkip: skip => { skips.push(skip) },
      onMessage: async () => { await new Promise(resolve => setTimeout(resolve, 20)); handled = true } })
    await connection.connect()
    client.push({ headers: { messageId: 'envelope-1' }, data: '{not json' })
    client.push({ headers: { messageId: 'envelope-2' }, data: JSON.stringify(callback({ isInAtList: false })) })
    client.push({ headers: { messageId: 'envelope-3' }, data: JSON.stringify(callback()) })
    await connection.close()
    expect(handled).toBe(true)
    expect(skips.map(skip => skip.reason)).toEqual(['invalid', 'not-addressed'])
    expect(client.acks.map(ack => ack.messageId)).toEqual(['envelope-1', 'envelope-2', 'envelope-3'])
  })
  it('reports the stage and reason of a connection failure without the secret', async () => {
    const refused = new DingtalkConnection({ clientId: 'client-1', clientSecret: 'secret-1', onMessage: () => {},
      streamFactory: (async () => { throw new Error('handshake refused for secret-1') }) as DingtalkStreamFactory })
    const loadError = await refused.connect().catch((error: unknown) => error) as Error
    expect(loadError).toBeInstanceOf(DingtalkStreamError)
    expect(loadError).toMatchObject({ stage: 'load' })
    expect(loadError.message).toContain('handshake refused')
    expect(loadError.message).not.toContain('secret-1')
    const client = fakeStreamClient()
    client.connectError = new Error('socket error')
    const failing = new DingtalkConnection({ clientId: 'client-1', clientSecret: 'secret-1', onMessage: () => {},
      streamFactory: clientFactory(client), connectTimeoutMs: 100, probeIntervalMs: 2 })
    await expect(failing.connect()).rejects.toMatchObject({ stage: 'connect' })
    const unusable = new DingtalkConnection({ clientId: 'client-1', clientSecret: 'secret-1', onMessage: () => {},
      streamFactory: (async () => ({ client: {} as DingtalkStreamClient, topic: DINGTALK_TOPIC_ROBOT })) as DingtalkStreamFactory })
    await expect(unusable.connect()).rejects.toMatchObject({ stage: 'load' })
    expect(dingtalkFailureText(new DingtalkStreamError('connect', 'socket closed'))).toBe('connect: socket closed')
  })
  it('times out when the socket never opens', async () => {
    const client = fakeStreamClient()
    client.connect = async () => {}
    const connection = new DingtalkConnection({ clientId: 'client-1', clientSecret: 'secret-1', onMessage: () => {},
      streamFactory: clientFactory(client), connectTimeoutMs: 30, probeIntervalMs: 2 })
    await expect(connection.connect()).rejects.toMatchObject({ stage: 'connect' })
    expect(client.disconnects).toBe(1)
  })
  it('resolves waitForClose when the socket closes and stops when the caller aborts', async () => {
    const client = fakeStreamClient()
    const connection = new DingtalkConnection({ clientId: 'client-1', clientSecret: 'secret-1', onMessage: () => {},
      streamFactory: clientFactory(client), probeIntervalMs: 2, connectTimeoutMs: 100 })
    await connection.connect()
    const closed = connection.waitForClose()
    client.connected = false
    await expect(closed).resolves.toBeUndefined()
    await connection.close()
    const aborted = new AbortController()
    const second = fakeStreamClient()
    const other = new DingtalkConnection({ clientId: 'client-1', clientSecret: 'secret-1', onMessage: () => {},
      streamFactory: clientFactory(second), probeIntervalMs: 2, connectTimeoutMs: 100 })
    await other.connect()
    const waiting = other.waitForClose(aborted.signal)
    aborted.abort()
    await expect(waiting).resolves.toBeUndefined()
    await other.close()
  })
})

describe('the plugin loop', () => {
  it('waits for setup and reports paused when setup is not done', async () => {
    const source = fakeSource([config()], { configured: false })
    await watchDingtalk(source.ctx, new AbortController().signal, {})
    expect(lastHealth(source)).toMatchObject({ state: 'paused', code: 'setupPending' })
  })
  it('reports paused with the missing credentials instead of failing, and a disabled instance as off', async () => {
    const source = fakeSource([dingtalkKind.schema.parse({})])
    await watching(source, { streamFactory: streamFactoryOf([]) }, async () => {
      await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'paused',
        detail: 'The DingTalk bot is not configured: clientId, clientSecret, robotCode' }))
    })
    const disabled = fakeSource([config()], { enabled: false })
    await watching(disabled, { streamFactory: streamFactoryOf([]) }, async () => {
      await vi.waitFor(() => expect(lastHealth(disabled)).toMatchObject({ state: 'paused', code: 'sourceOff' }))
    })
  })
  it('reports ready once connected and reconnects after the socket closes', async () => {
    const clients: FakeClient[] = []
    const source = fakeSource([config()])
    await watching(source, { streamFactory: streamFactoryOf(clients), probeIntervalMs: 2, backoffMs: [1],
      reconcileSeconds: 0.05 }, async () => {
      await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'ready' }))
      expect(lastHealth(source)!.detail).toBe('Connected to the DingTalk Stream; 0 messages received')
      expect(clients).toHaveLength(1)
      // A message the bot receives is acknowledged before it becomes a Trigger, and the health detail counts it.
      clients[0]!.push({ headers: { messageId: 'envelope-1' }, data: JSON.stringify(callback()) })
      await vi.waitFor(() => expect(lastHealth(source)!.detail).toContain('1 messages received'))
      expect(source.receive).toHaveBeenCalledTimes(1)
      // The socket closing is reported as a reconnect and followed by a second connection.
      clients[0]!.connected = false
      await vi.waitFor(() => expect(clients).toHaveLength(2))
      await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'ready' }))
      expect(source.reports.some(report => report.health.detail === 'The DingTalk Stream connection closed; reconnecting')).toBe(true)
    })
  }, 20_000)
  it('reports an error only after three consecutive failed connections, and keeps retrying', async () => {
    const source = fakeSource([config()])
    let attempts = 0
    const factory = (async () => { attempts += 1; throw new Error('gateway down') }) as unknown as DingtalkStreamFactory
    await watching(source, { streamFactory: factory, backoffMs: [1, 1, 1], probeIntervalMs: 2, connectTimeoutMs: 40,
      reconcileSeconds: 0.05 }, async () => {
      await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'error' }))
      expect(source.reports.some(report => report.health.state === 'error' && report.health.detail.includes('failed 3 times'))).toBe(true)
      expect(source.reports.some(report => report.health.detail.includes('gateway down'))).toBe(true)
      await vi.waitFor(() => expect(attempts).toBeGreaterThan(3))
    })
  }, 20_000)
  it('serves several instances on their own connections and reports each one separately', async () => {
    const clients: FakeClient[] = []
    const source = fakeSource([config(), config({ clientId: 'client-2' })])
    await watching(source, { streamFactory: streamFactoryOf(clients), probeIntervalMs: 2, backoffMs: [1],
      reconcileSeconds: 0.05 }, async () => {
      await vi.waitFor(() => expect(lastHealth(source, 'dingtalk:ops')).toMatchObject({ state: 'ready' }))
      await vi.waitFor(() => expect(lastHealth(source, 'dingtalk:ops-1')).toMatchObject({ state: 'ready' }))
      expect(clients).toHaveLength(2)
    })
  }, 20_000)
  it('registers the kind and starts its loop from the plugin entry', async () => {
    const clients: FakeClient[] = []
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
    apply(host as never, { streamFactory: streamFactoryOf(clients), probeIntervalMs: 2, backoffMs: [1], reconcileSeconds: 0.05 })
    expect(registered).toEqual([dingtalkKind])
    await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'ready' }))
    for (const dispose of disposers.reverse()) await dispose()
  }, 20_000)
  it('reports a credential-free failure reason from the transport classification', () => {
    expect(dingtalkFailureText(new DingtalkApiError('auth', 'DingTalk answered HTTP 401', { status: 401, providerCode: 'InvalidAuthentication' })))
      .toBe('auth: DingTalk answered HTTP 401 (InvalidAuthentication)')
  })
})
