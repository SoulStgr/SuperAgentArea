/** Source views: each instance's state, its last day's counts, its execution buckets, recent Triggers, filtered or dropped messages, and unanswered Project questions. */
import { threadKey, ticketStage, type ProjectCandidate, type ProjectProposal, type Reason } from '../../core/index.ts'
import { SETUP_FIELDS } from '../../deployment.ts'
import { KV } from '../../kv.ts'
import type { Deployment } from '../../deployment.ts'
import type { Health } from '../../sources/host.ts'
import type { Localized, SourceInstance } from '../../sources/kind.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import type { SetupProblem } from '../../setup.ts'
import { needsProjectValues } from '../project-service.ts'
import { dayAgo, snapshot, ticketInstance, type ActorView, type ViewHost } from './records.ts'
import { preview } from './text.ts'
import { ticketList } from './tickets.ts'

export type HealthMap = Record<string, Health>
/** A Source instance's display title: its label, its kind's title, or the kind and key for a named instance. */
export function sourceTitle(kind: { title: Localized; kind: string } | undefined, instance: { id: string; label?: string }): Localized {
  if (instance.label) return { zh: instance.label, en: instance.label }
  if (!kind) return { zh: instance.id, en: instance.id }
  if (!instance.id.startsWith(`${kind.kind}:`)) return kind.title
  const key = instance.id.slice(kind.kind.length + 1)
  return { zh: `${kind.title.zh} · ${key}`, en: `${kind.title.en} · ${key}` }
}
/** Resolves health entries for a Source instance, treating stale `sourceOff` entries on an enabled Source as `starting`. */
export function sourceHealth(sources: SourceRegistry, instance: SourceInstance, health: HealthMap) {
  const kind = sources.kind(instance.kind)
  const starting: Health = { state: 'starting', detail: '' }
  const parts = (kind?.health ?? []).map(name => {
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
}
export const problemOf = (id: string, setup: SetupState) => [setup.problem, setup.feishuProblem].find(problem => problem?.place === id)
/** Source lifecycle state in priority order: missing kind, disabled, setup/part error, blocked on global setup, starting, paused, or ready. */
export type SourceState = 'missing' | 'off' | 'error' | 'setup' | 'starting' | 'paused' | 'ready'
function sourceState(instance: SourceInstance & { installed: boolean }, parts: { state: string }[], setup: SetupState): SourceState {
  if (!instance.installed) return 'missing'
  if (!instance.enabled) return 'off'
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
      installed: instance.installed, enabled: instance.enabled, state: sourceState(instance, parts, setup), health: parts,
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
  return { ...row, value: { enabled: instance.enabled, config: instance.config },
    revision: store.blockRevision(`source:${id}`), restarts: SETUP_FIELDS[instance.kind] ?? [],
    description: kind?.description ?? { zh: '', en: '' }, fields: kind?.fields ?? [],
    defaults: kind ? kind.schema.parse({}) : {}, labels: store.get(KV.sources.labels(id)) ?? {},
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
