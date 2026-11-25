/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ProjectLocation, ProjectRecord, ProjectStatus } from '../core/index.ts'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { ArtifactDetailView, ArtifactListView } from './views/artifacts.ts'
import type { OverviewView } from './views/overview.ts'
import type { ProjectDetailView, ProjectListView, ProjectTicketListView } from './views/projects.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceDetailView, SourceKindView, SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
/**
 * A person's answer to a Trigger's Project question: an existing Project, a new one (a station, or one temporary `adhoc`
 * task), or the assessment's proposal confirmed.
 */
export type AnswerProject =
  | { projectId: string }
  | { new: { name: string; location: ProjectLocation; kind?: 'station' | 'adhoc' } }
  | { confirmProposal: true }
/** A Source instance the panel creates: its kind, an optional key that names it, and its kind's single-instance configuration. */
export interface NewSource { kind: string; key?: string; label?: string; config: Record<string, unknown> }
/** What a Source instance's page changes: its switch, label, kind configuration, and default Project. */
export interface SourcePatch { enabled?: boolean; label?: string; config?: Record<string, unknown>; defaultProjectId?: string }
/** The panel's new-workstation form: a name, an address, and the Project kind it makes. */
export interface NewProject { name: string; location: ProjectLocation; kind?: 'station' | 'adhoc' }
/** What a Project's settings page changes; its directories were fixed when it was created. */
export interface ProjectPatch { name?: string; aliases?: string[]; archived?: boolean; sourceIds?: string[] }
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET source-kinds': { response: SourceKindView[] }
  'GET sources': { response: SourceStatusView[] }
  'GET sources/:id': { query?: Paged; response: SourceDetailView }
  'POST sources': { body: NewSource; response: { id: string; revision: number; restarting: boolean } }
  'PATCH sources/:id': { body: SourcePatch; response: { revision: number; restarting: boolean } }
  'GET projects': { query?: { status?: ProjectStatus }; response: ProjectListView }
  'GET projects/:id': { response: ProjectDetailView }
  'GET projects/:id/tickets': { query?: Paged & { state?: TicketFilter }; response: ProjectTicketListView }
  'GET projects/:id/threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET projects/:id/decisions': { query?: Paged; response: DecisionListView }
  'POST projects': { body: NewProject; response: { project: ProjectRecord } }
  'PATCH projects/:id': { body: ProjectPatch; response: { project: ProjectRecord } }
  'GET artifacts': { query?: Paged & { q?: string; project?: string; source?: string; ticket?: string }; response: ArtifactListView }
  'GET artifacts/:id': { query?: { assignment?: string }; response: ArtifactDetailView }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'POST triggers/:id/answer-project': { body: AnswerProject; response: { resolved: string } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter; source?: string }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
