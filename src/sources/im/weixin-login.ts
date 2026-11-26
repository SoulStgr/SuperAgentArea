/**
 * WeChat QR sign-in sessions: one in-memory login attempt per Source instance, its iLink status poll, and the credential
 * record the Source's watch loop reads from KV.
 *
 * An attempt lives five minutes, holds only the public QR token and the status the panel polls, and is replaced by the
 * next attempt of the same instance. On `confirmed` the poll writes the bot token to the instance's KV record
 * (`weixin.token:<instance>` as `{token, ilinkBotId, at}`) and stops; the token is never returned to the panel, logged or
 * put in a health detail. The QR image is the HTTPS image URL iLink returns when it returns one, and a locally rendered
 * PNG data URL otherwise (the public `qrcode` package), so the panel never loads a third-party page as an image.
 *
 * Protocol details adapted from dsh-im (MIT, Copyright (c) 2026 xmanrui, upstream 5.10.0), files
 * `src/channels/weixin/weixin-controller.mjs` (the attempt lifecycle, `confirmed` credentials) and
 * `src/channels/weixin/weixin-runtime.mjs` (the status monitor); see THIRD_PARTY_NOTICES.md.
 */
import { randomUUID } from 'node:crypto'
import { family } from '../../kv.ts'
import { beginWeixinLogin, nap, pollWeixinLogin, trustedWeixinUrl, WEIXIN_LONG_POLL_TIMEOUT_MS, WeixinApiError,
  weixinFailureText, type WeixinLoginState } from './weixin-transport.ts'

/** The signed-in credential of one WeChat Source instance. It is a credential: never logged, returned or put in a Trigger. */
export interface WeixinCredential {
  /** The iLink bot token, sent only as the bearer of the iLink calls. */
  token: string
  /** The iLink bot id the account signed in as, shown in the panel as its account id. */
  ilinkBotId: string
  /** When the sign-in was confirmed, as an ISO time. */
  at: string
}
/** The KV record of one instance's signed-in credential; setting it to undefined signs the instance out. */
export const weixinToken = family<WeixinCredential, [instance: string]>('weixin.token:')
/** How long one login attempt may stay open; the QR code stops being scanned after five minutes. */
export const WEIXIN_LOGIN_TTL_MS = 5 * 60_000
/** The state the panel polls for: the same states iLink reports, plus `failed` for an unusable answer. */
export type WeixinLoginStatus = WeixinLoginState
/** What starting a sign-in returns the panel: the attempt to poll and the QR image to show. */
export interface WeixinLoginStartView {
  loginId: string
  /** A data URL or an HTTPS WeChat image URL; never a third-party page. */
  qrImage: string
}
/** What one poll of a sign-in returns the panel. */
export interface WeixinLoginPollView {
  status: WeixinLoginStatus
  /** The account id once `confirmed`; no token is ever returned. */
  ilinkBotId?: string
  /** Why the attempt failed, worded for the panel; never a credential. */
  error?: string
}
/** How the manager reaches iLink and the clock: production defaults, shortened in tests. */
export interface WeixinLoginManagerOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  ttlMs?: number
  /** The wait between two status polls of one attempt. */
  pollIntervalMs?: number
  /** How long one status poll may wait for iLink to answer. */
  pollTimeoutMs?: number
  /** Renders QR content that is not an image URL, as a data URL. */
  renderQr?: (content: string) => Promise<string>
}
/** One in-memory login attempt: its public QR token, its state and the loop polling iLink. */
interface LoginSession {
  loginId: string
  instance: string
  qrcode: string
  createdAt: number
  status: WeixinLoginStatus
  ilinkBotId?: string
  error?: string
  controller: AbortController
}
/** Renders arbitrary QR content as a PNG data URL with the public `qrcode` package. */
export async function renderWeixinQrImage(content: string): Promise<string> {
  const module = await import('qrcode') as { toDataURL(text: string, options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
    margin?: number; width?: number }): Promise<string> }
  return module.toDataURL(content, { errorCorrectionLevel: 'M', margin: 1, width: 320 })
}
/**
 * One installation's login attempts, by attempt id, with only the latest attempt of each instance kept as its own. An
 * attempt is a few hundred bytes in memory and never outlives its TTL by more than one cleanup round; nothing is written to
 * disk until iLink confirms the sign-in, which writes only the credential record to the Source's KV store.
 */
export class WeixinLoginManager {
  private readonly sessions = new Map<string, LoginSession>()
  /** The newest attempt of each instance; an older attempt's poll returns `expired`. */
  private readonly current = new Map<string, string>()

  constructor(private readonly options: WeixinLoginManagerOptions = {}) {}
  /** The clock the attempt TTL reads. */
  private now(): number { return (this.options.now ?? Date.now)() }
  /** The TTL of one attempt, five minutes unless a test shortens it. */
  private get ttlMs(): number { return this.options.ttlMs ?? WEIXIN_LOGIN_TTL_MS }
  /**
   * Starts one attempt: supersedes the instance's previous attempt, asks iLink for a QR token and returns the QR image to
   * show. `save` receives the confirmed credential, which the caller stores in the instance's KV record.
   */
  async start(instance: string, request: { botType?: string; save: (credential: WeixinCredential) => void }): Promise<WeixinLoginStartView> {
    this.prune()
    const previousId = this.current.get(instance)
    if (previousId) {
      const previous = this.sessions.get(previousId)
      if (previous) {
        previous.controller.abort()
        if (previous.status !== 'confirmed' && previous.status !== 'failed') previous.status = 'expired'
      }
    }
    const login = await beginWeixinLogin({ ...this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl },
      ...request.botType === undefined ? {} : { botType: request.botType } })
    const session: LoginSession = { loginId: randomUUID(), instance, qrcode: login.qrcode, createdAt: this.now(),
      status: 'wait', controller: new AbortController() }
    try {
      const qrImage = await this.qrImageOf(login.qrContent)
      this.sessions.set(session.loginId, session)
      this.current.set(instance, session.loginId)
      void this.run(session, request.save)
      return { loginId: session.loginId, qrImage }
    } catch (error) {
      session.controller.abort()
      throw error
    }
  }
  /**
   * Reads one attempt's state without contacting iLink: the background poll keeps it current, so the panel's request is
   * fast and safe to send every two seconds. An unknown attempt, or one of another instance, reads as `expired`.
   */
  status(instance: string, loginId: string): WeixinLoginPollView {
    const session = this.sessions.get(loginId)
    if (!session || session.instance !== instance) return { status: 'expired' }
    if (this.now() - session.createdAt >= this.ttlMs && session.status !== 'confirmed') {
      session.controller.abort()
      session.status = 'expired'
    }
    return { status: session.status, ...session.ilinkBotId === undefined ? {} : { ilinkBotId: session.ilinkBotId },
      ...session.error === undefined ? {} : { error: session.error } }
  }
  /** Aborts and forgets every attempt; the plugin's entry uses it when it unloads, tests between cases. */
  clear(): void {
    for (const session of this.sessions.values()) session.controller.abort()
    this.sessions.clear()
    this.current.clear()
  }
  /** Drops attempts that are well past their TTL and keeps the map small when a person retries repeatedly. */
  private prune(): void {
    const now = this.now()
    for (const [loginId, session] of this.sessions) {
      if (now - session.createdAt > this.ttlMs * 2) {
        session.controller.abort()
        this.sessions.delete(loginId)
      }
    }
    // Only the newest attempts matter; drop the oldest finished ones when the map grew without a cleanup between attempts.
    while (this.sessions.size > 20) {
      const oldest = [...this.sessions.values()].filter(session => session.status !== 'wait' && session.status !== 'scaned')
        .sort((one, two) => one.createdAt - two.createdAt)[0]
      if (!oldest) break
      this.sessions.delete(oldest.loginId)
    }
  }
  /** One attempt's background status poll: updates its state and writes the confirmed credential through `save`. */
  private async run(session: LoginSession, save: (credential: WeixinCredential) => void): Promise<void> {
    const { pollIntervalMs = 1_000 } = this.options
    try {
      while (!session.controller.signal.aborted) {
        if (this.now() - session.createdAt >= this.ttlMs) { session.status = 'expired'; return }
        const poll = await pollWeixinLogin({ qrcode: session.qrcode,
          ...this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl },
          timeoutMs: this.options.pollTimeoutMs ?? WEIXIN_LONG_POLL_TIMEOUT_MS, signal: session.controller.signal })
        if (session.controller.signal.aborted) return
        if (poll.status === 'confirmed') {
          const { botToken, ilinkBotId } = poll
          if (!botToken || !ilinkBotId) {
            session.status = 'failed'
            session.error = 'WeChat returned an incomplete sign-in'
            return
          }
          save({ token: botToken, ilinkBotId, at: new Date(this.now()).toISOString() })
          session.status = 'confirmed'
          session.ilinkBotId = ilinkBotId
          return
        }
        if (poll.status === 'expired') { session.status = 'expired'; return }
        if (poll.status === 'failed') {
          session.status = 'failed'
          session.error = poll.detail ?? 'The WeChat sign-in failed'
          return
        }
        session.status = poll.status
        await nap(pollIntervalMs, session.controller.signal)
      }
    } catch (error) {
      if (session.controller.signal.aborted) return
      session.status = 'failed'
      session.error = weixinFailureText(error)
    }
  }
  /** The image the panel shows for one QR answer: a trusted image URL, a data URL as sent, or a rendered PNG data URL. */
  private async qrImageOf(content: string): Promise<string> {
    const text = typeof content === 'string' ? content.trim() : ''
    if (!text) throw new WeixinApiError('invalid-response', 'WeChat returned no QR image')
    if (/^data:image\//i.test(text)) return text
    const trusted = trustedWeixinUrl(text)
    if (trusted) return trusted
    const render = this.options.renderQr ?? renderWeixinQrImage
    return render(text)
  }
}
/** The installation's login attempts; the management routes and the plugin's entry share it. */
export const weixinLogins = new WeixinLoginManager()
/** Aborts and forgets every attempt of the shared manager; tests use it between cases. */
export function clearWeixinLogins(): void { weixinLogins.clear() }
