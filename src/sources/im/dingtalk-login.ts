/**
 * DingTalk QR sign-in sessions: one in-memory login attempt, its device-registration poll and the Source account a
 * confirmed scan creates.
 *
 * An attempt lives ten minutes and holds the host-only device code and the state the panel polls; starting a new attempt
 * supersedes the previous one. The panel receives only the attempt id and a locally rendered PNG data URL of
 * `verification_uri_complete` — never the device code. On `confirmed` the polled Client ID and Client Secret are handed
 * to a caller that stores them (the management route creates the DingTalk Source instance) and only the created account
 * id is returned; the secret is never returned to the panel, logged or put in a health detail.
 *
 * Protocol details adapted from dsh-im (MIT, Copyright (c) 2026 xmanrui, upstream 5.10.0), file
 * `src/channels/dingtalk/device-auth.mjs` (the registration lifecycle and the provisioned credentials); see
 * THIRD_PARTY_NOTICES.md.
 */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { DingtalkDeviceAuth, dingtalkDeviceAuthFailureText, type DingtalkDeviceAuthOptions } from './dingtalk-device-auth.ts'

/** How long one login attempt may stay open; the QR code stops being accepted after ten minutes. */
export const DINGTALK_LOGIN_TTL_MS = 10 * 60_000
/** How often the manager polls DingTalk when the registration did not name an interval of its own. */
export const DINGTALK_LOGIN_POLL_MS = 5_000
/** The states one DingTalk QR sign-in attempt moves through, as the panel polls them. */
export type DingtalkLoginStatus = 'waiting' | 'confirmed' | 'expired' | 'failed'
/** The credentials one confirmed scan provisioned; a secret, handed only to the caller that stores the account. */
export interface DingtalkLoginCredentials {
  clientId: string
  clientSecret: string
}
/** What starting a sign-in returns the panel: the attempt to poll, the QR image to show and when the attempt ends. */
export interface DingtalkLoginStartView {
  loginId: string
  /** A PNG data URL of the verification address; never the address itself and never the device code. */
  qrImage: string
  /** When this attempt stops being usable, as an ISO time. */
  expiresAt: string
}
/** What one poll of a sign-in returns the panel. */
export interface DingtalkLoginPollView {
  status: DingtalkLoginStatus
  /** The created Source instance once `confirmed`; no credential is ever returned. */
  sourceId?: string
  /** Why the attempt failed, worded for the panel; never a credential. */
  error?: string
}
/** How the manager reaches DingTalk and the clock: production defaults, shortened in tests. */
export interface DingtalkLoginManagerOptions extends DingtalkDeviceAuthOptions {
  ttlMs?: number
  /** The wait between two status polls of one attempt; defaults to the interval DingTalk named. */
  pollIntervalMs?: number
  /** Renders the verification address as a data URL. */
  renderQr?: (content: string) => Promise<string>
}
/** One in-memory login attempt: its host-only device code, its state and the loop polling DingTalk. */
interface DingtalkLoginSession {
  loginId: string
  deviceCode: string
  createdAt: number
  expiresAt: number
  pollIntervalMs: number
  status: DingtalkLoginStatus
  sourceId?: string
  error?: string
  controller: AbortController
}
/** Renders the verification address a person scans as a PNG data URL with the public `qrcode` package. */
export async function renderDingtalkQrImage(content: string): Promise<string> {
  const module = await import('qrcode') as { toDataURL(text: string, options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    margin?: number; width?: number }): Promise<string> }
  return module.toDataURL(content, { errorCorrectionLevel: 'M', margin: 1, width: 320 })
}
/** One attempt's failure text, sanitized: the secret a failed account save may have been echoed with is removed. */
function loginFailureText(error: unknown, clientSecret = ''): string {
  const text = error instanceof Error ? error.message : String(error)
  const redacted = clientSecret ? text.split(clientSecret).join('[redacted]') : text
  return redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted
}
/** Sleeps for `ms`, returning false when the caller aborted instead of throwing. */
async function nap(ms: number, signal: AbortSignal): Promise<boolean> {
  return delay(ms, undefined, { signal }).then(() => true, () => false)
}
/**
 * One installation's DingTalk login attempt at a time: starting an attempt supersedes the previous one, the background
 * poll keeps the state the panel polls current, and a confirmed attempt creates the account through the caller's
 * `create` and then stops. Nothing is written to disk here: the credential goes to the caller, which stores it in the
 * settings; the manager keeps only a device code and the panel-visible state.
 */
export class DingtalkLoginManager {
  private readonly sessions = new Map<string, DingtalkLoginSession>()
  /** The newest attempt's id; an older attempt's poll reads `expired`. */
  private current = ''

  constructor(private readonly options: DingtalkLoginManagerOptions = {}) {}
  /** The clock the attempt TTL reads. */
  private now(): number { return (this.options.now ?? Date.now)() }
  /** The TTL of one attempt, ten minutes unless a test shortens it. */
  private get ttlMs(): number { return this.options.ttlMs ?? DINGTALK_LOGIN_TTL_MS }
  /**
   * Starts one attempt: supersedes the previous one, begins a DingTalk device registration and returns its QR image.
   * `create` receives the confirmed Client ID and Secret and returns the created Source instance id.
   */
  async start(request: { create: (credentials: DingtalkLoginCredentials) => Promise<string> }): Promise<DingtalkLoginStartView> {
    this.prune()
    this.supersede()
    const auth = new DingtalkDeviceAuth({
      ...this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl },
      ...this.options.now === undefined ? {} : { now: this.options.now },
      ...this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl },
      ...this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs },
    })
    const registration = await auth.start()
    const createdAt = this.now()
    // The attempt ends at its own TTL even when DingTalk's registration would live longer.
    const expiresAt = Math.min(createdAt + this.ttlMs, registration.expiresAt)
    const qrImage = await (this.options.renderQr ?? renderDingtalkQrImage)(registration.verificationUrl)
    const interval = this.options.pollIntervalMs ?? registration.pollIntervalMs
    const session: DingtalkLoginSession = { loginId: randomUUID(), deviceCode: registration.deviceCode, createdAt,
      expiresAt, pollIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : DINGTALK_LOGIN_POLL_MS,
      status: 'waiting', controller: new AbortController() }
    this.sessions.set(session.loginId, session)
    this.current = session.loginId
    void this.run(auth, session, request.create)
    return { loginId: session.loginId, qrImage, expiresAt: new Date(expiresAt).toISOString() }
  }
  /**
   * Reads one attempt's state without contacting DingTalk: the background poll keeps it current, so the panel's request
   * is fast and safe to send every two seconds. An unknown or superseded attempt reads `expired`.
   */
  poll(loginId: string): DingtalkLoginPollView {
    const session = this.sessions.get(loginId)
    if (!session || session.loginId !== this.current) return { status: 'expired' }
    if (session.status !== 'confirmed' && this.now() >= session.expiresAt) {
      session.controller.abort()
      session.deviceCode = ''
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
  /** Aborts and expires the previous attempt, so only one registration is alive at a time. */
  private supersede(): void {
    const previous = this.sessions.get(this.current)
    if (!previous) return
    previous.controller.abort()
    previous.deviceCode = ''
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
  private async run(auth: DingtalkDeviceAuth, session: DingtalkLoginSession,
    create: (credentials: DingtalkLoginCredentials) => Promise<string>): Promise<void> {
    const fail = (error: string): void => {
      session.status = 'failed'
      session.error = error
      session.deviceCode = ''
    }
    try {
      while (!session.controller.signal.aborted) {
        if (this.now() >= session.expiresAt) { session.status = 'expired'; session.deviceCode = ''; return }
        const poll = await auth.poll({ deviceCode: session.deviceCode, signal: session.controller.signal })
        if (session.controller.signal.aborted) return
        // DingTalk issues the credentials once the app exists — including while an organization still has to approve it
        // (state APPROVING) — so both credentials decide success, not the state's name. Intermediate states (CREATING,
        // PUBLISHING, APPROVING) are just more waiting, as is a state this version does not know yet.
        const clientId = poll.clientId ?? ''
        const clientSecret = poll.clientSecret ?? ''
        if (clientId && clientSecret) {
          session.deviceCode = ''
          try {
            session.sourceId = await create({ clientId, clientSecret })
            session.status = 'confirmed'
          } catch (error) {
            // The account could not be stored: say why, and never keep the credentials of the attempt.
            fail(loginFailureText(error, clientSecret))
          }
          return
        }
        if (poll.status === 'EXPIRED') { session.status = 'expired'; session.deviceCode = ''; return }
        if (poll.status === 'FAIL') { fail('DingTalk refused the QR sign-in'); return }
        // WAITING, CREATING, PUBLISHING, APPROVING, an unrecognized state, or a success that has issued only one of the
        // two credentials: poll again until the attempt's TTL ends.
        session.status = 'waiting'
        if (!await nap(session.pollIntervalMs, session.controller.signal)) return
      }
    } catch (error) {
      if (session.controller.signal.aborted) return
      fail(dingtalkDeviceAuthFailureText(error))
    }
  }
}
/** The installation's DingTalk login attempts; the management routes share it. */
export const dingtalkLogins = new DingtalkLoginManager()
/** Aborts and forgets every attempt of the shared manager; tests use it between cases. */
export function clearDingtalkLogins(): void { dingtalkLogins.clear() }
