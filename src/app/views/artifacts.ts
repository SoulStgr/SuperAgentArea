/**
 * Artifact views: the global index of delivered files, one artifact's page with its delivery and the reverse chain from it
 * back to the Ticket, the Assignment that ran and that Ticket's worker Session, and the file a person downloads.
 */
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { statSync } from 'node:fs'
import { liveTicket, threadKey, ticketStage, WORKSPACE_PROJECT_ID, WORKSPACE_PROJECT_KEY, type ArtifactRecord, type Ticket }
  from '../../core/index.ts'
import { workerSessionId } from '../../executor/dsh.ts'
import type { Localized } from '../../sources/kind.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import type { Store } from '../store.ts'
import { page, snapshot, type ActorView, type ViewHost } from './records.ts'
import { sourceTitle } from './sources.ts'

/** The Project an artifact belongs to: the one its row records, or the built-in workspace for rows saved before Projects existed. */
const artifactProject = (artifact: Pick<ArtifactRecord, 'project'>): string => artifact.project ?? WORKSPACE_PROJECT_ID
/** A file that exists at `path`, with its size; undefined when the path is taken by a directory or nothing. */
function fileAt(path: string): { path: string; size: number } | undefined {
  try {
    const info = statSync(path)
    return info.isFile() ? { path, size: info.size } : undefined
  } catch {
    return undefined
  }
}
/** A file under `root` by its forward-slash artifact name, refusing a name that resolves outside the root or at the root itself. */
function inside(root: string, name: string): string | undefined {
  const base = resolve(root)
  const path = resolve(base, name)
  const rest = relative(base, path)
  return rest && !rest.startsWith('..') && !isAbsolute(rest) ? path : undefined
}
/**
 * The file an artifact names, preferring its Project output directory and falling back to the outbox copy a folder Source
 * received, which is where an artifact indexed before Projects recorded a target still is.
 */
function located(artifact: Pick<ArtifactRecord, 'name' | 'value'>): { path: string; size: number } | undefined {
  for (const root of [artifact.value.targetRoot, artifact.value.deliveredTo]) {
    if (!root) continue
    const path = inside(root, artifact.name)
    const found = path ? fileAt(path) : undefined
    if (found) return found
  }
  return undefined
}
/** Whether an artifact's file can still be read where it was delivered. */
const deliverable = (artifact: Pick<ArtifactRecord, 'name' | 'value'>): boolean => located(artifact) !== undefined
/** The title of the Source instance that delivered an artifact, or its id once no kind provides it any more. */
function sourceRef(sources: SourceRegistry, id: string): { id: string; label: Localized } {
  const instance = sources.instances().find(item => item.id === id)
  return { id, label: instance ? sourceTitle(sources.kind(instance.kind), instance) : { zh: id, en: id } }
}
/** One artifact as the list shows it: its file, the work it belongs to, its content, and whether it is still readable. */
export interface ArtifactRowView {
  id: string
  name: string
  ticket: string
  ticketTitle: string
  project: string
  projectName: string
  source: string
  sourceLabel: Localized
  size: number
  hash: string
  at: string
  targetRoot: string
  deliverable: boolean
}
/** The Projects, Tickets and Source titles the list reads once for every row it shows. */
interface Index {
  projects: Map<string, { id: string; name: string; key: string }>
  tickets: Map<string, Ticket>
  labels: Map<string, Localized>
}
function indexOf(host: Pick<ViewHost, 'store' | 'sources'>, artifacts: readonly ArtifactRecord[]): Index {
  const { store, sources } = host
  const projects = new Map<string, { id: string; name: string; key: string }>()
  const tickets = new Map<string, Ticket>()
  const labels = new Map<string, Localized>()
  for (const artifact of artifacts) {
    const project = artifactProject(artifact)
    const record = store.projects.get(project)
    if (record) projects.set(project, { id: record.id, name: record.value.name, key: record.key })
    const ticket = store.tickets.get(artifact.ticket)
    if (ticket) tickets.set(artifact.ticket, ticket)
    if (!labels.has(artifact.source)) labels.set(artifact.source, sourceRef(sources, artifact.source).label)
  }
  return { projects, tickets, labels }
}
function rowView(index: Index, artifact: ArtifactRecord): ArtifactRowView {
  const project = artifactProject(artifact)
  return { id: artifact.id, name: artifact.name, ticket: artifact.ticket,
    ticketTitle: index.tickets.get(artifact.ticket)?.title ?? artifact.ticket,
    project, projectName: index.projects.get(project)?.name ?? project, source: artifact.source,
    sourceLabel: index.labels.get(artifact.source) ?? { zh: artifact.source, en: artifact.source },
    size: artifact.value.size, hash: artifact.value.hash, at: artifact.at, targetRoot: artifact.value.targetRoot,
    deliverable: deliverable(artifact) }
}
/** The filters the artifact list takes; `q` matches a name or a hash, case-insensitively. */
export interface ArtifactFilter { q?: string; project?: string; source?: string; ticket?: string }
const matches = (artifact: ArtifactRecord, filter: ArtifactFilter): boolean => {
  const project = artifactProject(artifact)
  const projectFilter = filter.project === WORKSPACE_PROJECT_KEY ? WORKSPACE_PROJECT_ID : filter.project
  if (projectFilter && project !== projectFilter) return false
  if (filter.source && artifact.source !== filter.source) return false
  if (filter.ticket && artifact.ticket !== filter.ticket) return false
  if (filter.q) {
    const query = filter.q.toLowerCase()
    if (!artifact.name.toLowerCase().includes(query) && !artifact.value.hash.toLowerCase().includes(query)) return false
  }
  return true
}
/**
 * One page of the artifact index: artifacts newest collection first and then by id, optionally of one Project, Source or
 * Ticket, or matching a name or hash. Every row states whether its file is still readable where it was delivered.
 */
export function artifactList(host: ViewHost, filter: ArtifactFilter, offset: number, limit: number) {
  const artifacts = host.store.artifacts.list().filter(artifact => matches(artifact, filter))
    .sort((one, two) => two.at.localeCompare(one.at) || one.id.localeCompare(two.id))
  const result = page(artifacts, offset, limit)
  const index = indexOf(host, result.items)
  return { ...result, items: result.items.map(artifact => rowView(index, artifact)) }
}
export type ArtifactListView = ReturnType<typeof artifactList>
/** The newest artifacts of the index, as the overview lists them: each file, its Project, and when it was collected. */
export function recentArtifacts(host: Pick<ViewHost, 'store' | 'sources'>, limit: number) {
  const artifacts = host.store.artifacts.list().sort((one, two) => two.at.localeCompare(one.at) || one.id.localeCompare(two.id))
    .slice(0, limit)
  const index = indexOf(host, artifacts)
  return artifacts.map(artifact => {
    const project = artifactProject(artifact)
    return { id: artifact.id, name: artifact.name, project, projectName: index.projects.get(project)?.name ?? project, at: artifact.at }
  })
}
export type RecentArtifactView = ReturnType<typeof recentArtifacts>[number]
/** What one artifact's page says about the Ticket behind it. */
export interface ArtifactTicketView {
  id: string
  title: string
  stage: string
  action?: string
  state: 'open' | 'ended'
  reporter?: ActorView
  mentions?: { source: string; id: string; name?: string }[]
}
/** One delivered file's page: its row, the Project and Source it belongs to, its Ticket and Assignment, its delivery and links. */
export function artifactDetail(host: ViewHost, id: string, assignmentId?: string) {
  const artifact = host.store.artifacts.get(id)
  if (!artifact) return undefined
  const view = snapshot(host)
  const project = artifactProject(artifact)
  const record = host.store.projects.get(project)
  const ticket = host.store.tickets.get(artifact.ticket)
  const stage = ticket ? ticketStage(ticket) : undefined
  const assignment = ticket
    ? (assignmentId ? ticket.assignments.find(item => item.id === assignmentId) : ticket.assignments.at(-1))
    : undefined
  const found = located(artifact)
  // Where the file was meant to land, also when it is gone; an artifact without a root names only its relative path.
  const landing = artifact.value.targetRoot || artifact.value.deliveredTo
  const trigger = ticket ? host.store.triggers.get(ticket.origin.triggerId) : undefined
  const thread = trigger?.threads[0] ? threadKey(trigger.threads[0]) : undefined
  const ticketView: ArtifactTicketView | undefined = ticket && stage ? {
    id: ticket.id, title: ticket.title, stage: stage.stage, ...'action' in stage && stage.action ? { action: stage.action } : {},
    state: liveTicket(ticket) ? 'open' : 'ended', ...ticket.reporter ? { reporter: view.actor(ticket.reporter) } : {},
    ...ticket.mentions?.length ? { mentions: ticket.mentions } : {} } : undefined
  return {
    artifact,
    ...record ? { project: { id: record.id, name: record.value.name, key: record.key } } : {},
    source: sourceRef(host.sources, artifact.source),
    ...ticketView ? { ticket: ticketView } : {},
    ...assignment ? { assignment: { id: assignment.id, state: assignment.state,
      ...assignment.startedAt ? { startedAt: assignment.startedAt } : {}, ...assignment.endedAt ? { endedAt: assignment.endedAt } : {},
      ...assignment.report ? { report: { state: assignment.report.state, summary: assignment.report.summary } } : {} } } : {},
    ...ticket?.assignments.some(item => item.startedAt) ? { workerSessionId: workerSessionId(artifact.ticket) } : {},
    delivery: { path: found?.path ?? (landing ? join(landing, artifact.name) : artifact.name), exists: !!found,
      ...artifact.value.messageId ? { messageId: artifact.value.messageId } : {} },
    // The ids the panel opens these records with; a deep link to them arrives in P6.
    links: { ticket: artifact.ticket, ...thread ? { thread } : {} },
  }
}
export type ArtifactDetailView = NonNullable<ReturnType<typeof artifactDetail>>
/** A file of one artifact, resolved and checked to sit inside the directory the artifact names, for the download route. */
export interface ArtifactFile { readonly path: string; readonly name: string; readonly size: number }
export function artifactFile(store: Pick<Store, 'artifacts'>, id: string): ArtifactFile | undefined {
  const artifact = store.artifacts.get(id)
  const found = artifact ? located(artifact) : undefined
  return artifact && found ? { path: found.path, name: basename(artifact.name), size: found.size } : undefined
}
