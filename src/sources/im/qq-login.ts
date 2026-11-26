/**
 * QQ QR sign-in sessions: one in-memory bind attempt for the whole installation, its bind-result poll and the Source
 * account a confirmed scan creates.
 *
 * An attempt lives five minutes and holds the host-only bind key and task id the panel's poll state never sees; starting a
 * new attempt supersedes the previous one, so only one scan is alive at a time. The panel receives only the attempt id and
 * a locally rendered PNG data URL of QQ's connect page — never the bind key, the task id or the AppSecret. On `confirmed`
 * the decrypted AppID, AppSecret and the scanning person's openid are handed to a caller that stores them (the management
 * route creates the QQ Source instance, whitelists the scanner and returns only the created account id); the AppSecret is
 * never returned to the panel, logged or put in a health detail.
 *
 * Protocol flow reimplemented from Tencent's public QQ Bot connector behavior (no code copied); see THIRD_PARTY_NOTICES.md.
 */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { buildConnectUrl, QqQrAuth, qqQrAuthFailureText, type QqQrAuthOptions } from './qq-qr-auth.ts'

/** How long one login attempt may stay open; the QR code stops being accepted after five minutes. */
export const QQ_LOGIN_TTL_MS = 5 * 60_000
/** How often the manager asks QQ for the bind result; the panel polls its own route every two seconds as well. */
export const QQ_LOGIN_POLL_MS = 2_000
/** The states one QQ QR sign-in attempt moves through, as the panel polls them. */
export type QqLoginStatus = 'waiting' | 'confirmed' | 'expired' | 'failed'
/** The credentials one confirmed scan provisioned; a secret, handed only to the caller that stores the account. */
export interface QqLoginCredentials {
  appId: string
  appSecret: string
  /** The openid of the person who scanned, when QQ sent one; added to the new account's allow-list. */
  userOpenid?: string
}
/** What starting a sign-in returns the panel: the attempt to poll, the QR image to show and when the attempt ends. */
export interface QqLoginStartView {
  loginId: string
  /** A PNG data URL of the connect page; never the address itself, the task id or the bind key. */
  qrImage: string
  /** When this attempt stops being usable, as an ISO time. */
  expiresAt: string
}
/** What one poll of a sign-in returns the panel. */
export interface QqLoginPollView {
  status: QqLoginStatus
  /** The created Source instance once `confirmed`; no credential is ever returned. */
  sourceId?: string
  /** Why the attempt failed, worded for the panel; never a credential. */
  error?: string
}
/** How the manager reaches QQ and the clock: production defaults, shortened in tests. */
export interface QqLoginManagerOptions extends QqQrAuthOptions {
  /** The clock the attempt TTL reads; tests inject one with the manager's shortened TTL. */
  now?: () => number
  ttlMs?: number
  /** The wait between two bind-result polls; QQ's connector uses two seconds. */
  pollIntervalMs?: number
  /** The `source` tag the connect page carries; empty by default, as Tencent's own connector leaves it. */
  source?: string
  /** Renders the connect address as a data URL. */
  renderQr?: (content: string) => Promise<string>
}
/** One in-memory login attempt: its host-only bind task, its state and the loop polling QQ. */
interface QqLoginSession {
  loginId: string
  taskId: string
  key: string
  createdAt: number
  expiresAt: number
  pollIntervalMs: number
  status: QqLoginStatus
  sourceId?: string
  error?: string
  controller: AbortController
}
/** Renders the connect address a person scans as a PNG data URL with the public `qrcode` package. */
export async function renderQqQrImage(content: string): Promise<string> {
  const module = await import('qrcode') as { toDataURL(text: string, options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    margin?: number; width?: number }): Promise<string> }
  return module.toDataURL(content, { errorCorrectionLevel: 'M', margin: 1, width: 320 })
}
/** One attempt's failure text, sanitized: the secret a failed account save may have been echoed with is removed. */
function loginFailureText(error: unknown, appSecret = ''): string {
  const text = error instanceof Error ? error.message : String(error)
  const redacted = appSecret ? text.split(appSecret).join('[redacted]') : text
  return redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted
}
/** Sleeps for `ms`, returning false when the caller aborted instead of throwing. */
async function nap(ms: number, signal: AbortSignal): Promise<boolean> {
  return delay(ms, undefined, { signal }).then(() => true, () => false)
}
/**
 * One installation's QQ login attempt at a time: starting an attempt supersedes the previous one, the background poll
 * keeps the state the panel polls current, and a confirmed attempt creates the account through the caller's `create` and
 * then stops. Nothing is written to disk here: the credentials go to the caller, which stores them in the settings; the
 * manager keeps only a bind task and the panel-visible state.
 */
export class QqLoginManager {
  private readonly sessions = new Map<string, QqLoginSession>()
  /** The newest attempt's id; an older attempt's poll reads `expired`. */
  private current = ''

  constructor(private readonly options: QqLoginManagerOptions = {}) {}
  /** The clock the attempt TTL reads. */
  private now(): number { return (this.options.now ?? Date.now)() }
  /** The TTL of one attempt, five minutes unless a test shortens it. */
  private get ttlMs(): number { return this.options.ttlMs ?? QQ_LOGIN_TTL_MS }
  /** The wait between two bind-result polls, two seconds unless a test shortens it. */
  private get pollIntervalMs(): number {
    const interval = this.options.pollIntervalMs ?? QQ_LOGIN_POLL_MS
    return Number.isFinite(interval) && interval > 0 ? interval : QQ_LOGIN_POLL_MS
  }
  /**
   * Starts one attempt: supersedes the previous one, creates a QQ bind task and returns its QR image. `create` receives
   * the confirmed AppID, AppSecret and user openid and returns the created Source instance id.
   */
  async start(request: { create: (credentials: QqLoginCredentials) => Promise<string> }): Promise<QqLoginStartView> {
    this.prune()
    this.supersede()
    const auth = new QqQrAuth({
      ...this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl },
      ...this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl },
      ...this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs },
    })
    const task = await auth.createBindTask()
    const qrImage = await (this.options.renderQr ?? renderQqQrImage)(buildConnectUrl(task.taskId, this.options.source))
    // A concurrent start may have registered its attempt while this one waited for QQ: only the newest stays readable,
    // and the loser is aborted so one installation never polls two bind tasks.
    this.supersede()
    const createdAt = this.now()
    const session: QqLoginSession = { loginId: randomUUID(), taskId: task.taskId, key: task.key, createdAt,
      expiresAt: createdAt + this.ttlMs, pollIntervalMs: this.pollIntervalMs, status: 'waiting',
      controller: new AbortController() }
    this.sessions.set(session.loginId, session)
    this.current = session.loginId
    void this.run(auth, session, request.create)
    return { loginId: session.loginId, qrImage, expiresAt: new Date(session.expiresAt).toISOString() }
  }
  /**
   * Reads one attempt's state without contacting QQ: the background poll keeps it current, so the panel's request is fast
   * and safe to send every two seconds. An unknown or superseded attempt reads `expired`.
   */
  poll(loginId: string): QqLoginPollView {
    const session = this.sessions.get(loginId)
    if (!session || session.loginId !== this.current) return { status: 'expired' }
    if (session.status !== 'confirmed' && this.now() >= session.expiresAt) {
      session.controller.abort()
      session.taskId = ''
      session.key = ''
      session.status = 'expired'
    }
    return { status: session.status, ...session.sourceId === undefined ? {} : { sourceId: session.sourceId },
      ...session.error === undefined ? {} : { error: session.error } }
  }
  /** Aborts and forgets every attempt; tests use it between cases. */
  clear(): void {
    for (const session of this.sessions.values()) session.controller.abort()
    this.sessions.clear()
    this.current = ''
  }
  /** Aborts and expires the previous attempt, so only one bind task is alive at a time. */
  private supersede(): void {
    const previous = this.sessions.get(this.current)
    if (!previous) return
    previous.controller.abort()
    previous.taskId = ''
    previous.key = ''
    if (previous.status === 'waiting') previous.status = 'expired'
  }
  /** Drops attempts well past their TTL and keeps the map small when a person retries repeatedly. */
  private prune(): void {
    const now = this.now()
    for (const [loginId, session] of this.sessions) {
      if (loginId !== this.current && now - session.createdAt > this.ttlMs * 2) this.sessions.delete(loginId)
    }
    while (this.sessions.size > 5) {
      const oldest = [...this.sessions.values()].filter(session => session.loginId !== this.current)
        .sort((one, two) => one.createdAt - two.createdAt)[0]
      if (!oldest) break
      this.sessions.delete(oldest.loginId)
    }
  }
  /** One attempt's background poll: updates its state and hands the confirmed credentials to `create`. */
  private async run(auth: QqQrAuth, session: QqLoginSession,
    create: (credentials: QqLoginCredentials) => Promise<string>): Promise<void> {
    const fail = (error: string): void => {
      session.status = 'failed'
      session.error = error
      session.taskId = ''
      session.key = ''
    }
    try {
      while (!session.controller.signal.aborted) {
        if (this.now() >= session.expiresAt) { session.status = 'expired'; session.taskId = ''; session.key = ''; return }
        const poll = await auth.pollBindResult({ taskId: session.taskId, key: session.key,
          signal: session.controller.signal })
        if (session.controller.signal.aborted) return
        if (poll.status === 'COMPLETED') {
          const appId = poll.appId ?? ''
          const appSecret = poll.appSecret ?? ''
          session.taskId = ''
          session.key = ''
          if (!appId || !appSecret) { fail('QQ returned an incomplete bind result'); return }
          try {
            session.sourceId = await create({ appId, appSecret,
              ...poll.userOpenid === undefined ? {} : { userOpenid: poll.userOpenid } })
            session.status = 'confirmed'
          } catch (error) {
            // The account could not be stored: say why, and never keep the credentials of the attempt.
            fail(loginFailureText(error, appSecret))
          }
          return
        }
        if (poll.status === 'EXPIRED') { session.status = 'expired'; session.taskId = ''; session.key = ''; return }
        if (poll.status !== 'NONE' && poll.status !== 'PENDING') {
          fail('QQ reported an unknown bind state')
          return
        }
        session.status = 'waiting'
        if (!await nap(session.pollIntervalMs, session.controller.signal)) return
      }
    } catch (error) {
      if (session.controller.signal.aborted) return
      fail(qqQrAuthFailureText(error))
    }
  }
}
/** The installation's QQ login attempts; the management routes share it. */
export const qqLogins = new QqLoginManager()
/** Aborts and forgets every attempt of the shared manager; tests use it between cases. */
export function clearQqLogins(): void { qqLogins.clear() }
