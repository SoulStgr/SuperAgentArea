/**
 * The QQ QR bind-task client and its login manager, without QQ: the create/poll payloads over a fake fetch, the status
 * normalization, the AES-256-GCM decryption of the provisioned AppSecret, sanitized failures, and the manager creating
 * one Source account for a confirmed scan.
 */
import { createCipheriv, randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildConnectUrl, decryptBindSecret, generateBindKey, QqQrAuth, QqQrAuthError, QQ_BIND_BASE,
} from '../src/sources/im/qq-qr-auth.ts'
import { clearQqLogins, QqLoginManager, renderQqQrImage, type QqLoginCredentials } from '../src/sources/im/qq-login.ts'

/** One recorded bind call: its address, method, headers, parsed body and redirect mode. */
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
/** The AES-256-GCM ciphertext QQ sends as `bot_encrypt_secret`: IV first, then ciphertext, then the auth tag. */
function sealSecret(plaintext: string, key: string): string {
  const keyBytes = Buffer.from(key, 'base64')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyBytes, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64')
}
/** A fake QQ bind service: it remembers the key the client sent and answers the queued poll bodies in order. */
function bindService(polls: (unknown | ((key: string) => unknown))[]): { fetchImpl: typeof fetch; calls: FakeCall[]
  key: () => string } {
  const queue = [...polls]
  let key = ''
  const { fetchImpl, calls } = fakeFetch(call => {
    if (call.url.endsWith('/lite/create_bind_task')) {
      key = String(call.body.key ?? '')
      return json({ retcode: 0, data: { task_id: 'task-1' } })
    }
    const next = queue.shift() ?? { retcode: 0, data: { status: 0 } }
    return json(typeof next === 'function' ? (next as (key: string) => unknown)(key) : next)
  })
  return { fetchImpl, calls, key: () => key }
}
/** A fetch that never answers until its request is aborted, as a hung bind service does. */
const hangingFetch = (): typeof fetch => ((_url: URL | string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  const signal = init?.signal
  const fail = (): void => reject(new DOMException('The operation was aborted', 'AbortError'))
  if (signal?.aborted) { fail(); return }
  signal?.addEventListener('abort', fail, { once: true })
})) as typeof fetch
beforeEach(() => { clearQqLogins() })

describe('the bind-task client', () => {
  it('starts a bind task with a host-generated 32-byte key and returns the task id', async () => {
    const { fetchImpl, calls } = bindService([])
    const auth = new QqQrAuth({ fetchImpl })
    const task = await auth.createBindTask()
    expect(task.taskId).toBe('task-1')
    // The key is 32 random bytes as base64, generated here and sent only to QQ's create_bind_task.
    expect(Buffer.from(task.key, 'base64')).toHaveLength(32)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: 'https://q.qq.com/lite/create_bind_task', method: 'POST',
      body: { key: task.key }, redirect: 'error',
      headers: expect.objectContaining({ accept: 'application/json', 'content-type': 'application/json' }) })
  })
  it('builds the connect page a person scans from the task id and the source tag', () => {
    expect(buildConnectUrl('task-1')).toBe('https://q.qq.com/qqbot/openclaw/connect.html?task_id=task-1&source=&_wv=2')
    expect(buildConnectUrl('a b&c', 'dsh/superagent')).toBe(
      'https://q.qq.com/qqbot/openclaw/connect.html?task_id=a%20b%26c&source=dsh%2Fsuperagent&_wv=2')
    expect(() => buildConnectUrl('  ')).toThrow(TypeError)
  })
  it('polls the four bind states and decrypts the completed AppSecret with the task key', async () => {
    const secret = 'qq-app-secret-1'
    const { fetchImpl, calls } = bindService([
      { retcode: 0, data: { status: 0 } },
      { retcode: 0, data: { status: 1 } },
      (key: string) => ({ retcode: 0, data: { status: 2, bot_appid: 'app-1', user_openid: 'openid-1',
        bot_encrypt_secret: sealSecret(secret, key) } }),
      { retcode: 0, data: { status: 3 } },
      { retcode: 0, data: { status: 9 } },
    ])
    const auth = new QqQrAuth({ fetchImpl })
    const task = await auth.createBindTask()
    expect(await auth.pollBindResult({ taskId: task.taskId, key: task.key })).toEqual({ status: 'NONE' })
    expect(await auth.pollBindResult({ taskId: task.taskId, key: task.key })).toEqual({ status: 'PENDING' })
    expect(await auth.pollBindResult({ taskId: task.taskId, key: task.key })).toEqual({ status: 'COMPLETED',
      appId: 'app-1', appSecret: secret, userOpenid: 'openid-1' })
    expect(await auth.pollBindResult({ taskId: task.taskId, key: task.key })).toEqual({ status: 'EXPIRED' })
    expect(await auth.pollBindResult({ taskId: task.taskId, key: task.key })).toEqual({ status: 'UNKNOWN' })
    expect(calls[1]).toMatchObject({ url: 'https://q.qq.com/lite/poll_bind_result', method: 'POST',
      body: { task_id: 'task-1' }, redirect: 'error' })
    await expect(auth.pollBindResult({ taskId: '  ', key: task.key })).rejects.toThrow(TypeError)
    await expect(auth.pollBindResult({ taskId: task.taskId, key: '' })).rejects.toThrow(TypeError)
  })
  it('fails an incomplete completed answer and a completed answer it cannot decrypt', async () => {
    const incomplete = bindService([{ retcode: 0, data: { status: 2, bot_appid: 'app-1' } }])
    const auth = new QqQrAuth({ fetchImpl: incomplete.fetchImpl })
    const task = await auth.createBindTask()
    await expect(auth.pollBindResult({ taskId: task.taskId, key: task.key }))
      .rejects.toMatchObject({ code: 'incomplete-bind', action: 'poll' })
    const broken = bindService([{ retcode: 0, data: { status: 2, bot_appid: 'app-1',
      bot_encrypt_secret: sealSecret('qq-app-secret-1', generateBindKey()) } }])
    const other = new QqQrAuth({ fetchImpl: broken.fetchImpl })
    const otherTask = await other.createBindTask()
    const failure = await other.pollBindResult({ taskId: otherTask.taskId, key: otherTask.key })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'invalid-secret', action: 'decrypt' })
    expect(String((failure as Error).message)).not.toContain('qq-app-secret-1')
  })
  it('classifies a rejected, failed, malformed, refused-redirect and timed-out call without an answer body', async () => {
    const rejected = bindService([{ retcode: 1001, msg: 'bad key', data: { bot_encrypt_secret: 'secret-1' } }])
    const refused = await new QqQrAuth({ fetchImpl: rejected.fetchImpl }).pollBindResult({ taskId: 'task-1',
      key: generateBindKey() }).catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: 'api-error', action: 'poll', retcode: 1001 })
    expect(String((refused as Error).message)).not.toContain('secret-1')
    const http = fakeFetch(() => json({ error: 'nope', bot_encrypt_secret: 'secret-1' }, 503))
    await expect(new QqQrAuth({ fetchImpl: http.fetchImpl }).createBindTask())
      .rejects.toMatchObject({ code: 'http-error', status: 503 })
    const malformed = fakeFetch(() => new Response('<html>', { status: 200 }))
    await expect(new QqQrAuth({ fetchImpl: malformed.fetchImpl }).createBindTask())
      .rejects.toMatchObject({ code: 'invalid-json', action: 'create' })
    const network = fakeFetch(() => new Error('socket closed'))
    await expect(new QqQrAuth({ fetchImpl: network.fetchImpl }).createBindTask())
      .rejects.toMatchObject({ code: 'network-error', action: 'create' })
    // `redirect: 'error'` is on every call: a service that redirects makes fetch throw, which is a network failure here.
    const redirected = fakeFetch(call => call.redirect === 'error'
      ? new TypeError('Failed to fetch: redirect not allowed') : json({ retcode: 0 }))
    await expect(new QqQrAuth({ fetchImpl: redirected.fetchImpl }).createBindTask())
      .rejects.toMatchObject({ code: 'network-error' })
    await expect(new QqQrAuth({ fetchImpl: hangingFetch(), timeoutMs: 20 }).createBindTask())
      .rejects.toMatchObject({ code: 'timeout', action: 'create' })
    const empty = fakeFetch(() => json({ retcode: 0, data: {} }))
    await expect(new QqQrAuth({ fetchImpl: empty.fetchImpl }).createBindTask())
      .rejects.toMatchObject({ code: 'invalid-task', action: 'create' })
  })
  it('refuses a bind base that is not exactly the QQ HTTPS host, and a bad timeout', () => {
    const { fetchImpl } = bindService([])
    for (const baseUrl of ['http://q.qq.com', 'https://evil.example', 'https://test.q.qq.com', 'https://q.qq.com:8443',
      'https://q.qq.com/?x=1', 'https://user:pass@q.qq.com']) {
      expect(() => new QqQrAuth({ fetchImpl, baseUrl })).toThrow(QqQrAuthError)
    }
    expect(() => new QqQrAuth({ fetchImpl, timeoutMs: 0 })).toThrow(TypeError)
    // The production base is QQ's own host.
    expect(QQ_BIND_BASE).toBe('https://q.qq.com')
  })
  it('decrypts only well-formed AES-256-GCM answers, failing without echoing key or plaintext', () => {
    const key = generateBindKey()
    expect(decryptBindSecret(sealSecret('qq-app-secret-1', key), key)).toBe('qq-app-secret-1')
    const sealed = sealSecret('qq-app-secret-1', key)
    const cases: [string, string][] = [
      [sealed, generateBindKey()],
      [sealed, key.slice(0, 24)],
      [Buffer.alloc(10).toString('base64'), key],
      [Buffer.concat([Buffer.from('00'.repeat(40), 'hex')]).toString('base64'), key],
      ['not base64 at all !!!', key],
      ['', key],
    ]
    for (const [encrypted, wrongKey] of cases) {
      const failure = (() => { try { decryptBindSecret(encrypted, wrongKey); return undefined } catch (error) { return error } })()
      expect(failure).toMatchObject({ name: 'QqQrAuthError', code: 'invalid-secret' })
      const message = String((failure as Error).message) + JSON.stringify(failure)
      expect(message).not.toContain('qq-app-secret-1')
      expect(message).not.toContain(key)
    }
  })
})

describe('the login manager', () => {
  /** One fake settings store the manager's `create` writes a Source instance into. */
  function settingsOf(): { sources: Record<string, { label?: string; config: Record<string, unknown> }> } {
    return { sources: {} }
  }
  /** The `create` callback of one attempt: stores the credentials as the host's account creation does. */
  const createIn = (settings: ReturnType<typeof settingsOf>) =>
    async (credentials: QqLoginCredentials): Promise<string> => {
      settings.sources.qq = { label: 'QQ（扫码）', config: { appId: credentials.appId, appSecret: credentials.appSecret,
        sandbox: false, ...credentials.userOpenid ? { allowedUserIds: credentials.userOpenid } : {} } }
      return 'qq'
    }
  it('creates the account once a scanned bind is confirmed, and never returns its secret', async () => {
    const secret = 'qq-app-secret-1'
    const polls: unknown[] = [{ retcode: 0, data: { status: 1 } }, { retcode: 0, data: { status: 2, bot_appid: 'app-1',
      user_openid: 'openid-1', bot_encrypt_secret: '' } }]
    // The completed poll must be sealed with the key the manager itself generated, so the fake service reads it from the
    // create_bind_task body it received.
    let key = ''
    const { fetchImpl } = fakeFetch(call => {
      if (call.url.endsWith('/lite/create_bind_task')) {
        key = String(call.body.key ?? '')
        return json({ retcode: 0, data: { task_id: 'task-1' } })
      }
      const answer = polls.shift() as { data: Record<string, unknown> }
      if (answer.data.status === 2) answer.data.bot_encrypt_secret = sealSecret(secret, key)
      return json(answer)
    })
    const settings = settingsOf()
    const manager = new QqLoginManager({ fetchImpl, pollIntervalMs: 1,
      renderQr: async content => `rendered:${content}`, source: 'dsh/superagent' })
    try {
      const started = await manager.start({ create: createIn(settings) })
      // The panel gets the attempt id and a rendered QR image; the task id, key and secret stay on the host.
      expect(started.loginId).toEqual(expect.any(String))
      expect(started.qrImage).toBe('rendered:https://q.qq.com/qqbot/openclaw/connect.html?task_id=task-1'
        + '&source=dsh%2Fsuperagent&_wv=2')
      expect(started.expiresAt).toEqual(expect.any(String))
      expect(JSON.stringify(started)).not.toContain(key)
      expect(manager.poll(started.loginId)).toEqual({ status: 'waiting' })
      await vi.waitFor(() => expect(manager.poll(started.loginId))
        .toMatchObject({ status: 'confirmed', sourceId: 'qq' }))
      expect(settings.sources.qq).toEqual({ label: 'QQ（扫码）', config: { appId: 'app-1', appSecret: secret,
        sandbox: false, allowedUserIds: 'openid-1' } })
      expect(JSON.stringify(manager.poll(started.loginId))).not.toContain(secret)
      // Only the newest attempt is readable; an unknown attempt reads expired.
      expect(manager.poll('unknown')).toEqual({ status: 'expired' })
    } finally { manager.clear() }
  })
  it('keeps one attempt at a time: a new scan supersedes the previous one as expired', async () => {
    const { fetchImpl } = fakeFetch(call => call.url.endsWith('/lite/create_bind_task')
      ? json({ retcode: 0, data: { task_id: 'task-1' } })
      : json({ retcode: 0, data: { status: 0 } }))
    const manager = new QqLoginManager({ fetchImpl, pollIntervalMs: 1, renderQr: async () => 'rendered' })
    try {
      const first = await manager.start({ create: createIn(settingsOf()) })
      const second = await manager.start({ create: createIn(settingsOf()) })
      expect(manager.poll(first.loginId)).toEqual({ status: 'expired' })
      expect(manager.poll(second.loginId).status).toBe('waiting')
    } finally { manager.clear() }
  })
  it('keeps only the newest attempt when two scans start together, aborting the loser', async () => {
    const { fetchImpl } = fakeFetch(call => call.url.endsWith('/lite/create_bind_task')
      ? json({ retcode: 0, data: { task_id: 'task-1' } })
      : json({ retcode: 0, data: { status: 0 } }))
    const manager = new QqLoginManager({ fetchImpl, pollIntervalMs: 1, renderQr: async () => 'rendered' })
    try {
      const [first, second] = await Promise.all([manager.start({ create: createIn(settingsOf()) }),
        manager.start({ create: createIn(settingsOf()) })])
      expect(manager.poll(first.loginId)).toEqual({ status: 'expired' })
      expect(manager.poll(second.loginId).status).toBe('waiting')
    } finally { manager.clear() }
  })
  it('reports an expired bind, an unknown state and a short TTL as expired or failed attempts', async () => {
    const expired = bindService([{ retcode: 0, data: { status: 3 } }])
    const manager = new QqLoginManager({ fetchImpl: expired.fetchImpl, pollIntervalMs: 1, renderQr: async () => 'rendered' })
    try {
      const attempt = await manager.start({ create: createIn(settingsOf()) })
      await vi.waitFor(() => expect(manager.poll(attempt.loginId)).toEqual({ status: 'expired' }))
    } finally { manager.clear() }
    const unknown = bindService([{ retcode: 0, data: { status: 42 } }])
    const failed = new QqLoginManager({ fetchImpl: unknown.fetchImpl, pollIntervalMs: 1, renderQr: async () => 'rendered' })
    try {
      const attempt = await failed.start({ create: createIn(settingsOf()) })
      await vi.waitFor(() => expect(failed.poll(attempt.loginId)).toMatchObject({ status: 'failed',
        error: 'QQ reported an unknown bind state' }))
    } finally { failed.clear() }
    // An attempt whose TTL passed is expired without another upstream call.
    const waiting = bindService(Array(50).fill({ retcode: 0, data: { status: 1 } }))
    const short = new QqLoginManager({ fetchImpl: waiting.fetchImpl, pollIntervalMs: 1, ttlMs: 30,
      renderQr: async () => 'rendered' })
    try {
      const attempt = await short.start({ create: createIn(settingsOf()) })
      await vi.waitFor(() => expect(short.poll(attempt.loginId).status).toBe('expired'))
    } finally { short.clear() }
  })
  it('fails the attempt without keeping the credentials when the account cannot be stored', async () => {
    const secret = 'qq-app-secret-1'
    let key = ''
    const { fetchImpl } = fakeFetch(call => {
      if (call.url.endsWith('/lite/create_bind_task')) {
        key = String(call.body.key ?? '')
        return json({ retcode: 0, data: { task_id: 'task-1' } })
      }
      return json({ retcode: 0, data: { status: 2, bot_appid: 'app-1', user_openid: 'openid-1',
        bot_encrypt_secret: sealSecret(secret, key) } })
    })
    const manager = new QqLoginManager({ fetchImpl, pollIntervalMs: 1, renderQr: async () => 'rendered' })
    try {
      const attempt = await manager.start({ create: async () => { throw new Error(`the save failed: ${secret}`) } })
      await vi.waitFor(() => {
        const poll = manager.poll(attempt.loginId)
        expect(poll.status).toBe('failed')
        expect(poll.error).toContain('[redacted]')
        expect(poll.error).not.toContain(secret)
      })
    } finally { manager.clear() }
  })
  it('renders the connect page as a PNG data URL and rejects a start QQ cannot complete', async () => {
    expect((await renderQqQrImage('https://q.qq.com/qqbot/openclaw/connect.html?task_id=task-1&source=&_wv=2'))
      .startsWith('data:image/png;base64,')).toBe(true)
    const broken = new QqLoginManager({ fetchImpl: fakeFetch(() => json({ retcode: 500 })).fetchImpl,
      pollIntervalMs: 1, renderQr: async () => 'rendered' })
    try {
      await expect(broken.start({ create: createIn(settingsOf()) })).rejects.toMatchObject({ code: 'api-error',
        retcode: 500 })
      expect(broken.poll('whatever')).toEqual({ status: 'expired' })
    } finally { broken.clear() }
  })
})
