/**
 * DingTalk transport: the bot's Stream long connection, inbound message normalization, the access token cache and the two
 * reply transports — the message's own `sessionWebhook` first, the robot API once it expired.
 *
 * Protocol details adapted from dsh-im (MIT, Copyright (c) 2026 xmanrui, upstream 5.10.0), files
 * `src/channels/dingtalk/dingtalk-runtime.mjs` and `src/channels/dingtalk/dingtalk-api.mjs`; see THIRD_PARTY_NOTICES.md.
 * Only the wire protocol is adapted: this module has no session, command, approval or workspace logic, and imports no part
 * of dsh-im.
 *
 * Nothing here reads configuration: the credentials come from a caller that stores them (the Source instance), and the
 * clientSecret never appears in a transport error, a log line, a health detail or a Trigger.
 */
import type { OutboundMessage } from '../../core/index.ts'
import { setTimeout as delay } from 'node:timers/promises'

/** DingTalk's Stream bot topic: a callback carries one message the bot received. */
export const DINGTALK_TOPIC_ROBOT = '/v1.0/im/bot/messages/get'
/** The DingTalk API base every robot call uses. */
export const DINGTALK_API_BASE = 'https://api.dingtalk.com/'
/** How much of one inbound message text a Trigger carries; the rest is not available to the worker. */
export const DINGTALK_TEXT_CHARS = 8000
/** The longest piece of reply text one DingTalk message may carry; a longer reply is sent as several messages. */
export const DINGTALK_REPLY_CHARS = 4_000
const REQUEST_TIMEOUT_MS = 15_000
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
/** One inbound text message the bot received, normalized for the Source. */
export interface DingtalkMessage {
  /** The message id; a Trigger derives its id from it, so a redelivered callback is a duplicate. */
  messageId: string
  /** The message text as received, without trimming. */
  text: string
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
/**
 * Normalizes one Stream callback payload (already parsed) into a message, or says why it is no message for this Source.
 * A direct message addresses the bot by construction; a group message only when DingTalk says it is in the at-list, which
 * is `isInAtList` or an `atUsers` entry naming the bot's own `chatbotUserId`. A callback from the bot itself, one that is
 * not text, and one with no sender, conversation or message id are skipped and never become a Trigger.
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
  const text = raw.text && typeof raw.text === 'object' ? nonEmpty((raw.text as Record<string, unknown>).content) : ''
  if (messageType !== 'text' || !text.trim()) return skip('non-text')
  const group = conversationType === '2'
  const mentioned = Array.isArray(raw.atUsers) ? atUsersOf(raw) : []
  const addressed = !group || raw.isInAtList === true || (!!chatbotUserId && mentioned.includes(chatbotUserId))
  if (!addressed) return skip('not-addressed')
  return { message: {
    messageId,
    text,
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
/**
 * Sends one text piece through the robot API: `groupMessages/send` with the group's `openConversationId`, or
 * `oToMessages/batchSend` with the person's `userIds`. A failure that says the target no longer exists is `invalid-route`.
 */
export async function sendDingtalkRobot(options: DingtalkRequestOptions & { target: DingtalkReplyTarget; token: string
  text: string }): Promise<void> {
  const { target } = options
  if (!target.robotCode) throw new DingtalkApiError('invalid-route', 'The DingTalk reply has no robot code')
  const group = target.conversationType === 'group'
  if (group ? !target.openConversationId : !target.userId) {
    throw new DingtalkApiError('invalid-route', 'The DingTalk reply has no target conversation')
  }
  const path = group ? 'v1.0/robot/groupMessages/send' : 'v1.0/robot/oToMessages/batchSend'
  const body = { robotCode: target.robotCode, msgKey: 'sampleText', msgParam: JSON.stringify({ content: options.text }),
    ...group ? { openConversationId: target.openConversationId } : { userIds: [target.userId] } }
  try {
    const answer = await postJson(new URL(path, DINGTALK_API_BASE).toString(), body, options,
      { 'x-acs-dingtalk-access-token': options.token })
    const record = answer.body && typeof answer.body === 'object' ? answer.body as Record<string, unknown> : {}
    const rejection = nonEmpty(record.code) || nonEmpty(record.errcode)
    if (rejection && rejection !== '0') {
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
 * Sends one Channel message to the route its Trigger carried: pieces go to the still-fresh `sessionWebhook` first, and a
 * piece whose webhook expired is sent through the robot API instead. Only a conversation DingTalk no longer knows is
 * `gone`; every other failure is thrown for the Outbox to retry.
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
