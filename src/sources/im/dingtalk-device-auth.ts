/**
 * DingTalk device-registration client: the QR sign-in that provisions an enterprise app's Client ID and Client Secret.
 *
 * A scan starts with `/app/registration/init` (`source: 'DING_DWS_CLAW'`, answering a nonce), then
 * `/app/registration/begin` (`nonce`, answering the `device_code`, the `verification_uri_complete` a person scans, the
 * poll interval and the lifetime), and repeats `/app/registration/poll` (`device_code`) until DingTalk answers WAITING,
 * SUCCESS (with `client_id`/`client_secret`), FAIL or EXPIRED. Every call is a POST to the registration base
 * (`https://oapi.dingtalk.com`), never follows a redirect, is bounded to 15 s, and every failure is sanitized: no answer
 * body, nonce, device code or credential appears in an error message.
 *
 * Protocol details adapted from dsh-im (MIT, Copyright (c) 2026 xmanrui, upstream 5.10.0), file
 * `src/channels/dingtalk/device-auth.mjs` (the init/begin/poll payloads, the status normalization and the error
 * classification); see THIRD_PARTY_NOTICES.md. Only the wire protocol is adapted: this module has no session, command,
 * approval or workspace logic, and imports no part of dsh-im.
 */

/** The registration base every call uses; only HTTPS on a DingTalk host is ever contacted. */
export const DINGTALK_REGISTRATION_BASE = 'https://oapi.dingtalk.com'
/** The source DingTalk's device registration expects in its `init` body. */
export const DINGTALK_REGISTRATION_SOURCE = 'DING_DWS_CLAW'
/** How long one registration call may take before it is abandoned. */
export const DINGTALK_REGISTRATION_TIMEOUT_MS = 15_000
/** The statuses DingTalk's poll answers with; an unrecognized one is reported as `UNKNOWN` and fails the attempt. */
export const DINGTALK_REGISTRATION_STATUSES = ['WAITING', 'SUCCESS', 'FAIL', 'EXPIRED'] as const
export type DingtalkRegistrationStatus = typeof DINGTALK_REGISTRATION_STATUSES[number] | 'UNKNOWN'
/** The kinds of failure a device-registration call can have; never carries an answer body or a credential. */
export type DingtalkDeviceAuthFailure = 'invalid-route' | 'network-error' | 'timeout' | 'http-error' | 'invalid-json'
  | 'invalid-response' | 'api-error' | 'missing-nonce' | 'incomplete-registration'
/** One classified device-registration failure: its kind, the stage that failed and, when there was one, the HTTP status. */
export class DingtalkDeviceAuthError extends Error {
  readonly code: DingtalkDeviceAuthFailure
  /** The registration stage that failed: `initialization`, `begin` or `poll`. */
  readonly action: string
  readonly status: number | undefined

  constructor(code: DingtalkDeviceAuthFailure, message: string, action: string, options: { status?: number
    cause?: unknown } = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'DingtalkDeviceAuthError'
    this.code = code
    this.action = action
    this.status = options.status
  }
}
/** A started registration: the host-only device code to poll and the QR metadata the panel needs. */
export interface DingtalkRegistrationStart {
  /** The host-only device code to poll with; never returned to the panel. */
  deviceCode: string
  /** The address a person scans or opens to authorize the registration. */
  verificationUrl: string
  /** The plain verification address, when DingTalk named one beside the complete one. */
  verificationUri: string
  /** The short code a person may type instead of scanning, when DingTalk named one. */
  userCode: string
  /** When this registration stops being usable, as an epoch millisecond. */
  expiresAt: number
  /** How often DingTalk asks to be polled, in milliseconds. */
  pollIntervalMs: number
}
/** One normalized registration poll: the state and, on SUCCESS, the provisioned credentials. */
export interface DingtalkRegistrationPoll {
  status: DingtalkRegistrationStatus
  /** The app's Client ID (AppKey) DingTalk provisioned; present only on SUCCESS. */
  clientId?: string
  /** The app's Client Secret (AppSecret); present only on SUCCESS and never returned to the panel. */
  clientSecret?: string
  /** DingTalk's own wording of a FAIL, or undefined; kept internal and safe to describe without it. */
  failReason?: string
}
/** How to reach DingTalk's registration service: the injected fetch and clock keep tests off the network. */
export interface DingtalkDeviceAuthOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  /** The registration base; production uses `https://oapi.dingtalk.com` and only a DingTalk HTTPS host is accepted. */
  baseUrl?: string
  timeoutMs?: number
}

const nonEmpty = (value: unknown): string => typeof value === 'string' && value.trim() ? value.trim() : ''
/** Whether a hostname belongs to DingTalk, as the only hosts a registration call may target. */
function isDingtalkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'dingtalk.com' || host.endsWith('.dingtalk.com')
}
/**
 * A trusted registration base: HTTPS on a DingTalk host, no credentials, no query, no fragment and the standard port
 * only. Throws rather than contacting anything else.
 */
function normalizeBaseUrl(value: unknown): string {
  let url: URL
  try { url = new URL(nonEmpty(value) || DINGTALK_REGISTRATION_BASE) } catch { throw invalidBase() }
  if (url.protocol !== 'https:' || !isDingtalkHost(url.hostname) || url.port || url.username || url.password
    || url.search || url.hash) throw invalidBase()
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.href.replace(/\/$/, '')
}
function invalidBase(): DingtalkDeviceAuthError {
  return new DingtalkDeviceAuthError('invalid-route', 'The DingTalk registration base must be an HTTPS DingTalk URL',
    'initialization')
}
/** A positive number from DingTalk, or the fallback when the value is missing or unusable. */
function positiveNumber(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}
/** The provider error DingTalk's answer names (`errcode` non-zero), or undefined when the answer succeeded. */
function rejectedCode(value: Record<string, unknown>): string | undefined {
  const code = value.errcode
  if (code === undefined || code === 0 || code === '0') return undefined
  const text = String(code).trim()
  return /^-?[A-Za-z0-9_.:-]{1,160}$/.test(text) ? text : 'rejected'
}
/**
 * Host-only client for DingTalk's QR device-registration flow. `start` initializes and begins one registration; `poll`
 * reads its state and, on SUCCESS, the provisioned Client ID and Secret. Nothing is cached between calls and no error
 * carries an answer body.
 */
export class DingtalkDeviceAuth {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(options: DingtalkDeviceAuthOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    const timeoutMs = options.timeoutMs ?? DINGTALK_REGISTRATION_TIMEOUT_MS
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive number')
    this.timeoutMs = timeoutMs
  }

  /** Starts one QR registration: the init nonce, then the device code and the address a person scans or opens. */
  async start(options: { signal?: AbortSignal } = {}): Promise<DingtalkRegistrationStart> {
    const initialized = await this.post('/app/registration/init', { source: DINGTALK_REGISTRATION_SOURCE },
      'initialization', options.signal)
    const nonce = nonEmpty(initialized.nonce)
    if (!nonce) throw new DingtalkDeviceAuthError('missing-nonce',
      'The DingTalk registration initialization returned no nonce', 'initialization')
    const begun = await this.post('/app/registration/begin', { nonce }, 'begin', options.signal)
    const deviceCode = nonEmpty(begun.device_code)
    const verificationUrl = nonEmpty(begun.verification_uri_complete)
    if (!deviceCode || !verificationUrl) throw new DingtalkDeviceAuthError('incomplete-registration',
      'The DingTalk registration returned incomplete QR metadata', 'begin')
    return {
      deviceCode,
      verificationUrl,
      verificationUri: nonEmpty(begun.verification_uri),
      userCode: nonEmpty(begun.user_code),
      expiresAt: this.now() + positiveNumber(begun.expires_in, 7_200) * 1_000,
      pollIntervalMs: positiveNumber(begun.interval, 5) * 1_000,
    }
  }

  /** Polls one registration; on SUCCESS it carries the provisioned Client ID and Secret, nowhere else. */
  async poll(request: { deviceCode: string; signal?: AbortSignal }): Promise<DingtalkRegistrationPoll> {
    const deviceCode = nonEmpty(request?.deviceCode)
    if (!deviceCode) throw new TypeError('deviceCode is required')
    const response = await this.post('/app/registration/poll', { device_code: deviceCode }, 'poll', request.signal)
    const raw = nonEmpty(response.status).toUpperCase()
    const status: DingtalkRegistrationStatus = (DINGTALK_REGISTRATION_STATUSES as readonly string[]).includes(raw)
      ? raw as DingtalkRegistrationStatus : 'UNKNOWN'
    return {
      status,
      clientId: nonEmpty(response.client_id) || undefined,
      clientSecret: nonEmpty(response.client_secret) || undefined,
      failReason: nonEmpty(response.fail_reason) || undefined,
    }
  }

  /** One JSON registration call with the bounded timeout and the caller's abort signal. */
  private async post(path: string, body: unknown, action: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body),
        redirect: 'error', signal: combined })
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('The DingTalk request was stopped')
      if (timeout.aborted) throw new DingtalkDeviceAuthError('timeout', `The DingTalk ${action} request timed out`,
        action, { cause: error })
      throw new DingtalkDeviceAuthError('network-error', `The DingTalk ${action} request could not be completed`,
        action, { cause: error })
    }
    if (!response.ok) throw new DingtalkDeviceAuthError('http-error', `The DingTalk ${action} request failed`,
      action, { status: response.status })
    let parsed: unknown
    try { parsed = await response.json() } catch {
      // The parse error may quote the answer body, which never appears in a failure of this client.
      throw new DingtalkDeviceAuthError('invalid-json', `The DingTalk ${action} answer was not JSON`, action)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new DingtalkDeviceAuthError('invalid-response', `The DingTalk ${action} answer was invalid`, action)
    }
    const value = parsed as Record<string, unknown>
    if (rejectedCode(value) !== undefined) {
      throw new DingtalkDeviceAuthError('api-error', `The DingTalk ${action} request was rejected`, action)
    }
    return value
  }
}
/** A one-line, sanitized description of a device-registration failure, for a health detail or a panel message. */
export function dingtalkDeviceAuthFailureText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}
