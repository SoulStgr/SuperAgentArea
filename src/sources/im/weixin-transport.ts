/**
 * WeChat transport: the iLink bot protocol — the QR sign-in handshake, the long-poll message loop and the text reply path —
 * plus inbound message normalization and text splitting.
 *
 * Protocol details adapted from dsh-im (MIT, Copyright (c) 2026 xmanrui, upstream 5.10.0), files
 * `src/channels/weixin/weixin-api.mjs` (iLink client: QR sign-in, status poll, getupdates, sendmessage, headers, base_info,
 * error classification, text splitting), `src/channels/weixin/weixin-runtime.mjs` (the update monitor, ordering, long-poll
 * timeout as an empty result) and `src/channels/weixin/weixin-controller.mjs` (the `confirmed` credentials); see
 * THIRD_PARTY_NOTICES.md. Only the wire protocol is adapted: this module has no session, command, approval or workspace
 * logic, and imports no part of dsh-im.
 *
 * Nothing here reads configuration: the bot token comes from a caller that stores it (the Source instance's KV record), and
 * it never appears in a transport error, a log line, a health detail or a Trigger. There is no public npm SDK for iLink, so
 * this module is the vendored client.
 */
import type { OutboundMessage } from '../../core/index.ts'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

/** The iLink API base every call uses; the QR handshake and the authenticated bot calls share it. */
export const WEIXIN_ILINK_BASE = 'https://ilinkai.weixin.qq.com/'
/** The iLink protocol version this client announces in `base_info.channel_version`. */
export const WEIXIN_PROTOCOL_VERSION = '2.4.6'
/** The bot type the QR handshake asks for; 3 is the iLink bot account dsh-im signs in. */
export const DEFAULT_BOT_TYPE = '3'
/** How much of one inbound message text a Trigger carries; the rest is not available to the worker. */
export const WEIXIN_TEXT_CHARS = 8_000
/** The longest piece of reply text one WeChat message carries; a longer reply is sent as several messages. */
export const WEIXIN_REPLY_CHARS = 1_800
/** How a login status the panel may poll maps onto this client's normalized states. */
export const WEIXIN_LOGIN_STATUSES = ['wait', 'scaned', 'confirmed', 'expired'] as const
export type WeixinLoginState = typeof WEIXIN_LOGIN_STATUSES[number] | 'failed'

const ILINK_APP_ID = 'bot'
/** The iLink app client version, packed as dsh-im packs it: major << 16 | minor << 8 | patch. */
const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6
const DEFAULT_TIMEOUT_MS = 15_000
/** A long poll waits this long for the service to answer with new messages; its timeout means "no messages yet". */
export const WEIXIN_LONG_POLL_TIMEOUT_MS = 30_000
const LOGIN_TIMEOUT_MS = 10_000
/** iLink's own "this bot token is no longer valid" code; the account must sign in again. */
const STALE_TOKEN_CODE = '-14'
const BOT_AGENT = 'dsh-superagent'

/** The kinds of failure a WeChat call can have; the Channel decides from them whether a reply is retryable or gone. */
export type WeixinFailure = 'network' | 'timeout' | 'auth' | 'rate-limit' | 'rejected' | 'invalid-response'
  | 'invalid-route'
/** One classified iLink failure: its kind, the HTTP status when there was one, and WeChat's own code when it sent one. */
export class WeixinApiError extends Error {
  readonly code: WeixinFailure
  readonly status: number | undefined
  readonly providerCode: string | undefined

  constructor(code: WeixinFailure, message: string, options: { status?: number; providerCode?: string
    cause?: unknown } = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'WeixinApiError'
    this.code = code
    this.status = options.status
    this.providerCode = options.providerCode
  }
}
/** How to reach iLink: the injected fetch, clock and abort signal keep tests off the network. */
export interface WeixinRequestOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

const nonEmpty = (value: unknown): string => typeof value === 'string' && value.trim() ? value.trim() : ''

/** Whether a hostname belongs to WeChat, as the only hosts a response may name or a QR may point at. */
function isWeixinHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com')
    || host === 'wechat.com' || host.endsWith('.wechat.com')
}
/**
 * A trusted WeChat URL: HTTPS on a WeChat host, no credentials, no fragment and the standard port only. Empty when the
 * value is not such a URL, so a broker cannot redirect a QR image or an API call elsewhere.
 */
export function trustedWeixinUrl(value: unknown): string {
  const text = nonEmpty(value)
  if (!text) return ''
  let url: URL
  try { url = new URL(text) } catch { return '' }
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname) || (url.port && url.port !== '443')
    || url.username || url.password) return ''
  url.hash = ''
  return url.toString()
}
/** The `base_info` every authenticated iLink call carries: the channel version and the agent that speaks it. */
function baseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: WEIXIN_PROTOCOL_VERSION, bot_agent: BOT_AGENT }
}
/** The headers every iLink call carries. */
function commonHeaders(): Record<string, string> {
  return { 'iLink-App-Id': ILINK_APP_ID, 'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION) }
}
/**
 * The headers of an authenticated call: the bot token as a bearer, the iLink token type, and a random `X-WECHAT-UIN` the
 * service expects. The token is sent only here, never in a URL.
 */
function authenticatedHeaders(token: string): Record<string, string> {
  return { ...commonHeaders(), 'content-type': 'application/json', AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`, 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64') }
}
/** The provider code of a rejected iLink answer (`ret` or `errcode` non-zero), or undefined when it succeeded. */
export function rejectedProviderResponse(value: unknown, fields: readonly string[] = ['ret', 'errcode']): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const field of fields) {
    const code = record[field]
    if (code !== undefined && code !== 0 && code !== '0') {
      const text = String(code).trim()
      return /^-?[A-Za-z0-9_.:-]{1,160}$/.test(text) ? text : 'rejected'
    }
  }
  return undefined
}
/** The kind of failure one HTTP status is, before WeChat's own code refines it. */
function failureOfStatus(status: number): WeixinFailure {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limit'
  if (status === 408 || status >= 500) return 'network'
  return 'rejected'
}
/**
 * One JSON call to iLink with a bounded timeout; the caller's abort signal and the timeout both stop it. A failed HTTP
 * answer becomes a `WeixinApiError` carrying its status and iLink's own code, never the token.
 */
async function requestJson(options: {
  method: 'GET' | 'POST'
  endpoint: string
  body?: unknown
  token?: string
  authenticated?: boolean
  timeoutMs?: number
  request?: WeixinRequestOptions
}): Promise<unknown> {
  const request = options.request ?? {}
  const { fetchImpl = fetch, signal } = request
  signal?.throwIfAborted()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
  const combined = timeout && signal ? AbortSignal.any([signal, timeout]) : signal ?? timeout
  let url: URL
  try { url = new URL(options.endpoint, WEIXIN_ILINK_BASE) } catch (error) {
    throw new WeixinApiError('invalid-route', 'The WeChat request address is invalid', { cause: error })
  }
  if (!isWeixinHost(url.hostname)) {
    throw new WeixinApiError('invalid-route', 'The WeChat request would leave WeChat hosts')
  }
  const token = nonEmpty(options.token)
  const headers: Record<string, string> = options.authenticated === false
    ? { ...commonHeaders(), ...options.body === undefined ? {} : { 'content-type': 'application/json' } }
    : token ? authenticatedHeaders(token)
      : { ...commonHeaders(), 'content-type': 'application/json' }
  let response: Response
  try {
    response = await fetchImpl(url, { method: options.method, redirect: 'error', headers,
      ...options.body === undefined ? {} : { body: JSON.stringify(options.body) }, signal: combined })
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('The WeChat request was stopped')
    if (timeout?.aborted) throw new WeixinApiError('timeout', 'The WeChat request timed out', { cause: error })
    throw new WeixinApiError('network', 'WeChat could not be reached', { cause: error })
  }
  let parsed: unknown
  try { parsed = await response.json() } catch { parsed = undefined }
  if (!response.ok) {
    const providerCode = rejectedProviderResponse(parsed)
    const code: WeixinFailure = providerCode === STALE_TOKEN_CODE ? 'auth' : failureOfStatus(response.status)
    throw new WeixinApiError(code, `WeChat answered HTTP ${response.status}`,
      { status: response.status, ...providerCode === undefined ? {} : { providerCode } })
  }
  return parsed
}
/** The QR token and image content one `get_bot_qrcode` answer carries. */
export interface WeixinLoginStart {
  /** The opaque QR token to poll with; not a credential. */
  qrcode: string
  /** What the service returned for the QR image: usually an HTTPS WeChat URL, sometimes arbitrary rendered content. */
  qrContent: string
}
/**
 * Starts one iLink QR sign-in: asks for a bot QR code of `botType` and returns its token and image content. The bot type
 * defaults to 3; the QR token is public and short-lived, and no credential is involved yet.
 */
export async function beginWeixinLogin(options: WeixinRequestOptions & { botType?: string } = {}): Promise<WeixinLoginStart> {
  const botType = nonEmpty(options.botType) || DEFAULT_BOT_TYPE
  const response = await requestJson({ method: 'POST', endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: { local_token_list: [] }, timeoutMs: LOGIN_TIMEOUT_MS, request: options })
  const rejection = rejectedProviderResponse(response)
  if (rejection) throw new WeixinApiError('rejected', 'WeChat rejected the QR request', { providerCode: rejection })
  const record = response && typeof response === 'object' ? response as Record<string, unknown> : {}
  const qrcode = nonEmpty(record.qrcode)
  if (!qrcode) throw new WeixinApiError('invalid-response', 'WeChat returned no QR code token')
  return { qrcode, qrContent: nonEmpty(record.qrcode_img_content) }
}
/** One normalized QR status answer: the state, and the credentials a `confirmed` answer carries. */
export interface WeixinLoginPoll {
  status: WeixinLoginState
  /** The bot token the account is signed in with; present only when `confirmed`. */
  botToken?: string
  /** The iLink bot id of the signed-in account; present only when `confirmed`. */
  ilinkBotId?: string
  /** The person the bot belongs to, as iLink names it; present only when `confirmed`. */
  ilinkUserId?: string
  /** The API base the service redirected this account to, if it named one. */
  baseUrl?: string
  /** How the service worded an unrecognized state, for the panel's message; never a credential. */
  detail?: string
}
/** The raw status values iLink may answer with; unknown ones are reported as failed rather than polled forever. */
const KNOWN_LOGIN_STATUSES = new Set(['wait', 'scaned', 'confirmed', 'expired', 'scaned_but_redirect', 'need_verifycode',
  'verify_code_blocked', 'binded_redirect'])
/**
 * Polls one QR token's status. This is a long poll: the service answers when the status changes or after its own timeout.
 * `confirmed` carries the bot token and bot id; `scaned_but_redirect` is a scan and the redirect host is ignored here, since
 * this client always speaks to the main iLink base. A sign-in needing a verification code, or one that is already bound, is
 * reported as failed: the panel asks the person to start over.
 */
export async function pollWeixinLogin(options: WeixinRequestOptions & { qrcode: string; timeoutMs?: number }): Promise<WeixinLoginPoll> {
  const qrcode = nonEmpty(options.qrcode)
  if (!qrcode) throw new TypeError('qrcode is required')
  const response = await requestJson({ method: 'GET', endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    authenticated: false, timeoutMs: options.timeoutMs ?? WEIXIN_LONG_POLL_TIMEOUT_MS, request: options })
  const record = response && typeof response === 'object' ? response as Record<string, unknown> : {}
  const raw = nonEmpty(record.status)
  const confirmed = () => {
    const botToken = nonEmpty(record.bot_token)
    const ilinkBotId = nonEmpty(record.ilink_bot_id)
    const ilinkUserId = nonEmpty(record.ilink_user_id)
    const baseUrl = nonEmpty(record.baseurl)
    if (!botToken || !ilinkBotId) {
      return { status: 'failed' as const, detail: 'WeChat returned an incomplete sign-in' }
    }
    return { status: 'confirmed' as const, botToken, ilinkBotId, ...ilinkUserId ? { ilinkUserId } : {},
      ...baseUrl ? { baseUrl } : {} }
  }
  if (raw === 'confirmed') return confirmed()
  if (raw === 'wait' || raw === 'scaned') return { status: raw }
  if (raw === 'scaned_but_redirect') return { status: 'scaned' }
  if (raw === 'expired') return { status: 'expired' }
  return { status: 'failed', detail: KNOWN_LOGIN_STATUSES.has(raw) ? `WeChat reported ${raw}` : 'WeChat reported an unknown sign-in state' }
}
/** One update poll's result: the inbound messages and the cursor to send with the next poll. */
export interface WeixinUpdates {
  /** The raw messages iLink pushed; `normalizeWeixinInbound` turns each into a message or a skip. */
  msgs: unknown[]
  /** The new `get_updates_buf` cursor; the same value when the service sent none. */
  cursor: string
}
/**
 * Polls iLink for new messages with the account's bot token. A long-poll timeout is not a failure: it means no message
 * arrived in the window, so the caller polls again. iLink's stale-token code becomes an `auth` error, which ends the
 * instance's loop until the account signs in again.
 */
export async function getWeixinUpdates(options: WeixinRequestOptions & { token: string; cursor?: string
  timeoutMs?: number } = { token: '' }): Promise<WeixinUpdates> {
  const token = nonEmpty(options.token)
  if (!token) throw new TypeError('A WeChat bot token is required')
  const cursor = typeof options.cursor === 'string' ? options.cursor : ''
  try {
    const response = await requestJson({ method: 'POST', endpoint: 'ilink/bot/getupdates', token,
      body: { get_updates_buf: cursor, base_info: baseInfo() },
      timeoutMs: options.timeoutMs ?? WEIXIN_LONG_POLL_TIMEOUT_MS, request: options })
    const rejection = rejectedProviderResponse(response)
    if (rejection) {
      throw new WeixinApiError(rejection === STALE_TOKEN_CODE ? 'auth' : 'rejected', rejection === STALE_TOKEN_CODE
        ? 'The WeChat sign-in is no longer valid' : 'WeChat rejected the update poll', { providerCode: rejection })
    }
    const record = response && typeof response === 'object' ? response as Record<string, unknown> : {}
    return { msgs: Array.isArray(record.msgs) ? record.msgs : [], cursor: nonEmpty(record.get_updates_buf) || cursor }
  } catch (error) {
    if (error instanceof WeixinApiError && error.code === 'timeout') return { msgs: [], cursor }
    throw error
  }
}
/** One outbound text piece's inputs: the signed-in credential, the recipient and the conversation's reply route. */
export interface WeixinSendOptions extends WeixinRequestOptions {
  /** The account's bot token; sent only as the request's bearer. */
  token: string
  /** The WeChat user the reply goes to: the sender of the message the Channel answers. */
  toUserId: string
  /** The text of this piece; nothing longer than `WEIXIN_REPLY_CHARS` should reach here. */
  text: string
  /** The conversation capability the inbound message carried; the service may require it for a reply. */
  contextToken?: string
  /** The inbound message id, which the service correlates with the reply. */
  runId?: string
  /** A stable id for this piece, so a retry of the same outbound message reuses it; generated when omitted. */
  clientId?: string
}
/** The reply one send call delivered: the client id it used, for logs and receipts (never a credential). */
export interface WeixinSendResult { clientId: string }
/**
 * Sends one text piece through `ilink/bot/sendmessage`: the bot answers the person, carrying the conversation's
 * `context_token` and the inbound message id as `run_id`. A rejection becomes a classified error for the Outbox.
 */
export async function sendWeixinText(options: WeixinSendOptions): Promise<WeixinSendResult> {
  const token = nonEmpty(options.token)
  const toUserId = nonEmpty(options.toUserId)
  const text = typeof options.text === 'string' ? options.text.trim() : ''
  if (!token || !toUserId || !text) throw new TypeError('A WeChat reply needs a token, a recipient and text')
  const clientId = nonEmpty(options.clientId) || `dsh-weixin-${randomUUID()}`
  const contextToken = nonEmpty(options.contextToken)
  const runId = nonEmpty(options.runId)
  const response = await requestJson({ method: 'POST', endpoint: 'ilink/bot/sendmessage', token,
    body: { msg: { from_user_id: '', to_user_id: toUserId, client_id: clientId, message_type: 2, message_state: 2,
      item_list: [{ type: 1, text_item: { text } }], ...contextToken ? { context_token: contextToken } : {},
      ...runId ? { run_id: runId } : {} }, base_info: baseInfo() }, request: options })
  const rejection = rejectedProviderResponse(response)
  if (rejection) {
    throw new WeixinApiError(rejection === STALE_TOKEN_CODE ? 'auth' : 'rejected', rejection === STALE_TOKEN_CODE
      ? 'The WeChat sign-in is no longer valid' : 'WeChat rejected the reply', { providerCode: rejection })
  }
  return { clientId }
}
/** One inbound iLink message; the fields this Source reads, with iLink numeric and string forms both accepted. */
export interface WeixinRawInbound {
  message_id?: string | number
  client_id?: string
  from_user_id?: string
  to_user_id?: string
  /** iLink's message type: 2 marks a message the bot itself sent, which never asks it for work. */
  message_type?: number
  message_state?: number
  item_list?: { type?: number; text_item?: { text?: string }; voice_item?: { text?: string } }[]
  context_token?: string
  run_id?: string
  create_time_ms?: string | number
  seq?: string | number
  /** A room/chat id iLink sets only for a group chat; this Source receives direct messages only for now. */
  chatroom_id?: string
  room_id?: string
}
/** One inbound text message the bot received, normalized for the Source. */
export interface WeixinMessage {
  /** The message id; a Trigger derives its id from it, and a reply sends it as `run_id`. */
  messageId: string
  /** The iLink client id of the inbound message, when it sent one; recorded for dedupe and receipts. */
  clientId: string
  /** The message text as received, trimmed. */
  text: string
  /** The sender as the Policy's `allowed` list names people: the WeChat user id. */
  fromUserId: string
  /** This Source listens to direct messages only; a group message is a skip. */
  conversationKind: 'dm' | 'group'
  /** Always true: an inbound direct message addresses the bot by construction. */
  addressed: true
  /** The conversation capability the reply should carry. */
  contextToken: string
  /** iLink's own run id of the message, when it sent one. */
  runId: string
  /** The message time as an ISO time; empty when iLink sent none. */
  createdAt: string
}
/** Why one inbound message became no message. */
export type WeixinSkip = 'invalid' | 'self' | 'group' | 'non-text'
/** A message that was not turned into a message, with what to count for the instance's health detail. */
export interface WeixinSkipEvent { reason: WeixinSkip; messageId?: string }
/** One inbound message's result: either a normalized message or why it was skipped. */
export type WeixinInbound = { message: WeixinMessage } | { skipped: WeixinSkipEvent }
/** A message id iLink sent as a number is a string here, so it compares and stores as one value. */
const idText = (value: string | number | undefined): string =>
  typeof value === 'number' && Number.isFinite(value) ? String(value) : nonEmpty(value)
/** A `create_time_ms` timestamp as ISO; an absent or unusable value becomes empty. */
function isoTime(value: string | number | undefined): string {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (!Number.isFinite(number) || number <= 0) return ''
  return new Date(number < 10_000_000_000 ? number * 1_000 : number).toISOString()
}
/** The text of an item list: iLink's text item, or the transcript iLink attaches to a voice message. */
function extractText(items: WeixinRawInbound['item_list']): string {
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue
    const text = item.type === 1 ? nonEmpty(item.text_item?.text) : item.type === 3 ? nonEmpty(item.voice_item?.text) : ''
    if (text) return text
  }
  return ''
}
/**
 * Normalizes one iLink message into an inbound message, or says why it is no message for this Source. The bot's own
 * outgoing message (`message_type` 2), a group chat message, a message with no text item and a malformed one are skipped and
 * never become a Trigger.
 */
export function normalizeWeixinInbound(raw: unknown): WeixinInbound {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { skipped: { reason: 'invalid' } }
  const message = raw as WeixinRawInbound
  const messageId = idText(message.message_id) || nonEmpty(message.client_id)
  const skip = (reason: WeixinSkip): WeixinInbound => ({ skipped: { reason, ...messageId ? { messageId } : {} } })
  const fromUserId = nonEmpty(message.from_user_id)
  if (!messageId || !fromUserId) return skip('invalid')
  const group = nonEmpty(message.chatroom_id) || nonEmpty(message.room_id)
  const conversationKind = group ? 'group' as const : 'dm' as const
  if (message.message_type === 2) return skip('self')
  if (conversationKind === 'group') return skip('group')
  const text = extractText(message.item_list)
  if (!text) return skip('non-text')
  return { message: {
    messageId,
    clientId: nonEmpty(message.client_id),
    text: text.slice(0, WEIXIN_TEXT_CHARS),
    fromUserId,
    conversationKind,
    addressed: true,
    contextToken: nonEmpty(message.context_token),
    runId: nonEmpty(message.run_id),
    createdAt: isoTime(message.create_time_ms),
  } }
}
/** Splits a long reply into WeChat-sized text messages, preferring a line break when one is not too early. */
export function splitWeixinText(value: string, maxChars = WEIXIN_REPLY_CHARS): string[] {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return []
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new TypeError('maxChars must be a positive integer')
  if (text.length <= maxChars) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n', maxChars)
    if (splitAt < Math.floor(maxChars * 0.6)) splitAt = maxChars
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n+/, '')
  }
  if (remaining) chunks.push(remaining)
  return chunks
}
/** The route a stored Channel address names for a reply, or undefined when it cannot receive one. */
export interface WeixinReplyTarget {
  /** The WeChat user the reply goes to. */
  toUserId: string
  /** The inbound message id the reply correlates with, sent as `run_id`; empty when the address names none. */
  messageId: string
  /** The conversation capability the inbound message carried. */
  contextToken: string
}
/**
 * Reads the reply route a Trigger's Channel address carries. Only the ids the Source itself wrote are used: the sender, the
 * message and its conversation token; a reply goes nowhere else.
 */
export function weixinReplyTargetOf(address: Record<string, string>): WeixinReplyTarget | undefined {
  const toUserId = nonEmpty(address.fromUserId)
  if (!toUserId) return undefined
  return { toUserId, messageId: nonEmpty(address.messageId), contextToken: nonEmpty(address.contextToken) }
}
/** A stable, credential-free client id for one outbound message and piece, so a retried send reuses it. */
export function weixinClientId(messageId: string, index: number): string {
  const digest = createHash('sha256').update(`${messageId}\u0000${index}`).digest('hex').slice(0, 32)
  return `dsh-weixin-${digest}`
}
/** Sends every piece of one Channel reply, in order, through the account's bot token. */
export async function sendWeixinReply(message: OutboundMessage, options: WeixinRequestOptions & { token: string
  target: WeixinReplyTarget }): Promise<'sent' | 'gone'> {
  const { target } = options
  if (!target.toUserId) return 'gone'
  const chunks = splitWeixinText(message.text)
  for (const [index, chunk] of chunks.entries()) {
    await sendWeixinText({ ...options, toUserId: target.toUserId, text: chunk, contextToken: target.contextToken,
      runId: target.messageId, clientId: weixinClientId(message.id, index) })
  }
  return 'sent'
}
/** The credentials of the instances currently polling, by Source instance id: a reply is sent through the signed-in one. */
const liveCredentials = new Map<string, string>()
/** Registers the bot token of an instance that is polling, so the Channel can send replies through it. */
export function registerWeixinCredential(instance: string, token: string): void {
  const clean = nonEmpty(token)
  if (clean) liveCredentials.set(instance, clean)
}
/** Removes one instance's live credential if it is still that token; a newer sign-in of the same instance stays. */
export function unregisterWeixinCredential(instance: string, token: string): void {
  if (liveCredentials.get(instance) === token) liveCredentials.delete(instance)
}
/** The bot token of one polling instance, or undefined while it is not signed in. */
export const liveWeixinCredential = (instance: string): string | undefined => liveCredentials.get(instance)
/** Forgets every live credential; tests use it between cases (a stopped loop removes its own). */
export function clearWeixinLiveCredentials(): void { liveCredentials.clear() }
/** A one-line, credential-free description of a transport failure, for a health detail. */
export function weixinFailureText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const clipped = text.length > 300 ? `${text.slice(0, 300)}…` : text
  if (error instanceof WeixinApiError) return `${error.code}: ${clipped}${error.providerCode ? ` (${error.providerCode})` : ''}`
  return clipped
}
/** Sleeps for `ms`, returning false when the caller aborted instead of throwing. */
export async function nap(ms: number, signal?: AbortSignal): Promise<boolean> {
  return delay(ms, undefined, { signal }).then(() => true, () => false)
}
