/**
 * The WeChat Source without WeChat: its configuration, Trigger translation, the duplicate set, Policy admission, the QR
 * sign-in/poll loop over a fake `SourceContext` and fake iLink fetch, and the reply path over the live credential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { key, threadKey, type OutboundMessage, type Thread, type Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { apply, rememberSeen, receiveWechat, watchWechat, wechatKind, wechatTrigger, WEIXIN_SEEN_LIMIT,
  weixinCursor, weixinSeen, type WechatConfig, type WechatWatchOptions } from '../src/sources/wechat.ts'
import type { Health, SourceContext } from '../src/sources/host.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { clearWeixinLiveCredentials, liveWeixinCredential, normalizeWeixinInbound, registerWeixinCredential,
  splitWeixinText, WEIXIN_REPLY_CHARS, weixinClientId } from '../src/sources/im/weixin-transport.ts'
import { weixinToken, type WeixinCredential } from '../src/sources/im/weixin-login.ts'
import { testDeployment } from './fixtures/deployment.ts'

/** A validated configuration, as an operator saves it. */
const config = (overrides: Record<string, unknown> = {}): WechatConfig => wechatKind.schema.parse(overrides)
/** A signed-in credential record, as the QR sign-in writes it to KV. */
const credential = (overrides: Partial<WeixinCredential> = {}): WeixinCredential =>
  ({ token: 'bot-token-1', ilinkBotId: 'bot-1', at: '2026-11-26T00:00:00.000Z', ...overrides })
/** One normalized inbound message, a direct text message by default. */
const message = (overrides: Partial<{ messageId: string; clientId: string; text: string; fromUserId: string
  contextToken: string; runId: string; createdAt: string }> = {}) => ({ messageId: 'msg-1', clientId: 'client-1',
  text: 'please fix the typo', fromUserId: 'user-1', contextToken: 'ctx-1', runId: 'run-1',
  createdAt: '2026-11-26T00:00:00.000Z', ...overrides })
/** One raw iLink message, as the fake fetch pushes it. */
const raw = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ message_id: 'msg-1',
  client_id: 'client-1', from_user_id: 'user-1', message_type: 1, context_token: 'ctx-1', run_id: 'run-1',
  create_time_ms: 1_764_115_200_000, item_list: [{ type: 1, text_item: { text: 'please fix the typo' } }], ...overrides })
const reply = (text: string, route: Record<string, string> = wechatTrigger(message(), 'wechat:ops').channel!.address): OutboundMessage =>
  ({ id: 'm-1', kind: 'reply', text, channel: { source: 'wechat:ops', thread: 'wechat:ops:user-1', address: route } })

/** The health reports one fake Source context received, in order. */
interface FakeSource { ctx: SourceContext; reports: { id: string; health: Health }[]; receive: ReturnType<typeof vi.fn>
  state: Map<string, unknown> }
function fakeSource(instances: { id: string; config: WechatConfig; enabled?: boolean }[], options: { configured?: boolean } = {}): FakeSource {
  const state = new Map<string, unknown>()
  const reports: { id: string; health: Health }[] = []
  const receive = vi.fn((_trigger: Trigger) => 'stored' as const)
  const stored = instances.map(item => ({ id: item.id, kind: 'wechat', enabled: item.enabled ?? true, config: item.config }))
  const ctx = {
    ready: Promise.resolve(),
    configured: () => options.configured ?? true,
    instances: () => stored,
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
    // The kind is a real one: order 5, one health entry, a Channel and a Policy, and no placeholder mark.
    expect(wechatKind).toMatchObject({ kind: 'wechat', order: 5, health: ['wechat'] })
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
  it('polls the signed-in instance, receives direct text messages and skips groups, its own messages and non-text ones', async () => {
    const source = fakeSource([{ id: 'wechat', config: config() }])
    source.state.set(weixinToken('wechat'), credential())
    const updates = updatesFetch([[
      raw(),
      raw({ message_id: 'msg-2', from_user_id: 'user-2' }),
      raw({ message_id: 'msg-3', chatroom_id: 'room-1' }),
      raw({ message_id: 'msg-4', message_type: 2 }),
      raw({ message_id: 'msg-5', item_list: [{ type: 2, image_item: {} }] }),
    ]])
    await watching(source, { fetchImpl: updates.fetchImpl, pollTimeoutMs: 5, reconcileSeconds: 0.02 }, async () => {
      await vi.waitFor(() => expect(source.receive).toHaveBeenCalledTimes(2))
      expect(source.receive.mock.calls.map(([trigger]) => (trigger as Trigger).actor.id)).toEqual(['user-1', 'user-2'])
      await vi.waitFor(() => expect(lastHealth(source)).toMatchObject({ state: 'ready' }))
      expect(lastHealth(source)!.detail).toBe('Connected to WeChat; 2 messages received; 3 skipped (group 1, non-text 1, self 1)')
      // The cursor is kept for the next run of the instance, and the token appears in no health detail.
      expect(source.state.get(weixinCursor('wechat'))).toBe('cursor-0')
      expect(JSON.stringify(source.reports)).not.toContain('bot-token-1')
      expect(updates.calls[0]!.body).toMatchObject({ get_updates_buf: '' })
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
