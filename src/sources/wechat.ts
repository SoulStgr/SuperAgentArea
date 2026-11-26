/**
 * WeChat Source: one instance is one personal WeChat account signed in to Tencent's iLink bot service by scanning a QR code.
 * The account's transport (`im/weixin-transport.ts`) long-polls iLink for messages; a direct message from a person — text,
 * a picture, a file, or both — becomes a Trigger, while the account's own messages, group messages (this Source receives
 * direct messages only for now) and messages with neither text nor an attachment are counted and dropped. A message iLink
 * named an attachment on, even one with no text at all, is downloaded and decrypted first into
 * `<stateDir>/area/attachments/wechat/<instance>/<messageId>/` and its Trigger names every saved absolute path, so the
 * worker can read the file; a message whose attachments cannot be received is counted in the instance's health instead of
 * opening an empty Ticket. A reply goes back through the same conversation: it carries the inbound message's `from_user_id`,
 * its `context_token` and its id as `run_id`, and never anywhere else; replies are text only.
 *
 * The bot token is not part of the configuration: the QR sign-in (`im/weixin-login.ts`) writes it to this installation's KV
 * store under `weixin.token:<instance>`, and the management API returns the account id and sign-in time but never the token.
 * An instance with no token reports `paused` with the "needs a QR sign-in" health code; a token iLink no longer accepts
 * reports `error` and asks for a new sign-in, and a new sign-in restarts the instance without a plugin restart. The token is
 * never logged, never written to a health detail and never put in a Trigger: the Channel sends through the live credential
 * of the instance the Trigger names. An attachment's signed download address, its query string and its AES key are just as
 * restricted: the transport never copies one into a failure, so none can reach a log line, a health detail or a Trigger.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import type { Commands } from '../infra/commands.ts'
import { clearWeixinLiveCredentials, downloadWeixinAttachment, getWeixinUpdates, liveWeixinCredential,
  normalizeWeixinInbound, registerWeixinCredential, sendWeixinReply, unregisterWeixinCredential, WEIXIN_ATTACHMENTS_PER_MESSAGE,
  WEIXIN_TEXT_CHARS, weixinFailureText, weixinReplyTargetOf, WeixinApiError, WeixinAttachmentError, type WeixinAttachmentRef,
  type WeixinDownloadedFile, type WeixinMessage } from './im/weixin-transport.ts'
import { weixinToken, type WeixinCredential } from './im/weixin-login.ts'
import { health, reportFailure, sourceContext, type SourceContext } from './host.ts'
import type { FieldSpec, SourceKind } from './kind.ts'

/** The update cursor of one instance: the opaque `get_updates_buf` value the next poll sends back. */
export const weixinCursor = family<string, [instance: string]>('weixin.cursor:')
/** The message ids one instance already received, with their arrival time: a redelivered message is a duplicate. */
export const weixinSeen = family<Record<string, number>, [instance: string]>('weixin.seen:')
/** How long a received message id stays in the duplicate set: seven days, as the plan requires. */
export const WEIXIN_SEEN_TTL_MS = 7 * 24 * 60 * 60_000
/** The most ids one instance remembers; the oldest are forgotten first. */
export const WEIXIN_SEEN_LIMIT = 1_000
const RECONCILE_SECONDS = 5
/** The waits after consecutive failed polls: 5 s doubling up to 60 s. */
const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const
const FAILURES_BEFORE_ERROR = 3

const ConfigSchema = z.object({
  /**
   * The iLink bot type the QR sign-in asks for. 3 is the bot account this Source signs in; the field only exists so an
   * operator can reproduce an iLink-side change without a new build.
   */
  botType: z.string().trim().regex(/^\d{1,3}$/u, 'bot_type must be a number').default('3'),
}).strict()
export type WechatConfig = z.infer<typeof ConfigSchema>
/** The configuration one instance replies with, as `channel.send` reads it from the Commands the registry scoped to this kind. */
const scopedConfigs = new WeakMap<object, WechatConfig>()

/** One attachment saved under this installation's state directory, as a worker reads it and as a Trigger carries it. */
export interface WechatSavedAttachment { path: string; kind: 'image' | 'file'; name: string; mime: string; bytes: number }
/** Why a message whose attachments could not be received became no Trigger; the Source counts it in the instance's health. */
export type WechatAttachmentSkip = 'attachment-count' | 'attachment-unavailable' | 'attachment-too-large'
  | 'attachment-untrusted' | 'attachment-key' | 'attachment-decrypt' | 'attachment-download-failed'
/** How one received message fetches its attachments; the watch loop leaves every default in place. */
export interface WechatReceiveOptions {
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
/** The directory one message's attachments are saved in: `<stateDir>/area/attachments/wechat/<instance>/<messageId>`. */
export function wechatAttachmentDirectory(stateDir: string, instance: string, messageId: string): string {
  const directory = join(resolve(stateDir), 'area', 'attachments', 'wechat', safeSegment(instance, 'instance'),
    safeSegment(messageId, 'message'))
  if (!withinStateDir(stateDir, directory)) throw new Error('The WeChat attachment directory escapes the state directory')
  return directory
}
/**
 * The saved file name of one attachment: only `[A-Za-z0-9._-]`, never a path and never `.` or `..`. Only the provider name's
 * last path segment is used, so a name like `../../etc/passwd` can never leave the message's directory; an unusable stem
 * falls back to the message id and keeps a sanitized extension.
 */
function safeFileName(value: string, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  const base = text.split(/[\\/]/).at(-1) ?? ''
  const dot = base.lastIndexOf('.')
  const rawStem = dot > 0 ? base.slice(0, dot) : base
  const rawExtension = dot > 0 ? base.slice(dot + 1) : ''
  const cleaned = rawStem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '')
  const usable = cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 110) : ''
  const extension = rawExtension.replace(/[^A-Za-z0-9]/g, '').slice(0, 10)
  return `${usable || fallback}${extension ? `.${extension}` : ''}`
}
/** The extension a picture is saved under; a type beyond the four iLink sends is kept as raw bytes. */
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
/**
 * The display name of a saved file: the last path segment of the name iLink sent, with control characters and leading dots
 * removed. It is only ever shown (in `meta.attachments`), never used as a path; a name that leaves nothing usable falls back
 * to the saved file name.
 */
function displayFileName(value: string, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  const base = text.split(/[\\/]/).at(-1) ?? ''
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^[.\-]+/, '').trim()
  return (cleaned || fallback).slice(0, 120)
}
/** The saved file name of one attachment: a picture by its sniffed MIME type, a file by the name iLink sent, sanitized. */
function attachmentFileName(ref: WeixinAttachmentRef, file: WeixinDownloadedFile, messageId: string,
  used: Set<string>): string {
  const base = ref.kind === 'image' ? `image${IMAGE_EXTENSIONS[file.mime] ?? '.bin'}`
    : safeFileName(file.name, `file-${safeSegment(messageId, 'message')}`)
  return uniqueFileName(base, used)
}
/** The receipt one failed attachment fetch becomes, as the instance's health counts it. */
function attachmentSkipOf(error: unknown): WechatAttachmentSkip {
  if (error instanceof WeixinAttachmentError) {
    if (error.code === 'too-large') return 'attachment-too-large'
    if (error.code === 'untrusted-url') return 'attachment-untrusted'
    if (error.code === 'unavailable') return 'attachment-unavailable'
    if (error.code === 'invalid-key') return 'attachment-key'
    if (error.code === 'decryption-failed') return 'attachment-decrypt'
  }
  return 'attachment-download-failed'
}
/**
 * Fetches, decrypts and saves every attachment of one message under
 * `<stateDir>/area/attachments/wechat/<instance>/<messageId>/`. A message with more than five attachments, a missing or
 * untrusted download address, a key that is missing or malformed, a failed or oversized download and an undecryptable body
 * all make the message no work: the directory is removed again and the reason is returned for the instance's health, so the
 * Source never opens a Ticket that silently misses a file.
 */
async function saveWechatAttachments(stateDir: string, instance: string, message: WeixinMessage,
  options: WechatReceiveOptions): Promise<{ attachments: WechatSavedAttachment[] } | { skipped: WechatAttachmentSkip }> {
  const refs = message.attachments
  if (!refs.length) return { attachments: [] }
  if (refs.length > WEIXIN_ATTACHMENTS_PER_MESSAGE) return { skipped: 'attachment-count' }
  const directory = wechatAttachmentDirectory(stateDir, instance, message.messageId)
  const saved: WechatSavedAttachment[] = []
  const used = new Set<string>()
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const ref of refs) {
      const file = await downloadWeixinAttachment({ attachment: ref,
        ...options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
        ...options.signal ? { signal: options.signal } : {} })
      const name = attachmentFileName(ref, file, message.messageId, used)
      const display = ref.kind === 'file' ? displayFileName(file.name, name) : name
      const path = join(directory, name)
      if (!withinStateDir(stateDir, path)) throw new Error('The WeChat attachment path escapes the state directory')
      await writeFile(path, file.data, { mode: 0o600 })
      saved.push({ path, kind: ref.kind, name: display, mime: file.mime, bytes: file.data.byteLength })
    }
    return { attachments: saved }
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    if (options.signal?.aborted) throw error
    return { skipped: attachmentSkipOf(error) }
  }
}
/** The text a Trigger carries: the original text (when there is one) plus one line per saved attachment with its path. */
function triggerTextOf(text: string, attachments: readonly WechatSavedAttachment[]): string {
  if (!attachments.length) return text.slice(0, WEIXIN_TEXT_CHARS)
  const lines = attachments.map((attachment, index) => index === 0 && !text.trim()
    ? `收到图片/文件：${attachment.path}`
    : `附件：${attachment.path}（${attachment.kind}/${attachment.mime}）`)
  const block = lines.join('\n')
  const original = text.trim()
  // A long message text is cut so that every attachment path survives: the worker needs the paths more than the tail.
  const room = WEIXIN_TEXT_CHARS - block.length - 1
  if (!original || room <= 0) return block.slice(0, WEIXIN_TEXT_CHARS)
  return `${original.slice(0, room)}\n${block}`
}
/**
 * The Trigger of one WeChat message on its instance: the thread is the direct chat with its sender, and the text names every
 * attachment the Source saved for the worker (its absolute path plus kind and MIME type). `meta.attachments` carries the same
 * files as data, so an adapter can read them without parsing the text; the reply route is unchanged.
 */
export function wechatTrigger(message: WeixinMessage, instance: string,
  attachments: readonly WechatSavedAttachment[] = []): Trigger {
  const at = message.createdAt || new Date().toISOString()
  const address: Record<string, string> = {
    row: instance,
    fromUserId: message.fromUserId,
    messageId: message.messageId,
    clientId: message.clientId,
    contextToken: message.contextToken,
  }
  return {
    id: key('wechat', instance, message.messageId),
    source: instance,
    threads: [{ source: instance, id: message.fromUserId }],
    actor: { source: instance, id: message.fromUserId },
    human: true,
    addressed: 'direct',
    at,
    text: triggerTextOf(message.text, attachments),
    channel: { source: instance, thread: `${instance}:${message.fromUserId}`, address },
    meta: { row: instance, conversationKind: 'dm', addressed: true, fromUserId: message.fromUserId,
      messageId: message.messageId, clientId: message.clientId, contextToken: message.contextToken,
      ...attachments.length ? { attachments: attachments.map(attachment => ({ ...attachment })) } : {} },
  }
}
/** What receiving one message did; an attachment skip names why the message became no Trigger. */
export type WechatReceipt = 'received' | 'duplicate' | 'filtered' | WechatAttachmentSkip
/** The duplicate set after one arrival, with the ids older than the retention window and beyond the size cap forgotten. */
export function rememberSeen(seen: Record<string, number>, messageId: string, at: number): Record<string, number> {
  const cutoff = at - WEIXIN_SEEN_TTL_MS
  const kept = Object.entries(seen).filter(([, time]) => Number.isFinite(time) && time > cutoff)
  kept.push([messageId, at])
  const newest = kept.sort((one, two) => two[1] - one[1]).slice(0, WEIXIN_SEEN_LIMIT)
  return Object.fromEntries(newest)
}
/**
 * Turns one normalized message into a Trigger and hands it to the Engine. The instance's duplicate set (message ids for
 * seven days) makes a redelivered message a duplicate before the Engine sees it, which also keeps a long-poll restart from
 * asking for the same work twice. A message that carries attachments fetches and saves them first (a message whose files
 * cannot be received becomes no Trigger and is counted in the instance's health).
 */
export async function receiveWechat(ctx: SourceContext, instance: string, message: WeixinMessage,
  options: WechatReceiveOptions = {}): Promise<WechatReceipt> {
  const seenKey = weixinSeen(instance)
  const seen = ctx.state.get(seenKey) ?? {}
  if (seen[message.messageId] !== undefined) return 'duplicate'
  ctx.state.set(seenKey, rememberSeen(seen, message.messageId, Date.now()))
  let attachments: WechatSavedAttachment[] = []
  if (message.attachments.length) {
    const outcome = await saveWechatAttachments(ctx.deployment.stateDir, instance, message, options)
    if ('skipped' in outcome) return outcome.skipped
    attachments = outcome.attachments
  }
  const trigger = wechatTrigger(message, instance, attachments)
  const result = await ctx.receive(trigger)
  ctx.threads.describe(threadKey(trigger.threads[0]!), { label: message.fromUserId, facts: {
    conversation: { label: { zh: '会话', en: 'Conversation' }, value: `direct ${message.fromUserId}` } } })
  return result === 'stored' ? 'received' : result
}

const fields: FieldSpec[] = [
  { key: 'botType', type: 'text', advanced: true, label: { zh: '机器人类型（bot_type）', en: 'Bot type (bot_type)' },
    hint: { zh: '扫码登录时向 iLink 申请机器人所用的类型，默认 3；通常不需要改。', en: 'The bot type the QR sign-in asks iLink for; 3 by default and normally left alone.' } },
]
const PolicySchema = z.object({
  allowed: z.array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()).default([]),
}).strict()

export const wechatKind: SourceKind<WechatConfig> = {
  kind: 'wechat',
  order: 6,
  title: { zh: '微信', en: 'WeChat' },
  description: { zh: '用手机微信扫码登录一个个人微信号，接收白名单私聊的文字、图片与文件消息并回到同一会话；群消息暂不接收，个人号自动化有封号风险。',
    en: 'Signs one personal WeChat account in by scanning a QR code with the phone, receives text messages, pictures and files from allowed direct chats and replies in the same conversation. Group messages are not received yet, and automating a personal account risks a ban.' },
  schema: ConfigSchema,
  fields,
  health: ['wechat'],
  scope({ meta }) {
    // The transport drops group messages before a Trigger exists; this still protects stored Triggers and old data.
    if (meta.conversationKind !== 'dm' || meta.addressed !== true) return { listened: false, reason: 'group_not_supported' }
    return { listened: true, observed: false, row: 'direct' }
  },
  channel: {
    // A reply goes only to the sender's own direct chat: the address names it, and the instance's live token sends it.
    allowed: address => !!weixinReplyTargetOf(address),
    send: (host, message) => sendWechat(message, host.commands),
    link: address => ({ url: '', label: { zh: `微信会话 ${address.row}`, en: `WeChat conversation ${address.row}` } }),
  },
  policy: {
    schema: PolicySchema,
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的微信用户', en: 'WeChat users who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '微信用户 id（from_user_id）', en: 'WeChat user id (from_user_id)' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
    ] }],
    explicit: { zh: '名单里的微信用户私聊机器人账号。', en: 'A WeChat user on the list messages the bot account directly.' },
    unnamed: { person: { zh: '微信用户', en: 'WeChat user' }, bot: { zh: '微信机器人', en: 'WeChat bot' } },
    // The one receiving scope this Source records: a direct conversation. Group messages never become Triggers.
    rows: () => [
      { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: { zh: '接收', en: 'Received' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
    ],
  },
  /**
   * Adapts the Commands the registry scopes to this instance: the Channel reads the validated configuration from it, so an
   * unscoped reply cannot be sent.
   */
  commands: (config, commands) => {
    const scoped = Object.create(commands) as Commands
    scopedConfigs.set(scoped, config)
    return scoped
  },
}
/** Sends one message to the route it carries, through the signed-in account of the instance the Trigger names. */
async function sendWechat(message: OutboundMessage, commands: object): Promise<'sent' | 'gone'> {
  const config = scopedConfigs.get(commands)
  if (!config) throw new Error('The WeChat Source has no configuration for this reply')
  const target = weixinReplyTargetOf(message.channel.address)
  if (!target) return 'gone'
  const instance = message.channel.address.row
  const token = instance ? liveWeixinCredential(instance) : undefined
  // A reply needs the account's live token; an Outbox retry sends it once the instance is signed in and polling again.
  if (!token) throw new WeixinApiError('network', 'The WeChat account is not signed in; the reply waits for the connection')
  return sendWeixinReply(message, { token, target })
}

/** The per-instance counters a health detail reports: messages received, duplicates, skips and receive failures. */
interface WechatCounters {
  received: number
  duplicates: number
  failed: number
  skipped: Map<string, number>
}
const countersOf = (): WechatCounters => ({ received: 0, duplicates: 0, failed: 0, skipped: new Map() })
/** The suffix a health detail gives the skips the transport and the Engine counted. */
function skipText(counters: WechatCounters): string {
  const skipped = [...counters.skipped.entries()].sort(([a], [b]) => a.localeCompare(b))
  const total = skipped.reduce((sum, [, count]) => sum + count, 0)
  return total ? `; ${total} skipped (${skipped.map(([reason, count]) => `${reason} ${count}`).join(', ')})` : ''
}
/** One instance's health detail while polling: what it received and skipped since the loop started. */
function connectedText(counters: WechatCounters): string {
  const duplicates = counters.duplicates ? `; ${counters.duplicates} duplicate messages` : ''
  const failed = counters.failed ? `; ${counters.failed} messages could not be received` : ''
  return `Connected to WeChat; ${counters.received} messages received${duplicates}${failed}${skipText(counters)}`
}
/** One watch loop's options, as the caller injected them; every field has a production default. */
export interface WechatWatchOptions {
  /** The `fetch` update polls and attachment downloads use; tests inject a fake, production takes the global one. */
  fetchImpl?: typeof fetch
  /** How long one update poll may wait for iLink to answer; its timeout means no messages yet. */
  pollTimeoutMs?: number
  /** The waits after consecutive failed polls; tests shorten them. */
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
 * One instance's long-poll loop: registers the signed-in credential for replies, polls iLink for messages, counts and
 * hands over what it receives, and reports ready after every successful poll. A stale token reports the sign-in-expired
 * error and ends the loop (a new sign-in restarts it with the instance's new record); a poll that fails for another reason
 * is retried with the backoff and reported `error` after three consecutive failures. Stops at once on abort.
 */
async function runWechatInstance(ctx: SourceContext, id: string, config: WechatConfig, credential: WeixinCredential,
  signal: AbortSignal, options: WechatWatchOptions): Promise<void> {
  const counters = countersOf()
  const counter = (reason: string): void => { counters.skipped.set(reason, (counters.skipped.get(reason) ?? 0) + 1) }
  const reportReady = (): void => { ctx.report(id, { state: 'ready', detail: connectedText(counters), at: iso() }) }
  const backoff = options.backoffMs ?? BACKOFF_MS
  const failureThreshold = options.failureThreshold ?? FAILURES_BEFORE_ERROR
  const waited = (ms: number): number => Math.max(1, Math.round(ms / 1_000))
  let failures = 0
  let cursor = ctx.state.get(weixinCursor(id)) ?? ''
  registerWeixinCredential(id, credential.token)
  try {
    ctx.report(id, { state: 'starting', detail: 'Connecting to WeChat', at: iso() })
    while (!signal.aborted) {
      let updates
      try {
        updates = await getWeixinUpdates({ token: credential.token, cursor,
          ...options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
          ...options.pollTimeoutMs === undefined ? {} : { timeoutMs: options.pollTimeoutMs }, signal })
      } catch (error) {
        if (signal.aborted) break
        if (error instanceof WeixinApiError && error.code === 'auth') {
          // iLink no longer accepts this token: the person signs in again, and the Source loop restarts on the new record.
          ctx.report(id, health('error', 'wechatSignInExpired'))
          return
        }
        failures += 1
        const delayMs = backoff[Math.min(failures - 1, backoff.length - 1)] ?? 60_000
        const failure = weixinFailureText(error)
        if (failures >= failureThreshold) {
          ctx.report(id, { state: 'error',
            detail: `The WeChat update poll failed ${failures} times; last: ${failure}; retrying in ${waited(delayMs)} s`, at: iso() })
        } else {
          ctx.report(id, { state: 'starting',
            detail: `The WeChat update poll failed: ${failure}; retrying in ${waited(delayMs)} s`, at: iso() })
        }
        if (!await nap(delayMs, signal)) break
        continue
      }
      failures = 0
      for (const raw of updates.msgs) {
        const inbound = normalizeWeixinInbound(raw)
        if ('skipped' in inbound) { counter(inbound.skipped.reason); continue }
        try {
          const receipt = await receiveWechat(ctx, id, inbound.message,
            options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
          if (receipt === 'received') counters.received += 1
          else if (receipt === 'duplicate') counters.duplicates += 1
          else counter(receipt)
        } catch {
          counters.failed += 1
        }
      }
      // The cursor moves only after the batch was handled, so a restart rereads an interrupted batch and the duplicate set
      // drops what it already received instead of losing it.
      if (updates.cursor && updates.cursor !== cursor) {
        cursor = updates.cursor
        ctx.state.set(weixinCursor(id), cursor)
      }
      if (!signal.aborted) reportReady()
    }
  } finally {
    unregisterWeixinCredential(id, credential.token)
  }
}
/** One running instance loop: the configuration and credential it runs with, and how to stop it. */
interface InstanceLoop { fingerprint: string; controller: AbortController; running: Promise<void> }
/**
 * A configuration and credential's own fingerprint, so a save or a new sign-in restarts the poll loop and one that changes
 * neither leaves it alone. The token itself is part of the comparison and is never written anywhere else.
 */
const fingerprintOf = (config: WechatConfig, credential: WeixinCredential | undefined): string => JSON.stringify(
  [config.botType, credential?.token ?? '', credential?.ilinkBotId ?? ''])
/**
 * The Source loop: waits for setup, then keeps one iLink long poll per enabled instance that is signed in, following saves,
 * sign-ins and the enable switch without a restart. An enabled instance with no credential reports `paused` with the
 * needs-sign-in health code; each instance reports its own health entry, and stopping the loop stops every poll.
 */
export async function watchWechat(ctx: SourceContext, signal: AbortSignal, options: WechatWatchOptions = {}): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) {
    for (const instance of ctx.instances('wechat')) ctx.report(instance.id, health('paused', 'setupPending'))
    return
  }
  const loops = new Map<string, InstanceLoop>()
  /** Stops one instance's poll loop and waits for it to end. */
  const stop = async (id: string): Promise<void> => {
    const loop = loops.get(id)
    if (!loop) return
    loops.delete(id)
    loop.controller.abort()
    await loop.running
  }
  try {
    while (!signal.aborted) {
      const instances = ctx.instances<WechatConfig>('wechat')
      for (const instance of instances) {
        if (!instance.enabled) {
          await stop(instance.id)
          ctx.report(instance.id, health('paused', 'sourceOff'))
          continue
        }
        const credential = ctx.state.get(weixinToken(instance.id))
        if (!credential) {
          await stop(instance.id)
          ctx.report(instance.id, health('paused', 'wechatLogin'))
          continue
        }
        const fingerprint = fingerprintOf(instance.config, credential)
        const current = loops.get(instance.id)
        if (current && current.fingerprint !== fingerprint) await stop(instance.id)
        if (loops.has(instance.id)) continue
        const controller = new AbortController()
        const loopSignal = AbortSignal.any([signal, controller.signal])
        const loop: InstanceLoop = { fingerprint, controller, running: Promise.resolve() }
        loop.running = runWechatInstance(ctx, instance.id, instance.config, credential, loopSignal, options)
          .catch((error: unknown) => { ctx.report(instance.id, { state: 'error', detail: weixinFailureText(error), at: iso() }) })
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

export const name = 'dsh-superagent-wechat'
export const inject = ['orchestrator']
/** Registers the kind and starts its sign-in/poll loop. `options` injects fakes in tests; production uses iLink over fetch. */
export function apply(ctx: Context, options: WechatWatchOptions = {}): void {
  ctx.effect(() => ctx.orchestrator.sources.register(wechatKind), 'wechat: source kind')
  ctx.effect(() => clearWeixinLiveCredentials, 'wechat: live credentials')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, wechatKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watchWechat(source, controller.signal, options)
      .catch((error: unknown) => { reportFailure(source, wechatKind.kind, error) })
    return async () => { controller.abort(); await running }
  })
}
