/**
 * DingTalk transport: the bot's Stream long connection, inbound message normalization (including the attachments a picture,
 * file or rich-text callback names and the download that turns one into bytes), the access token cache, the attachment
 * download path, the two text reply transports — the message's own `sessionWebhook` first, the robot API once it expired —
 * and the outbound media path that uploads a reply's files and sends them as a picture or file message.
 *
 * Protocol details adapted from dsh-im (MIT, Copyright (c) 2026 xmanrui, upstream 5.10.0), files
 * `src/channels/dingtalk/dingtalk-runtime.mjs`, `src/channels/dingtalk/dingtalk-api.mjs` and
 * `src/channels/dingtalk/dingtalk-bridge.mjs` (the attachment references a callback names, the file download API and the
 * media-upload plus `sampleFile`/`sampleImageMsg` send path); see THIRD_PARTY_NOTICES.md. Only the wire protocol is adapted:
 * this module has no session, command, approval or workspace logic, and imports no part of dsh-im.
 *
 * Nothing here reads configuration: the credentials come from a caller that stores them (the Source instance), and the
 * clientSecret never appears in a transport error, a log line, a health detail or a Trigger.
 */
import type { OutboundMessage } from '../../core/index.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { extname } from 'node:path'

/** DingTalk's Stream bot topic: a callback carries one message the bot received. */
export const DINGTALK_TOPIC_ROBOT = '/v1.0/im/bot/messages/get'
/** The DingTalk API base every robot call uses. */
export const DINGTALK_API_BASE = 'https://api.dingtalk.com/'
/** How much of one inbound message text a Trigger carries; the rest is not available to the worker. */
export const DINGTALK_TEXT_CHARS = 8000
/** The longest piece of reply text one DingTalk message may carry; a longer reply is sent as several messages. */
export const DINGTALK_REPLY_CHARS = 4_000
/** The largest attachment one DingTalk message may deliver; a larger file is skipped and counted in the instance's health. */
export const DINGTALK_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** The most attachments one DingTalk message may carry; a message with more is skipped instead of partly received. */
export const DINGTALK_ATTACHMENTS_PER_MESSAGE = 5
/** The largest file one reply may deliver to DingTalk; a larger one is skipped and counted in the instance's health. */
export const DINGTALK_SENT_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** The most files one reply may deliver to DingTalk; the rest are skipped and counted in the instance's health. */
export const DINGTALK_SENT_ATTACHMENTS_PER_MESSAGE = 10
/** The legacy media upload endpoint: the access token goes in the query and the file in a multipart `media` field. */
export const DINGTALK_MEDIA_UPLOAD_URL = 'https://oapi.dingtalk.com/media/upload'
const REQUEST_TIMEOUT_MS = 15_000
/** How long one media upload may take; 20 MiB over a slow link still finishes. */
const UPLOAD_TIMEOUT_MS = 60_000
/** How long the file bytes themselves may take to download; the download-address request keeps the API timeout. */
const DOWNLOAD_TIMEOUT_MS = 30_000
/** The hosts a DingTalk file download URL may name: DingTalk itself and the Alibaba CDN that serves its media. */
const DINGTALK_DOWNLOAD_HOSTS = ['dingtalk.com', 'alicdn.com'] as const
/** A cached token is refreshed this long before DingTalk expires it. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000
const DEFAULT_TOKEN_SECONDS = 7_200
const WEBHOOK_EXPIRY_MARGIN_MS = 10_000

/** The kinds of failure a DingTalk call can have; the Channel decides from them whether a reply is retryable or gone. */
export type DingtalkFailure = 'network' | 'timeout' | 'auth' | 'rate-limit' | 'rejected' | 'invalid-route' | 'expired'
  | 'invalid-response'

/** One classified DingTalk API failure: its kind, the HTTP status when there was one, and DingTalk's own code and text. */
export class DingtalkApiError extends Error {
  readonly code: DingtalkFailure
  readonly status: number | undefined
  readonly providerCode: string | undefined
  readonly providerMessage: string | undefined

  constructor(code: DingtalkFailure, message: string, options: { status?: number; providerCode?: string; providerMessage?: string
    cause?: unknown } = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'DingtalkApiError'
    this.code = code
    this.status = options.status
    this.providerCode = options.providerCode
    this.providerMessage = options.providerMessage
  }
}

/** The stage of opening the Stream connection a failure happened in, so a health detail names it. */
export type DingtalkConnectStage = 'load' | 'connect' | 'callback'

/** A failure of the Stream connection: its stage and a message that never carries a credential. */
export class DingtalkStreamError extends Error {
  readonly stage: DingtalkConnectStage

  constructor(stage: DingtalkConnectStage, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'DingtalkStreamError'
    this.stage = stage
  }
}

/** The two credentials every DingTalk API call needs; the app's Client ID and Client Secret. */
export interface DingtalkCredentials { clientId: string; clientSecret: string }
/** Why one attachment of an inbound message could not be fetched; the Source counts it in the instance's health. */
export type DingtalkAttachmentFailure = 'unavailable' | 'too-large' | 'untrusted-url' | 'download-failed'
/**
 * A failed attachment download: its kind, plus what failed for a health detail. The message never carries the access token
 * or the signed download URL, because neither may reach a log, a health detail or a Trigger.
 */
export class DingtalkAttachmentError extends Error {
  readonly code: DingtalkAttachmentFailure
  readonly status: number | undefined

  constructor(code: DingtalkAttachmentFailure, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'DingtalkAttachmentError'
    this.code = code
    this.status = options.status
  }
}
/** One attachment a callback names, before its bytes are fetched: a picture, or a file with the name DingTalk sent. */
export interface DingtalkAttachmentRef {
  kind: 'image' | 'file'
  /** The download code DingTalk issued; empty when the callback named none, which makes the attachment unavailable. */
  downloadCode: string
  /** The file name DingTalk sent for a file; empty when it sent none or for a picture. */
  name: string
}
/** One inbound message the bot received, normalized for the Source. */
export interface DingtalkMessage {
  /** The message id; a Trigger derives its id from it, so a redelivered callback is a duplicate. */
  messageId: string
  /** The message text as received, without trimming. */
  text: string
  /** The attachments the callback names, in order; the Source fetches them before the message becomes work. */
  attachments: DingtalkAttachmentRef[]
  /** The sender as the Policy's `allowed` list names people: senderStaffId, or senderId for a user outside the organization. */
  senderStaffId: string
  senderNick: string
  conversationId: string
  conversationType: 'direct' | 'group'
  conversationTitle: string
  /** Whether the message addresses the bot: a direct message always does, a group message only when it mentions the bot. */
  addressed: boolean
  /** The message's own reply address; empty when DingTalk sent none or it was not a trusted DingTalk URL. */
  sessionWebhook: string
  /** When `sessionWebhook` expires, as an ISO time; empty when DingTalk did not say. */
  sessionWebhookExpiresAt: string
  /** The robot the callback belongs to, as DingTalk names it. */
  robotCode: string
  /** The group conversation replies by robot API address; empty for a direct message. */
  openConversationId: string
  /** The message time as an ISO time; empty when DingTalk sent none. */
  createdAt: string
}
/** Why one callback became no message. */
export type DingtalkSkip = 'invalid' | 'self' | 'non-text' | 'not-addressed'
/** A callback that was not turned into a message, with what to count for the instance's health detail. */
export interface DingtalkSkipEvent { reason: DingtalkSkip; messageId?: string; messageType?: string }
/** One callback's result: either a normalized message or why it was skipped. */
export type DingtalkInbound = { message: DingtalkMessage } | { skipped: DingtalkSkipEvent }
/** The result of `replyTargetOf`: the immutable route a trigger carries for its replies. */
export interface DingtalkReplyTarget {
  conversationType: 'direct' | 'group'
  /** The group conversation the robot API sends to; empty for a direct message. */
  openConversationId: string
  /** The person the robot API sends a direct message to; empty for a group. */
  userId: string
  /** The sender a group reply mentions natively; empty when unknown. */
  senderStaffId: string
  robotCode: string
  /** The message's own reply address, sent to while it is fresh. */
  sessionWebhook: string
  /** When `sessionWebhook` expires, as an ISO time; empty when unknown. */
  sessionWebhookExpiresAt: string
}
/** How to reach DingTalk: the injected fetch and clock keep tests off the network. */
export interface DingtalkRequestOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  signal?: AbortSignal
  timeoutMs?: number
}
/** One outbound text job: the credentials to authenticate with and the reply route to send to. */
export interface DingtalkSendOptions extends DingtalkRequestOptions {
  credentials: DingtalkCredentials
  /** The route the Trigger carried; the only place a reply may go. */
  target: DingtalkReplyTarget
}
/** One file a reply delivers, already read from disk: its display name, MIME type and bytes. */
export interface DingtalkOutboundFile { name: string; mime: string; data: Buffer }
/** One robot message the transport sends: DingTalk's message template key and its JSON `msgParam` object. */
export interface DingtalkRobotMessage { msgKey: string; msgParam: Record<string, unknown> }

const nonEmpty = (value: unknown): string => typeof value === 'string' && value.trim() ? value.trim() : ''
/** A DingTalk timestamp as ISO: Stream callbacks send milliseconds, and a seconds value is accepted too. */
function isoTime(value: unknown): string {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (!Number.isFinite(number) || number <= 0) return ''
  return new Date(number < 10_000_000_000 ? number * 1_000 : number).toISOString()
}
/** The trusted form of a DingTalk URL: HTTPS on dingtalk.com, no credentials and no fragment; empty when unacceptable. */
function trustedDingtalkUrl(value: unknown): string {
  const text = nonEmpty(value)
  if (!text) return ''
  let url: URL
  try { url = new URL(text) } catch { return '' }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const trusted = host === 'dingtalk.com' || host.endsWith('.dingtalk.com')
  if (url.protocol !== 'https:' || !trusted || (url.port && url.port !== '443') || url.username || url.password) return ''
  url.hash = ''
  return url.toString()
}
/**
 * The trusted form of the file download URL DingTalk hands back: HTTPS on a DingTalk host or the Alibaba CDN that serves
 * its media, no port beyond 443 and no credentials. The URL is the only place the download may go; an empty result means
 * the Source refuses it, so a provider that answers an arbitrary host cannot redirect the download.
 */
export function trustedDingtalkDownloadUrl(value: unknown): string {
  const text = nonEmpty(value)
  if (!text) return ''
  let url: URL
  try { url = new URL(text) } catch { return '' }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password) return ''
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!DINGTALK_DOWNLOAD_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`))) return ''
  // The query string is a signed download credential and is kept; the fragment means nothing to a download.
  url.hash = ''
  return url.toString()
}
/** The `senderStaffId` a callback names, falling back to `senderId` for a sender outside the organization. */
function senderOf(payload: Record<string, unknown>): string {
  return nonEmpty(payload.senderStaffId) || nonEmpty(payload.senderId)
}
/** The at-list of a group callback, as objects carrying the mentioned user's ids. */
function atUsersOf(payload: Record<string, unknown>): string[] {
  const list = Array.isArray(payload.atUsers) ? payload.atUsers : []
  return list.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as Record<string, unknown>
    return [nonEmpty(row.dingtalkId), nonEmpty(row.staffId), nonEmpty(row.userId)].filter(Boolean)
  })
}
/** The JSON object a callback carries in `content`; DingTalk sends picture, file and rich-text content as an object or JSON. */
function contentOf(raw: Record<string, unknown>): Record<string, unknown> {
  const content = raw.content
  if (typeof content === 'string') {
    try {
      const parsed: unknown = JSON.parse(content)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch { return {} }
  }
  return content && typeof content === 'object' && !Array.isArray(content) ? content as Record<string, unknown> : {}
}
/** The rich-text entries a rich-text content carries, whether DingTalk sent them as an array or as JSON text. */
function richTextEntries(content: Record<string, unknown>): Record<string, unknown>[] {
  const entries = content.richText ?? content.rich_text
  return Array.isArray(entries) ? entries.filter((entry): entry is Record<string, unknown> =>
    !!entry && typeof entry === 'object' && !Array.isArray(entry)) : []
}
/** The text of one rich-text entry: its `text` string, its nested `text.content`, or a text entry's `content`. */
function richTextEntryText(entry: Record<string, unknown>): string {
  const direct = nonEmpty(entry.text)
  if (direct) return direct
  if (entry.text && typeof entry.text === 'object') {
    const nested = nonEmpty((entry.text as Record<string, unknown>).content)
    if (nested) return nested
  }
  return String(entry.type ?? '').toLowerCase() === 'text' ? nonEmpty(entry.content) : ''
}
/** The download code a picture or file content names: `downloadCode`, or a picture's `pictureDownloadCode`. */
function downloadCodeOf(content: Record<string, unknown>): string {
  return nonEmpty(content.downloadCode) || nonEmpty(content.pictureDownloadCode)
}
/** The kind marker of a rich-text entry; a quoted entry names it `msgType` instead of `type`. */
function richTextEntryType(entry: Record<string, unknown>): string {
  return String(entry.type ?? entry.msgType ?? entry.msgtype ?? '').toLowerCase()
}
/**
 * The attachments one callback names: the download reference of a picture, of a file, or the pictures a rich-text message
 * carries in order. A file's name is kept as DingTalk sent it and sanitized only when it becomes a local path.
 */
function attachmentsOf(messageType: string, content: Record<string, unknown>): DingtalkAttachmentRef[] {
  if (messageType === 'picture') return [{ kind: 'image', downloadCode: downloadCodeOf(content), name: '' }]
  if (messageType === 'file') {
    return [{ kind: 'file', downloadCode: nonEmpty(content.downloadCode),
      name: nonEmpty(content.fileName) || nonEmpty(content.file_name) }]
  }
  if (messageType !== 'richtext') return []
  return richTextEntries(content)
    .filter(entry => richTextEntryType(entry) === 'picture')
    .map(entry => ({ kind: 'image' as const, downloadCode: downloadCodeOf(entry), name: '' }))
}
/**
 * Normalizes one Stream callback payload (already parsed) into a message, or says why it is no message for this Source.
 * A direct message addresses the bot by construction; a group message only when DingTalk says it is in the at-list, which
 * is `isInAtList` or an `atUsers` entry naming the bot's own `chatbotUserId`. A callback from the bot itself, one of an
 * unsupported type (voice, video, an empty rich-text card) and one with no sender, conversation or message id are skipped
 * and never become a Trigger. A text message, a picture, a file and a rich-text message whose pictures it names all become
 * a message; the attachments are references only, and the Source fetches their bytes before the message becomes work.
 */
export function normalizeDingtalkCallback(payload: unknown): DingtalkInbound {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { skipped: { reason: 'invalid' } }
  const raw = payload as Record<string, unknown>
  const messageId = nonEmpty(raw.msgId) || nonEmpty(raw.messageId)
  const sender = senderOf(raw)
  const conversationId = nonEmpty(raw.conversationId)
  const conversationType = String(raw.conversationType ?? '')
  const messageType = nonEmpty(raw.msgtype ?? raw.msgType).toLowerCase()
  const skip = (reason: DingtalkSkip): DingtalkInbound => ({ skipped: { reason, ...messageId ? { messageId } : {},
    ...messageType ? { messageType } : {} } })
  if (!messageId || !sender || !conversationId) return skip('invalid')
  if (conversationType !== '1' && conversationType !== '2') return skip('invalid')
  // The bot's own user id names the messages it wrote; those never ask it for work.
  const chatbotUserId = nonEmpty(raw.chatbotUserId)
  const senderId = nonEmpty(raw.senderId)
  if (chatbotUserId && (sender === chatbotUserId || senderId === chatbotUserId)) return skip('self')
  const content = contentOf(raw)
  const text = messageType === 'text'
    ? nonEmpty(raw.text && typeof raw.text === 'object' ? (raw.text as Record<string, unknown>).content : '')
    : messageType === 'richtext' ? richTextEntries(content).map(richTextEntryText).filter(Boolean).join('\n') : ''
  const attachments = attachmentsOf(messageType, content)
  const supported = messageType === 'text' || messageType === 'picture' || messageType === 'file'
    || messageType === 'richtext'
  if (!supported || (!text.trim() && !attachments.length)) return skip('non-text')
  const group = conversationType === '2'
  const mentioned = Array.isArray(raw.atUsers) ? atUsersOf(raw) : []
  const addressed = !group || raw.isInAtList === true || (!!chatbotUserId && mentioned.includes(chatbotUserId))
  if (!addressed) return skip('not-addressed')
  return { message: {
    messageId,
    text,
    attachments,
    senderStaffId: sender,
    senderNick: nonEmpty(raw.senderNick),
    conversationId,
    conversationType: group ? 'group' : 'direct',
    conversationTitle: nonEmpty(raw.conversationTitle),
    addressed: true,
    sessionWebhook: trustedDingtalkUrl(raw.sessionWebhook),
    sessionWebhookExpiresAt: isoTime(raw.sessionWebhookExpiredTime),
    robotCode: nonEmpty(raw.robotCode),
    openConversationId: group ? conversationId : '',
    createdAt: isoTime(raw.createAt),
  } }
}
/** Splits a long reply into DingTalk-sized text messages, preferring a line break when one is not too early. */
export function splitDingtalkText(value: string, maxChars = DINGTALK_REPLY_CHARS): string[] {
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
/** The route a stored Channel address names, or undefined when it cannot receive a reply. */
export function replyTargetOf(address: Record<string, string>): DingtalkReplyTarget | undefined {
  const conversationType = address.conversationType === 'group' || address.conversationType === 'direct'
    ? address.conversationType : undefined
  const robotCode = address.robotCode ?? ''
  if (!conversationType || !robotCode) return undefined
  const openConversationId = address.openConversationId ?? ''
  const userId = address.userId ?? ''
  if (conversationType === 'group' ? !openConversationId : !userId) return undefined
  return { conversationType, openConversationId: conversationType === 'group' ? openConversationId : '',
    userId: conversationType === 'direct' ? userId : '', senderStaffId: address.senderStaffId ?? '', robotCode,
    sessionWebhook: address.sessionWebhook ? trustedDingtalkUrl(address.sessionWebhook) : '',
    sessionWebhookExpiresAt: address.sessionWebhookExpiresAt ?? '' }
}
/** Whether a route's own reply address is known to have expired; a route without a known expiry is tried first. */
export function webhookExpired(target: DingtalkReplyTarget, now: number): boolean {
  if (!target.sessionWebhook) return true
  const expiry = Date.parse(target.sessionWebhookExpiresAt)
  return Number.isFinite(expiry) && now >= expiry - WEBHOOK_EXPIRY_MARGIN_MS
}
/** The ids of people a group reply mentions natively; a direct message mentions nobody. */
export function replyAtUserIds(target: DingtalkReplyTarget): string[] {
  return target.conversationType === 'group' && target.senderStaffId ? [target.senderStaffId] : []
}
/** The status, code and text of a failed HTTP answer, read without ever touching a credential. */
function failureOf(status: number, body: unknown): { code: DingtalkFailure; providerCode?: string; providerMessage?: string } {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  const providerCode = nonEmpty(record.code) || nonEmpty(record.errcode) || undefined
  const providerMessage = nonEmpty(record.message) || nonEmpty(record.errmsg) || undefined
  const extra = { ...providerCode ? { providerCode } : {}, ...providerMessage ? { providerMessage } : {} }
  if (status === 401 || status === 403) return { code: 'auth', ...extra }
  if (status === 429) return { code: 'rate-limit', ...extra }
  if (status === 408 || status >= 500) return { code: 'network', ...extra }
  return { code: 'rejected', ...extra }
}
/** The rejection code a DingTalk answer carries as `errcode` or `code`, whether a number or text; empty on success. */
function rejectionOf(record: Record<string, unknown>): string {
  const errcode = record.errcode
  if (typeof errcode === 'number') return errcode === 0 ? '' : String(errcode)
  if (typeof errcode === 'string') {
    const text = errcode.trim()
    if (text && text !== '0') return text
  }
  const code = nonEmpty(record.code)
  return code === '0' ? '' : code
}
/** DingTalk's "the reply address has expired" answer: an HTTP 4xx whose code or text names the session webhook. */
function expiredWebhook(status: number, body: unknown): boolean {
  if (status < 400 || status >= 500) return false
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  const text = `${nonEmpty(record.code)} ${nonEmpty(record.errcode)} ${nonEmpty(record.message)} ${nonEmpty(record.errmsg)}`
  return /(?:session.?webhook|invalid.?session|expire|临时授权码|过期)/i.test(text)
}
/**
 * Whether a failed robot send says the target can never receive: an unknown or invalid user, conversation or robot. Such
 * a failure settles the message as gone, while any other failure is retried.
 */
function unreachableTarget(status: number, body: unknown): boolean {
  if (status !== 400 && status !== 404) return false
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  const text = `${nonEmpty(record.code)} ${nonEmpty(record.message)}`
  return /(?:invalid|unknown|not.?found|not.?exist).{0,24}(?:staff|user|member|conversation|chat|robot)|(?:staff|user|member|conversation|chat|robot).{0,24}(?:invalid|unknown|not.?found|not.?exist|no.?longer)/i
    .test(text)
}
/** One JSON POST with a bounded timeout; the caller's abort signal and the timeout both stop it. */
async function postJson(url: string, body: unknown, options: DingtalkRequestOptions,
  headers: Record<string, string> = {}): Promise<{ status: number; ok: boolean; body: unknown }> {
  const { fetchImpl = fetch, signal, timeoutMs = REQUEST_TIMEOUT_MS } = options
  signal?.throwIfAborted()
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
  const combined = timeout && signal ? AbortSignal.any([signal, timeout]) : signal ?? timeout
  let response: Response
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}), signal: combined })
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('The DingTalk request was stopped')
    if (timeout?.aborted) throw new DingtalkApiError('timeout', 'The DingTalk request timed out', { cause: error })
    throw new DingtalkApiError('network', 'DingTalk could not be reached', { cause: error })
  }
  let parsed: unknown
  try { parsed = await response.json() } catch { parsed = undefined }
  if (!response.ok) {
    const failure = failureOf(response.status, parsed)
    throw new DingtalkApiError(failure.code, `DingTalk answered HTTP ${response.status}`,
      { status: response.status, ...failure.providerCode ? { providerCode: failure.providerCode } : {},
        ...failure.providerMessage ? { providerMessage: failure.providerMessage } : {} })
  }
  return { status: response.status, ok: response.ok, body: parsed }
}
/** The access tokens one client id already fetched, and the requests in flight, so parallel sends share one call. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>()
const tokenRequests = new Map<string, Promise<string>>()
/** Forgets cached tokens (tests, or an instance whose credentials changed). */
export function clearDingtalkTokens(): void {
  tokenCache.clear()
  tokenRequests.clear()
}
/**
 * Fetches a DingTalk access token for one app, caching it per Client ID until five minutes before DingTalk's expiry.
 * Concurrent calls for the same Client ID share one request; the Client Secret is sent only in the request body.
 */
export async function dingtalkAccessToken(credentials: DingtalkCredentials, options: DingtalkRequestOptions = {}): Promise<string> {
  const clientId = nonEmpty(credentials.clientId)
  const clientSecret = nonEmpty(credentials.clientSecret)
  if (!clientId || !clientSecret) throw new TypeError('DingTalk needs a Client ID and a Client Secret')
  const now = options.now ?? Date.now
  const cached = tokenCache.get(clientId)
  if (cached && cached.expiresAt > now()) return cached.token
  const running = tokenRequests.get(clientId)
  if (running) return running
  const request = (async () => {
    const { body } = await postJson(new URL('v1.0/oauth2/accessToken', DINGTALK_API_BASE).toString(),
      { appKey: clientId, appSecret: clientSecret }, options)
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    const token = nonEmpty(record.accessToken)
    if (!token) throw new DingtalkApiError('invalid-response', 'DingTalk returned no access token')
    const seconds = Number(record.expireIn ?? record.expiresIn)
    const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TOKEN_SECONDS
    const refreshAfter = Math.max(60_000, lifetime * 1_000 - TOKEN_REFRESH_MARGIN_MS)
    tokenCache.set(clientId, { token, expiresAt: now() + refreshAfter })
    return token
  })()
  const shared = request.finally(() => tokenRequests.delete(clientId))
  tokenRequests.set(clientId, shared)
  return shared
}
/** One attachment download request: the instance credentials, the robot and the reference to fetch. */
export interface DingtalkAttachmentRequest extends DingtalkRequestOptions {
  credentials: DingtalkCredentials
  /** The robot the callback belongs to; DingTalk resolves the download code for it. */
  robotCode: string
  attachment: DingtalkAttachmentRef
  /** The largest file accepted, in bytes; a larger one fails as `too-large` without any of it being kept. */
  maxBytes?: number
}
/** One fetched attachment: its bytes, MIME type and the file name DingTalk sent (empty for a picture). */
export interface DingtalkDownloadedFile { data: Buffer; mime: string; name: string }
/** The MIME type a Content-Type names, without parameters; a missing or malformed one is a binary stream. */
function mimeOf(value: string | null): string {
  const text = (value ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(text) ? text : 'application/octet-stream'
}
/** Reads a response body, stopping as soon as it exceeds `maxBytes`; the rest of a too-large body is cancelled. */
async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new DingtalkAttachmentError('too-large', `The DingTalk attachment exceeds ${maxBytes} bytes`)
  }
  const body = response.body
  if (!body) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new DingtalkAttachmentError('too-large', `The DingTalk attachment exceeds ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    try { reader.releaseLock() } catch { /* A cancelled stream is already released. */ }
  }
  return Buffer.concat(chunks, total)
}
/**
 * Fetches one inbound attachment: `messageFiles/download` turns the callback's download code into a signed download URL,
 * which must be HTTPS on a DingTalk host — an answer naming any other host is refused and the URL is never followed —
 * and a bounded 30 s GET then reads the bytes. Neither the access token nor the signed URL appears in a failure.
 */
export async function downloadDingtalkAttachment(request: DingtalkAttachmentRequest): Promise<DingtalkDownloadedFile> {
  const { credentials, attachment, fetchImpl = fetch, signal } = request
  const robotCode = nonEmpty(request.robotCode)
  const downloadCode = nonEmpty(attachment.downloadCode)
  if (!robotCode || !downloadCode) {
    throw new DingtalkAttachmentError('unavailable', 'DingTalk delivered no download reference for the attachment')
  }
  const maxBytes = typeof request.maxBytes === 'number' && Number.isFinite(request.maxBytes) && request.maxBytes > 0
    ? request.maxBytes : DINGTALK_ATTACHMENT_BYTES
  let downloadUrl: string
  try {
    const token = await dingtalkAccessToken(credentials, request)
    const answer = await postJson(new URL('v1.0/robot/messageFiles/download', DINGTALK_API_BASE).toString(),
      { downloadCode, robotCode }, request, { 'x-acs-dingtalk-access-token': token })
    const record = answer.body && typeof answer.body === 'object' ? answer.body as Record<string, unknown> : {}
    const candidate = record.downloadUrl ?? record.download_url
    downloadUrl = trustedDingtalkDownloadUrl(candidate)
    if (!downloadUrl) {
      if (!nonEmpty(candidate)) {
        throw new DingtalkAttachmentError('download-failed', 'DingTalk returned no attachment download address')
      }
      throw new DingtalkAttachmentError('untrusted-url', 'DingTalk returned an untrusted attachment download address')
    }
  } catch (error) {
    if (error instanceof DingtalkAttachmentError) throw error
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('The DingTalk attachment download was stopped')
    throw new DingtalkAttachmentError('download-failed',
      `The attachment download address could not be fetched: ${dingtalkFailureText(error)}`, { cause: error })
  }
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetchImpl(downloadUrl, { method: 'GET', redirect: 'error', signal: combined })
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('The DingTalk attachment download was stopped')
    if (timeout.aborted) throw new DingtalkAttachmentError('download-failed', 'The DingTalk attachment download timed out', { cause: error })
    throw new DingtalkAttachmentError('download-failed', 'The DingTalk attachment download failed', { cause: error })
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new DingtalkAttachmentError('download-failed', `DingTalk answered HTTP ${response.status} for the attachment`,
      { status: response.status })
  }
  const data = await boundedBody(response, maxBytes)
  return { data, mime: mimeOf(response.headers.get('content-type')), name: nonEmpty(attachment.name) }
}
/**
 * Sends one text piece to the message's own `sessionWebhook`, mentioning `atUserIds` natively with DingTalk's `at` field
 * (the syntax dsh-im uses for a group reply). Throws `expired` when DingTalk says the address is no longer valid.
 */
export async function sendDingtalkWebhook(options: DingtalkRequestOptions & { webhook: string; token: string; text: string
  atUserIds?: readonly string[] }): Promise<void> {
  const webhook = trustedDingtalkUrl(options.webhook)
  if (!webhook) throw new DingtalkApiError('invalid-route', 'The DingTalk reply address is not a trusted DingTalk URL')
  const atUserIds = (options.atUserIds ?? []).filter(Boolean)
  const body = { msgtype: 'text', text: { content: options.text }, ...atUserIds.length ? { at: { atUserIds } } : {} }
  try {
    const answer = await postJson(webhook, body, options, { 'x-acs-dingtalk-access-token': options.token })
    const record = answer.body && typeof answer.body === 'object' ? answer.body as Record<string, unknown> : {}
    if (record.errcode !== undefined && record.errcode !== 0 && record.errcode !== '0') {
      if (expiredWebhook(400, record)) throw new DingtalkApiError('expired', 'The DingTalk reply address expired')
      throw new DingtalkApiError('rejected', 'DingTalk rejected the reply', { providerCode: nonEmpty(record.errcode) || undefined })
    }
  } catch (error) {
    if (error instanceof DingtalkApiError && error.status !== undefined
      && expiredWebhook(error.status, { code: error.providerCode, message: error.providerMessage })) {
      throw new DingtalkApiError('expired', 'The DingTalk reply address expired', { status: error.status, cause: error })
    }
    throw error
  }
}
/** One robot message: its message key and JSON `msgParam`, sent to the group conversation or the person the route names. */
async function sendDingtalkRobotMessage(target: DingtalkReplyTarget, message: DingtalkRobotMessage,
  options: DingtalkRequestOptions & { token: string }): Promise<void> {
  assertDingtalkRoute(target)
  const group = target.conversationType === 'group'
  const path = group ? 'v1.0/robot/groupMessages/send' : 'v1.0/robot/oToMessages/batchSend'
  const body = { robotCode: target.robotCode, msgKey: message.msgKey, msgParam: JSON.stringify(message.msgParam),
    ...group ? { openConversationId: target.openConversationId } : { userIds: [target.userId] } }
  try {
    const answer = await postJson(new URL(path, DINGTALK_API_BASE).toString(), body, options,
      { 'x-acs-dingtalk-access-token': options.token })
    const record = answer.body && typeof answer.body === 'object' ? answer.body as Record<string, unknown> : {}
    const rejection = rejectionOf(record)
    if (rejection) {
      if (unreachableTarget(400, record)) throw new DingtalkApiError('invalid-route', 'DingTalk no longer knows the target', { providerCode: rejection })
      throw new DingtalkApiError('rejected', 'DingTalk rejected the robot message', { providerCode: rejection })
    }
  } catch (error) {
    if (error instanceof DingtalkApiError && error.status !== undefined
      && unreachableTarget(error.status, { code: error.providerCode, message: error.providerMessage })) {
      throw new DingtalkApiError('invalid-route', 'DingTalk no longer knows the target', { status: error.status, cause: error })
    }
    throw error
  }
}
/**
 * Sends one text piece through the robot API: `groupMessages/send` with the group's `openConversationId`, or
 * `oToMessages/batchSend` with the person's `userIds`. A failure that says the target no longer exists is `invalid-route`.
 */
export async function sendDingtalkRobot(options: DingtalkRequestOptions & { target: DingtalkReplyTarget; token: string
  text: string }): Promise<void> {
  await sendDingtalkRobotMessage(options.target, { msgKey: 'sampleText', msgParam: { content: options.text } }, options)
}
/** The message one uploaded file is sent as: a picture for an `image/*` type (`sampleImageMsg`, whose `photoURL` may be the
 * media id) and a file for every other type (`sampleFile` with its media id, display name and lower-case extension).
 */
export function dingtalkMediaMessage(file: { name: string; mime: string }, mediaId: string): DingtalkRobotMessage {
  if (/^image\//i.test(file.mime)) return { msgKey: 'sampleImageMsg', msgParam: { photoURL: mediaId } }
  return { msgKey: 'sampleFile', msgParam: { mediaId, fileName: file.name, fileType: extname(file.name).slice(1).toLowerCase() } }
}
/** Throws `invalid-route` when the Trigger's route cannot receive a robot message; nothing is uploaded for such a route. */
function assertDingtalkRoute(target: DingtalkReplyTarget): void {
  if (!target.robotCode) throw new DingtalkApiError('invalid-route', 'The DingTalk reply has no robot code')
  const group = target.conversationType === 'group'
  if (group ? !target.openConversationId : !target.userId) {
    throw new DingtalkApiError('invalid-route', 'The DingTalk reply has no target conversation')
  }
}
/**
 * Uploads one outbound file through DingTalk's media API: `POST /media/upload` with the instance's access token in the query
 * and the bytes as a multipart `media` field, typed `image` for a picture and `file` otherwise. Returns the `media_id` the
 * message sends it with; the upload address and the token never appear in a failure.
 */
export async function uploadDingtalkMedia(file: DingtalkOutboundFile, options: DingtalkRequestOptions & { token: string }):
Promise<string> {
  const token = nonEmpty(options.token)
  if (!token) throw new DingtalkApiError('auth', 'The DingTalk media upload has no access token')
  if (!nonEmpty(file.name)) throw new TypeError('A DingTalk media upload needs a file name')
  if (!file.data.byteLength) throw new DingtalkApiError('rejected', 'The DingTalk media upload carries no bytes')
  const { fetchImpl = fetch, signal, timeoutMs = UPLOAD_TIMEOUT_MS } = options
  signal?.throwIfAborted()
  const url = new URL(DINGTALK_MEDIA_UPLOAD_URL)
  url.searchParams.set('access_token', token)
  url.searchParams.set('type', /^image\//i.test(file.mime) ? 'image' : 'file')
  const form = new FormData()
  form.append('media', new Blob([new Uint8Array(file.data)], { type: file.mime || 'application/octet-stream' }), file.name)
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
  const combined = timeout && signal ? AbortSignal.any([signal, timeout]) : signal ?? timeout
  let response: Response
  try {
    response = await fetchImpl(url.toString(), { method: 'POST', redirect: 'error', body: form, signal: combined })
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('The DingTalk media upload was stopped')
    if (timeout?.aborted) throw new DingtalkApiError('timeout', 'The DingTalk media upload timed out', { cause: error })
    throw new DingtalkApiError('network', 'DingTalk could not be reached for the media upload', { cause: error })
  }
  let parsed: unknown
  try { parsed = await response.json() } catch { parsed = undefined }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  if (!response.ok) {
    const failure = failureOf(response.status, record)
    throw new DingtalkApiError(failure.code, `DingTalk answered HTTP ${response.status} for the media upload`,
      { status: response.status, ...failure.providerCode ? { providerCode: failure.providerCode } : {},
        ...failure.providerMessage ? { providerMessage: failure.providerMessage } : {} })
  }
  const rejection = rejectionOf(record)
  if (rejection) throw new DingtalkApiError('rejected', 'DingTalk rejected the media upload', { providerCode: rejection })
  const mediaId = nonEmpty(record.media_id) || nonEmpty(record.mediaId)
  if (!mediaId) throw new DingtalkApiError('invalid-response', 'DingTalk returned no media id for the uploaded file')
  return mediaId
}
/**
 * Delivers one file beside a reply: upload it with the instance's own access token, then send the media to the Trigger's own
 * route as the picture or file message its MIME type names. Every failure is thrown, classified, for the Source to count;
 * the reply's text is already delivered and is never sent again because of a file.
 */
export async function sendDingtalkAttachment(file: DingtalkOutboundFile, options: DingtalkSendOptions): Promise<void> {
  // The route is checked before anything is uploaded, so a Trigger that cannot receive a reply uploads nothing.
  assertDingtalkRoute(options.target)
  const token = await dingtalkAccessToken(options.credentials, options)
  const mediaId = await uploadDingtalkMedia(file, { ...options, token })
  await sendDingtalkRobotMessage(options.target, dingtalkMediaMessage(file, mediaId), { ...options, token })
}
/**
 * Sends one Channel message to the route its Trigger carried: pieces go to the still-fresh `sessionWebhook` first, and a
 * piece whose webhook expired is sent through the robot API instead. Only a conversation DingTalk no longer knows is
 * `gone`; every other failure is thrown for the Outbox to retry. Files are not sent here; the Source delivers them after.
 */
export async function sendDingtalkReply(message: OutboundMessage, options: DingtalkSendOptions): Promise<'sent' | 'gone'> {
  const { target } = options
  const now = options.now ?? Date.now
  const chunks = splitDingtalkText(message.text)
  if (!chunks.length) return 'sent'
  const token = await dingtalkAccessToken(options.credentials, options)
  let webhookUsable = !webhookExpired(target, now())
  for (const chunk of chunks) {
    if (webhookUsable) {
      try {
        await sendDingtalkWebhook({ ...options, webhook: target.sessionWebhook, token, text: chunk,
          atUserIds: replyAtUserIds(target) })
        continue
      } catch (error) {
        if (!(error instanceof DingtalkApiError) || error.code !== 'expired') throw error
        webhookUsable = false
      }
    }
    try {
      await sendDingtalkRobot({ ...options, target, token, text: chunk })
    } catch (error) {
      if (error instanceof DingtalkApiError && error.code === 'invalid-route') return 'gone'
      throw error
    }
  }
  return 'sent'
}

/** One callback envelope from DingTalk's Stream as the SDK hands it over: its headers and the payload's JSON text. */
export interface DingtalkStreamEnvelope { headers?: { messageId?: string } | undefined; data?: unknown }
/** The DingTalk Stream client operations this transport needs, so tests can inject a fake instead of a socket. */
export interface DingtalkStreamClient {
  connected: boolean
  registerCallbackListener(topic: string, callback: (envelope: DingtalkStreamEnvelope) => void): unknown
  connect(): Promise<void>
  disconnect(): void
  socketCallBackResponse(messageId: string, result: unknown): void
}
/** A created Stream client and the bot topic it answers. */
export interface DingtalkStream { client: DingtalkStreamClient; topic: string }
/** Creates a Stream client for one app; the production one loads the `dingtalk-stream` SDK lazily. */
export type DingtalkStreamFactory = (credentials: DingtalkCredentials) => Promise<DingtalkStream>
/**
 * The production Stream factory: loads the public `dingtalk-stream` SDK on first use, with DingTalk's own reconnect off
 * because the Source's loop owns the backoff. A missing SDK fails here as a `load` error instead of breaking the plugin.
 */
export const dingtalkStreamFactory: DingtalkStreamFactory = async ({ clientId, clientSecret }) => {
  let sdk: { DWClient: new (config: unknown) => unknown; TOPIC_ROBOT: string }
  try { sdk = await import('dingtalk-stream') as unknown as typeof sdk }
  catch (error) { throw new DingtalkStreamError('load', 'The dingtalk-stream SDK could not be loaded', { cause: error }) }
  const client = new sdk.DWClient({ clientId, clientSecret, keepAlive: true, debug: false, autoReconnect: false })
  return { client: client as unknown as DingtalkStreamClient, topic: sdk.TOPIC_ROBOT ?? DINGTALK_TOPIC_ROBOT }
}
/** One connection's options, as the caller injected them; every field has a production default. */
export interface DingtalkConnectionOptions extends DingtalkCredentials {
  onMessage(message: DingtalkMessage): void | Promise<void>
  onSkip?(skip: DingtalkSkipEvent): void
  streamFactory?: DingtalkStreamFactory
  connectTimeoutMs?: number
  probeIntervalMs?: number
}
/** Sleeps for `ms`, returning false when `signal` aborted instead of throwing. */
const nap = (ms: number, signal?: AbortSignal): Promise<boolean> =>
  delay(ms, undefined, { signal }).then(() => true, () => false)
/** The short reason of an error, for a health detail; a secret is redacted wherever it would appear. */
function reasonOf(error: unknown, clientSecret: string): string {
  const text = error instanceof Error ? error.message : String(error)
  const scrubbed = clientSecret.length >= 4 ? text.split(clientSecret).join('[redacted]') : text
  return scrubbed.length > 200 ? `${scrubbed.slice(0, 200)}…` : scrubbed
}
/**
 * One bot's Stream connection: registers the bot-message callback, acknowledges each callback at once (DingTalk retries an
 * unacknowledged push), then parses and dispatches it; connects within a bounded time and reports when the socket closes,
 * so the Source's loop owns reconnection. Nothing is retried inside: a closed or failed connection is thrown to the loop.
 */
export class DingtalkConnection {
  private readonly options: DingtalkConnectionOptions
  private client: DingtalkStreamClient | null = null
  private topic = DINGTALK_TOPIC_ROBOT
  private readonly tasks = new Set<Promise<void>>()
  private closed = false

  constructor(options: DingtalkConnectionOptions) {
    if (!nonEmpty(options.clientId) || !nonEmpty(options.clientSecret)) {
      throw new TypeError('A DingTalk connection needs a Client ID and a Client Secret')
    }
    this.options = options
  }
  /** Whether the Stream client says its socket is open. */
  get connected(): boolean { return this.client?.connected === true }
  /** The topic the connection answers, for health details. */
  get botTopic(): string { return this.topic }
  /**
   * Creates the Stream client, registers the callback and opens the socket within `connectTimeoutMs`. An SDK, handshake or
   * callback-registration failure is thrown as a `DingtalkStreamError` naming its stage; the failed client is closed.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.client) throw new DingtalkStreamError('connect', 'The DingTalk connection is already open')
    const { clientId, clientSecret, connectTimeoutMs = 15_000, probeIntervalMs = 50 } = this.options
    const factory = this.options.streamFactory ?? dingtalkStreamFactory
    let created: DingtalkStream
    try { created = await factory({ clientId, clientSecret }) }
    catch (error) {
      if (error instanceof DingtalkStreamError) throw error
      throw new DingtalkStreamError('load', `The DingTalk Stream client could not be created: ${reasonOf(error, clientSecret)}`, { cause: error })
    }
    const { client, topic } = created
    const usable = client && typeof client.registerCallbackListener === 'function' && typeof client.connect === 'function'
      && typeof client.disconnect === 'function' && typeof client.socketCallBackResponse === 'function'
    if (!usable || !nonEmpty(topic)) {
      throw new DingtalkStreamError('load', 'The DingTalk Stream client is not usable')
    }
    this.client = client
    this.topic = nonEmpty(topic) || DINGTALK_TOPIC_ROBOT
    try { client.registerCallbackListener(this.topic, envelope => { this.receive(envelope) }) }
    catch (error) {
      await this.close()
      throw new DingtalkStreamError('callback', `The DingTalk bot message callback could not be registered: ${reasonOf(error, clientSecret)}`, { cause: error })
    }
    signal?.throwIfAborted()
    const deadline = Date.now() + connectTimeoutMs
    try { await client.connect() }
    catch (error) {
      await this.close()
      throw new DingtalkStreamError('connect', `The DingTalk Stream handshake failed: ${reasonOf(error, clientSecret)}`, { cause: error })
    }
    while (!client.connected) {
      if (signal?.aborted) { await this.close(); throw signal.reason ?? new Error('The DingTalk connection was stopped') }
      if (Date.now() > deadline) {
        await this.close()
        throw new DingtalkStreamError('connect', `The DingTalk Stream connection did not open within ${connectTimeoutMs} ms`)
      }
      await nap(probeIntervalMs, signal)
    }
  }
  /** Acknowledges a callback at once, then parses and dispatches it; nothing a callback does closes the connection. */
  private receive(envelope: DingtalkStreamEnvelope): void {
    const client = this.client
    if (!client || this.closed) return
    const messageId = nonEmpty(envelope?.headers?.messageId)
    if (messageId) {
      try { client.socketCallBackResponse(messageId, { success: true }) } catch { /* A failed ack shows as a redelivery. */ }
    }
    let payload: unknown = envelope?.data
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload) } catch { this.skip({ reason: 'invalid', ...messageId ? { messageId } : {} }); return }
    }
    const inbound = normalizeDingtalkCallback(payload)
    if ('skipped' in inbound) { this.skip(inbound.skipped); return }
    const task = Promise.resolve().then(() => this.options.onMessage((inbound as { message: DingtalkMessage }).message))
      .catch(() => { /* A handler failure is the Source's to report; the connection stays up. */ })
      .finally(() => { this.tasks.delete(task) })
    this.tasks.add(task)
  }
  private skip(skip: DingtalkSkipEvent): void {
    try { this.options.onSkip?.(skip) } catch { /* Counting a skip never interrupts the connection. */ }
  }
  /** Waits until the Stream socket closes or the caller aborts; returns immediately when it is already closed. */
  async waitForClose(signal?: AbortSignal): Promise<void> {
    const probeIntervalMs = this.options.probeIntervalMs ?? 1_000
    while (!signal?.aborted && this.client?.connected) await nap(probeIntervalMs, signal)
  }
  /** Closes the socket and waits for the callback handlers already dispatched. */
  async close(): Promise<void> {
    this.closed = true
    const client = this.client
    this.client = null
    if (client) { try { client.disconnect() } catch { /* Already closed. */ } }
    await Promise.allSettled([...this.tasks])
    this.tasks.clear()
  }
}
/** A one-line, credential-free description of a transport failure, for a health detail. */
export function dingtalkFailureText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const clipped = text.length > 300 ? `${text.slice(0, 300)}…` : text
  if (error instanceof DingtalkApiError) return `${error.code}: ${clipped}${error.providerCode ? ` (${error.providerCode})` : ''}`
  if (error instanceof DingtalkStreamError) return `${error.stage}: ${clipped}`
  return clipped
}
