/**
 * WeChat Source: one instance is one personal WeChat account signed in to Tencent's iLink bot service by scanning a QR code.
 * The account's transport (`im/weixin-transport.ts`) long-polls iLink for messages; a direct text message from a person
 * becomes a Trigger, while the account's own messages, group messages (this Source receives direct messages only for now)
 * and media-only messages are counted and dropped. A reply goes back through the same conversation: it carries the inbound
 * message's `from_user_id`, its `context_token` and its id as `run_id`, and never anywhere else.
 *
 * The bot token is not part of the configuration: the QR sign-in (`im/weixin-login.ts`) writes it to this installation's KV
 * store under `weixin.token:<instance>`, and the management API returns the account id and sign-in time but never the token.
 * An instance with no token reports `paused` with the "needs a QR sign-in" health code; a token iLink no longer accepts
 * reports `error` and asks for a new sign-in, and a new sign-in restarts the instance without a plugin restart. The token is
 * never logged, never written to a health detail and never put in a Trigger: the Channel sends through the live credential
 * of the instance the Trigger names.
 */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import type { Commands } from '../infra/commands.ts'
import { clearWeixinLiveCredentials, getWeixinUpdates, liveWeixinCredential, normalizeWeixinInbound,
  registerWeixinCredential, sendWeixinReply, unregisterWeixinCredential, WEIXIN_TEXT_CHARS, weixinFailureText,
  weixinReplyTargetOf, WeixinApiError } from './im/weixin-transport.ts'
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

/** The Trigger of one WeChat message on its instance: the thread is the direct chat with its sender. */
export function wechatTrigger(message: { messageId: string; clientId: string; text: string; fromUserId: string
  contextToken: string; runId: string; createdAt: string }, instance: string): Trigger {
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
    text: message.text.slice(0, WEIXIN_TEXT_CHARS),
    channel: { source: instance, thread: `${instance}:${message.fromUserId}`, address },
    meta: { row: instance, conversationKind: 'dm', addressed: true, fromUserId: message.fromUserId,
      messageId: message.messageId, clientId: message.clientId, contextToken: message.contextToken },
  }
}
/** What receiving one message did. */
export type WechatReceipt = 'received' | 'duplicate' | 'filtered'
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
 * asking for the same work twice.
 */
export async function receiveWechat(ctx: SourceContext, instance: string, message: { messageId: string; clientId: string
  text: string; fromUserId: string; contextToken: string; runId: string; createdAt: string }): Promise<WechatReceipt> {
  const seenKey = weixinSeen(instance)
  const seen = ctx.state.get(seenKey) ?? {}
  if (seen[message.messageId] !== undefined) return 'duplicate'
  ctx.state.set(seenKey, rememberSeen(seen, message.messageId, Date.now()))
  const trigger = wechatTrigger(message, instance)
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
  order: 5,
  title: { zh: '微信', en: 'WeChat' },
  description: { zh: '用手机微信扫码登录一个个人微信号，接收白名单私聊的文字消息并回到同一会话；群消息暂不接收，个人号自动化有封号风险。',
    en: 'Signs one personal WeChat account in by scanning a QR code with the phone, receives text messages from allowed direct chats and replies in the same conversation. Group messages are not received yet, and automating a personal account risks a ban.' },
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
          const receipt = await receiveWechat(ctx, id, inbound.message)
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
