/**
 * The DingTalk device-registration client and its QR login manager, without DingTalk: the init/begin/poll payloads over a
 * fake fetch, status normalization, sanitized failures, and the manager creating one Source account for a confirmed scan.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DingtalkDeviceAuth, DingtalkDeviceAuthError, DINGTALK_REGISTRATION_SOURCE,
} from '../src/sources/im/dingtalk-device-auth.ts'
import {
  clearDingtalkLogins, DingtalkLoginManager, renderDingtalkQrImage, type DingtalkLoginCredentials,
} from '../src/sources/im/dingtalk-login.ts'

/** One recorded registration call: its address, method, headers, parsed body and redirect mode. */
interface FakeCall { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown>
  redirect: RequestRedirect | undefined }
/** A fake fetch that records each call and answers from a callback; a returned Error is a socket-level failure. */
function fakeFetch(answer: (call: FakeCall) => Response | Error): { fetchImpl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const fetchImpl = (async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const call: FakeCall = { url: String(input), method: init?.method ?? 'GET',
      headers: { ...(init?.headers ?? {}) as Record<string, string> },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {},
      redirect: init?.redirect }
    calls.push(call)
    const result = answer(call)
    if (result instanceof Error) throw result
    return result
  }) as typeof fetch
  return { fetchImpl, calls }
}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
/** The answer DingTalk gives a registration `begin`. */
const BEGUN = { errcode: 0, device_code: 'dev-1', verification_uri_complete: 'https://login.dingtalk.com/oauth2/auth?x=1',
  verification_uri: 'https://login.dingtalk.com/oauth2/auth', user_code: 'ABCD-1234', interval: 5, expires_in: 600 }
/** A fake registration that answers init and begin, then the given poll answers in order. */
function registration(polls: unknown[]): { fetchImpl: typeof fetch; calls: FakeCall[] } {
  const queue = [...polls]
  return fakeFetch(call => {
    if (call.url.endsWith('/app/registration/init')) return json({ errcode: 0, nonce: 'nonce-1' })
    if (call.url.endsWith('/app/registration/begin')) return json(BEGUN)
    return json(queue.shift() ?? { errcode: 0, status: 'WAITING' })
  })
}
/** A fetch that never answers until its request is aborted, as a hung registration service does. */
const hangingFetch = (): typeof fetch => ((_url: URL | string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  const signal = init?.signal
  const fail = (): void => reject(new DOMException('The operation was aborted', 'AbortError'))
  if (signal?.aborted) { fail(); return }
  signal?.addEventListener('abort', fail, { once: true })
})) as typeof fetch
beforeEach(() => { clearDingtalkLogins() })

describe('the device registration client', () => {
  it('starts a registration with the source nonce and returns its device code and QR metadata', async () => {
    const now = vi.fn(() => 1_000)
    const { fetchImpl, calls } = registration([])
    const auth = new DingtalkDeviceAuth({ fetchImpl, now })
    expect(await auth.start()).toEqual({ deviceCode: 'dev-1', verificationUrl: 'https://login.dingtalk.com/oauth2/auth?x=1',
      verificationUri: 'https://login.dingtalk.com/oauth2/auth', userCode: 'ABCD-1234', expiresAt: 601_000,
      pollIntervalMs: 5_000 })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ url: 'https://oapi.dingtalk.com/app/registration/init', method: 'POST',
      body: { source: DINGTALK_REGISTRATION_SOURCE }, redirect: 'error',
      headers: expect.objectContaining({ accept: 'application/json', 'content-type': 'application/json' }) })
    expect(calls[1]).toMatchObject({ url: 'https://oapi.dingtalk.com/app/registration/begin', method: 'POST',
      body: { nonce: 'nonce-1' } })
  })
  it('refuses a start whose nonce or QR metadata is missing, and any base that is not DingTalk HTTPS', async () => {
    const noNonce = fakeFetch(() => json({ errcode: 0 }))
    await expect(new DingtalkDeviceAuth({ fetchImpl: noNonce.fetchImpl }).start())
      .rejects.toMatchObject({ name: 'DingtalkDeviceAuthError', code: 'missing-nonce', action: 'initialization' })
    const incomplete = fakeFetch(() => json({ errcode: 0, nonce: 'n' }))
    await expect(new DingtalkDeviceAuth({ fetchImpl: incomplete.fetchImpl }).start())
      .rejects.toMatchObject({ code: 'incomplete-registration', action: 'begin' })
    const { fetchImpl } = registration([])
    expect(() => new DingtalkDeviceAuth({ fetchImpl, baseUrl: 'http://dingtalk.com' })).toThrow(DingtalkDeviceAuthError)
    expect(() => new DingtalkDeviceAuth({ fetchImpl, baseUrl: 'https://evil.example' })).toThrow(/HTTPS DingTalk URL/)
    expect(() => new DingtalkDeviceAuth({ fetchImpl, timeoutMs: 0 })).toThrow(TypeError)
  })
  it('polls a registration and normalizes its four states and the provisioned credentials', async () => {
    const responses: unknown[] = [{ status: 'WAITING' }, { status: 'SUCCESS', client_id: 'client-1', client_secret: 'secret-1' },
      { status: 'FAIL', fail_reason: 'denied' }, { status: 'EXPIRED' }, { status: 'what' }]
    const { fetchImpl, calls } = fakeFetch(() => json(responses.shift()))
    const auth = new DingtalkDeviceAuth({ fetchImpl })
    expect(await auth.poll({ deviceCode: 'dev-1' })).toEqual({ status: 'WAITING' })
    expect(await auth.poll({ deviceCode: 'dev-1' })).toEqual({ status: 'SUCCESS', clientId: 'client-1',
      clientSecret: 'secret-1' })
    expect(await auth.poll({ deviceCode: 'dev-1' })).toEqual({ status: 'FAIL', failReason: 'denied' })
    expect(await auth.poll({ deviceCode: 'dev-1' })).toEqual({ status: 'EXPIRED' })
    expect(await auth.poll({ deviceCode: 'dev-1' })).toEqual({ status: 'UNKNOWN' })
    expect(calls[0]).toMatchObject({ url: 'https://oapi.dingtalk.com/app/registration/poll', method: 'POST',
      body: { device_code: 'dev-1' } })
    await expect(auth.poll({ deviceCode: '  ' })).rejects.toThrow(TypeError)
  })
  it('classifies a rejected, failed, malformed and timed-out request without carrying an answer body', async () => {
    const rejected = fakeFetch(() => json({ errcode: 400, client_secret: 'secret-1' }))
    const refused = await new DingtalkDeviceAuth({ fetchImpl: rejected.fetchImpl }).poll({ deviceCode: 'dev-1' })
      .catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: 'api-error', action: 'poll' })
    expect(String((refused as Error).message)).not.toContain('secret-1')
    const http = fakeFetch(() => json({ error: 'nope', client_secret: 'secret-1' }, 503))
    await expect(new DingtalkDeviceAuth({ fetchImpl: http.fetchImpl }).poll({ deviceCode: 'dev-1' }))
      .rejects.toMatchObject({ code: 'http-error', status: 503 })
    const malformed = fakeFetch(() => new Response('<html>', { status: 200 }))
    await expect(new DingtalkDeviceAuth({ fetchImpl: malformed.fetchImpl }).poll({ deviceCode: 'dev-1' }))
      .rejects.toMatchObject({ code: 'invalid-json' })
    const network = fakeFetch(() => new Error('socket closed'))
    await expect(new DingtalkDeviceAuth({ fetchImpl: network.fetchImpl }).start())
      .rejects.toMatchObject({ code: 'network-error', action: 'initialization' })
    await expect(new DingtalkDeviceAuth({ fetchImpl: hangingFetch(), timeoutMs: 20 }).start())
      .rejects.toMatchObject({ code: 'timeout', action: 'initialization' })
  })
})

describe('the login manager', () => {
  /** One fake settings store the manager's `create` writes a Source instance into. */
  function settingsOf(): { sources: Record<string, { label?: string; config: Record<string, unknown> }> } {
    return { sources: {} }
  }
  /** The `create` callback of one attempt: stores the credentials as the host's account creation does. */
  const createIn = (settings: ReturnType<typeof settingsOf>) =>
    async (credentials: DingtalkLoginCredentials): Promise<string> => {
      settings.sources.dingtalk = { label: '钉钉（扫码）', config: { clientId: credentials.clientId,
        clientSecret: credentials.clientSecret, robotCode: credentials.clientId } }
      return 'dingtalk'
    }
  it('creates the account once a scanned registration is confirmed, and never returns its secret', async () => {
    const { fetchImpl } = registration([{ errcode: 0, status: 'WAITING' },
      { errcode: 0, status: 'SUCCESS', client_id: 'client-1', client_secret: 'secret-1' }])
    const settings = settingsOf()
    const manager = new DingtalkLoginManager({ fetchImpl, pollIntervalMs: 1,
      renderQr: async content => `rendered:${content}` })
    try {
      const started = await manager.start({ create: createIn(settings) })
      // The panel gets the attempt id and a rendered QR image; the device code and any secret stay on the host.
      expect(started.loginId).toEqual(expect.any(String))
      expect(started.qrImage).toBe('rendered:https://login.dingtalk.com/oauth2/auth?x=1')
      expect(started.expiresAt).toEqual(expect.any(String))
      expect(JSON.stringify(started)).not.toContain('dev-1')
      expect(manager.poll(started.loginId)).toEqual({ status: 'waiting' })
      await vi.waitFor(() => expect(manager.poll(started.loginId))
        .toMatchObject({ status: 'confirmed', sourceId: 'dingtalk' }))
      expect(settings.sources.dingtalk).toEqual({ label: '钉钉（扫码）', config: { clientId: 'client-1',
        clientSecret: 'secret-1', robotCode: 'client-1' } })
      expect(JSON.stringify(manager.poll(started.loginId))).not.toContain('secret-1')
      // Only the newest attempt is readable; an unknown attempt reads expired.
      expect(manager.poll('unknown')).toEqual({ status: 'expired' })
    } finally { manager.clear() }
  })
  it('keeps one attempt at a time: a new scan supersedes the previous one as expired', async () => {
    const { fetchImpl } = registration(Array(20).fill({ errcode: 0, status: 'WAITING' }))
    const manager = new DingtalkLoginManager({ fetchImpl, pollIntervalMs: 1, renderQr: async () => 'rendered' })
    try {
      const first = await manager.start({ create: createIn(settingsOf()) })
      const second = await manager.start({ create: createIn(settingsOf()) })
      expect(manager.poll(first.loginId)).toEqual({ status: 'expired' })
      expect(manager.poll(second.loginId).status).toBe('waiting')
    } finally { manager.clear() }
  })
  it('reports an expired registration, a refused scan and a short TTL as expired or failed attempts', async () => {
    const expired = registration([{ errcode: 0, status: 'EXPIRED' }])
    const manager = new DingtalkLoginManager({ fetchImpl: expired.fetchImpl, pollIntervalMs: 1, renderQr: async () => 'rendered' })
    try {
      const attempt = await manager.start({ create: createIn(settingsOf()) })
      await vi.waitFor(() => expect(manager.poll(attempt.loginId)).toEqual({ status: 'expired' }))
    } finally { manager.clear() }
    const refused = registration([{ errcode: 0, status: 'FAIL', fail_reason: 'secret-1 was rejected' }])
    const failed = new DingtalkLoginManager({ fetchImpl: refused.fetchImpl, pollIntervalMs: 1, renderQr: async () => 'rendered' })
    try {
      const attempt = await failed.start({ create: createIn(settingsOf()) })
      await vi.waitFor(() => expect(failed.poll(attempt.loginId)).toMatchObject({ status: 'failed',
        error: 'DingTalk refused the QR sign-in' }))
    } finally { failed.clear() }
    // An attempt whose TTL passed is expired without another upstream call.
    const waiting = registration(Array(50).fill({ errcode: 0, status: 'WAITING' }))
    const short = new DingtalkLoginManager({ fetchImpl: waiting.fetchImpl, pollIntervalMs: 1, ttlMs: 30,
      renderQr: async () => 'rendered' })
    try {
      const attempt = await short.start({ create: createIn(settingsOf()) })
      await vi.waitFor(() => expect(short.poll(attempt.loginId).status).toBe('expired'))
    } finally { short.clear() }
  })
  it('fails the attempt without keeping the credentials when the account cannot be stored', async () => {
    const { fetchImpl } = registration([{ errcode: 0, status: 'SUCCESS', client_id: 'client-1', client_secret: 'secret-1' }])
    const manager = new DingtalkLoginManager({ fetchImpl, pollIntervalMs: 1, renderQr: async () => 'rendered' })
    try {
      const attempt = await manager.start({ create: async () => { throw new Error('the save failed: secret-1') } })
      await vi.waitFor(() => {
        const poll = manager.poll(attempt.loginId)
        expect(poll.status).toBe('failed')
        expect(poll.error).toContain('[redacted]')
        expect(poll.error).not.toContain('secret-1')
      })
    } finally { manager.clear() }
  })
  it('renders the verification address as a PNG data URL and rejects a start DingTalk cannot complete', async () => {
    expect((await renderDingtalkQrImage('https://login.dingtalk.com/oauth2/auth?x=1')).startsWith('data:image/png;base64,'))
      .toBe(true)
    const broken = new DingtalkLoginManager({ fetchImpl: fakeFetch(() => json({ errcode: 500 })).fetchImpl,
      pollIntervalMs: 1, renderQr: async () => 'rendered' })
    try {
      await expect(broken.start({ create: createIn(settingsOf()) })).rejects.toMatchObject({ code: 'api-error' })
      expect(broken.poll('whatever')).toEqual({ status: 'expired' })
    } finally { broken.clear() }
  })
})
