/**
 * QQ QR bind-task client: the QR code a person scans in mobile QQ to bind (or create) the open-platform bot whose
 * AppID, AppSecret and user openid then become one Source account.
 *
 * A scan starts by generating a 32-byte key on this host and sending it to `/lite/create_bind_task`, which answers the
 * task id the QR code carries. The code itself is the openclaw connect page
 * (`https://q.qq.com/qqbot/openclaw/connect.html?task_id=<task_id>&source=<source>&_wv=2`). `/lite/poll_bind_result`
 * is then polled with the task id until it answers NONE (0), PENDING (1), COMPLETED (2) or EXPIRED (3); a COMPLETED
 * answer carries `bot_appid`, `bot_encrypt_secret` and `user_openid`. The encrypted secret is base64 AES-256-GCM
 * ciphertext — its first 12 bytes are the IV, its last 16 the auth tag — decrypted with the key this host generated, so
 * the AppSecret only exists decrypted on this machine. Every call is a POST to `https://q.qq.com` only, never follows a
 * redirect, is bounded to 15 s, and every failure is sanitized: no answer body, key or secret appears in an error message.
 *
 * Protocol flow reimplemented from Tencent's public QQ Bot connector behavior (no code copied); see THIRD_PARTY_NOTICES.md.
 */
import { createDecipheriv, randomBytes } from 'node:crypto'

/** The only host a bind-task call is ever sent to. */
export const QQ_BIND_BASE = 'https://q.qq.com'
/** How long one bind-task call may take before it is abandoned. */
export const QQ_BIND_TIMEOUT_MS = 15_000
/** The connect page a scanned QR code opens; `task_id` and `source` are its query parameters. */
export const QQ_CONNECT_PAGE = 'https://q.qq.com/qqbot/openclaw/connect.html'
/** The bind-task statuses QQ answers with, in QQ's own numeric order; an unrecognized one fails the attempt. */
export const QQ_BIND_STATUSES = ['NONE', 'PENDING', 'COMPLETED', 'EXPIRED'] as const
export type QqBindStatus = typeof QQ_BIND_STATUSES[number] | 'UNKNOWN'
/** The kinds of failure one bind-task call can have; never carries an answer body, the key or a secret. */
export type QqQrAuthFailure = 'invalid-route' | 'network-error' | 'timeout' | 'http-error' | 'invalid-json'
  | 'invalid-response' | 'api-error' | 'invalid-task' | 'incomplete-bind' | 'invalid-secret'
/** One classified bind-task failure: its kind, the stage that failed, QQ's retcode and, when there was one, the HTTP status. */
export class QqQrAuthError extends Error {
  readonly code: QqQrAuthFailure
  /** The bind-task stage that failed: `create`, `poll` or `decrypt`. */
  readonly action: string
  readonly status: number | undefined
  /** Tencent's own `retcode` when the answer was a rejection; it is a code, never an answer body. */
  readonly retcode: number | undefined

  constructor(code: QqQrAuthFailure, message: string, action: string, options: { status?: number
    retcode?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'QqQrAuthError'
    this.code = code
    this.action = action
    this.status = options.status
    this.retcode = options.retcode
  }
}
/** A started bind task: the id the QR code carries and the host-only key that decrypts the confirmed secret. */
export interface QqBindTask {
  /** The task id polled and put in the QR code; not a credential. */
  taskId: string
  /** The 32-byte AES-256-GCM key as base64; it stays on this host and never reaches the panel. */
  key: string
}
/** One normalized bind-result poll: the state and, on COMPLETED, the bot's credentials and the scanning person. */
export interface QqBindResult {
  status: QqBindStatus
  /** The bot's AppID; present only on COMPLETED. */
  appId?: string
  /** The bot's AppSecret, decrypted; present only on COMPLETED and never returned to the panel. */
  appSecret?: string
  /** The openid of the person who scanned, when QQ sent one; it identifies them per bot, not a QQ number. */
  userOpenid?: string
}
/** How to reach QQ's bind service: the injected fetch and base keep tests off the network. */
export interface QqQrAuthOptions {
  fetchImpl?: typeof fetch
  /** The bind base; production uses `https://q.qq.com`, and only that HTTPS host is accepted. */
  baseUrl?: string
  timeoutMs?: number
}

const nonEmpty = (value: unknown): string => typeof value === 'string' && value.trim() ? value.trim() : ''
/** A 32-byte random key as base64, the AES-256-GCM key one bind task uses. */
export function generateBindKey(): string {
  return randomBytes(32).toString('base64')
}
/** Whether an address names QQ's bind service, the only service a bind-task call may target. */
function isQqHost(hostname: string): boolean {
  return hostname.toLowerCase().replace(/\.$/, '') === 'q.qq.com'
}
/**
 * The trusted bind base: HTTPS on `q.qq.com`, no credentials, no query, no fragment and the standard port only. Throws
 * rather than contacting anything else.
 */
function normalizeBaseUrl(value: unknown): string {
  let url: URL
  try { url = new URL(nonEmpty(value) || QQ_BIND_BASE) } catch { throw invalidBase() }
  if (url.protocol !== 'https:' || !isQqHost(url.hostname) || url.port || url.username || url.password
    || url.search || url.hash) throw invalidBase()
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.href.replace(/\/$/, '')
}
function invalidBase(): QqQrAuthError {
  return new QqQrAuthError('invalid-route', 'The QQ bind base must be https://q.qq.com', 'create')
}
/** Tencent's own rejection code when the answer carried one, or undefined when the answer succeeded. */
function rejectedRetcode(value: Record<string, unknown>): number | undefined {
  const retcode = Number(value.retcode)
  return Number.isFinite(retcode) && retcode !== 0 ? retcode : undefined
}
/** The status number QQ answered, normalized to its name; an absent status reads NONE, as QQ's own connector does. */
function statusOf(value: unknown): QqBindStatus {
  if (value === undefined || value === null || value === '') return 'NONE'
  const status = Number(value)
  if (!Number.isInteger(status) || status < 0 || status >= QQ_BIND_STATUSES.length) return 'UNKNOWN'
  return QQ_BIND_STATUSES[status]!
}
/**
 * Builds the QR content one bind task is scanned as: QQ's connect page with the task id and the source tag. The address
 * is always HTTPS on `q.qq.com`; the task id and source are query-encoded, so neither can change the origin.
 */
export function buildConnectUrl(taskId: string, source = ''): string {
  const task = nonEmpty(taskId)
  if (!task) throw new TypeError('taskId is required')
  const tag = nonEmpty(source)
  return `${QQ_CONNECT_PAGE}?task_id=${encodeURIComponent(task)}&source=${encodeURIComponent(tag)}&_wv=2`
}
/**
 * Decrypts a `bot_encrypt_secret`: the base64 ciphertext holds the 12-byte IV first and the 16-byte GCM auth tag last,
 * with the ciphertext between them, and `key` is the base64 32-byte AES-256-GCM key this host generated. A key or
 * ciphertext that does not fit, a failed authentication and an empty or non-text plaintext all fail with a sanitized
 * error: no key, ciphertext or plaintext appears in a message.
 */
export function decryptBindSecret(encryptedSecret: string, key: string): string {
  const ciphertext = nonEmpty(encryptedSecret)
  const keyText = nonEmpty(key)
  if (!ciphertext || !keyText) throw invalidSecret()
  let raw: Buffer
  let keyBytes: Buffer
  try {
    raw = Buffer.from(ciphertext, 'base64')
    keyBytes = Buffer.from(keyText, 'base64')
  } catch { throw invalidSecret() }
  // A 12-byte IV plus a 16-byte tag plus at least one ciphertext byte; a 32-byte key is AES-256.
  if (raw.length <= 28 || keyBytes.length !== 32) throw invalidSecret()
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(raw.length - 16)
  const body = raw.subarray(12, raw.length - 16)
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBytes, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
    if (!plaintext.trim()) throw invalidSecret()
    return plaintext
  } catch (error) {
    if (error instanceof QqQrAuthError) throw error
    // The crypto error may quote the tag, the ciphertext or the key; none of it belongs in a failure of this client.
    throw invalidSecret()
  }
}
function invalidSecret(): QqQrAuthError {
  return new QqQrAuthError('invalid-secret', 'The QQ bind secret could not be decrypted', 'decrypt')
}
/**
 * Host-only client for QQ's QR bind-task flow. `createBindTask` generates the key and starts one task; `pollBindResult`
 * reads its state and, on COMPLETED, decrypts the AppSecret. Nothing is cached between calls and no error carries an
 * answer body, the key or a secret.
 */
export class QqQrAuth {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(options: QqQrAuthOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    const timeoutMs = options.timeoutMs ?? QQ_BIND_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive number')
    this.timeoutMs = timeoutMs
  }

  /** Starts one bind task: the host-only key and the task id the QR code carries. */
  async createBindTask(options: { signal?: AbortSignal } = {}): Promise<QqBindTask> {
    const key = generateBindKey()
    const answer = await this.post('/lite/create_bind_task', { key }, 'create', options.signal)
    const data = answer.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new QqQrAuthError('invalid-task', 'The QQ bind task answer carried no task', 'create')
    }
    const taskId = nonEmpty((data as Record<string, unknown>).task_id)
    if (!taskId) throw new QqQrAuthError('invalid-task', 'The QQ bind task answer carried no task id', 'create')
    return { taskId, key }
  }

  /**
   * Polls one bind task; on COMPLETED the answer's encrypted secret is decrypted with `key`, so the only AppSecret this
   * client ever returns is the plaintext one, and it goes no further than the caller that stores it.
   */
  async pollBindResult(request: { taskId: string; key: string; signal?: AbortSignal }): Promise<QqBindResult> {
    const taskId = nonEmpty(request?.taskId)
    if (!taskId) throw new TypeError('taskId is required')
    const key = nonEmpty(request?.key)
    if (!key) throw new TypeError('key is required')
    const answer = await this.post('/lite/poll_bind_result', { task_id: taskId }, 'poll', request.signal)
    const data = answer.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new QqQrAuthError('invalid-response', 'The QQ bind poll answer was invalid', 'poll')
    }
    const value = data as Record<string, unknown>
    const status = statusOf(value.status)
    if (status !== 'COMPLETED') return { status }
    const appId = nonEmpty(value.bot_appid)
    const encrypted = nonEmpty(value.bot_encrypt_secret)
    if (!appId || !encrypted) throw new QqQrAuthError('incomplete-bind',
      'The QQ bind poll answer carried an incomplete bot', 'poll')
    return { status, appId, appSecret: decryptBindSecret(encrypted, key),
      userOpenid: nonEmpty(value.user_openid) || undefined }
  }

  /** One JSON bind-task call with the bounded timeout and the caller's abort signal. */
  private async post(path: string, body: unknown, action: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body),
        redirect: 'error', signal: combined })
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('The QQ bind request was stopped')
      if (timeout.aborted) throw new QqQrAuthError('timeout', `The QQ bind ${action} request timed out`, action, { cause: error })
      throw new QqQrAuthError('network-error', `The QQ bind ${action} request could not be completed`, action, { cause: error })
    }
    if (!response.ok) throw new QqQrAuthError('http-error', `The QQ bind ${action} request failed`, action,
      { status: response.status })
    let parsed: unknown
    try { parsed = await response.json() } catch {
      // The parse error may quote the answer body, which never appears in a failure of this client.
      throw new QqQrAuthError('invalid-json', `The QQ bind ${action} answer was not JSON`, action)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new QqQrAuthError('invalid-response', `The QQ bind ${action} answer was invalid`, action)
    }
    const value = parsed as Record<string, unknown>
    const retcode = rejectedRetcode(value)
    if (retcode !== undefined) {
      throw new QqQrAuthError('api-error', `The QQ bind ${action} request was rejected (retcode ${retcode})`, action,
        { retcode })
    }
    return value
  }
}
/** A one-line, sanitized description of a bind-task failure, for a panel message. */
export function qqQrAuthFailureText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}
