/**
 * QQ Source: one instance is one QQ open-platform bot reached over the bot gateway's WebSocket long connection. The bot's
 * client (`im/qq-transport.ts`) delivers every message the gateway pushes; a direct message, and a group message that
 * mentions the bot, becomes a Trigger, while the bot's own messages, other bots' messages and unmentioned group messages are
 * counted and dropped. A text message becomes a Trigger as it arrives; a message QQ named a picture or a file on — even one
 * with no text at all — is downloaded first into `<stateDir>/area/attachments/qq/<instance>/<messageId>/` and its Trigger
 * names every saved absolute path, so the worker can read the file. A message whose attachments cannot be received is
 * counted in the instance's health instead of opening an empty Ticket. A reply is always a passive reply anchored to the
 * inbound message's `msg_id` — QQ's official bots mainly deliver results that way — and goes nowhere else; replies are text
 * only.
 *
 * The two credentials (AppID, AppSecret) are required before the bot connects; an account saved with neither is a new
 * account and reports `paused` until it is filled, while filling only one is refused at save time. Saving does not contact
 * QQ: a wrong credential surfaces as this instance's health, and the connection is retried with a 5 s to 60 s backoff,
 * reporting `error` after three consecutive failures. The AppSecret is stored in our own settings, is never logged, never
 * written to a health detail and never put in a Trigger: a reply routes by the conversation ids the Trigger carries plus
 * the App ID that names the live bot.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { downloadQqAttachment, liveQqBot, QqApiError, QqAttachmentError, QQ_ATTACHMENT_BYTES, QQ_ATTACHMENTS_PER_MESSAGE,
  QqConnection, QQ_TEXT_CHARS, qqFailureText, qqMention, replyTargetOf, sendQqReply, type QqAttachmentRef,
  type QqBotFactory, type QqMessage, type QqSkipEvent } from './im/qq-transport.ts'
import { health, reportFailure, sourceContext, type SourceContext } from './host.ts'
import type { FieldSpec, SourceKind } from './kind.ts'

/** A comma-separated text field in the panel, an array in stored JSON: both name the same user openids. */
const UserIdList = z.union([z.string(), z.array(z.string())]).default('')
  .transform(value => (Array.isArray(value) ? value : value.split(',')).map(entry => entry.trim()).filter(Boolean))
const ConfigSchema = z.object({
  /** The bot's AppID from the QQ open platform; with the secret it authenticates the bot. */
  appId: z.string().trim().default(''),
  /** The bot's AppSecret; never leaves this settings store except in a token request body. */
  appSecret: z.string().trim().default(''),
  /** Optional user openids whose messages are listened to; empty listens to every participant the Policy then judges. */
  allowedUserIds: UserIdList,
  /** Use QQ's sandbox environment for a test bot; the credentials and the token endpoint stay the same. */
  sandbox: z.boolean().default(false),
}).strict().superRefine((config, ctx) => {
  const fields = [['appId', config.appId], ['appSecret', config.appSecret]] as const
  // An account saves before its credentials are filled; once one is set, the other is required too.
  if (fields.every(([, value]) => !value)) return
  for (const [field, value] of fields) {
    if (!value) ctx.addIssue({ code: 'custom', path: [field], message: `The QQ bot needs ${field}` })
  }
})
export type QqConfig = z.infer<typeof ConfigSchema>
/** The two settings a bot needs before it can connect; an enabled instance missing one reports paused. */
const REQUIRED_FIELDS = ['appId', 'appSecret'] as const
const missingFields = (config: QqConfig): string[] => REQUIRED_FIELDS.filter(field => !config[field])
/** The reconnect waits after consecutive failed attempts: 5 s doubling up to 60 s. */
const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const
const FAILURES_BEFORE_ERROR = 3
const RECONCILE_SECONDS = 5

/** The configuration one instance replies with, as `channel.send` reads it from the Commands the registry scoped to this kind. */
const scopedConfigs = new WeakMap<object, QqConfig>()

/** One attachment saved under this installation's state directory, as a worker reads it and as a Trigger carries it. */
export interface QqSavedAttachment { path: string; kind: 'image' | 'file'; name: string; mime: string; bytes: number }
/** Why a message whose attachments could not be received became no Trigger; the Source counts it in the instance's health. */
export type QqAttachmentSkip = 'attachment-count' | 'attachment-unavailable' | 'attachment-too-large'
  | 'attachment-untrusted' | 'attachment-download-failed'
/** How one received message fetches its attachments; the watch loop leaves every default in place. */
export interface QqReceiveOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

/** A short stable hash, so a sanitized path segment or file name stays unique. */
const shortHash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 8)
/**
 * One safe path segment: only `[A-Za-z0-9._-]`, never `.` or `..`. A value that had to change keeps a short hash, so two
 * native ids that sanitize alike cannot share one directory.
 */
function safeSegment(value: string, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  const cleaned = text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '')
  const usable = cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 96) : ''
  if (!usable) return fallback
  return usable === text ? usable : `${usable}-${shortHash(text)}`
}
/** Whether `path` resolves inside `stateDir`; a path that escapes it is never written or kept. */
function withinStateDir(stateDir: string, path: string): boolean {
  const inside = relative(resolve(stateDir), resolve(path))
  return !!inside && !inside.startsWith('..') && !isAbsolute(inside)
}
/** The directory one message's attachments are saved in: `<stateDir>/area/attachments/qq/<instance>/<messageId>`. */
export function qqAttachmentDirectory(stateDir: string, instance: string, messageId: string): string {
  const directory = join(resolve(stateDir), 'area', 'attachments', 'qq', safeSegment(instance, 'instance'),
    safeSegment(messageId, 'message'))
  if (!withinStateDir(stateDir, directory)) throw new Error('The QQ attachment directory escapes the state directory')
  return directory
}
/** The file name an attachment is saved as: only `[A-Za-z0-9._-]`, never a path, never `.` or `..`. */
function safeFileName(value: string, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  const cleaned = text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '')
  const usable = cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 120) : ''
  return usable || fallback
}
/** The extension a picture is saved under; a Content-Type beyond the four QQ sends is kept as raw bytes. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': '.png', 'image/jpeg': '.jpg',
  'image/webp': '.webp', 'image/gif': '.gif' }
/** A name made unique among the files already saved for one message; the second `image.png` becomes `image-1.png`. */
function uniqueFileName(name: string, used: Set<string>): string {
  if (!used.has(name)) { used.add(name); return name }
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  for (let index = 1; ; index += 1) {
    const candidate = `${stem}-${index}${extension}`
    if (!used.has(candidate)) { used.add(candidate); return candidate }
  }
}
/** The file name one downloaded attachment is saved as: a picture by Content-Type, a file by the name QQ sent. */
function attachmentFileName(ref: QqAttachmentRef, name: string, mime: string, messageId: string,
  used: Set<string>): string {
  const base = ref.kind === 'image' ? `image${IMAGE_EXTENSIONS[mime] ?? '.bin'}`
    : safeFileName(name, `file-${safeSegment(messageId, 'message')}`)
  return uniqueFileName(base, used)
}
/** The receipt one failed attachment fetch becomes, as the instance's health counts it. */
function attachmentSkipOf(error: unknown): QqAttachmentSkip {
  if (error instanceof QqAttachmentError) {
    if (error.code === 'too-large') return 'attachment-too-large'
    if (error.code === 'untrusted-url') return 'attachment-untrusted'
    if (error.code === 'unavailable') return 'attachment-unavailable'
  }
  return 'attachment-download-failed'
}
/**
 * Fetches and saves every attachment of one message under `<stateDir>/area/attachments/qq/<instance>/<messageId>/`.
 * A message with more than five attachments, an attachment without a download address, a failed or oversized download and
 * an address outside QQ's media hosts all make the message no work: the directory is removed again and the reason is
 * returned for the instance's health, so the Source never opens a Ticket that silently misses a file.
 */
async function saveQqAttachments(stateDir: string, instance: string, message: QqMessage,
  options: QqReceiveOptions): Promise<{ attachments: QqSavedAttachment[] } | { skipped: QqAttachmentSkip }> {
  const refs = message.attachments
  if (!refs.length) return { attachments: [] }
  if (refs.length > QQ_ATTACHMENTS_PER_MESSAGE) return { skipped: 'attachment-count' }
  if (refs.some(ref => !ref.url)) return { skipped: 'attachment-unavailable' }
  const directory = qqAttachmentDirectory(stateDir, instance, message.messageId)
  const saved: QqSavedAttachment[] = []
  const used = new Set<string>()
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const ref of refs) {
      const file = await downloadQqAttachment({ attachment: ref,
        ...options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
        ...options.signal ? { signal: options.signal } : {} })
      const name = attachmentFileName(ref, file.name, file.mime, message.messageId, used)
      const path = join(directory, name)
      if (!withinStateDir(stateDir, path)) throw new Error('The QQ attachment path escapes the state directory')
      await writeFile(path, file.data, { mode: 0o600 })
      saved.push({ path, kind: ref.kind, name, mime: file.mime, bytes: file.data.byteLength })
    }
    return { attachments: saved }
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    if (options.signal?.aborted) throw error
    return { skipped: attachmentSkipOf(error) }
  }
}
/** The text a Trigger carries: the original text (when there is one) plus one line per saved attachment with its path. */
function triggerTextOf(text: string, attachments: readonly QqSavedAttachment[]): string {
  if (!attachments.length) return text.slice(0, QQ_TEXT_CHARS)
  const lines = attachments.map((attachment, index) => index === 0 && !text.trim()
    ? `收到图片/文件：${attachment.path}`
    : `附件：${attachment.path}（${attachment.kind}/${attachment.mime}）`)
  const block = lines.join('\n')
  const original = text.trim()
  // A long message text is cut so that every attachment path survives: the worker needs the paths more than the tail.
  const room = QQ_TEXT_CHARS - block.length - 1
  if (!original || room <= 0) return block.slice(0, QQ_TEXT_CHARS)
  return `${original.slice(0, room)}\n${block}`
}

/**
 * The Trigger of one QQ message on its instance: the thread is the direct chat's user openid or the group's openid, and
 * the text names every attachment the Source saved for the worker (its absolute path plus kind and MIME type).
 * `meta.attachments` carries the same files as data, so an adapter can read them without parsing the text.
 */
export function qqTrigger(message: QqMessage, instance: string, config: QqConfig,
  attachments: readonly QqSavedAttachment[] = []): Trigger {
  const group = message.kind === 'group'
  const thread = message.conversationId
  const at = message.createdAt || new Date().toISOString()
  // The reply route: QQ's passive reply anchors to this message id, and the conversation ids name the target.
  const address: Record<string, string> = {
    row: instance,
    conversationType: group ? 'group' : 'direct',
    conversationId: message.conversationId,
    groupId: group ? message.groupId : '',
    userId: message.senderId,
    senderId: message.senderId,
    msgId: message.messageId,
    messageId: message.messageId,
    // QQ pushes one id for the message event and uses it as the passive reply's msg_id; it is kept under both names.
    eventId: message.messageId,
    receivedAt: String(Date.parse(at)),
  }
  return {
    id: key('qq', instance, message.messageId),
    source: instance,
    threads: [{ source: instance, id: thread }],
    actor: { source: instance, id: message.senderId },
    human: true,
    addressed: group ? 'mention' : 'direct',
    at,
    text: triggerTextOf(message.text, attachments),
    channel: { source: instance, thread: `${instance}:${thread}`, address },
    meta: { row: instance, conversationType: group ? 'group' : 'direct', conversationId: message.conversationId,
      groupId: group ? message.groupId : '', userId: message.senderId, senderId: message.senderId,
      senderNick: message.senderNick, messageId: message.messageId, msgId: message.messageId, eventId: message.messageId,
      sandbox: config.sandbox, addressed: true,
      ...attachments.length ? { attachments: attachments.map(attachment => ({ ...attachment })) } : {} },
  }
}
/** The name one conversation shows for itself, or its id. */
const conversationLabel = (message: QqMessage): string => message.kind === 'group'
  ? `QQ group ${message.groupId}`
  : message.senderNick || message.senderId
/** What receiving one message did; an attachment skip names why the message became no Trigger. */
export type QqReceipt = 'received' | 'duplicate' | 'filtered' | 'not-allowed' | QqAttachmentSkip
/**
 * Turns one normalized message into a Trigger and hands it to the Engine: the allow-list filter of this instance drops a
 * sender it does not name, its attachments are fetched first (a message whose files cannot be received becomes no Trigger
 * and is counted in the instance's health), and a message whose Trigger the Engine already holds is a duplicate, not an
 * error.
 */
export async function receiveQq(ctx: SourceContext, instance: string, config: QqConfig, message: QqMessage,
  options: QqReceiveOptions = {}): Promise<QqReceipt> {
  if (config.allowedUserIds.length && !config.allowedUserIds.includes(message.senderId)) return 'not-allowed'
  let attachments: QqSavedAttachment[] = []
  if (message.attachments.length) {
    const outcome = await saveQqAttachments(ctx.deployment.stateDir, instance, message, options)
    if ('skipped' in outcome) return outcome.skipped
    attachments = outcome.attachments
  }
  const trigger = qqTrigger(message, instance, config, attachments)
  const result = await ctx.receive(trigger)
  ctx.threads.describe(threadKey(trigger.threads[0]!), { label: conversationLabel(message), facts: {
    conversation: { label: { zh: '会话', en: 'Conversation' },
      value: message.kind === 'group' ? `group ${message.groupId}` : `direct ${message.senderId}` } } })
  return result === 'stored' ? 'received' : result
}

const fields: FieldSpec[] = [
  { key: 'appId', type: 'text', label: { zh: 'AppID', en: 'AppID' },
    hint: { zh: 'QQ 开放平台机器人资料页的 AppID；保存时不联网校验，连接失败会显示在本实例的健康里。',
      en: 'The AppID on the bot\'s page in the QQ open platform. Saving checks nothing online; a failed connection shows in this instance\'s health.' } },
  { key: 'appSecret', type: 'text', label: { zh: 'AppSecret', en: 'AppSecret' },
    hint: { zh: '机器人密钥；只存在本机设置里，不写日志、不进健康详情、不进工单。',
      en: 'The bot secret; it stays in the local settings and never appears in logs, health details or Triggers.' } },
  { key: 'allowedUserIds', type: 'text', label: { zh: '允许的发送人 openid（可选）', en: 'Allowed sender openids (optional)' },
    hint: { zh: '逗号分隔的用户 openid；留空则接收机器人所在会话的所有人，再由策略的 allowed 名单决定谁能发起工作。',
      en: 'Comma-separated user openids; empty listens to everyone in the bot\'s conversations, and the Policy\'s allowed list still decides who may originate work.' } },
  { key: 'sandbox', type: 'switch', label: { zh: '沙箱环境', en: 'Sandbox environment' },
    hint: { zh: '测试机器人使用 QQ 的沙箱环境；凭据与 token 接口不变，只有 API 地址不同。',
      en: 'Use the QQ sandbox environment for a test bot; credentials and the token endpoint are the same, only the API base differs.' } },
]
const PolicySchema = z.object({
  allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()).default([]),
}).strict()

export const qqKind: SourceKind<QqConfig> = {
  kind: 'qq',
  order: 4,
  title: { zh: 'QQ', en: 'QQ' },
  description: { zh: '接收 QQ 开放平台机器人收到的私聊与群 @ 消息（文字、图片、文件），并回到原会话；长连接（WebSocket 网关），不需要公网回调地址。',
    en: 'Receives the direct messages and group mentions of a QQ open-platform bot — text, pictures and files — and replies in the same conversation over the bot gateway\'s WebSocket; no public callback URL is needed.' },
  schema: ConfigSchema,
  fields,
  health: ['qq'],
  scope({ meta }, config) {
    // The transport drops unmentioned group messages before a Trigger exists; this still protects stored Triggers and old data.
    const sender = typeof meta.userId === 'string' ? meta.userId : typeof meta.senderId === 'string' ? meta.senderId : ''
    if (config.allowedUserIds.length && !config.allowedUserIds.includes(sender)) return { listened: false, reason: 'not_a_member' }
    const group = meta.conversationType === 'group'
    if (group && meta.addressed !== true) return { listened: false, reason: 'no_mention' }
    return { listened: true, observed: false, row: group ? 'group' : 'direct' }
  },
  channel: {
    // A reply goes only to the instance's own live bot: the address names the conversation and the passive reply's msg_id.
    allowed: (address, config) => !!replyTargetOf(address) && !!config.appId,
    send: (host, message) => sendQq(message, host.commands),
    link: address => ({ url: '', label: { zh: `QQ 会话 ${address.row}`, en: `QQ conversation ${address.row}` } }),
    // A group reply may mention its sender with QQ's inline mention markup; the transport sends it as markdown so it renders.
    mention: person => qqMention(person.id),
  },
  // The user openids the instance's own allow-list names are people this Source knows, beside the Policy's allowed list.
  people: config => config.allowedUserIds.map(id => ({ id })),
  policy: {
    schema: PolicySchema,
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 QQ 用户', en: 'QQ users who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '用户 openid', en: 'User openid' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
    ] }],
    explicit: { zh: '名单里的用户 openid 私聊机器人，或在群里 @ 机器人。', en: 'A user openid on the list messages the bot directly, or mentions it in a group.' },
    unnamed: { person: { zh: 'QQ 用户', en: 'QQ user' }, bot: { zh: 'QQ 机器人', en: 'QQ bot' } },
    // The two receiving scopes a Trigger records: a group (only messages that mention the bot) and a direct conversation.
    rows: () => [
      { id: 'group', label: { zh: '群聊', en: 'Group chats' }, note: { zh: '仅 @ 机器人', en: '@ only' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
      { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: { zh: '接收', en: 'Received' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
    ],
  },
  /**
   * Adapts the Commands the Registry scopes to this instance: a reply is sent through the instance's live bot, whose App
   * ID the scoped configuration names, so the Channel only needs the validated configuration.
   */
  commands: (config, commands) => {
    const scoped = Object.create(commands) as Commands
    scopedConfigs.set(scoped, config)
    return scoped
  },
}
/** Sends one message to the route it carries, through the connected bot of the instance the Registry resolved. */
async function sendQq(message: OutboundMessage, commands: object): Promise<'sent' | 'gone'> {
  const config = scopedConfigs.get(commands)
  if (!config) throw new Error('The QQ Source has no configuration for this reply')
  const target = replyTargetOf(message.channel.address)
  if (!target) return 'gone'
  const sender = liveQqBot(config.appId)
  // A reply is anchored to a message id, so only the instance's own connection can send it; the Outbox retries once it is
  // connected again, and an already closed window is reported as gone by the transport instead of being retried.
  if (!sender) throw new QqApiError('network', 'The QQ bot is not connected; the reply waits for the connection')
  return sendQqReply(message, { target, sender })
}

/** The per-instance counters a health detail reports: messages received, duplicates, skips and receive failures. */
interface QqCounters {
  received: number
  duplicates: number
  failed: number
  skipped: Map<string, number>
}
const countersOf = (): QqCounters => ({ received: 0, duplicates: 0, failed: 0, skipped: new Map() })
/** The suffix a health detail gives the skips the transport and the allow-list counted. */
function skipText(counters: QqCounters): string {
  const skipped = [...counters.skipped.entries()].sort(([a], [b]) => a.localeCompare(b))
  const total = skipped.reduce((sum, [, count]) => sum + count, 0)
  return total ? `; ${total} skipped (${skipped.map(([reason, count]) => `${reason} ${count}`).join(', ')})` : ''
}
/** One instance's health detail while connected: what it received and skipped since it connected. */
function connectedText(counters: QqCounters): string {
  const duplicates = counters.duplicates ? `; ${counters.duplicates} duplicate messages` : ''
  const failed = counters.failed ? `; ${counters.failed} messages could not be received` : ''
  return `Connected to the QQ bot gateway; ${counters.received} messages received${duplicates}${failed}${skipText(counters)}`
}
/** One connection's options, as the caller injected them; every field has a production default. */
export interface QqWatchOptions {
  botFactory?: QqBotFactory
  /** The `fetch` attachment downloads use; tests inject a fake, production takes the global one. */
  fetchImpl?: typeof fetch
  /** How long one gateway handshake may take before the attempt counts as failed. */
  connectTimeoutMs?: number
  /** The waits after consecutive failed attempts; tests shorten them. */
  backoffMs?: readonly number[]
  /** Consecutive failures after which the instance reports `error` while it keeps retrying. */
  failureThreshold?: number
  /** How often the loop rereads the configured instances, so a save takes effect without a restart. */
  reconcileSeconds?: number
}
const iso = (): string => new Date().toISOString()
/** Sleeps for `ms`, returning false when the caller aborted instead of throwing. */
const nap = (ms: number, signal: AbortSignal): Promise<boolean> =>
  delay(ms, undefined, { signal }).then(() => true, () => false)
/**
 * One instance's connection loop: connects, reports ready, waits until the gateway closes or three errors fail it, reports
 * the reconnect delay, and tries again; a failed attempt counts toward the error threshold and waits the next backoff.
 * Stops at once on abort.
 */
async function runQqInstance(ctx: SourceContext, id: string, config: QqConfig, signal: AbortSignal,
  options: QqWatchOptions): Promise<void> {
  const counters = countersOf()
  const counter = (reason: string): void => { counters.skipped.set(reason, (counters.skipped.get(reason) ?? 0) + 1) }
  const reportReady = (): void => { ctx.report(id, { state: 'ready', detail: connectedText(counters), at: iso() }) }
  const backoff = options.backoffMs ?? BACKOFF_MS
  const failureThreshold = options.failureThreshold ?? FAILURES_BEFORE_ERROR
  const waited = (ms: number): number => Math.max(1, Math.round(ms / 1_000))
  let failures = 0
  while (!signal.aborted) {
    ctx.report(id, { state: 'starting', detail: 'Connecting to the QQ bot gateway', at: iso() })
    const connection = new QqConnection({
      appId: config.appId,
      appSecret: config.appSecret,
      sandbox: config.sandbox,
      ...options.botFactory === undefined ? {} : { botFactory: options.botFactory },
      ...options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs },
      onMessage: async message => {
        try {
          const receipt = await receiveQq(ctx, id, config, message,
            options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
          if (receipt === 'received') counters.received += 1
          else if (receipt === 'duplicate') counters.duplicates += 1
          else counter(receipt)
        } catch {
          counters.failed += 1
        }
        // A message may finish after the gateway closed; the loop's reconnect report owns the health then.
        if (!signal.aborted && connection.connected) reportReady()
      },
      onSkip: (skip: QqSkipEvent) => {
        counter(skip.reason)
        if (!signal.aborted && connection.connected) reportReady()
      },
    })
    try {
      await connection.connect(signal)
      failures = 0
      reportReady()
      const outcome = await connection.waitForClose(signal)
      await connection.close()
      if (signal.aborted || outcome.closed === 'aborted') break
      const delayMs = backoff[0] ?? 5_000
      if (outcome.closed === 'failed') {
        // Three consecutive gateway errors fail a live connection; the loop restarts it after the first backoff.
        failures = 1
        ctx.report(id, { state: 'error',
          detail: `The QQ bot gateway failed three times in a row: ${outcome.reason}; retrying in ${waited(delayMs)} s`, at: iso() })
      } else {
        ctx.report(id, { state: 'starting',
          detail: `The QQ bot gateway connection closed; reconnecting in ${waited(delayMs)} s`, at: iso() })
      }
      if (!await nap(delayMs, signal)) break
    } catch (error) {
      await connection.close()
      if (signal.aborted) break
      failures += 1
      const delayMs = backoff[Math.min(failures - 1, backoff.length - 1)] ?? 60_000
      const failure = qqFailureText(error)
      if (failures >= failureThreshold) {
        ctx.report(id, { state: 'error',
          detail: `The QQ bot connection failed ${failures} times; last: ${failure}; retrying in ${waited(delayMs)} s`, at: iso() })
      } else {
        ctx.report(id, { state: 'starting',
          detail: `The QQ bot connect attempt ${failures} failed: ${failure}; retrying in ${waited(delayMs)} s`, at: iso() })
      }
      if (!await nap(delayMs, signal)) break
    }
  }
}
/** One running instance loop: the configuration it runs with and how to stop it. */
interface InstanceLoop { fingerprint: string; controller: AbortController; running: Promise<void> }
/** A configuration's own fingerprint, so a save that changes it restarts the connection and one that does not leaves it alone. */
const fingerprintOf = (config: QqConfig): string => JSON.stringify([config.appId, config.appSecret, config.sandbox,
  config.allowedUserIds])
/**
 * The Source loop: waits for setup, then keeps one gateway connection per enabled and complete instance, following saves and
 * the enable switch without a restart, reports each instance's own health, and stops every connection on abort. An enabled
 * instance whose two credentials are not set reports `paused` with what it waits for instead of counting as a failure.
 */
export async function watchQq(ctx: SourceContext, signal: AbortSignal, options: QqWatchOptions = {}): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) {
    for (const instance of ctx.instances('qq')) ctx.report(instance.id, health('paused', 'setupPending'))
    return
  }
  const loops = new Map<string, InstanceLoop>()
  /** Stops one instance's connection and waits for it to end. */
  const stop = async (id: string): Promise<void> => {
    const loop = loops.get(id)
    if (!loop) return
    loops.delete(id)
    loop.controller.abort()
    await loop.running
  }
  try {
    while (!signal.aborted) {
      const instances = ctx.instances<QqConfig>('qq')
      for (const instance of instances) {
        const missing = missingFields(instance.config)
        if (!instance.enabled) {
          await stop(instance.id)
          ctx.report(instance.id, health('paused', 'sourceOff'))
          continue
        }
        if (missing.length) {
          await stop(instance.id)
          ctx.report(instance.id, { state: 'paused', detail: `The QQ bot is not configured: ${missing.join(', ')}`, at: iso() })
          continue
        }
        const fingerprint = fingerprintOf(instance.config)
        const current = loops.get(instance.id)
        if (current && current.fingerprint !== fingerprint) await stop(instance.id)
        if (loops.has(instance.id)) continue
        const controller = new AbortController()
        const loopSignal = AbortSignal.any([signal, controller.signal])
        const loop: InstanceLoop = { fingerprint, controller, running: Promise.resolve() }
        loop.running = runQqInstance(ctx, instance.id, instance.config, loopSignal, options)
          .catch((error: unknown) => { ctx.report(instance.id, { state: 'error', detail: qqFailureText(error), at: iso() }) })
        loops.set(instance.id, loop)
      }
      const known = new Set(instances.map(instance => instance.id))
      for (const id of [...loops.keys()]) if (!known.has(id)) await stop(id)
      await delay((options.reconcileSeconds ?? RECONCILE_SECONDS) * 1_000, undefined, { signal }).catch(() => {})
    }
  } finally {
    for (const id of [...loops.keys()]) await stop(id)
  }
}

export const name = 'dsh-superagent-qq'
export const inject = ['orchestrator']
/** Registers the kind and starts its gateway loop. `options` injects fake transport pieces in tests; production loads the SDK. */
export function apply(ctx: Context, options: QqWatchOptions = {}): void {
  ctx.effect(() => ctx.orchestrator.sources.register(qqKind), 'qq: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, qqKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watchQq(source, controller.signal, options)
      .catch((error: unknown) => { reportFailure(source, qqKind.kind, error) })
    return async () => { controller.abort(); await running }
  })
}
