/**
 * QQ transport: the bot's WebSocket gateway long connection over the public `@tencent-connect/qqbot-nodejs` SDK, inbound
 * message normalization (including the attachment references QQ sends and the download that turns one into bytes), and the
 * passive reply path (a reply anchored to the inbound message's `msg_id` inside QQ's window).
 *
 * Protocol details adapted from dsh-im (MIT, Copyright (c) 2026 xmanrui, upstream 5.10.0), files
 * `src/channels/qq/qq-runtime.mjs` (QQBot connection/events), `src/channels/qq/qq-controller.mjs` (the send path),
 * `src/channels/qq/markdown-reply.mjs` (markdown first, plain text on a definite rejection, passive reply budget),
 * `src/channels/qq/qq-mention.mjs` (self-mention detection and stripping), `src/channels/qq/qq-bridge.mjs` (the inbound
 * attachment fields, the image-or-file decision and the media-host list) and `src/channels/shared/markdown-chunks.mjs`
 * (line-break-aware splitting); see THIRD_PARTY_NOTICES.md. Only the wire protocol is adapted: this module has no session,
 * command, approval or workspace logic, and imports no part of dsh-im.
 *
 * Nothing here reads configuration: the credentials come from a caller that stores them (the Source instance), and the
 * AppSecret never appears in a transport error, a log line, a health detail or a Trigger. A signed attachment URL is just as
 * restricted: no failure carries one, so neither a health detail nor a Trigger can. The SDK is loaded lazily by the
 * production bot factory, so a missing SDK is a connection error of one instance instead of a broken plugin.
 */
import type { OutboundMessage } from '../../core/index.ts'
import { isIP } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

/** The QQ Open Platform API base; the production bot factory uses it unless the account is in the sandbox environment. */
export const QQ_API_BASE = 'https://api.sgroup.qq.com'
/** The sandbox API base QQ gives a test bot; the token endpoint is the same in both environments. */
export const QQ_SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com'
/** How much of one inbound message text a Trigger carries; the rest is not available to the worker. */
export const QQ_TEXT_CHARS = 8_000
/** The longest piece of reply text one QQ message carries; a longer reply is sent as several messages. */
export const QQ_REPLY_CHARS = 4_000
/**
 * How long a passive reply to an inbound message stays valid. QQ documents 60 minutes for both a direct and a group
 * message; the older group-documentation value of 5 minutes is sometimes still enforced, which the platform then answers
 * with an expired-msg_id error this transport classifies as gone.
 */
export const QQ_PASSIVE_WINDOW_MS = Object.freeze({ c2c: 60 * 60_000, group: 60 * 60_000 })
/** A reply is not started this close to the window's end, so the round trip cannot cross it. */
export const QQ_PASSIVE_MARGIN_MS = 30_000
/** How many passive replies one inbound message may answer; QQ counts them and refuses the rest. */
export const QQ_PASSIVE_REPLY_LIMIT = Object.freeze({ c2c: 4, group: 5 })
/** Appended in the last passive slot when a reply is longer than the passive budget can carry. */
export const QQ_TRUNCATION_NOTICE = '(The reply was longer than QQ can deliver in one passive reply and was truncated.)'
/** The largest attachment one QQ message may deliver; a larger file is skipped and counted in the instance's health. */
export const QQ_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** The most attachments one QQ message may carry; a message with more is skipped instead of partly received. */
export const QQ_ATTACHMENTS_PER_MESSAGE = 5
/** How long one attachment download may take before it is abandoned; a download that times out keeps none of its bytes. */
const DOWNLOAD_TIMEOUT_MS = 30_000
/**
 * The hosts a QQ attachment download URL may name: QQ's own media hosts and the Tencent CDNs that serve them, taken from
 * the upstream `QQ_IMAGE_HOSTS` list. A host matches the registrable domain itself or any subdomain of it.
 */
export const QQ_DOWNLOAD_HOSTS = Object.freeze(['.myqcloud.com', '.qpic.cn', '.qq.com', '.qq.com.cn', '.tencentcos.com',
  '.ugcimg.cn'] as const)
/** The file names QQ's attachments use for a picture when no Content-Type says so; the extensions are upstream's. */
const QQ_IMAGE_FILENAME = /\.(?:gif|jpe?g|png|webp)$/i
/** The group-scope self mention QQ substitutes into inbound content, `<@!openid>` or the legacy `<@openid>`. */
const QQ_MENTION = /<@!?([^<>\s]+)>/gu
/** Consecutive gateway `error` events after which a connection is considered failed and the Source loop reconnects. */
const FAILURES_BEFORE_ERROR = 3

/** The kinds of failure a QQ call can have; the Channel decides from them whether a reply is retryable or gone. */
export type QqFailure = 'network' | 'timeout' | 'auth' | 'rate-limit' | 'rejected' | 'expired' | 'invalid-route'
  | 'invalid-response' | 'too-long'
/** One classified QQ API failure: its kind, the HTTP status when there was one, and QQ's own business code and text. */
export class QqApiError extends Error {
  readonly code: QqFailure
  readonly status: number | undefined
  readonly bizCode: number | undefined
  readonly bizMessage: string | undefined

  constructor(code: QqFailure, message: string, options: { status?: number; bizCode?: number; bizMessage?: string
    cause?: unknown } = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'QqApiError'
    this.code = code
    this.status = options.status
    this.bizCode = options.bizCode
    this.bizMessage = options.bizMessage
  }
}
/** The stage of opening the gateway connection a failure happened in, so a health detail names it. */
export type QqConnectStage = 'load' | 'connect' | 'ready'
/** A failure of the gateway connection: its stage and a message that never carries a credential. */
export class QqConnectError extends Error {
  readonly stage: QqConnectStage

  constructor(stage: QqConnectStage, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'QqConnectError'
    this.stage = stage
  }
}
/** The two credentials a bot needs; the App ID and the App Secret from the QQ open platform. */
export interface QqCredentials { appId: string; appSecret: string }
/** Why one attachment of an inbound message could not be fetched; the Source counts it in the instance's health. */
export type QqAttachmentFailure = 'unavailable' | 'too-large' | 'untrusted-url' | 'download-failed'
/**
 * A failed attachment download: its kind and the HTTP status when there was one. The message never carries the signed
 * download URL or its query string, because neither may reach a log line, a health detail or a Trigger.
 */
export class QqAttachmentError extends Error {
  readonly code: QqAttachmentFailure
  readonly status: number | undefined

  constructor(code: QqAttachmentFailure, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'QqAttachmentError'
    this.code = code
    this.status = options.status
  }
}
/** One attachment QQ named on an inbound message, before its bytes are fetched. */
export interface QqAttachmentRef {
  /** What the attachment is for the worker: a picture, or any other file. */
  kind: 'image' | 'file'
  /** The download address QQ issued; a protocol-relative address is already completed to `https:`. */
  url: string
  /** The file name QQ sent; empty when it sent none, and never trusted as a path. */
  name: string
  /** The Content-Type QQ declared; empty when it declared none, and only used when the answer declares none either. */
  mime: string
  /** The size QQ declared in bytes; 0 when it declared none. Used only to refuse an oversized download early. */
  bytes: number
}
/** One fetched attachment: its bytes, the MIME type it arrived as and the file name QQ sent (empty when it sent none). */
export interface QqDownloadedFile { data: Buffer; mime: string; name: string }
/** One message QQ's SDK normalized from a gateway event; the subset this transport reads. */
export interface QqRawInbound {
  /** The gateway event type, such as `C2C_MESSAGE_CREATE` or `GROUP_AT_MESSAGE_CREATE`. */
  rawEventType?: string
  /** `c2c` and `group` are this Source's; `guild` and `dm` are skipped. */
  kind?: string
  senderId?: string
  senderName?: string
  senderIsBot?: boolean
  content?: string
  messageId?: string
  timestamp?: string
  groupOpenid?: string
  msgType?: number
  mentions?: { is_you?: boolean; id?: string; user_openid?: string; member_openid?: string }[]
  attachments?: unknown[]
}
/** One inbound message the bot received, normalized for the Source. */
export interface QqMessage {
  /** The message id; a Trigger derives its id from it and the passive reply sends it back as `msg_id`. */
  messageId: string
  /** The message text as received, without the bot's own mention markers and trimmed; empty for a media-only message. */
  text: string
  /** The attachments QQ named, in order; the Source fetches them before the message becomes work. */
  attachments: QqAttachmentRef[]
  /** The sender as the Policy's `allowed` list names people: the user openid of a direct message or group member. */
  senderId: string
  senderNick: string
  /** The conversation kind: a direct message to the bot, or a group mention. */
  kind: 'c2c' | 'group'
  /** The direct chat's user openid, or the group's group openid; the Trigger's Thread is named after it. */
  conversationId: string
  /** The group openid of a group message; empty for a direct message. */
  groupId: string
  addressed: boolean
  /** The message time as an ISO time; empty when QQ sent none. */
  createdAt: string
  rawEventType: string
}
/** Why one gateway message became no message. */
export type QqSkip = 'invalid' | 'self' | 'non-text' | 'not-addressed' | 'unsupported'
/** A message that was not turned into a message, with what to count for the instance's health detail. */
export interface QqSkipEvent { reason: QqSkip; messageId?: string; kind?: string }
/** One gateway message's result: either a normalized message or why it was skipped. */
export type QqInbound = { message: QqMessage } | { skipped: QqSkipEvent }
/** One outbound message send as the SDK accepts it; the tests' fake bot implements this shape. */
export interface QqSendOptions {
  target: { scope: 'c2c' | 'group'; targetId: string; msgId?: string }
  msgType?: number
  content?: string
  markdown?: { content: string }
  extra?: Record<string, unknown>
}
/** The SDK's answer to one send: the message id QQ assigned. */
export interface QqSendResponse { id?: string; timestamp?: number | string }
/** The one operation a reply needs, so the Channel can send through a live bot or a test double. */
export interface QqSender { send(options: QqSendOptions): Promise<QqSendResponse> }
/** The immutable route a Trigger carries for its replies, read back from its Channel address. */
export interface QqReplyTarget {
  scope: 'c2c' | 'group'
  /** The user openid of a direct chat or the group openid of a group. */
  targetId: string
  /** The inbound message id the passive reply is anchored to; empty when the address names no message. */
  msgId: string
  /** The sender a group reply may mention; empty when unknown. */
  senderId: string
  /** When the inbound message was received, as epoch milliseconds; not finite when the address did not say. */
  receivedAt: number
}

const nonEmpty = (value: unknown): string => typeof value === 'string' && value.trim() ? value.trim() : ''
/** The short reason of an error, for a health detail; the AppSecret is redacted wherever it would appear. */
function reasonOf(error: unknown, appSecret: string): string {
  const text = error instanceof Error ? error.message : String(error)
  const scrubbed = appSecret.length >= 4 ? text.split(appSecret).join('[redacted]') : text
  return scrubbed.length > 200 ? `${scrubbed.slice(0, 200)}…` : scrubbed
}
/** A QQ timestamp as ISO; RFC3339 text and epoch milliseconds/seconds are accepted, an unknown value becomes empty. */
function isoTime(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
  }
  const number = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(number) || number <= 0) return ''
  return new Date(number < 10_000_000_000 ? number * 1_000 : number).toISOString()
}
/**
 * The trusted form of an attachment download URL: HTTPS on one of QQ's own media hosts, no credentials, no IP literal and
 * no port other than the default 443, with a protocol-relative address completed to `https:`. The URL is the only place a
 * download may go; an empty result means the Source refuses it, so a message naming any other host cannot redirect the
 * fetch. The query string is a signed download credential and is kept for the request, but no failure carries it.
 */
export function trustedQqDownloadUrl(value: unknown): string {
  const text = nonEmpty(value)
  if (!text) return ''
  const completed = text.startsWith('//') ? `https:${text}` : text
  let url: URL
  try { url = new URL(completed) } catch { return '' }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return ''
  const rawHost = url.hostname.toLowerCase().replace(/\.$/, '')
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  if (!host || isIP(host) !== 0) return ''
  if (!QQ_DOWNLOAD_HOSTS.some(domain => host === domain.slice(1) || host.endsWith(domain))) return ''
  // The fragment means nothing to a download.
  url.hash = ''
  return url.toString()
}
/** The Content-Type a QQ attachment declares, without parameters and in lower case; empty when it declares none. */
function attachmentMimeOf(attachment: Record<string, unknown>): string {
  const declared = nonEmpty(attachment.content_type) || nonEmpty(attachment.contentType)
  return declared ? declared.split(';')[0]!.trim().toLowerCase() : ''
}
/**
 * The attachment one `attachments` entry names: its download address (a protocol-relative one completed to `https:`), the
 * file name QQ sent, the declared Content-Type and size, and the kind the Content-Type or the file name's extension decides.
 * An entry that is not an object names no attachment; an object with no usable field still names one, so a message that only
 * carried a malformed attachment is counted as a skipped attachment instead of disappearing as a non-text message.
 */
function attachmentOf(entry: unknown): QqAttachmentRef | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const raw = entry as Record<string, unknown>
  const url = nonEmpty(raw.url)
  const name = nonEmpty(raw.filename) || nonEmpty(raw.fileName)
  const mime = attachmentMimeOf(raw)
  const declared = Number(raw.size)
  const image = mime.startsWith('image/') || QQ_IMAGE_FILENAME.test(name)
  return { kind: image ? 'image' : 'file', url: url.startsWith('//') ? `https:${url}` : url, name, mime,
    bytes: Number.isFinite(declared) && declared >= 0 ? declared : 0 }
}
/** The attachments one gateway message names, in order. */
function attachmentsOf(message: QqRawInbound): QqAttachmentRef[] {
  const entries = Array.isArray(message.attachments) ? message.attachments : []
  return entries.flatMap(entry => { const attachment = attachmentOf(entry); return attachment ? [attachment] : [] })
}
/** The mention ids a gateway message attributes to the bot itself, so its own mention is stripped from the text. */
function selfMentionIds(message: QqRawInbound): string[] {
  const mentions = Array.isArray(message.mentions) ? message.mentions : []
  return mentions.flatMap(mention => mention?.is_you === true
    ? [mention.id, mention.user_openid, mention.member_openid].flatMap(value => nonEmpty(value) ? [nonEmpty(value)] : [])
    : [])
}
/** Whether a group message addresses the bot: QQ's group @ event, its `is_you` mention, or an inline self mention. */
function addressedToBot(message: QqRawInbound, botIds: ReadonlySet<string>): boolean {
  if (message.kind !== 'group') return true
  if (message.rawEventType === 'GROUP_AT_MESSAGE_CREATE') return true
  if (selfMentionIds(message).length) return true
  const text = nonEmpty(message.content)
  for (const match of text.matchAll(QQ_MENTION)) if (botIds.has(match[1]!)) return true
  return false
}
/** Removes the bot's own `<@!id>`/`<@id>` mention markers from a message text and trims it. */
function withoutSelfMention(text: string, botIds: ReadonlySet<string>): string {
  return text.replace(QQ_MENTION, (marker, id: string) => botIds.has(id) ? '' : marker).trim()
}
/**
 * Normalizes one gateway message into an inbound message, or says why it is no message for this Source. A direct chat
 * always addresses the bot; a group message does only when QQ's group @ event, an `is_you` mention or an inline mention
 * names the bot. A message carrying text, attachments, or both becomes a message — a media-only message is work for the
 * worker too — while a message with neither, the bot's own message, a guild or DM event and a malformed event are skipped
 * and never become a Trigger. The attachments are references only; the Source fetches their bytes before the message
 * becomes work.
 */
export function normalizeQqInbound(message: QqRawInbound | null | undefined, botIds: ReadonlySet<string> = new Set()): QqInbound {
  if (!message || typeof message !== 'object') return { skipped: { reason: 'invalid' } }
  const messageId = nonEmpty(message.messageId)
  const senderId = nonEmpty(message.senderId)
  const kind = message.kind
  const skip = (reason: QqSkip): QqInbound => ({ skipped: { reason, ...messageId ? { messageId } : {},
    ...typeof kind === 'string' && kind ? { kind } : {} } })
  if (!messageId || !senderId) return skip('invalid')
  if (kind !== 'c2c' && kind !== 'group') return skip('unsupported')
  const conversationId = kind === 'group' ? nonEmpty(message.groupOpenid) : senderId
  if (!conversationId) return skip('invalid')
  // The bot's own messages never ask it for work; QQ marks a bot author, and a learned id catches the rest.
  if (message.senderIsBot === true || botIds.has(senderId)) return skip('self')
  const addressed = addressedToBot(message, botIds)
  // An unmentioned group message is dropped before its attachments are looked at, so nothing from it is downloaded.
  if (kind === 'group' && !addressed) return skip('not-addressed')
  const content = typeof message.content === 'string' ? message.content : ''
  const attachments = attachmentsOf(message)
  const text = withoutSelfMention(content, botIds)
  // Only a message that leaves neither text nor an attachment asks for nothing.
  if (!text && !attachments.length) return skip('non-text')
  return { message: {
    messageId,
    text: text.slice(0, QQ_TEXT_CHARS),
    attachments,
    senderId,
    senderNick: nonEmpty(message.senderName),
    kind,
    conversationId,
    groupId: kind === 'group' ? conversationId : '',
    addressed: true,
    createdAt: isoTime(message.timestamp),
    rawEventType: nonEmpty(message.rawEventType),
  } }
}
/** The MIME type a Content-Type names, without parameters; empty when the value is missing or malformed. */
function mimeOf(value: string | null): string {
  const text = (value ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(text) ? text : ''
}
/** Reads a response body, stopping as soon as it exceeds `maxBytes`; the rest of a too-large body is cancelled. */
async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new QqAttachmentError('too-large', `The QQ attachment exceeds ${maxBytes} bytes`)
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
        throw new QqAttachmentError('too-large', `The QQ attachment exceeds ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    try { reader.releaseLock() } catch { /* A cancelled stream is already released. */ }
  }
  return Buffer.concat(chunks, total)
}
/** One attachment download request: the reference to fetch and, in tests, the injected `fetch`. */
export interface QqAttachmentRequest {
  attachment: QqAttachmentRef
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  /** The largest file accepted, in bytes; a larger one fails as `too-large` without any of it being kept. */
  maxBytes?: number
}
/**
 * Fetches one inbound attachment from the signed address QQ issued: only HTTPS on a QQ media host is followed, a redirect is
 * never followed, the request is bounded to 30 s and at most `maxBytes` (20 MiB by default) of the body is read, with the
 * rest of a larger body cancelled at once. A declared size over the limit is refused before any request. Neither the signed
 * URL nor its query string appears in a failure.
 */
export async function downloadQqAttachment(request: QqAttachmentRequest): Promise<QqDownloadedFile> {
  const { attachment, fetchImpl = fetch, signal } = request
  const maxBytes = typeof request.maxBytes === 'number' && Number.isFinite(request.maxBytes) && request.maxBytes > 0
    ? request.maxBytes : QQ_ATTACHMENT_BYTES
  const url = trustedQqDownloadUrl(attachment.url)
  if (!url) {
    if (!nonEmpty(attachment.url)) throw new QqAttachmentError('unavailable', 'QQ named no download address for the attachment')
    throw new QqAttachmentError('untrusted-url', 'QQ named an attachment download address outside its media hosts')
  }
  if (attachment.bytes > maxBytes) throw new QqAttachmentError('too-large', `The QQ attachment exceeds ${maxBytes} bytes`)
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: combined })
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('The QQ attachment download was stopped')
    if (timeout.aborted) throw new QqAttachmentError('download-failed', 'The QQ attachment download timed out', { cause: error })
    throw new QqAttachmentError('download-failed', 'The QQ attachment download failed', { cause: error })
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new QqAttachmentError('download-failed', `QQ answered HTTP ${response.status} for the attachment`,
      { status: response.status })
  }
  const data = await boundedBody(response, maxBytes)
  // The answer's own Content-Type names the saved file; QQ's declared one is only a fallback, and the last resort is binary.
  const mime = mimeOf(response.headers.get('content-type')) || mimeOf(attachment.mime) || 'application/octet-stream'
  return { data, mime, name: nonEmpty(attachment.name) }
}
/** Splits a long reply into QQ-sized text pieces, preferring a line break when one is not too early. */
export function splitQqText(value: string, maxChars = QQ_REPLY_CHARS): string[] {
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
/** The route a stored Channel address names, or undefined when it cannot receive a passive reply. */
export function replyTargetOf(address: Record<string, string>): QqReplyTarget | undefined {
  const scope = address.conversationType === 'group' ? 'group' as const
    : address.conversationType === 'direct' ? 'c2c' as const : undefined
  const targetId = nonEmpty(address.conversationId)
  const msgId = nonEmpty(address.msgId)
  const receivedAt = Number(address.receivedAt)
  if (!scope || !targetId || !msgId) return undefined
  return { scope, targetId, msgId, senderId: nonEmpty(address.senderId),
    receivedAt: Number.isFinite(receivedAt) ? receivedAt : Number.NaN }
}
/** Whether a route's passive reply window is still open; a route with no timestamps is tried once and classified by QQ. */
export function replyWindowOpen(target: QqReplyTarget, now: number): boolean {
  const window = QQ_PASSIVE_WINDOW_MS[target.scope]
  if (!Number.isFinite(target.receivedAt)) return true
  return now - target.receivedAt < window - QQ_PASSIVE_MARGIN_MS
}
/** A stable 16-bit passive reply sequence for one outbound message and chunk, so a retried send is deduplicated by QQ. */
export function replySeqOf(messageId: string, index: number): number {
  let hash = 2_166_136_261
  for (let offset = 0; offset < messageId.length; offset += 1) {
    hash ^= messageId.charCodeAt(offset)
    hash = Math.imul(hash, 16_777_619)
  }
  return ((hash >>> 0) + index * 7_919) % 65_535 + 1
}
/** The mention markup one person renders as in a QQ message: QQ's inline self/other mention form. */
export function qqMention(id: string): string {
  const clean = id.replace(/[<>\s]/g, '')
  return clean ? `<@${clean}>` : ''
}
/** QQ's "this passive reply arrived too late or the message id is no longer valid" business codes. */
const QQ_EXPIRED_CODES: ReadonlySet<number> = new Set([304103, 40034005, 40034024, 40034025, 40034026, 40034027, 40034028])
/** QQ's "the conversation can never receive this reply" business codes. */
const QQ_GONE_CODES: ReadonlySet<number> = new Set([304064, 40034101, 40054003, 40054016])
/** QQ's "this message needs markdown permission or is not valid markdown" answers; a plain text fallback still may deliver. */
export const QQ_MARKDOWN_REJECTION_CODES: ReadonlySet<number> = new Set([304036, 40034008, 40034009, 40034010, 40034011, 40034090,
  40034124, 40034127])
/** QQ's "the same msg_id + msg_seq was already delivered" answer; the earlier attempt landed, so a retry must not resend. */
const QQ_DUPLICATE_CODE = 40054005
/** The status and QQ business code of a failed call, read without ever touching a credential. */
function failureFieldsOf(error: unknown): { status: number | undefined; bizCode: number | undefined; bizMessage: string | undefined } {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const status = Number(record.httpStatus)
  const bizCode = Number(record.bizCode)
  const bizMessage = nonEmpty(record.bizMessage) || nonEmpty((record as { message?: unknown }).message) || undefined
  return { status: Number.isFinite(status) && status > 0 ? status : undefined,
    bizCode: Number.isFinite(bizCode) ? bizCode : undefined, bizMessage }
}
/** Whether a failed call is QQ's own API error (structural, so the SDK need not be imported here). */
const isApiError = (error: unknown): boolean => {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  return record.name === 'ApiError' || typeof record.httpStatus === 'number' || typeof record.bizCode === 'number'
}
/**
 * Classifies one failed QQ call: `duplicate` means it was already delivered, `markdown` means a definite markdown
 * rejection a plain text send may survive, `gone` means the target or the passive reply can never receive it, and
 * anything else is thrown for the Outbox to retry.
 */
function classifyQqFailure(error: unknown): 'duplicate' | 'markdown' | 'gone' | 'retryable' {
  if (error instanceof QqApiError) {
    if (error.code === 'expired' || error.code === 'invalid-route') return 'gone'
    return 'retryable'
  }
  if (!isApiError(error)) return 'retryable'
  const { status, bizCode } = failureFieldsOf(error)
  if (bizCode === QQ_DUPLICATE_CODE) return 'duplicate'
  if (bizCode !== undefined && QQ_MARKDOWN_REJECTION_CODES.has(bizCode) && status !== undefined
    && status >= 400 && status < 500) return 'markdown'
  if (bizCode !== undefined && (QQ_EXPIRED_CODES.has(bizCode) || QQ_GONE_CODES.has(bizCode))) return 'gone'
  return 'retryable'
}
/** Wraps one failed send as a `QqApiError` that names QQ's own reason without leaking the credential. */
function apiErrorOf(error: unknown): QqApiError {
  if (error instanceof QqApiError) return error
  const { status, bizCode, bizMessage } = failureFieldsOf(error)
  const detail = bizMessage ? `: ${bizMessage}` : ''
  const message = `${bizCode !== undefined ? `QQ answered ${bizCode}` : status !== undefined ? `QQ answered HTTP ${status}`
    : 'QQ could not be reached'}${detail}`
  const code: QqFailure = bizCode !== undefined && (QQ_EXPIRED_CODES.has(bizCode) || QQ_GONE_CODES.has(bizCode)) ? 'expired'
    : status === 401 || status === 403 ? 'auth'
      : status === 429 ? 'rate-limit'
        : status === 408 || status === undefined || status >= 500 ? 'network'
          : 'rejected'
  return new QqApiError(code, message, { ...status !== undefined ? { status } : {}, ...bizCode !== undefined ? { bizCode } : {},
    ...bizMessage !== undefined ? { bizMessage } : {}, cause: error })
}
/** One outbound text piece: markdown first (QQ renders mentions, links and formatting in it), plain text on rejection. */
async function sendQqPiece(sender: QqSender, target: QqSendOptions['target'], text: string, seq: number,
  options: { markdown?: boolean } = {}): Promise<void> {
  const markdown = options.markdown ?? true
  if (markdown) {
    try {
      await sender.send({ target, msgType: 2, markdown: { content: text }, extra: { msg_seq: seq } })
      return
    } catch (error) {
      const failure = classifyQqFailure(error)
      // A duplicate means an earlier attempt of this exact piece landed; resending would duplicate it.
      if (failure === 'duplicate') return
      if (failure === 'gone') throw apiErrorOf(error)
      // Only a definite markdown rejection is retried as plain text; an uncertain outcome never resends.
      if (failure !== 'markdown') throw apiErrorOf(error)
    }
  }
  const plain = text.replace(QQ_MENTION, '').replace(/[ \t]{2,}/g, ' ').trim()
  if (!plain) return
  try {
    await sender.send({ target, msgType: 0, content: plain, extra: { msg_seq: seq } })
  } catch (error) {
    if (classifyQqFailure(error) === 'duplicate') return
    throw apiErrorOf(error)
  }
}
/**
 * Sends one Channel message to the route its Trigger carried, as passive replies only: every piece names the inbound
 * message's `msg_id` and a stable `msg_seq`, so a retry that crosses a delivered message is deduplicated by QQ rather than
 * duplicated in the chat. A window already known to be closed is `gone` without a call; QQ's own expired or unusable
 * answers are `gone` too, while network, auth, rate-limit and content failures are thrown for the Outbox to retry.
 * A reply longer than QQ's passive budget is cut to the budget's last slot with a truncation notice: this Source never
 * continues a reply through proactive messages, whose quota QQ limits per user and per day.
 */
export async function sendQqReply(message: OutboundMessage, options: { target: QqReplyTarget; sender: QqSender
  now?: () => number }): Promise<'sent' | 'gone'> {
  const { target, sender } = options
  const now = options.now ?? Date.now
  if (!target.targetId || !target.msgId) return 'gone'
  if (!replyWindowOpen(target, now())) return 'gone'
  const kept = splitQqText(message.text)
  if (!kept.length) return 'sent'
  const limit = QQ_PASSIVE_REPLY_LIMIT[target.scope]
  const overflow = kept.length > limit
  const chunks = overflow ? kept.slice(0, limit - 1) : kept
  const address = { scope: target.scope, targetId: target.targetId, msgId: target.msgId }
  for (const [index, chunk] of chunks.entries()) {
    try {
      await sendQqPiece(sender, address, chunk, replySeqOf(message.id, index))
    } catch (error) {
      if (error instanceof QqApiError && (error.code === 'expired' || error.code === 'invalid-route')) return 'gone'
      throw error
    }
  }
  if (overflow) {
    try {
      await sendQqPiece(sender, address, QQ_TRUNCATION_NOTICE, replySeqOf(message.id, chunks.length))
    } catch (error) {
      if (error instanceof QqApiError && (error.code === 'expired' || error.code === 'invalid-route')) return 'gone'
      throw error
    }
  }
  return 'sent'
}
/** One gateway connection failure's description, for a health detail: its stage and a credential-free reason. */
export function qqFailureText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const clipped = text.length > 300 ? `${text.slice(0, 300)}…` : text
  if (error instanceof QqApiError) return `${error.code}: ${clipped}${error.bizCode !== undefined ? ` (${error.bizCode})` : ''}`
  if (error instanceof QqConnectError) return `${error.stage}: ${clipped}`
  return clipped
}

/** The SDK client operations this transport needs, so tests can inject a fake instead of a socket. */
export interface QqBotClient extends QqSender {
  on(event: string, handler: (...args: unknown[]) => unknown): unknown
  start(signal?: AbortSignal): Promise<void>
  stop?(): void
}
/** Creates a bot client for one app; the production one loads the `@tencent-connect/qqbot-nodejs` SDK lazily. */
export type QqBotFactory = (credentials: QqCredentials & { sandbox: boolean }) => QqBotClient | Promise<QqBotClient>
/**
 * The production bot factory: loads the public QQ SDK on first use, with the SDK's own WebSocket heartbeat and RESUME.
 * A missing SDK fails here as a `load` error instead of breaking the plugin, and the SDK logger is silenced so a credential
 * or socket message can never print a secret.
 */
export const qqBotFactory: QqBotFactory = async ({ appId, appSecret, sandbox }) => {
  let sdk: { QQBot: new (options: Record<string, unknown>) => unknown }
  try { sdk = await import('@tencent-connect/qqbot-nodejs') as unknown as typeof sdk }
  catch (error) { throw new QqConnectError('load', 'The @tencent-connect/qqbot-nodejs SDK could not be loaded', { cause: error }) }
  const logger = { info: (): void => {}, error: (): void => {}, warn: (): void => {}, debug: (): void => {} }
  const bot = new sdk.QQBot({
    appId,
    appSecret,
    logger,
    transport: 'websocket',
    // Fail fast on a bad credential: the first token request happens before the gateway opens.
    tokenPrefetch: 'sync',
    markdownSupport: false,
    ...sandbox ? { baseUrl: QQ_SANDBOX_API_BASE } : {},
  })
  return bot as unknown as QqBotClient
}
/** The bots of this process's open connections, by App ID: a reply is sent through the instance's live bot. */
const liveBots = new Map<string, QqBotClient>()
/** Registers one connected bot for the Channel's sends; the last connection of an App ID wins. */
function registerLiveBot(appId: string, bot: QqBotClient): void { liveBots.set(appId, bot) }
/** Removes one bot if it is still the registered one; a newer connection of the same App ID stays. */
function unregisterLiveBot(appId: string, bot: QqBotClient): void {
  if (liveBots.get(appId) === bot) liveBots.delete(appId)
}
/** The live bot of one App ID, or undefined while its instance is not connected. */
export const liveQqBot = (appId: string): QqBotClient | undefined => liveBots.get(appId)
/** Forgets every live bot; tests use it between cases (a closed connection removes its own). */
export function clearQqLiveBots(): void { liveBots.clear() }
/** One connection's options, as the caller injected them; every field has a production default. */
export interface QqConnectionOptions {
  appId: string
  appSecret: string
  sandbox?: boolean
  onMessage(message: QqMessage): void | Promise<void>
  onSkip?(skip: QqSkipEvent): void
  botFactory?: QqBotFactory
  connectTimeoutMs?: number
}
/** How one connection ended: the caller aborted, the SDK stopped the gateway, or three errors in a row failed it. */
export type QqClose = { closed: 'aborted' } | { closed: 'closed' } | { closed: 'failed'; reason: string }
/**
 * One bot's gateway connection: registers the message and lifecycle handlers, starts the SDK and waits for READY within a
 * bounded time, keeps the SDK's own heartbeat/RESUME for transient drops, and reports three consecutive `error` events as
 * a failed connection so the Source's loop owns the restart and its backoff. Nothing is retried inside a failed start: the
 * caller's loop owns reconnection and its health.
 */
export class QqConnection {
  private readonly options: QqConnectionOptions
  private bot: QqBotClient | null = null
  private readonly botIds = new Set<string>()
  private startTask: Promise<void> | null = null
  private ready = false
  private errors = 0
  private lastFailure: string | undefined
  private closeOutcome: QqClose | null = null
  private readonly closeWaiters = new Set<(outcome: QqClose) => void>()
  private readonly tasks = new Set<Promise<void>>()

  constructor(options: QqConnectionOptions) {
    const { appId, appSecret } = options
    if (!nonEmpty(appId) || !nonEmpty(appSecret)) throw new TypeError('A QQ connection needs an App ID and an App Secret')
    this.options = options
    // The App ID also names the bot in mention markup, so a mention of the bot's own id is recognized before READY.
    this.botIds.add(appId)
  }
  /** Whether the SDK reported READY (or RESUMED) and the connection has not been closed since. */
  get connected(): boolean { return this.ready }
  /** The App ID of the account this connection serves, for health details. */
  get appId(): string { return this.options.appId }
  /** How many gateway errors arrived since the last READY, the count the failure threshold reads. */
  get consecutiveErrors(): number { return this.errors }
  /** One gateway connection's failure reason, once three errors in a row failed it. */
  get failure(): string | undefined { return this.lastFailure }
  /** Remembers the bot's own user id from READY so its mention markers are recognized and stripped. */
  private rememberBotIds(data: unknown): void {
    const user = data && typeof data === 'object' ? (data as { user?: unknown }).user : undefined
    const id = user && typeof user === 'object' ? nonEmpty((user as { id?: unknown }).id) : ''
    if (id) this.botIds.add(id)
  }
  /** The short reason of a connection failure; the AppSecret is redacted. */
  private reason(error: unknown): string { return reasonOf(error, this.options.appSecret) }
  /** Builds a staged connection error whose message never contains the AppSecret. */
  private errorOf(stage: QqConnectStage, message: string, cause?: unknown): QqConnectError {
    return new QqConnectError(stage, `${message}: ${this.reason(cause)}`, { cause })
  }
  /** Resolves every `waitForClose` caller with the one outcome this connection ended with. */
  private settleClose(outcome: QqClose): void {
    if (this.closeOutcome) return
    this.closeOutcome = outcome
    for (const resolve of [...this.closeWaiters]) resolve(outcome)
    this.closeWaiters.clear()
  }
  /**
   * Creates the bot, registers its lifecycle and message handlers, starts the SDK and waits for READY within
   * `connectTimeoutMs`. A factory, handshake or credential failure is thrown as a `QqConnectError` naming its stage; the
   * failed bot is stopped. Once READY, the bot is registered as this App ID's live sender for the Channel.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.bot) throw new QqConnectError('connect', 'The QQ connection is already open')
    const { appId, appSecret, sandbox = false, connectTimeoutMs = 20_000 } = this.options
    const factory = this.options.botFactory ?? qqBotFactory
    let bot: QqBotClient
    try { bot = await factory({ appId, appSecret, sandbox }) }
    catch (error) {
      if (error instanceof QqConnectError) throw error
      throw this.errorOf('load', 'The QQ bot client could not be created', error)
    }
    if (!bot || typeof bot.on !== 'function' || typeof bot.start !== 'function' || typeof bot.send !== 'function') {
      throw new QqConnectError('load', 'The QQ bot client is not usable')
    }
    this.bot = bot
    this.ready = false
    this.errors = 0
    this.closeOutcome = null
    let isReady = false
    let resolveReady!: () => void
    let rejectReady!: (error: QqConnectError) => void
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const onReady = (data: unknown): void => {
      this.rememberBotIds(data)
      if (isReady) { this.errors = 0; return }
      isReady = true
      this.ready = true
      this.errors = 0
      resolveReady()
    }
    const onError = (error: unknown): void => {
      this.errors += 1
      this.lastFailure = this.reason(error)
      if (!isReady) { rejectReady(this.errorOf('connect', 'The QQ gateway failed before it was ready', error)); return }
      if (this.errors >= FAILURES_BEFORE_ERROR) this.settleClose({ closed: 'failed', reason: this.lastFailure })
    }
    try {
      bot.on('ready', onReady)
      bot.on('resumed', onReady)
      bot.on('error', onError)
      bot.on('message', (...args: unknown[]) => { this.receive(args.at(-1)) })
    } catch (error) {
      this.bot = null
      throw this.errorOf('connect', 'The QQ bot handlers could not be registered', error)
    }
    // The SDK's start resolves only when its transport stops: before READY that is a failed start, after it a closed link.
    const started = Promise.resolve().then(() => bot.start(signal)).then(
      () => {
        this.ready = false
        if (!isReady) rejectReady(new QqConnectError('connect', 'The QQ gateway stopped before it was ready'))
        this.settleClose({ closed: 'closed' })
      },
      (error: unknown) => {
        const failure = this.errorOf('connect', 'The QQ gateway connection failed', error)
        this.lastFailure = failure.message
        if (!isReady) rejectReady(failure)
        this.settleClose({ closed: 'failed', reason: failure.message })
      },
    )
    this.startTask = started
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new QqConnectError('ready',
            `The QQ gateway did not become ready within ${connectTimeoutMs} ms`)), connectTimeoutMs)
        }),
      ])
    } catch (error) {
      await this.close()
      throw error instanceof QqConnectError ? error : this.errorOf('connect', 'The QQ gateway connection failed', error)
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (signal?.aborted) {
      await this.close()
      throw signal.reason instanceof Error ? signal.reason : new Error('The QQ connection was stopped')
    }
    registerLiveBot(appId, bot)
  }
  /** Dispatches one gateway message: parses and hands it over, counting what it cannot turn into a message. */
  private receive(payload: unknown): void {
    const bot = this.bot
    if (!bot || this.closeOutcome) return
    const inbound = normalizeQqInbound(payload as QqRawInbound, this.botIds)
    if ('skipped' in inbound) { this.skip(inbound.skipped); return }
    const task = Promise.resolve().then(() => this.options.onMessage(inbound.message))
      .catch(() => { /* A handler failure is the Source's to report; the connection stays up. */ })
      .finally(() => { this.tasks.delete(task) })
    this.tasks.add(task)
  }
  /** Counts one message the transport could not turn into a Source message. */
  private skip(skip: QqSkipEvent): void {
    try { this.options.onSkip?.(skip) } catch { /* Counting a skip never interrupts the connection. */ }
  }
  /**
   * Waits until the caller aborts, the SDK stops the gateway, or three consecutive errors fail the connection; a closed
   * connection returns at once, so the caller's loop can reconnect.
   */
  waitForClose(signal?: AbortSignal): Promise<QqClose> {
    if (signal?.aborted) return Promise.resolve({ closed: 'aborted' })
    if (this.closeOutcome) return Promise.resolve(this.closeOutcome)
    return new Promise<QqClose>(resolve => {
      const finish = (outcome: QqClose): void => {
        this.closeWaiters.delete(waiter)
        signal?.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
      const waiter = (outcome: QqClose): void => finish(outcome)
      const onAbort = (): void => finish({ closed: 'aborted' })
      this.closeWaiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  /** Stops the bot, drops it from the live senders, waits for the start task and for the handlers already dispatched. */
  async close(): Promise<void> {
    const bot = this.bot
    this.bot = null
    this.ready = false
    if (bot) unregisterLiveBot(this.options.appId, bot)
    if (bot) { try { bot.stop?.() } catch { /* Already stopped. */ } }
    // A bot whose start never settles must not hang the Source's loop; its late settlement finds the close already recorded.
    if (this.startTask) await Promise.race([this.startTask, delay(5_000)])
    await Promise.allSettled([...this.tasks])
    this.tasks.clear()
    if (!this.closeOutcome) this.settleClose({ closed: 'closed' })
  }
}
