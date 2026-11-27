/** Source views: each instance's state, its last day's counts, its execution buckets, recent Triggers, filtered or dropped messages, and unanswered Project questions. */
import { threadKey, ticketStage, type ProjectCandidate, type ProjectProposal, type Reason } from '../../core/index.ts'
import { SETUP_FIELDS } from '../../deployment.ts'
import { KV } from '../../kv.ts'
import type { Deployment } from '../../deployment.ts'
import { health as healthEntry, type Health } from '../../sources/host.ts'
import type { Localized, SourceInstance } from '../../sources/kind.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import type { SetupProblem } from '../../setup.ts'
import { needsProjectValues } from '../project-service.ts'
import { dayAgo, snapshot, ticketInstance, type ActorView, type ViewHost } from './records.ts'
import { preview } from './text.ts'
import { ticketList } from './tickets.ts'

export type HealthMap = Record<string, Health>
/** A conversation a monitored Source's results can be delivered to: a frozen address of a QQ or DingTalk chat. */
export interface DeliveryTargetOption {
  id: string
  source: string
  thread: string
  address: Record<string, string>
  label: Localized
  kind: 'qq' | 'dingtalk'
}
/**
 * A trigger Channel address reduced to what a later proactive send needs: the source conversation ids only. One-shot reply
 * ids, expiring webhooks and display names are dropped, so a result can go to it after the original message's window.
 */
function frozenReportAddress(kind: string | undefined, address: Record<string, string>): Record<string, string> | undefined {
  if (kind === 'qq') {
    const conversationType = address.conversationType === 'group' ? 'group' : address.conversationType === 'direct' ? 'direct' : undefined
    if (!conversationType || !address.conversationId) return undefined
    return { row: address.row ?? '', conversationType, conversationId: address.conversationId,
      ...address.groupId ? { groupId: address.groupId } : {}, ...address.senderId ? { senderId: address.senderId } : {} }
  }
  if (kind === 'dingtalk') {
    const conversationType = address.conversationType === 'group' ? 'group' : address.conversationType === 'direct' ? 'direct' : undefined
    if (!conversationType || !address.robotCode) return undefined
    if (conversationType === 'group' ? !address.openConversationId : !address.userId) return undefined
    return { row: address.row ?? '', conversationType, conversationId: address.conversationId ?? '',
      openConversationId: conversationType === 'group' ? address.openConversationId ?? '' : '',
      userId: conversationType === 'direct' ? address.userId ?? '' : '', senderStaffId: address.senderStaffId ?? '',
      robotCode: address.robotCode ?? '' }
  }
  return undefined
}
/**
 * The conversations recent Triggers came from that can receive a proactive result, newest first and one row per
 * conversation: a monitored web Source's report target is chosen from this list. Nothing here exposes a session webhook,
 * a passive reply id or a credential.
 */
export function deliveryTargets(host: Pick<ViewHost, 'store' | 'sources'>, limit = 20): DeliveryTargetOption[] {
  const { store, sources } = host
  const rows = new Map<string, DeliveryTargetOption>()
  for (const trigger of store.read.recentTriggers(0, 1_000)) {
    if (!trigger.channel) continue
    const kind = sources.kind(trigger.source)
    if (!kind || (kind.kind !== 'qq' && kind.kind !== 'dingtalk')) continue
    const address = frozenReportAddress(kind.kind, trigger.channel.address)
    if (!address) continue
    const key = `${trigger.source}\u0000${trigger.channel.thread}\u0000${JSON.stringify(address)}`
    if (rows.has(key)) continue
    const instance = sources.instance(trigger.source)
    const title = instance ? sourceTitle(kind, instance) : { zh: trigger.source, en: trigger.source }
    const threadLabel = store.threads.get(trigger.channel.thread)?.meta.label
    const label = kind.kind === 'qq'
      ? (address.groupId ? { zh: 'QQ 群', en: 'QQ group' } : { zh: 'QQ 私聊', en: 'QQ direct chat' })
      : (address.conversationType === 'group' ? { zh: '钉钉群', en: 'DingTalk group' } : { zh: '钉钉私聊', en: 'DingTalk direct chat' })
    rows.set(key, { id: key, source: trigger.source, thread: trigger.channel.thread, address, kind: kind.kind,
      label: { zh: `${title.zh} · ${label.zh}${threadLabel ? ` · ${threadLabel}` : ''}`,
        en: `${title.en} · ${label.en}${threadLabel ? ` · ${threadLabel}` : ''}` } })
    if (rows.size >= limit) break
  }
  return [...rows.values()]
}
/** A Source instance's display title: its label, its kind's title, or the kind and key for a named instance. */
export function sourceTitle(kind: { title: Localized; kind: string } | undefined, instance: { id: string; label?: string }): Localized {
  if (instance.label) return { zh: instance.label, en: instance.label }
  if (!kind) return { zh: instance.id, en: instance.id }
  if (!instance.id.startsWith(`${kind.kind}:`)) return kind.title
  const key = instance.id.slice(kind.kind.length + 1)
  return { zh: `${kind.title.zh} · ${key}`, en: `${kind.title.en} · ${key}` }
}
/**
 * Resolves the health entries of a Source instance: its own entry (named by its instance id, which is the kind when the
 * instance is named after its kind) and the entries its kind declares beside it, treating stale `sourceOff` entries on an
 * enabled Source as `starting`. A placeholder kind's instance reports the fixed paused coming-soon state instead.
 */
export function sourceHealth(sources: SourceRegistry, instance: SourceInstance, health: HealthMap) {
  const kind = sources.kind(instance.kind)
  const starting: Health = { state: 'starting', detail: '' }
  // A placeholder kind runs nothing yet: its instance shows the fixed coming-soon state instead of a claimed entry.
  if (kind?.placeholder) {
    return { id: instance.id, title: sourceTitle(kind, instance), health: [{ name: instance.id, ...healthEntry('paused', 'placeholder') }] }
  }
  const names = [instance.id, ...(kind?.health ?? []).filter(name => name !== kind?.kind)]
  const parts = names.map(name => {
    const entry = health[name]
    return { name, ...(!entry || (instance.enabled && entry.code === 'sourceOff') ? starting : entry) }
  })
  return { id: instance.id, title: sourceTitle(kind, instance), health: parts }
}
export interface SetupState {
  /** Resolved deployment facts; undefined while waiting for initial setup. */
  deployment?: Deployment | undefined
  /** Setup failure that stops all Sources. */
  problem?: SetupProblem | undefined
  /** Feishu bot check failure that pauses only the Feishu Source. */
  feishuProblem?: SetupProblem | undefined
  /** Setup problems of named GitHub and Feishu instances, by instance id; each stops only its own instance. */
  problems?: Record<string, SetupProblem> | undefined
}
/**
 * The setup problem of one Source instance: its own, else one recorded where `place` names it (the deployment's problem, or
 * the default instance's).
 */
export const problemOf = (id: string, setup: SetupState) =>
  setup.problems?.[id] ?? [setup.problem, setup.feishuProblem].find(problem => problem?.place === id)
/** Source lifecycle state in priority order: missing kind, disabled, placeholder, setup/part error, blocked on global setup, starting, paused, or ready. */
export type SourceState = 'missing' | 'off' | 'error' | 'setup' | 'starting' | 'paused' | 'ready'
function sourceState(instance: SourceInstance & { installed: boolean }, parts: { state: string }[], setup: SetupState,
  placeholder = false): SourceState {
  if (!instance.installed) return 'missing'
  if (!instance.enabled) return 'off'
  // A placeholder kind receives nothing yet, so it stays paused whatever setup and its claimed entries say.
  if (placeholder) return 'paused'
  if (problemOf(instance.id, setup) || parts.some(part => part.state === 'error')) return 'error'
  if (setup.problem) return 'setup'
  if (parts.some(part => part.state === 'starting')) return 'starting'
  return parts.some(part => part.state === 'paused') ? 'paused' : 'ready'
}
/** A recent Trigger of one instance, as the Source page lists it. */
interface RecentTrigger { id: string; at: string; actor: ActorView; preview: string; filtered?: Reason }
interface FilteredTrigger extends RecentTrigger { reason: Reason | undefined }
const add = <T extends object>(map: Map<string, T>, id: string, value: T, merge: (current: T, next: T) => T): void => {
  const current = map.get(id)
  map.set(id, current ? merge(current, value) : value)
}
/** The instance a stored Source and its row hint resolve to, if its kind is installed. */
const instanceOf = (sources: SourceRegistry, source: string, row?: string): string | undefined => sources.instanceFor(source, row)?.id
const hintOf = (meta: Record<string, unknown>): string | undefined => typeof meta.row === 'string' ? meta.row : undefined
/**
 * Builds the Source status view: every configured instance's state, its last day's arrivals, filtering, judgements and
 * acceptances, its Tickets' execution buckets, the Project questions its Triggers wait on, and what it filtered or dropped.
 */
export function sourcesStatus(host: ViewHost, health: HealthMap, setup: SetupState) {
  const { store, sources } = host
  const settings = store.settings()
  const view = snapshot(host)
  const instances = sources.instances(settings)
  const since = dayAgo()
  const counted = new Map<string, { arrived: number; filtered: number; lastAt: string }>()
  for (const stat of store.read.triggerStats(since)) {
    const id = instanceOf(sources, stat.source, stat.row)
    if (!id) continue
    add(counted, id, { arrived: stat.received, filtered: stat.filtered, lastAt: stat.lastAt },
      (current, next) => ({ arrived: current.arrived + next.arrived, filtered: current.filtered + next.filtered,
        lastAt: current.lastAt > next.lastAt ? current.lastAt : next.lastAt }))
  }
  const judged = new Map<string, { judged: number; accepted: number }>()
  for (const flow of store.read.flowBySource(since)) {
    const id = instanceOf(sources, flow.source, flow.row)
    if (!id) continue
    add(judged, id, { judged: flow.judged, accepted: flow.accepted },
      (current, next) => ({ judged: current.judged + next.judged, accepted: current.accepted + next.accepted }))
  }
  // One read of the open Tickets and of the recent Triggers serves every instance.
  const pending = new Map<string, number>(), exec = new Map<string, { working: number; queued: number; waiting: number }>()
  for (const ticket of store.tickets.open()) {
    const id = ticketInstance(view, ticket)
    if (!id) continue
    pending.set(id, (pending.get(id) ?? 0) + 1)
    const stage = ticketStage(ticket)
    const bucket = stage.stage === 'working' ? stage.action === 'queued' ? 'queued' : 'working'
      : stage.stage === 'idle' ? 'waiting' : undefined
    if (!bucket) continue
    const current = exec.get(id) ?? { working: 0, queued: 0, waiting: 0 }
    current[bucket] += 1
    exec.set(id, current)
  }
  const recent = new Map<string, RecentTrigger[]>()
  for (const trigger of store.read.recentTriggers(0, 200)) {
    const id = instanceOf(sources, trigger.source, hintOf(trigger.meta))
    if (!id) continue
    const rows = recent.get(id) ?? []
    if (rows.length < 4) rows.push({ id: trigger.id, at: trigger.at, actor: view.actor(trigger.actor, trigger.human),
      preview: preview(trigger.text, 120), ...store.triggers.disposition(trigger.id)?.filtered
        ? { filtered: store.triggers.disposition(trigger.id)!.filtered } : {} })
    recent.set(id, rows)
  }
  const filtered = new Map<string, FilteredTrigger[]>()
  for (const trigger of store.read.triggers({ filtered: true }, 0, 200).items) {
    if (trigger.at < since) continue
    const id = instanceOf(sources, trigger.source, hintOf(trigger.meta))
    if (!id) continue
    const rows = filtered.get(id) ?? []
    if (rows.length < 5) rows.push({ id: trigger.id, at: trigger.at, actor: view.actor(trigger.actor, trigger.human),
      preview: preview(trigger.text, 120), reason: store.triggers.disposition(trigger.id)?.filtered })
    filtered.set(id, rows)
  }
  const droppedOf = new Map<string, ReturnType<typeof droppedReplies>>()
  for (const item of droppedReplies(host)) {
    const id = instanceOf(sources, item.channel.source, item.channel.address.row)
    if (id) droppedOf.set(id, [...droppedOf.get(id) ?? [], item])
  }
  const questions = new Map<string, { triggerId: string; thread: string; at: string; preview: string
    candidates: ProjectCandidate[]; proposal?: ProjectProposal }[]>()
  for (const { decision, trigger } of store.read.pendingProjects()) {
    const id = instanceOf(sources, trigger.source, hintOf(trigger.meta))
    const values = needsProjectValues(decision)
    if (!id || !values) continue
    questions.set(id, [...questions.get(id) ?? [], { triggerId: trigger.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
      preview: preview(trigger.text, 120), candidates: values.candidates, ...values.proposal ? { proposal: values.proposal } : {} }])
  }
  return instances.map(instance => {
    const parts = sourceHealth(sources, instance, health).health
    const problem = problemOf(instance.id, setup) ?? problemOf(instance.kind, setup)
    const stats = counted.get(instance.id)
    const flow = judged.get(instance.id)
    return { id: instance.id, kind: instance.kind, ...instance.label ? { label: instance.label } : {},
      title: sourceTitle(sources.kind(instance.kind), instance),
      installed: instance.installed, enabled: instance.enabled,
      state: sourceState(instance, parts, setup, sources.kind(instance.kind)?.placeholder === true), health: parts,
      ...problem ? { problem } : {}, pending: pending.get(instance.id) ?? 0,
      stats24h: { arrived: stats?.arrived ?? 0, filtered: stats?.filtered ?? 0, judged: flow?.judged ?? 0, accepted: flow?.accepted ?? 0 },
      exec: exec.get(instance.id) ?? { working: 0, queued: 0, waiting: 0 },
      pendingProjects: questions.get(instance.id) ?? [], recent: recent.get(instance.id) ?? [],
      filtered: filtered.get(instance.id) ?? [], dropped: droppedOf.get(instance.id) ?? [], lastAt: stats?.lastAt ?? '' }
  })
}
export type SourceStatusView = ReturnType<typeof sourcesStatus>[number]
/** One instance's status plus what its detail page configures and lists: its kind's fields, its Tickets and its Project questions. */
export function sourceDetail(host: ViewHost, id: string, health: HealthMap, setup: SetupState, offset: number, limit: number) {
  const { store, sources } = host
  const settings = store.settings()
  const instance = sources.instances(settings).find(item => item.id === id)
  if (!instance) return undefined
  const row = sourcesStatus(host, health, setup).find(item => item.id === id)!
  const kind = sources.kind(instance.kind)
  return { ...row, value: { enabled: instance.enabled, config: instance.config,
    ...instance.label !== undefined ? { label: instance.label } : {},
    ...instance.reportTo !== undefined ? { reportTo: instance.reportTo } : {} },
    revision: store.blockRevision(`source:${id}`), restarts: SETUP_FIELDS[instance.kind] ?? [],
    description: kind?.description ?? { zh: '', en: '' }, fields: kind?.fields ?? [],
    defaults: kind ? kind.schema.parse({}) : {}, labels: store.get(KV.sources.labels(id)) ?? {},
    deliveryTargets: deliveryTargets(host),
    facts: kind?.facts?.(setup.deployment) ?? {}, ...instance.defaultProjectId ? { defaultProjectId: instance.defaultProjectId } : {},
    tickets: ticketList(host, 'open', offset, limit, id) }
}
export type SourceDetailView = NonNullable<ReturnType<typeof sourceDetail>>
/** Every installed Source kind, with the form fields a new instance of it is configured by. */
export function sourceKinds(sources: SourceRegistry) { return sources.catalog() }
export type SourceKindView = ReturnType<typeof sourceKinds>[number]
/** Replies dropped in the last 24 hours, enriched with their associated ticket and thread. */
export function droppedReplies({ store, links }: Pick<ViewHost, 'store' | 'links'>) {
  // Fetch the exact 24-hour dropped count so this list's length matches the overview's `dropped` metric.
  return store.read.droppedReplies(store.read.droppedSince(dayAgo())).map(item => {
    const ticket = item.ticketId ? store.tickets.get(item.ticketId) : undefined
    const { triggerId } = links(item.channel)
    const home = triggerId ? store.triggers.get(triggerId)?.threads[0] : undefined
    const thread = home ? threadKey(home) : store.threads.get(item.channel.thread) ? item.channel.thread : undefined
    return { id: item.id, kind: item.kind, channel: item.channel, preview: preview(item.text), dropped: item.dropped,
      ...ticket ? { ticket: { id: ticket.id, title: ticket.title } } : {}, ...thread ? { thread } : {} }
  })
}
