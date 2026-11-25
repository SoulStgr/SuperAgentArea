/**
 * Typed fake management API server for panel tests. Implements every route in `src/app/api.ts` and records any
 * undeclared query parameter or body mismatch in `server.misuse`, which `usePanelServer` asserts is empty after each test.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { z } from 'zod'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Api, ApiResponse, RouteParams, SourcePromptsView } from '../../src/app/api.ts'
import { SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInPart, builtInParts, composePrompt, composeSkill, defaultPrompts,
  environmentSection, policySection, promptParts, type PromptConfig } from '../../src/app/prompts.ts'
import { bundledSkillNames, bundledSkills } from '../../src/app/skill-files.ts'
import type { DecisionRow, DroppedReply, HistoryView, Problem, ProjectDetailView, ProjectHistoryView, ProjectRow, PromptsView, SetupView,
  SourceDetailView, SourceStatusRow, SourceView, StateView,
  ThreadPageView,
  ThreadRow, TicketPageView,
  TicketRow, TicketStage,
  TriggerRow,
  ArtifactDetailView, ArtifactRow } from '../../src/client/api.ts'
import { SETUP_FIELDS } from '../../src/deployment.ts'
import { AdmissionTableSchema, EvalConfigSchema, ExecutorConfigSchema, PolicyConfigSchema, RuleArraySchema, SettingsSchema }
  from '../../src/policy.ts'
import { SetupError, type SetupCode } from '../../src/setup.ts'
import { feishuChannel } from '../../src/sources/feishu-trigger.ts'
import { githubChannel } from '../../src/sources/github-trigger.ts'
import { feishuKind } from '../../src/sources/feishu.ts'
import { folderKind } from '../../src/sources/folder.ts'
import { githubKind } from '../../src/sources/github.ts'
import type { Health } from '../../src/sources/host.ts'
import type { SourceKind } from '../../src/sources/kind.ts'
import { testDeployment } from './deployment.ts'

export const MEMBER = 'ou_alice'
const ALLOWED: Record<string, { id: string; name?: string }[]> = { feishu: [{ id: MEMBER, name: 'Alice' }], github: [{ id: 'alice' }] }
type Actor = TriggerRow['actor']
/** Resolve an actor display label using the fixture policy's allowed list or the source kind's unnamed fallback. */
export function actor(source: string, id: string, human = true): Actor {
  if (!id) return { source, id }
  const entry = ALLOWED[source]?.find(item => item.id.toLowerCase() === id.toLowerCase())
  const unnamed = source === 'feishu' ? feishuKind.policy?.unnamed : undefined
  const name = entry ? entry.name || entry.id : unnamed ? undefined : id
  return { source, id, name: name ? { zh: name, en: name } : human ? unnamed!.person : unnamed!.bot }
}
type TicketFields = Omit<TicketRow, 'stage' | 'action'>
const TICKET = {
  id: 't1', title: '修复回归', state: 'open', actions: { retry: false, stop: true }, strength: 'explicit', ended: undefined,
  attention: undefined, assignments: 1, inputs: 2, undelivered: 0, deliveryError: undefined, sessionId: 'worker-t1', directory: '/w/t1',
  summary: 'working on it', createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z',
  threads: [{ key: 'github:42', source: 'github', title: '#42 Fix login', url: 'https://github.com/acme/widgets/pull/42',
    facts: { number: { value: '#42' }, ci: { label: { zh: 'CI 失败', en: 'CI failed' }, value: '1', problem: true } } }],
} satisfies TicketFields
export const ticketSummary = (fields: Partial<TicketFields> = {}, stage: TicketStage = { stage: 'working' }): TicketRow =>
  ({ ...TICKET, ...fields, ...stage })
export const threadSummary = (fields: Partial<ThreadRow> = {}): ThreadRow => ({
  key: 'feishu:oc_1:om_root', source: 'feishu', title: '这个文案好奇怪', stage: 'subscribed', latest: undefined, lastAt: '2026-09-23T00:00:00Z',
  createdAt: '2026-09-22T00:00:00Z', subscriptions: 1, tickets: [{ id: 't1', title: '修复回归', state: 'open' }], evaluating: undefined,
  pending: 0, pollError: undefined, url: undefined, facts: { chat: { value: '团队群' } }, ...fields,
})
type TriggerFields = Partial<Omit<TriggerRow, 'disposition' | 'actions'>> & { disposition?: Partial<TriggerRow['disposition']> }
/** Build a trigger row on the default thread and compute `actions.requeue` using the host's eligibility rules. */
export function trigger(id: string, at: string, { disposition, ...fields }: TriggerFields = {}): TriggerRow {
  const row = { id, source: 'feishu', actor: actor('feishu', MEMBER), human: true, at, text: `message ${id}`, preview: `message ${id}`,
    url: undefined, threads: ['feishu:oc_1:om_root'], ...fields,
    disposition: { queued: false, evaluating: false, delivered: false, filtered: undefined, fanout: [], handbacks: [], decision: undefined,
      ...disposition } }
  return { ...row, actions: { requeue: requeueable(row) } }
}
const requeueable = ({ human, disposition: d }: Pick<TriggerRow, 'human' | 'disposition'>) => human && !d.queued && !d.evaluating
  && (!!d.filtered || d.decision?.outcome === 'unavailable' || d.delivered || (d.fanout.length > 0 && !d.decision))
type SearchItem = ApiResponse<'GET search'>['items'][number]
export function found(id: string, at: string, { threadTitle, filtered,
  ...fields }: TriggerFields & { threadTitle?: string; filtered?: string } = {}): SearchItem {
  const { text: _text, ...result } = trigger(id, at, fields)
  return filtered === undefined ? { ...result, threadTitle } : { ...result, threadTitle: undefined, filtered }
}
export const promptVersion = (revision: number, config: PromptsView['current']['config']): PromptsView['current'] =>
  ({ revision, previousRevision: revision ? revision - 1 : null, savedAt: '', source: 'panel', config })
/** One Source instance's own prompt chain, once it saves one: the revision it is at, its version and page of history. */
export interface PromptScope {
  revision: number
  current: PromptsView['current']
  revisions: PromptsView['revisions']
  next_offset: number | null
}
/** A delivered artifact as the 产物 list shows it; a test overrides the file, its work or whether it is still readable. */
export function artifactRow(fields: Partial<ArtifactRow> = {}): ArtifactRow {
  return { id: 'a1', name: 'report.md', ticket: 't1', ticketTitle: '修复回归', project: 'prj_aps', projectName: 'aps',
    source: 'feishu', sourceLabel: feishuKind.title, size: 120, hash: 'abcdef0123456789', at: '2026-09-23T00:00:00Z',
    targetRoot: '/srv/aps', deliverable: true, ...fields }
}
/** One artifact's page: its row, Project, Source, Ticket, Assignment, worker Session, delivery and links. */
export function artifactDetail(fields: Partial<ArtifactDetailView> = {}): ArtifactDetailView {
  const at = '2026-09-23T00:00:00Z'
  return { artifact: { id: 'a1', ticket: 't1', project: 'prj_aps', source: 'feishu', name: 'report.md',
      value: { hash: 'abcdef0123456789', size: 120, at, targetRoot: '/srv/aps', messageId: 'reply-a1' }, at },
    project: { id: 'prj_aps', name: 'aps', key: 'aps' }, source: { id: 'feishu', label: feishuKind.title },
    ticket: { id: 't1', title: '修复回归', stage: 'working', state: 'open', reporter: actor('feishu', MEMBER) },
    assignment: { id: 'a1', state: 'running', startedAt: '2026-09-22T00:01:00Z',
      report: { state: 'progress', summary: 'working' } },
    workerSessionId: 'worker-t1', delivery: { path: '/srv/aps/report.md', exists: true, messageId: 'reply-a1' },
    links: { ticket: 't1', thread: 'feishu:oc_1:om_root' }, ...fields }
}
/** Build a dropped outbound reply fixture (`feishu` replies to `oc_1`/`om_root`; `github` comments on PR #42). */
export const droppedReply = (id: string, hoursAgo: number, source: 'feishu' | 'github', reason: DroppedReply['dropped']['reason'],
  { ticket, thread }: { ticket?: DroppedReply['ticket']; thread?: false } = {}): DroppedReply => ({
  id, preview: `Reply ${id}`, kind: 'reply',
  channel: source === 'feishu' ? feishuChannel('oc_1', 'om_root') : githubChannel(42),
  dropped: { at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), reason }, ...ticket ? { ticket } : {},
  ...thread === false ? {} : { thread: source === 'feishu' ? 'feishu:oc_1:om_root' : 'github:42' },
})
const dayAgo = () => new Date(Date.now() - 86_400_000).toISOString()
export const problemOf = (code: SetupCode, values: Record<string, string> = {}) => new SetupError(code, values).problem
/** A workstation as the fake host keeps it: its row, and the Tickets, Threads, Decisions and artifacts its page serves. */
export interface ProjectFixture {
  id: string; key: string; name: string; kind: ProjectRow['kind']; location: ProjectRow['location']
  status: ProjectRow['status']; sourceIds: string[]; aliases: string[]; outputDir: string; scratchDir: string; rulesDir: string
  createdAt: string; updatedAt: string; archivedAt?: string
  /** The per-section rows of its page; the workspace defaults to the fake server's open and person Tickets and its Threads. */
  tickets?: string[]; threads?: string[]; decisions?: DecisionRow[]
  /** The artifacts its page lists; the history also states each file's hash, which the page's rows do not carry. */
  artifacts?: (ProjectDetailView['artifacts'][number] & { hash?: string })[]; reporter?: Actor
}
/** The key a Project's name gives it, as the host's `projectKey` does. */
const projectKeyOf = (name: string): string => name.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  .slice(0, 60) || 'station'
// The kinds' configurations differ, and the fake reads them only as the records the views carry.
const KINDS = [feishuKind, githubKind, folderKind] as unknown as SourceKind[]
export const MACHINE = { stateDir: '/srv/dsh-superagent', promptMaxChars: 100000, admissionContextMaxPages: 10,
  admissionContextTimeoutMs: 15000 }

type Settings = ReturnType<typeof SettingsSchema.parse>
export interface PanelServer {
  joined?: Record<string, string>; joining?: Record<string, string>
  joinError?: string
  settings: Settings; revisions: Record<string, number>
  prompts: PromptsView
  /** Each Source instance's own prompt chain, by instance id; an instance with none inherits `prompts`. */
  promptScopes: Record<string, PromptScope>
  tickets: { open: TicketRow[]; ended: TicketRow[] }; ticketDetails: Record<string, TicketPageView>
  threads: ThreadRow[]
  threadPages: (key: string, query: { before?: string; around?: string }) => ThreadPageView | undefined
  person: TicketRow[]; search: Pick<ApiResponse<'GET search'>, 'items' | 'threads'>; history: HistoryView
  requests: { path: string; method: string; body?: unknown }[]
  /** Requests with undeclared query params or invalid body presence; asserted empty after each test. */
  misuse: string[]
  queued: Set<string>
  /** Trigger ids that wait for a Project answer, as the Source status reports their `pendingProjects`. */
  projectQuestions: Set<string>
  /** The workstations the fake host keeps, in the order its page lists them. */
  projects: ProjectFixture[]
  /** Each Source instance's Project questions, by instance id. */
  pendingProjects: Record<string, SourceStatusRow['pendingProjects']>
  /** Each Source instance's last-day counts and pending Tickets, by instance id. */
  sourceStats: Record<string, SourceStatusRow['stats24h']>
  sourcePending: Record<string, number>
  sourceExec: Record<string, SourceStatusRow['exec']>
  /** The Source instance each Ticket came from, by Ticket id. */
  ticketSources: Record<string, string>
  searching?: (query: string) => Promise<void>
  setup: SetupView
  health: Record<string, Health>
  /** When true, all API requests return an empty 404 to simulate the host plugin being stopped. */
  down: boolean
  /** Count of responses not yet consumed by the client. */
  pending: number
  form?: ConfigForm<Record<string, unknown>> | undefined
  opened: string[]
  /** Session ids the fake host holds, which creating again refuses, and the ids its client catalog lists. */
  hostSessions: Set<string>
  sessions: Set<string>
  /** The Project Sessions the panel asked to create, in order. */
  created: { sessionId: string; cwd: string }[]
  dropped: DroppedReply[]
  failing: Extract<Problem, { kind: 'outgoing' }>['outgoing'][]
  /** The delivered artifacts the 产物 pages list, the page served for one of them, and the file each download answers with. */
  artifacts: ArtifactRow[]
  artifactDetails: Record<string, ArtifactDetailView>
  artifactFiles: Record<string, { name: string; body: string }>
  /** The artifact ids the panel downloaded, in order. */
  downloads: string[]
}
export let server: PanelServer

function resolved() {
  const accounts = server.setup.accounts
  if (!accounts) return undefined
  // An installation whose GitHub Source names no repository resolves no GitHub account.
  return testDeployment({ repository: accounts.repository,
    ...(accounts.agent ? { github: { cli: '/bin/false', login: accounts.agent, noreply: '' } } : { github: undefined }),
    ...accounts.feishu ? { feishu: { cli: '/bin/false', ...accounts.feishu } } : { feishu: undefined } })
}
/** Default source health: paused during setup; Feishu defaults to `socket closed` unless overridden or paused by setup. */
function healthOf(name: string): Health {
  if (server.setup.problem) return { state: 'paused', detail: 'Waiting for setup', code: 'setupPending' }
  if (server.health[name]) return server.health[name]
  if (name !== 'feishu') return { state: 'ready', detail: '' }
  return server.setup.feishuProblem ? { state: 'paused', detail: server.setup.feishuProblem.detail } : { state: 'error',
    detail: 'socket closed' }
}
const problemOf_ = (id: string) => server.setup.problems?.[id]
  ?? [server.setup.problem, server.setup.feishuProblem].find(item => item?.place === id) ?? undefined
/** The fixture's configured instances, in the panel's order: kind order, then instance id order. */
function instancesOf(): { id: string; kind: string; enabled: boolean; config: Record<string, unknown>; label?: string }[] {
  const order = KINDS.map(kind => kind.kind)
  return Object.entries(server.settings.sources).filter(([, instance]) => order.includes(instance.kind))
    .sort(([a, one], [b, two]) => order.indexOf(one.kind) - order.indexOf(two.kind) || a.localeCompare(b))
    .map(([id, instance]) => ({ id, kind: instance.kind, enabled: instance.enabled, config: instance.config,
      ...instance.label ? { label: instance.label } : {} }))
}
function sourceSettings(): SourceView[] {
  const instances = instancesOf()
  return instances.map(instance => {
    const kind = KINDS.find(item => item.kind === instance.kind)!
    const config = kind.schema.parse(instance.config)
    const problem = problemOf_(instance.id) ?? problemOf_(kind.kind)
    // What the instance saved of its own Policy, if anything: its kind's fields, its admission table and its own rules.
    const stored = server.settings.policy.sources[instance.id] ?? { allowed: [], admission: {} }
    const { admission: _admission, rules: _rules, ...storedFields } = stored
    const parsed = kind.policy ? kind.policy.schema.safeParse(storedFields) : undefined
    const part = { ...parsed?.success ? parsed.data : {}, admission: _admission ?? {},
      ...stored.rules === undefined ? {} : { rules: stored.rules } }
    const sync = kind.policy?.sync && { label: kind.policy.sync.label, ready: kind.policy.sync.ready(kind.policy.schema.parse(storedFields)),
      health: server.health[`sync:${instance.id}`] }
    const policy = kind.policy && { fields: kind.policy.fields, explicit: kind.policy.explicit, ...kind.policy.rows
      ? { rows: kind.policy.rows(config, instance.id) } : {}, ...sync ? { sync } : {},
      revision: server.revisions[`policy:${instance.id}`] ?? 0, rules: stored.rules ?? server.settings.policy.rules,
      inherited: stored.rules === undefined, value: part }
    const title = instance.label ? { zh: instance.label, en: instance.label }
      : instance.id.startsWith(`${kind.kind}:`) ? { zh: `${kind.title.zh} · ${instance.id.slice(kind.kind.length + 1)}`,
        en: `${kind.title.en} · ${instance.id.slice(kind.kind.length + 1)}` }
        : kind.title
    return { id: instance.id, kind: instance.kind, title, description: kind.description, installed: true,
      value: { enabled: instance.enabled, config }, revision: server.revisions[`source:${instance.id}`] ?? 0,
      restarts: SETUP_FIELDS[kind.kind] ?? [], fields: kind.fields, facts: kind.facts?.(resolved()) ?? {},
      labels: kind.kind === 'feishu' ? { oc_team: '团队群', oc_other: '另一个群', ...server.joined } : {}, ...problem ? { problem } : {},
      ...policy ? { policy: policy as unknown as NonNullable<SourceView['policy']> } : {} }
  })
}
function sourceStatuses(): SourceStatusRow[] {
  const instances = instancesOf()
  return instances.map(instance => {
    const kind = KINDS.find(item => item.kind === instance.kind)!
    const enabled = instance.enabled
    // Each instance has its own entry, named by its id; the kind's other entries are shared.
    const health = [instance.id, ...kind.health.filter(name => name !== kind.kind)].map(name => ({ name, ...healthOf(name) }))
    const problem = problemOf_(instance.id) ?? problemOf_(kind.kind)
    const state = !enabled ? 'off' : problem || health.some(item => item.state === 'error') ? 'error' : server.setup.problem ? 'setup'
      : health.some(item => item.state === 'starting') ? 'starting' : health.some(item => item.state === 'paused') ? 'paused' : 'ready'
    const title = instance.label ? { zh: instance.label, en: instance.label }
      : instance.id.startsWith(`${kind.kind}:`) ? { zh: `${kind.title.zh} · ${instance.id.slice(kind.kind.length + 1)}`,
        en: `${kind.title.en} · ${instance.id.slice(kind.kind.length + 1)}` }
        : kind.title
    return { id: instance.id, kind: instance.kind, ...instance.label ? { label: instance.label } : {}, title, installed: true, enabled, state, health,
      ...problem ? { problem } : {},
      pending: server.sourcePending[instance.id] ?? 0,
      stats24h: server.sourceStats[instance.id] ?? { arrived: 0, filtered: 0, judged: 0, accepted: 0 },
      exec: server.sourceExec[instance.id] ?? { working: 0, queued: 0, waiting: 0 },
      pendingProjects: server.pendingProjects[instance.id] ?? [],
      recent: instance.kind === 'feishu' ? [{ id: 'e3', at: '2026-09-23T00:00:00Z', actor: actor('feishu', MEMBER),
        preview: '这个文案好奇怪' }] : [],
      filtered: instance.kind === 'feishu' ? [] : [{ id: 'e9', at: '2026-09-23T00:02:00Z', actor: actor('github', 'someone'),
        preview: 'looks wrong', reason: { code: 'source_disabled' } }],
      dropped: server.dropped.filter(item => item.channel.source === instance.id && item.dropped.at >= dayAgo()),
      lastAt: (server.sourceStats[instance.id] ?? { arrived: 0 }).arrived > 0 ? '2026-09-23T00:00:00Z' : '' }
  })
}
/** One instance's page as the fake host builds it: the same status plus its form, and the Tickets that instance originated. */
function sourceDetailOf(id: string): SourceDetailView | undefined {
  const status = sourceStatuses().find(source => source.id === id)
  const instance = instancesOf().find(item => item.id === id)
  if (!status || !instance) return undefined
  const kind = KINDS.find(item => item.kind === instance.kind)!
  const config = kind.schema.parse(instance.config)
  const tickets = [...server.tickets.open, ...server.person]
    .filter(ticket => (server.ticketSources[ticket.id] ?? 'feishu') === id)
    .filter((ticket, index, list) => list.findIndex(item => item.id === ticket.id) === index)
  return { ...status, value: { enabled: instance.enabled, config }, revision: server.revisions[`source:${id}`] ?? 0,
    restarts: SETUP_FIELDS[kind.kind] ?? [], description: kind.description, fields: kind.fields, defaults: kind.schema.parse({}),
    labels: kind.kind === 'feishu' ? { oc_team: '团队群', oc_other: '另一个群', ...server.joined } : {},
    facts: kind.facts?.(resolved()) ?? {}, tickets: page(tickets) }
}
/** The bundled skills a scope registers by default: its Source instance's kind, or every configured kind's for the installation. */
function defaultSkillsOf(scope?: string): { name: string; description: string }[] {
  const kinds = scope === undefined ? new Set(instancesOf().map(instance => instance.kind))
    : new Set([instancesOf().find(instance => instance.id === scope)?.kind ?? scope.split(':')[0]!])
  return [...kinds].flatMap(kind => {
    const bundled = bundledSkills[kind]
    return bundled ? [{ name: bundled.name, description: bundled.description }] : []
  })
}
/** The view of one scope's prompts: the installation's, or a Source instance's own chain (inherited until it saves one). */
function promptsViewOf(scope?: string): PromptsView {
  const base = server.prompts
  const own = scope === undefined ? undefined : server.promptScopes[scope]
  const current = own ? own.current : scope === undefined ? base.current : { ...base.current, source: 'inherited' }
  return { masterId: base.masterId, ...scope === undefined ? {} : { source: scope }, current, defaults: base.defaults, sections: base.sections,
    skillName: base.skillName, skillPrefix: base.skillPrefix, builtin: [...bundledSkillNames], revision: current.revision,
    parts: Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) })),
    defaultChanged: base.defaultChanged, defaultSkills: defaultSkillsOf(scope),
    revisions: own ? own.revisions : base.revisions, sessions: base.sessions, notificationPending: base.notificationPending,
    next_offset: own ? own.next_offset : base.next_offset }
}
/** Validate a configuration as the host does, refusing an unknown part or a template that lost its placeholders. */
function invalidPrompt(config: PromptConfig): Refusal | undefined {
  for (const [part, override] of Object.entries(config.overrides ?? {})) {
    const found = builtInPart(part)
    if (!found) return refuse(400, 'refused', { code: 'unknownPromptPart', values: { part } })
    const missing = (found.placeholders ?? []).filter(placeholder => !override.text.includes(placeholder))
    if (missing.length) return refuse(400, 'refused', { code: 'promptPlaceholders', values: { part, placeholders: missing.join(', ') } })
  }
  return undefined
}
/** A preview as the host composes it for one scope: the fixed and team parts, the default skills and the team skills. */
function promptPreviewOf(scope: string | undefined, body: PromptConfig) {
  const names = [...defaultSkillsOf(scope).map(item => item.name), ...Object.keys(body.skills)]
  const environment = environmentSection(body, []), policy = policySection(SettingsSchema.parse({ policy: { rules: [] } }), body)
  return { ...scope === undefined ? {} : { source: scope },
    parts: { orchestrator: promptParts(body, 'orchestrator', environment, policy), worker: promptParts(body, 'worker', environment) },
    skills: Object.fromEntries(names.map(name => [name, composeSkill(body, name)])),
    orchestrator: composePrompt(body, 'orchestrator', environment, policy), worker: composePrompt(body, 'worker', environment),
    defaultSkills: defaultSkillsOf(scope), builtin: [...bundledSkillNames], scope: '' }
}
/** The Tickets a Project's page serves: the workspace's are every open and pending Ticket of the fake server. */
function projectTicketsOf(project: ProjectFixture): TicketRow[] {  const ids = project.tickets ?? (project.kind === 'workspace' ? undefined : [])
  const rows = ids ? ids.flatMap(id => {
    const ticket = [...server.tickets.open, ...server.person, ...server.tickets.ended].find(item => item.id === id)
    return ticket ? [ticket] : []
  }) : [...server.tickets.open, ...server.person]
  return rows.filter((ticket, index) => rows.findIndex(item => item.id === ticket.id) === index)
}
/** The Threads a Project's page serves: the workspace's are the fake server's Threads. */
function projectThreadsOf(project: ProjectFixture): ThreadRow[] {
  const keys = project.threads ?? (project.kind === 'workspace' ? server.threads.map(thread => thread.key) : [])
  return keys.flatMap(key => { const thread = server.threads.find(item => item.key === key); return thread ? [thread] : [] })
}
/** The Sources a Project names, or the ones its Tickets came from when it names none. */
function projectLinkedIds(project: ProjectFixture, tickets: TicketRow[]): string[] {
  if (project.sourceIds.length) return project.sourceIds
  return [...new Set(tickets.map(ticket => server.ticketSources[ticket.id] ?? 'feishu'))]
}
const projectSourceTitle = (id: string): { zh: string; en: string } => {
  const status = sourceStatuses().find(source => source.id === id)
  return status ? status.title : { zh: id, en: id }
}
/** A Project's page lists every configured Source, each marked when the Project names it. */
function projectSourceRows(project: ProjectFixture, tickets: TicketRow[]): ProjectDetailView['sources'] {
  const linked = new Set(projectLinkedIds(project, tickets))
  const statuses = sourceStatuses()
  const rows: ProjectDetailView['sources'] = statuses.map(source => ({ id: source.id, title: source.title, installed: source.installed,
    state: source.state, lastAt: source.lastAt, linked: linked.has(source.id) }))
  for (const id of linked) if (!statuses.some(source => source.id === id)) rows.push({ id, title: projectSourceTitle(id),
    installed: false, state: 'missing', lastAt: '', linked: true })
  return rows
}
/** One Project as its card lists it, counted from the rows its page serves. */
function projectRowOf(project: ProjectFixture): ProjectRow {
  const tickets = projectTicketsOf(project), artifacts = project.artifacts ?? []
  const lastActivity = [...tickets.map(ticket => ticket.updatedAt), ...artifacts.map(artifact => artifact.at)]
    .reduce((latest, at) => at > latest ? at : latest, '')
  return { id: project.id, key: project.key, name: project.name, kind: project.kind, location: project.location, status: project.status,
    ...project.archivedAt ? { archivedAt: project.archivedAt } : {},
    openTickets: tickets.filter(ticket => ticket.state === 'open').length, tickets: tickets.length, artifacts: artifacts.length,
    sources: projectLinkedIds(project, tickets).map(id => ({ id, title: projectSourceTitle(id) })),
    lastActivity, ...project.reporter ? { reporter: project.reporter } : {} }
}
/** The Project cards of one status, the built-in workspace first. */
function projectRows(status: ProjectRow['status']): ProjectRow[] {
  return server.projects.filter(project => project.status === status)
    .sort((one, two) => Number(two.kind === 'workspace') - Number(one.kind === 'workspace')).map(projectRowOf)
}
/** A Project's stored record, as the write routes return it and its page carries it. */
const projectRecordOf = (project: ProjectFixture): ProjectDetailView['project'] => ({
  id: project.id, key: project.key, status: project.status, createdAt: project.createdAt, updatedAt: project.updatedAt,
  value: { name: project.name, kind: project.kind, location: project.location, outputDir: project.outputDir,
    scratchDir: project.scratchDir, rulesDir: project.rulesDir, sourceIds: project.sourceIds, aliases: project.aliases,
    ...project.archivedAt ? { archivedAt: project.archivedAt } : {} } })
/** One Project's page: its record, its counts, its Sources and the first page of each section. */
function projectDetailOf(id: string): ProjectDetailView | undefined {
  const project = server.projects.find(item => item.id === id)
  if (!project) return undefined
  const tickets = projectTicketsOf(project), threads = projectThreadsOf(project)
  const decisions = project.decisions ?? [], artifacts = project.artifacts ?? []
  return { project: projectRecordOf(project),
    counts: { openTickets: tickets.filter(ticket => ticket.state === 'open').length, tickets: tickets.length, threads: threads.length,
      decisions: decisions.length, artifacts: artifacts.length },
    sources: projectSourceRows(project, tickets), tickets: page(tickets), threads: page(threads),
    decisions: { items: decisions, next_offset: null }, artifacts, recentTriggers: [] }
}
/** One Project's agent history: its Tickets newest first, the artifacts delivered for it, and its Assignment reports. */
function projectHistoryOf(id: string): ProjectHistoryView | undefined {
  const project = server.projects.find(item => item.id === id)
  if (!project) return undefined
  const tickets = projectTicketsOf(project)
  const ordered = tickets.slice().sort((one, two) => two.updatedAt.localeCompare(one.updatedAt) || one.id.localeCompare(two.id))
  const artifacts = (project.artifacts ?? []).slice().sort((one, two) => two.at.localeCompare(one.at) || one.id.localeCompare(two.id))
  const titles = new Map(tickets.map(ticket => [ticket.id, ticket.title]))
  const counts = new Map<string, number>()
  for (const artifact of artifacts) counts.set(artifact.ticket, (counts.get(artifact.ticket) ?? 0) + 1)
  const reports = ordered.flatMap(ticket => (server.ticketDetails[ticket.id]?.assignments ?? []).flatMap(assignment => assignment.report
    ? [{ ticketId: ticket.id, ticketTitle: ticket.title, assignmentId: assignment.id, state: assignment.report.state,
      summary: assignment.report.summary, at: assignment.report.at }]
    : [])).sort((one, two) => two.at.localeCompare(one.at) || one.ticketId.localeCompare(two.ticketId)
    || one.assignmentId.localeCompare(two.assignmentId))
  return {
    project: { id: project.id, name: project.name, key: project.key },
    tickets: ordered.map(ticket => ({ id: ticket.id, title: ticket.title, stage: ticket.stage,
      action: ticket.stage === 'person' || ticket.stage === 'working' ? ticket.action : undefined, state: ticket.state,
      ...ticket.ended ? { ended: { at: ticket.ended.at, outcome: ticket.ended.outcome } } : {},
      ...server.ticketDetails[ticket.id]?.mandate.actor ? { reporter: server.ticketDetails[ticket.id]!.mandate.actor } : {},
      assignments: ticket.assignments, artifacts: counts.get(ticket.id) ?? 0, updatedAt: ticket.updatedAt })),
    artifacts: artifacts.map(artifact => ({ id: artifact.id, name: artifact.name, ticket: artifact.ticket,
      ticketTitle: titles.get(artifact.ticket) ?? artifact.ticket, at: artifact.at, size: artifact.size, hash: artifact.hash ?? '' })),
    reports,
  }
}
const stateView = (): StateView => ({
  setup: server.setup, load: { running: server.setup.problem ? 0 : 2, queued: 0, maxWorkers: server.settings.executor.maxWorkers },
  masterId: 'master', paused: server.settings.paused,
  // The panel does not read health; the service script does.
  health: {},
})
const settingsView = (): ApiResponse<'GET settings'> => ({
  policyVersion: 'abcdef1234567890',
  blocks: { policy: { value: server.settings.policy, revision: server.revisions.policy ?? 0 },
    eval: { value: server.settings.eval, revision: server.revisions.eval ?? 0 },
    executor: { value: server.settings.executor, revision: server.revisions.executor ?? 0 } },
  sources: sourceSettings(),
  environment: { root: '/srv/dsh-superagent/work', variables: [
    { owner: 'executor', enabled: true, variables: [{ key: 'DSH_SUPERAGENT_DIR', description: { zh: '工单的执行目录',
      en: 'The ticket directory' } },
      { key: 'DSH_SUPERAGENT_NAME', description: { zh: '工单短名', en: 'Short name' } }] },
    { owner: 'github', enabled: false, variables: [{ key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: '仓库',
      en: 'Repository' } }] }] },
})
const overviewView = (): ApiResponse<'GET overview'> => {
  const { problem, feishuProblem } = server.setup
  const setup = problem ?? feishuProblem
  return {
    problems: [...setup ? [{ kind: 'setup' as const, ...setup }] : [],
      ...instancesOf().some(instance => instance.enabled) ? [] : [{ kind: 'no-source' as const }],
      ...feishuProblem || instancesOf().every(instance => instance.kind !== 'feishu' || !instance.enabled) ? [] : [{ kind: 'source-error' as const, source: { id: 'feishu',
        title: { zh: '飞书', en: 'Feishu' },
        health: { name: 'feishu', state: 'error' as const, detail: 'socket closed' } } }],
      ...server.threads.filter(thread => thread.evaluating && thread.evaluating.deadline < new Date().toISOString())
        .map(thread => ({ kind: 'eval-overdue' as const, thread })),
      { kind: 'eval-unavailable' as const, decisionId: 'u1', thread: threadSummary(), reason: [{ code: 'timeout' }], triggerId: 'e3' },
      ...server.settings.paused ? [{ kind: 'executor-paused' as const }] : [],
      // As on the host, every entry in error that is not a Source's own (an instance's or its kind's), a Policy sync, or the individually listed unavailable Evals is a runtime-error.
      ...Object.entries(server.health).filter(([name, item]) => item.state === 'error' && !KINDS.some(kind => kind.health.includes(name))
        && !instancesOf().some(instance => instance.id === name) && !name.startsWith('sync:') && name !== 'evals')
        .map(([name, item]) => ({ kind: 'runtime-error' as const, name, detail: item.detail })),
      ...Object.values(server.settings.policy.sources).some(part => part.allowed.length) ? [] : [{ kind: 'no-allowed' as const }],
      ...server.failing.map(outgoing => ({ kind: 'outgoing' as const, outgoing }))],
    person: server.person, executor: { running: 2, queued: 0, maxWorkers: server.settings.executor.maxWorkers, idle: 1 },
    flow: { received: 12, filtered: 2, triggers: 10, judged: 5, accepted: 1, evaluating: 0,
      dropped: server.dropped.filter(item => item.dropped.at >= dayAgo()).length },
    artifacts: server.artifacts.slice(0, 5).map(row => ({ id: row.id, name: row.name, project: row.project,
      projectName: row.projectName, at: row.at })),
    policyVersion: 'abcdef1234567890',
  }
}
export const acceptDecision = (): NonNullable<TicketPageView['decision']> => ({ id: 'd1', kind: 'accept', outcome: 'accept',
  reason: [{ code: 'explicitRouted' }], at: '2026-09-22T00:00:00Z', strength: 'explicit', policyVersion: 'abcdef1234567890',
  ticketId: undefined, triggerIds: ['e1'], thread: 'feishu:oc_1:om_root', rules: [], preview: '@bot 修一下', ticketTitle: undefined })
const ticketDetail = (): TicketPageView => ({
  ...ticketSummary(), paused: false, decision: acceptDecision(), threads: [threadSummary()],
  mandate: { strength: 'explicit', policyVersion: 'abcdef1234567890', basis: { via: 'addressed', sender: 'Alice', addressed: 'mention' },
    actor: actor('feishu', MEMBER), scope: '修复登录页回归' },
  basis: { facts: [{ name: 'sender', value: 'Alice' }, { name: 'addressed', value: 'mention' }], legacy: false },
  environment: [{ key: 'DSH_SUPERAGENT_DIR', value: '/w/t1', description: { zh: '执行目录', en: 'Directory' }, owner: 'executor' },
    { key: 'DSH_SUPERAGENT_GITHUB_NUMBER', value: '', description: { zh: '编号', en: 'Number' }, owner: 'github' }],
  channels: [{ source: 'feishu', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1', label: { zh: '飞书消息',
    en: 'Feishu message' } },
    { source: 'github', url: 'https://github.com/acme/widgets/issues/42', label: { zh: 'GitHub #42', en: 'GitHub #42' } }],
  assignments: [{ id: 'a1', state: 'running', createdAt: '2026-09-22T00:00:00Z',
    startedAt: '2026-09-22T00:01:00Z',
    report: { state: 'progress', summary: 'working', at: '2026-09-22T00:02:00Z' } }],
  inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:03:00Z', delivered: false,
    trigger: { id: 'e2', actor: actor('feishu', MEMBER), human: true, preview: '顺便改标题', thread: 'feishu:oc_1:om_root' } },
  { id: 'i2', kind: 'policy-changed', at: '2026-09-22T00:04:00Z', delivered: true, from: 'aaaaaaaaaaaaaaaa', to: 'bbbbbbbbbbbbbbbb' }],
})
function threadPage(key: string, { before, around }: { before?: string; around?: string }): ThreadPageView | undefined {
  if (key !== threadSummary().key) return undefined
  const base = { ...threadSummary(), tickets: [ticketSummary()], correlated: [{ key: 'github:42', title: 'PR 42' }], decisions: [],
    url: 'https://example.test/thread', context: [] }
  const decision = { id: 'd1', outcome: 'accept' as const, reason: [{ code: 'said', values: { text: 'x' } }], ticketId: 't1' }
  if (before === 'cursor-1' || around === 'e1') return { ...base, timeline: [trigger('e1', '2026-09-20T00:00:00Z',
    { disposition: { decision } })], earlier: null }
  return { ...base, earlier: 'cursor-1', timeline: [trigger('e3', '2026-09-23T00:00:00Z', { disposition: { fanout: ['t1'] } }),
    trigger('e4', '2026-09-23T00:01:00Z', { disposition: { filtered: { code: 'not_a_member' } } })] }
}
function initial(): PanelServer {
  const settings = SettingsSchema.parse({
    policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team' },
      github: { allowed: [{ id: 'alice' }] } },
      rules: [{ id: 'copy', name: '文案修改', enabled: true, instruction: '修正明确的文案错误' }] },
    sources: { feishu: { kind: 'feishu', enabled: true, config: { cli: 'lark-bot', chats: [{ chatId: 'oc_team', listen: 'mentions' }],
      directMessages: true } },
      github: { kind: 'github', enabled: true, config: { repository: 'acme/widgets', cli: 'gh-agent' } } },
    executor: { blockedCommands: ['gh-personal'] },
  })
  const ended = ticketSummary({ id: 't0', title: '旧工单', state: 'ended', actions: { retry: false, stop: false },
    ended: { at: '2026-09-21T00:00:00Z', by: 'human', reason: 'Human asked to stop', outcome: 'stopped' } }, { stage: 'ended' })
  const reply = { source: 'feishu', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1', label: { zh: '飞书消息',
    en: 'Feishu message' } }
  const defaults = { revision: 0, previousRevision: null, savedAt: '', source: 'defaults' }
  return {
    health: {}, down: false, pending: 0, opened: [], hostSessions: new Set(), sessions: new Set(), created: [],
    requests: [], misuse: [], queued: new Set(), projectQuestions: new Set(['e10']),
    projects: [
      { id: 'prj_workspace', key: 'workspace', name: 'workspace', kind: 'workspace', location: { type: 'managed' },
        status: 'active', sourceIds: [], aliases: [], outputDir: '/srv/dsh-superagent/area/workspace',
        scratchDir: '/srv/dsh-superagent/area/workspace/.work', rulesDir: '/srv/dsh-superagent/area/workspace/.work/rules',
        createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
      { id: 'prj_aps', key: 'aps', name: 'aps', kind: 'station', location: { type: 'folder', path: '/srv/aps' }, status: 'active',
        sourceIds: ['feishu'], aliases: ['APS'], outputDir: '/srv/aps', scratchDir: '/srv/dsh-superagent/area/aps.work',
        rulesDir: '/srv/dsh-superagent/area/aps.work/rules', createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z',
        tickets: ['t1'], threads: ['feishu:oc_1:om_root'], decisions: [acceptDecision()],
        artifacts: [{ id: 'a1', name: 'report.md', size: 120, at: '2026-09-23T00:00:00Z', ticket: 't1', source: 'feishu',
          targetRoot: '/srv/aps', hash: 'abcdef0123456789' }], reporter: actor('feishu', MEMBER) },
      { id: 'prj_legacy', key: 'legacy', name: 'legacy', kind: 'station',
        location: { type: 'repo', url: 'https://github.com/acme/legacy' }, status: 'archived', sourceIds: [], aliases: [],
        outputDir: '/srv/dsh-superagent/area/legacy', scratchDir: '/srv/dsh-superagent/area/legacy.work',
        rulesDir: '/srv/dsh-superagent/area/legacy.work/rules', createdAt: '2026-09-03T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z',
        archivedAt: '2026-09-20T00:00:00Z' },
    ],
    pendingProjects: { feishu: [{ triggerId: 'e10', thread: 'feishu:oc_team:om_10', at: '2026-09-23T00:03:00Z', preview: '把导出也做一下',
      candidates: [{ id: 'prj_aps', name: 'aps', kind: 'station' }],
      proposal: { name: 'aps 填报', location: { type: 'managed' } } }] },
    sourceStats: { feishu: { arrived: 12, filtered: 2, judged: 5, accepted: 1 } },
    sourcePending: { feishu: 2 },
    sourceExec: { feishu: { working: 1, queued: 1, waiting: 0 } },
    ticketSources: { t1: 'feishu', t0: 'feishu', t4: 'feishu' },
    dropped: [], failing: [], artifacts: [], artifactDetails: {}, artifactFiles: {}, downloads: [],
    setup: { machine: MACHINE, problem: null, feishuProblem: null, problems: {},
      accounts: { repository: 'acme/widgets', agent: 'agent-bot', feishu: { appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot',
        name: 'Widgets Bot' } } },
    settings, revisions: { policy: 3, eval: 1, executor: 0 },
    prompts: { masterId: 'master', sections: TEAM_SECTIONS, skillName: SKILL_NAME.source, builtin: [...bundledSkillNames],
      skillPrefix: SKILL_PREFIX, revision: 0, current: { ...defaults, config: defaultPrompts() },
      defaults: defaultPrompts(), parts: Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) })),
      defaultChanged: [], defaultSkills: [], revisions: [{ ...defaults, changed: [] }], sessions: [], notificationPending: false, next_offset: null },
    promptScopes: {},
    tickets: { open: [ticketSummary()], ended: [ended] }, ticketDetails: { t1: ticketDetail() },
    threads: [threadSummary()], threadPages: threadPage,
    person: [ticketSummary({ attention: { id: 'q1', question: '需要确认按钮颜色' }, note: { text: '需要确认按钮颜色', error: false }, reply },
      { stage: 'person', action: 'answer' }),
      ticketSummary({ id: 't4', title: '截图工具', actions: { retry: true, stop: true }, sessionId: 'worker-t4',
        summary: 'LlmError: no adapter registered for provider "provider-a"',
        note: { text: 'LlmError: no adapter registered for provider "provider-a"', error: true } }, { stage: 'person', action: 'failed' })],
    search: { items: [], threads: [] },
    history: { current: 3, policyVersion: 'abcdef1234567890', items: [
      { revision: 4, savedAt: '2026-09-23T00:00:00Z', source: 'panel', policyVersion: '9876543210fedcba', policyChanged: true, notified: [],
        block: 'source:feishu',
        changes: [{ code: 'sourceRowsAdded', source: 'feishu', field: 'chats', items: ['oc_team'] }] },
      { revision: 3, savedAt: '2026-09-22T00:00:00Z', source: 'panel', policyVersion: 'abcdef1234567890', policyChanged: true,
        notified: [{ id: 't1', title: '修复回归' }], block: 'policy',
        changes: [{ code: 'mode', from: 'off', to: 'observe' }, { code: 'sourceField', source: 'feishu', field: 'directMessages',
          from: true, to: false },
          { code: 'sourceRowsAdded', source: 'feishu', field: 'chats', items: ['oc_other', 'oc_new'] }] }] },
  }
}

/** A refusal response carrying the host's HTTP status code and JSON error body. Returned by route handlers when a request is rejected. */
class Refusal { constructor(readonly status: 400 | 404 | 409 | 500, readonly body: Record<string, unknown>) {} }
const refuse = (status: Refusal['status'], error: string, more: Record<string, unknown> = {}) => new Refusal(status, { error, ...more })
type Query<K extends keyof Api> = Api[K] extends { query?: infer Q } ? keyof NonNullable<Q> & string : never
type Body<K extends keyof Api> = Api[K] extends { body: infer B } ? B : undefined
interface Request<K extends keyof Api> { params: RouteParams<K>; query: Partial<Record<Query<K>, string>>; body: Body<K> }
type Answer<K extends keyof Api> = ApiResponse<K> | Refusal
type Route<K extends keyof Api> = { query?: readonly Query<K>[]; answer: (request: Request<K>) => Answer<K> | Promise<Answer<K>> }
  & (Api[K] extends { body: unknown } ? { body: true } : { body?: never })
const page = <T>(items: T[]) => ({ items, total: items.length, next_offset: null })
const ticketOf = (id: string) =>
  [...server.tickets.open, ...server.person, ...server.tickets.ended].find(ticket => ticket.id === id) ?? server.ticketDetails[id]
const SourceSave = z.object({ enabled: z.boolean(), config: z.unknown() })

const ROUTES: { [K in keyof Api]: Route<K> } = {
  'GET state': { answer: stateView },
  'GET overview': { answer: overviewView },
  'GET search': { query: ['q'], answer: async ({ query }) => {
    const q = query.q ?? ''
    await server.searching?.(q)
    return { tickets: [], threads: server.search.threads, items: server.search.items.filter(item => item.preview.includes(q)) }
  } },
  'GET sources': { answer: sourceStatuses },
  'GET source-kinds': { answer: () => KINDS.map(kind => ({ kind: kind.kind, title: kind.title, description: kind.description,
    fields: kind.fields, defaults: kind.schema.parse({}) })) },
  'GET sources/:id': { query: ['offset', 'limit'], answer: ({ params }) => sourceDetailOf(params.id) ?? refuse(404, 'Unknown Source', {
    code: 'unknownSource', values: { source: params.id } }) },
  'POST sources': { body: true, answer: ({ body }) => {
    const request = body as { kind: string; key?: string; label?: string; config: Record<string, unknown> }
    const kind = KINDS.find(item => item.kind === request.kind)
    if (!kind) return refuse(400, 'The Source kind is not installed', { code: 'sourceNotInstalled', values: { source: request.kind } })
    const key = request.key ? request.key.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') : ''
    const id = key ? `${kind.kind}:${key}` : kind.kind
    if (server.settings.sources[id]) return refuse(400, 'A Source instance with that id already exists', { code: 'sourceExists', values: { source: id } })
    server.settings = { ...server.settings, sources: { ...server.settings.sources, [id]: { kind: kind.kind, enabled: true,
      config: kind.schema.parse(request.config), ...request.label ? { label: request.label } : {} } } }
    server.revisions[`source:${id}`] = 1
    return { id, revision: 1, restarting: false }
  } },
  'PATCH sources/:id': { body: true, answer: ({ params, body }) => {
    const instance = server.settings.sources[params.id]
    if (!instance) return refuse(404, 'Unknown Source', { code: 'unknownSource', values: { source: params.id } })
    const patch = body as { enabled?: boolean; label?: string; config?: Record<string, unknown>; defaultProjectId?: string }
    const kind = KINDS.find(item => item.kind === instance.kind)!
    server.settings = { ...server.settings, sources: { ...server.settings.sources, [params.id]: { ...instance,
      enabled: patch.enabled ?? instance.enabled, config: patch.config ? kind.schema.parse(patch.config) : instance.config,
      ...'label' in patch ? { label: patch.label } : {}, ...'defaultProjectId' in patch ? { defaultProjectId: patch.defaultProjectId } : {} } } }
    server.revisions[`source:${params.id}`] = (server.revisions[`source:${params.id}`] ?? 0) + 1
    return { revision: server.revisions[`source:${params.id}`]!, restarting: false }
  } },
  'GET projects': { query: ['status'], answer: ({ query }) => projectRows(query.status === 'archived' ? 'archived' : 'active') },
  'GET projects/:id': { answer: ({ params }) => projectDetailOf(params.id) ?? refuse(404, 'Unknown Project',
    { code: 'projectUnknown', values: { project: params.id } }) },
  'GET projects/:id/tickets': { query: ['state', 'offset', 'limit'], answer: ({ params, query }) => {
    const project = server.projects.find(item => item.id === params.id)
    if (!project) return refuse(404, 'Unknown Project', { code: 'projectUnknown', values: { project: params.id } })
    const tickets = projectTicketsOf(project).filter(ticket => query.state === 'open' ? ticket.state === 'open'
      : query.state === 'ended' ? ticket.state === 'ended' : true)
    return page(tickets)
  } },
  'GET projects/:id/threads': { query: ['filter', 'offset', 'limit'], answer: ({ params }) => {
    const project = server.projects.find(item => item.id === params.id)
    return project ? page(projectThreadsOf(project))
      : refuse(404, 'Unknown Project', { code: 'projectUnknown', values: { project: params.id } })
  } },
  'GET projects/:id/decisions': { query: ['offset', 'limit'], answer: ({ params }) => {
    const project = server.projects.find(item => item.id === params.id)
    return project ? { items: project.decisions ?? [], next_offset: null }
      : refuse(404, 'Unknown Project', { code: 'projectUnknown', values: { project: params.id } })
  } },
  'GET projects/:id/history': { query: ['limit'], answer: ({ params }) => projectHistoryOf(params.id)
    ?? refuse(404, 'Unknown Project', { code: 'projectUnknown', values: { project: params.id } }) },
  'POST projects': { body: true, answer: ({ body }) => {
    const request = body as { name: string; location: { type: string; path?: string; url?: string; branch?: string } }
    const name = request.name.trim()
    if (!name) return refuse(400, 'The Project needs a name',
      { code: 'projectLocationInvalid', values: { reason: 'the Project needs a name' } })
    const key = projectKeyOf(name)
    if (server.projects.some(project => project.key === key)) return refuse(400, 'A Project is already called that',
      { code: 'projectExists', values: { project: key } })
    if (request.location.type === 'folder' && !/^(?:[A-Za-z]:[\\/]|\/)/.test(request.location.path ?? '')) return refuse(400,
      'The Project location is not usable', { code: 'projectLocationInvalid', values: { reason: 'the folder must be an absolute path' } })
    if (request.location.type === 'repo' && request.location.url && !/^(?:https|ssh|file):\/\//.test(request.location.url)) {
      return refuse(400, 'The Project location is not usable', { code: 'projectLocationInvalid',
        values: { reason: 'the repository address must use https, ssh or file' } })
    }
    const at = new Date().toISOString()
    const outputDir = request.location.type === 'folder' ? request.location.path!
      : request.location.type === 'repo' && request.location.path ? `${request.location.path}/artifacts` : `/srv/dsh-superagent/area/${key}`
    const project: ProjectFixture = { id: `prj_${key}`, key, name, kind: 'station',
      location: request.location as ProjectFixture['location'], status: 'active', sourceIds: [], aliases: [], outputDir,
      scratchDir: `/srv/dsh-superagent/area/${key}.work`, rulesDir: `/srv/dsh-superagent/area/${key}.work/rules`,
      createdAt: at, updatedAt: at }
    server.projects = [...server.projects, project]
    return { project: projectRecordOf(project) }
  } },
  'PATCH projects/:id': { body: true, answer: ({ params, body }) => {
    const project = server.projects.find(item => item.id === params.id)
    if (!project) return refuse(404, 'Unknown Project', { code: 'projectUnknown', values: { project: params.id } })
    const patch = body as { name?: string; aliases?: string[]; archived?: boolean; sourceIds?: string[] }
    const fixed = project.kind === 'workspace'
    if (fixed && (patch.archived === true || patch.name !== undefined && patch.name !== project.name)) {
      return refuse(400, 'The built-in workspace is fixed', { code: 'projectFixed' })
    }
    if (patch.name !== undefined && patch.name !== project.name && server.projects.some(item => item.id !== project.id
      && item.key === projectKeyOf(patch.name!))) {
      return refuse(400, 'A Project is already called that', { code: 'projectExists', values: { project: projectKeyOf(patch.name!) } })
    }
    if (patch.sourceIds) {
      const unknown = patch.sourceIds.find(id => !instancesOf().some(instance => instance.id === id))
      if (unknown) return refuse(404, 'Unknown Source', { code: 'unknownSource', values: { source: unknown } })
      project.sourceIds = [...new Set(patch.sourceIds)]
    }
    if (patch.name !== undefined) project.name = patch.name
    if (patch.aliases) project.aliases = [...new Set(patch.aliases.map(alias => alias.trim()).filter(Boolean))]
    if (patch.archived !== undefined && !fixed) {
      project.status = patch.archived ? 'archived' : 'active'
      if (patch.archived) project.archivedAt = new Date().toISOString()
      else delete project.archivedAt
    }
    project.updatedAt = new Date().toISOString()
    return { project: projectRecordOf(project) }
  } },
  // The artifact index filters by Project, Source, Ticket or a name/hash search; one artifact's page carries its chain.
  'GET artifacts': { query: ['q', 'project', 'source', 'ticket', 'offset', 'limit'], answer: ({ query }) => {
    const text = (query.q ?? '').toLowerCase()
    const filtered = server.artifacts.filter(row => (!query.project || row.project === query.project)
      && (!query.source || row.source === query.source) && (!query.ticket || row.ticket === query.ticket)
      && (!text || row.name.toLowerCase().includes(text) || row.hash.toLowerCase().includes(text)))
    const from = Number(query.offset ?? 0), size = Number(query.limit ?? 20)
    const items = filtered.slice(from, from + size)
    return { items, total: filtered.length, next_offset: from + size < filtered.length ? from + size : null }
  } },
  'GET artifacts/:id': { query: ['assignment'], answer: ({ params }) => server.artifactDetails[params.id]
    ?? refuse(404, 'Artifact not found') },
  'GET settings': { answer: settingsView },
  'POST sources/:id/labels': { answer: () => {
    // Label refresh failures come from the bot CLI and are returned verbatim.
    if (server.joinError) return refuse(500, server.joinError)
    const added = Object.values(server.joining ?? {}); server.joined = { ...server.joined, ...server.joining }; server.joining = undefined
    return { added }
  } },
  'GET threads': { query: ['filter', 'offset', 'limit'], answer: () => page(server.threads) },
  'GET threads/:key': { query: ['limit', 'before', 'around'], answer: ({ params, query }) => {
    const found = server.threadPages(params.key, query)
    if (!found) return refuse(404, 'Thread not found')
    // A Trigger sent to Eval again is queued and cannot be requeued.
    const queued = (item: TriggerRow) => ({ ...item, disposition: { ...item.disposition, queued: true }, actions: { requeue: false } })
    return { ...found, timeline: found.timeline.map(item => server.queued.has(item.id) ? queued(item) : item) }
  } },
  'POST threads/:key/unsubscribe': { answer: ({ params }) => {
    const removed = server.threads.length > 0
    server.threads = []
    return { removed, thread: params.key, context_delivery: 'injected' }
  } },
  'POST triggers/:id/requeue': { answer: ({ params }) => { server.queued.add(params.id); return { queued: true } } },
  'POST triggers/:id/answer-project': { body: true, answer: ({ params, body }) => {
    // As the host does: the Trigger must wait for a Project question, and a new address is validated before it is created.
    if (!server.projectQuestions.has(params.id)) return refuse(400, 'This Trigger is not waiting for a Project', { code: 'notNeedsProject', values: {} })
    const answer = body as { projectId?: string; new?: { name: string; location: { type: string; path?: string } }; confirmProposal?: true }
    if (answer.new?.location.type === 'folder' && !/^(?:[A-Za-z]:[\\/]|\/)/.test(answer.new.location.path ?? '')) {
      return refuse(400, 'The Project location is not usable', { code: 'projectLocationInvalid', values: { reason: 'the folder must be an absolute path' } })
    }
    const resolved = answer.projectId ?? 'prj_aps'
    server.projectQuestions.delete(params.id)
    for (const [source, items] of Object.entries(server.pendingProjects))
      server.pendingProjects[source] = items.filter(item => item.triggerId !== params.id)
    return { resolved }
  } },
  'GET decisions': { query: ['kind', 'window', 'offset', 'limit'], answer: ({ query }) =>
    ({ items: query.kind === 'ignore' ? [] : [acceptDecision()], next_offset: null }) },
  'POST decisions/:id/dismiss': { answer: ({ params }) => params.id === 'u1' ? { dismissed: true } : refuse(404,
    'Unavailable Eval not found') },
  'GET tickets': { query: ['state', 'source', 'offset', 'limit'], answer: ({ query }) => {
    const tickets = server.tickets[query.state === 'ended' ? 'ended' : 'open']
    return page(query.source ? tickets.filter(ticket => (server.ticketSources[ticket.id] ?? 'feishu') === query.source) : tickets)
  } },
  'GET tickets/:id': { answer: ({ params }) => server.ticketDetails[params.id] ?? refuse(404, 'Ticket not found') },
  'POST tickets/:id/retry': { answer: ({ params }) => {
    const ticket = ticketOf(params.id)
    if (!ticket) return refuse(404, 'Ticket not found')
    return ticket.actions.retry ? { retried: true } : refuse(400, 'Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed',
      { code: 'notRetryable', values: {} })
  } },
  'POST tickets/:id/stop': { answer: ({ params }) => {
    if (!ticketOf(params.id)) return refuse(404, 'Ticket not found')
    server.tickets.open = []; server.person = server.person.filter(ticket => ticket.id !== params.id)
    return { stopped: true }
  } },
  'POST executor/pause': { body: true, answer: ({ body }) => {
    server.settings = { ...server.settings, paused: body.paused }
    server.revisions.pause = (server.revisions.pause ?? 0) + 1
    return { paused: body.paused }
  } },
  'PUT settings/:block': { body: true, answer: ({ params: { block }, body }) => {
    const instanceId = block.startsWith('source:') ? block.slice('source:'.length)
      : block.startsWith('policy:') ? block.slice('policy:'.length) : undefined
    const instance = instanceId ? server.settings.sources[instanceId] : undefined
    const kind = instance ? KINDS.find(item => item.kind === instance.kind) : undefined
    if (!['policy', 'eval', 'executor'].includes(block) && !instance) return instanceId ? refuse(404, 'Source not found')
      : refuse(400, 'Invalid settings: block')
    if (body.revision !== (server.revisions[block] ?? 0)) return refuse(409, 'Settings changed. Reload before saving.')
    let restarting = false
    if (block === 'policy') server.settings = { ...server.settings, policy: PolicyConfigSchema.parse(body.value) }
    else if (block === 'executor') server.settings = { ...server.settings, executor: ExecutorConfigSchema.parse(body.value) }
    else if (block === 'eval') server.settings = { ...server.settings, eval: EvalConfigSchema.parse(body.value) }
    else if (block.startsWith('policy:') && kind?.policy && instanceId) {
      // One Source's Policy part: the kind validates its fields, the Policy validates its admission table and its own rules.
      const { rules, admission, ...fields } = body.value as Record<string, unknown>
      const part = { ...kind.policy.schema.parse(fields), admission: AdmissionTableSchema.parse(admission ?? {}),
        ...rules === undefined ? {} : { rules: RuleArraySchema.parse(rules) } }
      server.settings = { ...server.settings, policy: { ...server.settings.policy,
        sources: { ...server.settings.policy.sources, [instanceId]: part as typeof server.settings.policy.sources[string] } } }
    } else if (kind && instance) {
      const { enabled, config: value } = SourceSave.parse(body.value)
      const config = kind.schema.parse(value)
      // As on the server, a changed CLI that fails its check refuses the save with the setup problem.
      if (config.cli === 'lark-broken') {
        const refused = new SetupError('feishuCliFailed', { output: 'lark-cli: app secret missing' })
        return refuse(400, refused.message, { setup: refused.problem })
      }
      restarting = (config.cli ?? '') !== (instance.config.cli ?? '')
      server.settings = { ...server.settings, sources: { ...server.settings.sources, [instanceId!]: { ...instance, enabled, config } } }
    }
    server.revisions[block] = (server.revisions[block] ?? 0) + 1
    return { restarting, revision: server.revisions[block] }
  } },
  'GET policy/history': { answer: () => server.history },
  'POST policy-sync/:id': { answer: ({ params }) => ({ policy: server.settings.policy.sources[params.id] }) },
  'POST setup/check': { answer: () => ({ restarting: true }) },
  'GET models': { answer: () => ({ default: { provider: 'host', model: 'default' }, routableProviders: [], failures: [],
    groups: [{ id: 'worker-provider', name: 'Worker provider', models: [{ id: 'worker-model', name: 'Worker model',
      reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }] }) },
  'GET prompts': { query: ['revision', 'offset'], answer: () => promptsViewOf() },
  'PUT prompts': { body: true, answer: ({ body }) => {
    const { revision } = server.prompts
    if (body.baseRevision !== revision) return refuse(409,
      `Prompt version changed to ${revision}; compare the latest version before saving`)
    // As the host does: a template keeps its placeholders, and no overrides are stored as none.
    const { overrides = {}, ...config } = body.config as PromptsView['current']['config']
    for (const [part, override] of Object.entries(overrides)) {
      if (!builtInPart(part)) return refuse(400, 'refused', { code: 'unknownPromptPart', values: { part } })
      const missing = (builtInPart(part)?.placeholders ?? []).filter(placeholder => !override.text.includes(placeholder))
      if (missing.length) return refuse(400, 'refused', { code: 'promptPlaceholders', values: { part, placeholders: missing.join(', ') } })
    }
    server.prompts.revision++
    server.prompts.current = promptVersion(server.prompts.revision, Object.keys(overrides).length ? { ...config, overrides } : config)
    return { revision: server.prompts.revision, context_delivery: 'injected' }
  } },
  'POST prompts/preview': { body: true, answer: ({ body }) => promptPreviewOf(undefined, body) },
  'GET sources/:id/prompts': { query: ['revision', 'offset'], answer: ({ params }) =>
    instancesOf().some(instance => instance.id === params.id) ? { ...promptsViewOf(params.id), source: params.id } as SourcePromptsView
      : refuse(404, 'Source not found') },
  'PUT sources/:id/prompts': { body: true, answer: ({ params, body }) => {
    const instance = instancesOf().find(item => item.id === params.id)
    if (!instance) return refuse(404, 'Source not found')
    const view = promptsViewOf(params.id)
    if (body.baseRevision !== view.revision) return refuse(409,
      `Prompt version changed to ${view.revision}; compare the latest version before saving`)
    const config = body.config
    const invalid = invalidPrompt(config)
    if (invalid) return invalid
    // As on the host: a Source that had none first keeps the configuration it inherited as revision 0, then saves its own.
    const previous = server.promptScopes[params.id]
    const revision = (previous?.revision ?? 0) + 1
    const { overrides = {}, ...rest } = config
    const stored = { ...rest, ...Object.keys(overrides).length ? { overrides } : {} } as PromptConfig
    server.promptScopes[params.id] = { revision, current: promptVersion(revision, stored),
      revisions: [{ ...promptVersion(revision, config), changed: [] }, ...previous?.revisions
        ?? [{ ...promptVersion(0, view.current.config), source: view.current.source, changed: [] }]], next_offset: null }
    return { revision, context_delivery: 'injected' }
  } },
  'POST sources/:id/prompts/preview': { body: true, answer: ({ params, body }) =>
    instancesOf().some(instance => instance.id === params.id) ? promptPreviewOf(params.id, body)
      : refuse(404, 'Source not found') },
}

function match(method: string, segments: string[]) {
  for (const key of Object.keys(ROUTES) as (keyof Api)[]) {
    const [verb, path] = key.split(' ') as [string, string]
    const pattern = path.split('/')
    if (verb !== method || pattern.length !== segments.length || !pattern.every((part, index) => part.startsWith(':')
      || part === segments[index])) continue
    return { key, params: Object.fromEntries(pattern.flatMap((part, index) => part.startsWith(':') ? [[part.slice(1),
      decodeURIComponent(segments[index]!)]] : [])) }
  }
  return undefined
}
async function run<K extends keyof Api>(key: K, params: Record<string, string>, query: URLSearchParams, body: unknown): Promise<Answer<K>> {
  const route: Route<K> = ROUTES[key]
  const read: readonly string[] = route.query ?? []
  for (const name of query.keys()) if (!read.includes(name)) server.misuse.push(`${key} with the query parameter ${name}`)
  if ((body !== undefined) !== !!route.body) server.misuse.push(`${key} ${body === undefined ? 'without' : 'with'} a body`)
  const values: Partial<Record<Query<K>, string>> = {}
  for (const name of route.query ?? []) { const value = query.get(name); if (value !== null) values[name] = value }
  return route.answer({ params: params as RouteParams<K>, query: values, body: body as Body<K> })
}
/**
 * Response wrapper that increments `server.pending` when constructed and decrements it when `.text()` is consumed.
 * Requests held back by `server.searching` are not constructed until `searching` resolves, so they do not count as pending early.
 */
class Reply extends Response {
  constructor(value: unknown, status: number) { super(JSON.stringify(value), { status,
    headers: { 'content-type': 'application/json' } }); server.pending++ }
  override async text() { server.pending--; return super.text() }
}

export function usePanelServer(cleanup: () => void) {
  beforeEach(() => {
    sessionStorage.clear()
    server = initial()
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (server.down) return new Response(null, { status: 404 })
      const address = new URL(url, 'http://127.0.0.1:3082')
      const path = address.pathname.replace('/orchestrator/api/', '')
      const method = init?.method ?? 'GET'
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
      server.requests.push({ path: decodeURIComponent(`${path}${address.search}`), method, ...body === undefined ? {} : { body } })
      // A download answers with bytes, which the client hands to the browser, not with the JSON of a management route.
      const file = /^artifacts\/([^/]+)\/file$/.exec(path)
      if (method === 'GET' && file) {
        const id = decodeURIComponent(file[1]!)
        const content = server.artifactFiles[id]
        if (!content) return new Response(JSON.stringify({ error: 'Artifact not found' }), { status: 404,
          headers: { 'content-type': 'application/json' } })
        server.downloads.push(id)
        return new Response(content.body, { status: 200, headers: { 'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${content.name}"`, 'content-length': String(content.body.length) } })
      }
      const route = match(method, path.split('/'))
      if (!route) return new Reply({ error: 'Unknown operation' }, 404)
      const answer = await run(route.key, route.params, address.searchParams, body)
      return answer instanceof Refusal ? new Reply(answer.body, answer.status) : new Reply(answer, 200)
    }))
  })
  afterEach(() => {
    try { expect(server.misuse).toEqual([]) }
    finally { cleanup(); vi.unstubAllGlobals() }
  })
}

type Ops = Parameters<ConfigForm<Record<string, unknown>>['mutate']>[0]
/** Fake DSH host configuration form that records mutations and optionally applies them to its snapshot. */
export function fakeForm(writable = true, accept = true) {
  const listeners = new Set<() => void>()
  let snapshot: ConfigFormSnapshot<Record<string, unknown>> = { status: 'ready', value: { ...MACHINE }, base: undefined, user: undefined,
    revision: 1, writable,
    mode: 'host' }
  const notify = () => { for (const listener of listeners) listener() }
  const mutations: { ops: Ops; revision: number | undefined }[] = []
  const form: ConfigForm<Record<string, unknown>> = {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate: async (ops, revision) => {
      mutations.push({ ops, revision })
      if (!accept || revision !== snapshot.revision) return false
      const value = { ...snapshot.value }
      for (const op of ops) { if (op.op === 'set') value[op.path[0]!] = op.value; else delete value[op.path[0]!] }
      snapshot = { ...snapshot, value, revision: snapshot.revision! + 1 }
      notify()
      return true
    },
    set: async () => false, unset: async () => false,
  }
  const publish = (patch: Partial<ConfigFormSnapshot<Record<string, unknown>>>) => { snapshot = { ...snapshot, ...patch }; notify() }
  return { form, mutations, publish }
}
