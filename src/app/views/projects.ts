/**
 * Project (workstation) views: every Project as a card with its Open Tickets, artifacts, Sources and latest activity, and
 * one Project's page with the first page of each of its sections. A Project's Threads are the ones its Tickets came from,
 * the ones they follow, and the ones a person answered a Project question on; its Decisions are those Threads' Decisions.
 */
import { isWorkspaceProject, liveTicket, threadKey, ticketStage, WORKSPACE_PROJECT_ID, type ArtifactRecord, type Decision,
  type ProjectRecord, type ProjectStatus, type Ticket, type Trigger } from '../../core/index.ts'
import { KV } from '../../kv.ts'
import type { Localized } from '../../sources/kind.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import type { Store } from '../store.ts'
import type { ThreadFilter, TicketFilter } from '../api.ts'
import { artifactProject } from './artifacts.ts'
import { decisionView, newestFirst, page, snapshot, ticketInstance, type ActorView, type Snapshot, type ViewHost } from './records.ts'
import { sourceTitle, sourcesStatus, type HealthMap, type SetupState, type SourceState } from './sources.ts'
import { preview } from './text.ts'
import { threadList } from './threads.ts'
import { ticketRow } from './tickets.ts'

/** How many rows of each section a Project's page carries before its paged endpoints continue them. */
export const PROJECT_PAGE = 8
/** The Project a Ticket belongs to: the one it records, or the built-in workspace for Tickets saved before Projects existed. */
const ticketProject = (ticket: Ticket): string => ticket.projectId ?? WORKSPACE_PROJECT_ID
/** The Source instances behind a Project: its own `sourceIds`, or the ones its Tickets came from when it names none. */
export function projectSourceIds(host: Pick<ViewHost, 'store' | 'sources'>, project: ProjectRecord,
  tickets: readonly Ticket[]): string[] {
  if (project.value.sourceIds.length) return [...project.value.sourceIds]
  const derived = new Set<string>()
  for (const ticket of tickets) {
    const instance = ticketInstance(host, ticket)
    if (instance) derived.add(instance)
  }
  return [...derived]
}
/** A Source a Project names, by the title its kind and instance give it. */
export interface ProjectSourceRef { id: string; title: Localized }
/** A Source on a Project's page: whether the Project names it, and the state and latest Trigger the Source page reports. */
export interface ProjectSourceRow extends ProjectSourceRef { installed: boolean; state: SourceState; lastAt: string; linked: boolean }
/** The title of one configured Source instance, or its id once no kind provides it any more. */
function sourceTitleOf(sources: SourceRegistry, id: string): Localized {
  const instance = sources.instances().find(item => item.id === id)
  return instance ? sourceTitle(sources.kind(instance.kind), instance) : { zh: id, en: id }
}
/** One Project as the workstation cards list it. */
export interface ProjectRowView {
  id: string; key: string; name: string; kind: ProjectRecord['value']['kind']
  location: ProjectRecord['value']['location']; status: ProjectStatus
  archivedAt?: string; openTickets: number; tickets: number; artifacts: number
  sources: ProjectSourceRef[]; lastActivity: string; reporter?: ActorView
}
/** The work of one Project: its Tickets, and the Threads those Tickets came from, follow, or had answered into it. */
function projectWork(store: Store, projectId: string) {
  const tickets = store.tickets.list().filter(ticket => ticketProject(ticket) === projectId)
  const keys = new Set<string>()
  for (const ticket of tickets) {
    for (const id of ticket.origin.triggerIds) {
      const trigger = store.triggers.get(id)
      for (const ref of trigger?.threads ?? []) keys.add(threadKey(ref))
    }
    for (const follow of ticket.follows ?? []) keys.add(follow.thread)
  }
  // A Thread answered with this Project keeps its work here, even before its next Eval creates a Ticket.
  const prefix = KV.projects.answers.prefix
  for (const key of store.keys(prefix)) if (store.get<string>(key) === projectId) keys.add(key.slice(prefix.length))
  return { tickets, keys }
}
/** A Project's Decisions, newest first: the Decisions of the Threads its work belongs to. */
function projectDecisions(store: Store, keys: ReadonlySet<string>): Decision[] {
  const found = [...keys].flatMap(key => store.decisions.byThread(key))
  return found.sort((one, two) => two.at.localeCompare(one.at) || two.id.localeCompare(one.id))
}
/** The latest Triggers on a Project's Threads, newest first, as the Project page summarizes them. */
function projectRecentTriggers(store: Store, view: Snapshot, keys: ReadonlySet<string>, limit: number) {
  const found = new Map<string, Trigger>()
  for (const key of keys) for (const trigger of store.read.threadTriggers(key, limit)) found.set(trigger.id, trigger)
  return [...found.values()].sort((one, two) => two.at.localeCompare(one.at)).slice(0, limit).map(trigger => ({
    id: trigger.id, at: trigger.at, actor: view.actor(trigger.actor, trigger.human),
    preview: preview(trigger.text), thread: threadKey(trigger.threads[0]!), ...trigger.url ? { url: trigger.url } : {} }))
}
/** The latest moment of a Project's work: its newest Ticket or artifact. */
const lastActivityOf = (tickets: readonly Ticket[], artifacts: readonly ArtifactRecord[]): string =>
  [...tickets.map(ticket => ticket.updatedAt), ...artifacts.map(artifact => artifact.at)]
    .reduce((latest, at) => at > latest ? at : latest, '')
/** The Project card's reporter: the one who reported its most recently changed Ticket that names one. */
function reporterOf(view: Snapshot, tickets: readonly Ticket[]): ActorView | undefined {
  const latest = tickets.slice().sort(newestFirst).find(ticket => ticket.reporter)
  return latest?.reporter ? view.actor(latest.reporter) : undefined
}
/** The row of one Project, from the Tickets and artifacts read for the whole list. */
function projectRow(host: ViewHost, view: Snapshot, project: ProjectRecord, tickets: readonly Ticket[],
  artifacts: readonly ArtifactRecord[]): ProjectRowView {
  const reporter = reporterOf(view, tickets)
  return { id: project.id, key: project.key, name: project.value.name, kind: project.value.kind,
    location: project.value.location, status: project.status, ...project.value.archivedAt ? { archivedAt: project.value.archivedAt } : {},
    openTickets: tickets.filter(liveTicket).length, tickets: tickets.length, artifacts: artifacts.length,
    sources: projectSourceIds(host, project, tickets).map(id => ({ id, title: sourceTitleOf(host.sources, id) })),
    lastActivity: lastActivityOf(tickets, artifacts), ...reporter ? { reporter } : {} }
}
/**
 * Every Project's card, the built-in workspace first and the others by their latest change: the active ones by default,
 * or the archived ones. One read of the Tickets and artifacts serves every card.
 */
export function projectList(host: ViewHost, status: ProjectStatus = 'active') {
  const view = snapshot(host)
  const { store } = host
  const ticketsOf = new Map<string, Ticket[]>(), artifactsOf = new Map<string, ArtifactRecord[]>()
  for (const ticket of store.tickets.list()) {
    const id = ticketProject(ticket)
    ticketsOf.set(id, [...ticketsOf.get(id) ?? [], ticket])
  }
  for (const artifact of store.artifacts.list()) {
    if (artifact.project) artifactsOf.set(artifact.project, [...artifactsOf.get(artifact.project) ?? [], artifact])
  }
  return store.projects.list(status).sort((one, two) => Number(isWorkspaceProject(two)) - Number(isWorkspaceProject(one)))
    .map(project => projectRow(host, view, project, ticketsOf.get(project.id) ?? [], artifactsOf.get(project.id) ?? []))
}
export type ProjectListView = ReturnType<typeof projectList>
/** The Tickets of one Project, by stage: paged, with each row as the Ticket lists show it. */
export function projectTicketList(host: ViewHost, projectId: string, state: TicketFilter | undefined, offset: number,
  limit: number) {
  return ticketPage(host, projectWork(host.store, projectId).tickets, state, offset, limit)
}
function ticketPage(host: ViewHost, tickets: readonly Ticket[], state: TicketFilter | undefined, offset: number, limit: number) {
  const view = snapshot(host)
  const shown = tickets.filter(ticket => state === undefined ? true : state === 'open' ? liveTicket(ticket)
    : state === 'ended' ? !liveTicket(ticket) : ticketStage(ticket).stage === state)
  const result = page([...shown].sort(newestFirst), offset, limit)
  return { ...result, items: result.items.map(ticket => ticketRow(view, ticket)) }
}
export type ProjectTicketListView = ReturnType<typeof projectTicketList>
/** The Threads of one Project, by filter, page by page. */
export function projectThreadList(host: ViewHost, projectId: string, filter: ThreadFilter, offset: number, limit: number) {
  return threadList(host, filter, offset, limit, projectWork(host.store, projectId).keys)
}
export type ProjectThreadListView = ReturnType<typeof projectThreadList>
/** The Decisions of one Project's Threads, newest first. */
export function projectDecisionList(host: ViewHost, projectId: string, offset: number, limit: number) {
  return decisionPage(host, projectDecisions(host.store, projectWork(host.store, projectId).keys), offset, limit)
}
function decisionPage(host: ViewHost, decisions: readonly Decision[], offset: number, limit: number) {
  const view = snapshot(host)
  const result = page([...decisions], offset, limit)
  return { items: result.items.map(decision => decisionView(view, decision)), next_offset: result.next_offset }
}
export type ProjectDecisionListView = ReturnType<typeof projectDecisionList>
/** One Project's page: its record, its section counts, its Sources with their states, and the first page of each section. */
export function projectDetail(host: ViewHost, id: string, health: HealthMap, setup: SetupState) {
  const project = host.store.projects.get(id)
  if (!project) return undefined
  const view = snapshot(host)
  const { tickets, keys } = projectWork(host.store, id)
  const artifacts = host.store.artifacts.list({ project: id })
  const linked = new Set(projectSourceIds(host, project, tickets))
  const statuses = new Map(sourcesStatus(host, health, setup).map(source => [source.id, source]))
  // Every configured Source is listed, so the page links and unlinks any of them; one a Project still names after its kind went
  // away is listed as not installed rather than dropped.
  const sources: ProjectSourceRow[] = [...statuses.values()].map(source => ({ id: source.id, title: source.title,
    installed: source.installed, state: source.state, lastAt: source.lastAt, linked: linked.has(source.id) }))
  for (const source of linked) if (!statuses.has(source)) sources.push({ id: source, title: sourceTitleOf(host.sources, source),
    installed: false, state: 'missing', lastAt: '', linked: true })
  const decisions = projectDecisions(host.store, keys)
  const threads = threadList(host, 'all', 0, PROJECT_PAGE, keys)
  return { project, counts: { openTickets: tickets.filter(liveTicket).length, tickets: tickets.length, threads: threads.total,
    decisions: decisions.length, artifacts: artifacts.length }, sources,
    tickets: ticketPage(host, tickets, undefined, 0, PROJECT_PAGE), threads,
    decisions: decisionPage(host, decisions, 0, PROJECT_PAGE),
    artifacts: artifacts.slice(0, PROJECT_PAGE).map(artifact => ({ id: artifact.id, name: artifact.name, size: artifact.value.size,
      at: artifact.at, ticket: artifact.ticket, source: artifact.source, targetRoot: artifact.value.targetRoot })),
    recentTriggers: projectRecentTriggers(host.store, view, keys, PROJECT_PAGE) }
}
export type ProjectDetailView = NonNullable<ReturnType<typeof projectDetail>>
/** How many rows of each list a Project's history carries by default; the agent section shows them without paging. */
export const PROJECT_HISTORY = 50
/**
 * One Project's agent history, newest first: its Tickets, the artifacts delivered for it, and its Assignment reports. A
 * Ticket or artifact saved before Projects existed belongs to the built-in workspace, so it never appears in another
 * station's history. Every list stops at `limit`.
 */
export function projectHistory(host: ViewHost, projectId: string, limit = PROJECT_HISTORY) {
  const project = host.store.projects.get(projectId)
  if (!project) return undefined
  const view = snapshot(host)
  const tickets = host.store.tickets.list().filter(ticket => ticketProject(ticket) === projectId)
    .sort((one, two) => two.updatedAt.localeCompare(one.updatedAt) || one.id.localeCompare(two.id))
  const artifacts = host.store.artifacts.list().filter(artifact => artifactProject(artifact) === projectId)
    .sort((one, two) => two.at.localeCompare(one.at) || one.id.localeCompare(two.id))
  const delivered = new Map<string, number>()
  for (const artifact of artifacts) delivered.set(artifact.ticket, (delivered.get(artifact.ticket) ?? 0) + 1)
  const titles = new Map(tickets.map(ticket => [ticket.id, ticket.title]))
  const reports = tickets.flatMap(ticket => ticket.assignments.flatMap(assignment => assignment.report
    ? [{ ticketId: ticket.id, ticketTitle: ticket.title, assignmentId: assignment.id, state: assignment.report.state,
      summary: assignment.report.summary, at: assignment.report.at }]
    : [])).sort((one, two) => two.at.localeCompare(one.at) || one.ticketId.localeCompare(two.ticketId)
    || one.assignmentId.localeCompare(two.assignmentId))
  return {
    project: { id: project.id, name: project.value.name, key: project.key },
    // The stage and its action are what the panel words a Ticket's mark by; the ended outcome says how it ended.
    tickets: tickets.slice(0, limit).map(ticket => {
      const stage = ticketStage(ticket)
      return { id: ticket.id, title: ticket.title, stage: stage.stage, action: 'action' in stage ? stage.action : undefined,
        state: liveTicket(ticket) ? 'open' as const : 'ended' as const,
        ...ticket.ended ? { ended: { at: ticket.ended.at, outcome: ticket.ended.outcome } } : {},
        ...ticket.reporter ? { reporter: view.actor(ticket.reporter) } : {},
        assignments: ticket.assignments.length, artifacts: delivered.get(ticket.id) ?? 0, updatedAt: ticket.updatedAt }
    }),
    artifacts: artifacts.slice(0, limit).map(artifact => ({ id: artifact.id, name: artifact.name, ticket: artifact.ticket,
      ticketTitle: titles.get(artifact.ticket) ?? artifact.ticket, at: artifact.at, size: artifact.value.size,
      hash: artifact.value.hash })),
    reports: reports.slice(0, limit),
  }
}
export type ProjectHistoryView = NonNullable<ReturnType<typeof projectHistory>>
