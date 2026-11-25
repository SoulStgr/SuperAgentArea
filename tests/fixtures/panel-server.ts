/**
 * Typed fake management API server for panel tests. Implements every route in `src/app/api.ts` and records any
 * undeclared query parameter or body mismatch in `server.misuse`, which `usePanelServer` asserts is empty after each test.
 */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { z } from 'zod'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Api, ApiResponse, RouteParams } from '../../src/app/api.ts'
import { SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInPart, builtInParts, composePrompt, composeSkill, defaultPrompts,
  environmentSection, policySection, promptParts } from '../../src/app/prompts.ts'
import type { DroppedReply, HistoryView, Problem, PromptsView, SetupView, SourceDetailView, SourceStatusRow, SourceView, StateView,
  ThreadPageView,
  ThreadRow, TicketPageView,
  TicketRow, TicketStage,
  TriggerRow } from '../../src/client/api.ts'
import { SETUP_FIELDS } from '../../src/deployment.ts'
import { EvalConfigSchema, ExecutorConfigSchema, PolicyConfigSchema, SettingsSchema } from '../../src/policy.ts'
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
  dropped: DroppedReply[]
  failing: Extract<Problem, { kind: 'outgoing' }>['outgoing'][]
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
const problemOf_ = (id: string) => [server.setup.problem, server.setup.feishuProblem].find(item => item?.place === id) ?? undefined
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
    const problem = problemOf_(kind.kind)
    const { admission: _admission, ...part } = server.settings.policy.sources[instance.id] ?? { allowed: [], admission: {} }
    const sync = kind.policy?.sync && { label: kind.policy.sync.label, ready: kind.policy.sync.ready(kind.policy.schema.parse(part)),
      health: server.health[`sync:${instance.id}`] }
    const policy = kind.policy && { fields: kind.policy.fields, explicit: kind.policy.explicit, ...kind.policy.rows
      ? { rows: kind.policy.rows(config, instance.id) } : {}, ...sync ? { sync } : {} }
    const title = instance.label ? { zh: instance.label, en: instance.label }
      : instance.id.startsWith(`${kind.kind}:`) ? { zh: `${kind.title.zh} · ${instance.id.slice(kind.kind.length + 1)}`,
        en: `${kind.title.en} · ${instance.id.slice(kind.kind.length + 1)}` }
        : kind.title
    return { id: instance.id, kind: instance.kind, title, description: kind.description, installed: true,
      value: { enabled: instance.enabled, config }, revision: server.revisions[`source:${instance.id}`] ?? 0,
      restarts: SETUP_FIELDS[kind.kind] ?? [], fields: kind.fields, facts: kind.facts?.(resolved()) ?? {},
      labels: kind.kind === 'feishu' ? { oc_team: '团队群', oc_other: '另一个群', ...server.joined } : {}, ...problem ? { problem } : {},
      ...policy ? { policy } : {} }
  })
}
function sourceStatuses(): SourceStatusRow[] {
  const instances = instancesOf()
  return instances.map(instance => {
    const kind = KINDS.find(item => item.kind === instance.kind)!
    const enabled = instance.enabled
    const health = kind.health.map(name => ({ name, ...healthOf(name) }))
    const problem = problemOf_(kind.kind)
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
      // As on the host, every entry in error that is not a Source's own, a Policy sync, or the individually listed unavailable Evals is a runtime-error.
      ...Object.entries(server.health).filter(([name, item]) => item.state === 'error' && !KINDS.some(kind => kind.health.includes(name))
        && !name.startsWith('sync:') && name !== 'evals')
        .map(([name, item]) => ({ kind: 'runtime-error' as const, name, detail: item.detail })),
      ...Object.values(server.settings.policy.sources).some(part => part.allowed.length) ? [] : [{ kind: 'no-allowed' as const }],
      ...server.failing.map(outgoing => ({ kind: 'outgoing' as const, outgoing }))],
    person: server.person, executor: { running: 2, queued: 0, maxWorkers: server.settings.executor.maxWorkers, idle: 1 },
    flow: { received: 12, filtered: 2, triggers: 10, judged: 5, accepted: 1, evaluating: 0,
      dropped: server.dropped.filter(item => item.dropped.at >= dayAgo()).length },
    policyVersion: 'abcdef1234567890',
  }
}
export const acceptDecision = (): NonNullable<TicketPageView['decision']> => ({ id: 'd1', kind: 'accept', outcome: 'accept',
  reason: [{ code: 'explicitRouted' }], at: '2026-09-22T00:00:00Z', strength: 'explicit', ticketId: undefined,
  triggerIds: ['e1'], thread: 'feishu:oc_1:om_root', rules: [], preview: '@bot 修一下', ticketTitle: undefined })
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
    health: {}, down: false, pending: 0, opened: [], requests: [], misuse: [], queued: new Set(), projectQuestions: new Set(['e10']),
    pendingProjects: { feishu: [{ triggerId: 'e10', thread: 'feishu:oc_team:om_10', at: '2026-09-23T00:03:00Z', preview: '把导出也做一下',
      candidates: [{ id: 'prj_aps', name: 'aps', kind: 'station' }],
      proposal: { name: 'aps 填报', location: { type: 'managed' } } }] },
    sourceStats: { feishu: { arrived: 12, filtered: 2, judged: 5, accepted: 1 } },
    sourcePending: { feishu: 2 },
    sourceExec: { feishu: { working: 1, queued: 1, waiting: 0 } },
    ticketSources: { t1: 'feishu', t0: 'feishu', t4: 'feishu' },
    dropped: [], failing: [],
    setup: { machine: MACHINE, problem: null, feishuProblem: null,
      accounts: { repository: 'acme/widgets', agent: 'agent-bot', feishu: { appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot',
        name: 'Widgets Bot' } } },
    settings, revisions: { policy: 3, eval: 1, executor: 0 },
    prompts: { masterId: 'master', sections: TEAM_SECTIONS, skillName: SKILL_NAME.source, builtin: ['feishu', 'github'],
      skillPrefix: SKILL_PREFIX, revision: 0, current: { ...defaults, config: defaultPrompts() },
      defaults: defaultPrompts(), parts: Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) })),
      defaultChanged: [], revisions: [{ ...defaults, changed: [] }], sessions: [], notificationPending: false, next_offset: null },
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
    if (answer.new?.location.type === 'folder' && !/^[A-Za-z]:[\\/]|\//.test(answer.new.location.path ?? '')) {
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
    const id = block.startsWith('source:') ? block.slice('source:'.length) : undefined
    const instance = id ? server.settings.sources[id] : undefined
    const kind = instance ? KINDS.find(item => item.kind === instance.kind) : undefined
    if (!['policy', 'eval', 'executor'].includes(block) && !kind) return block.startsWith('source:') ? refuse(404, 'Source not found')
      : refuse(400, 'Invalid settings: block')
    if (body.revision !== (server.revisions[block] ?? 0)) return refuse(409, 'Settings changed. Reload before saving.')
    let restarting = false
    if (block === 'policy') server.settings = { ...server.settings, policy: PolicyConfigSchema.parse(body.value) }
    else if (block === 'executor') server.settings = { ...server.settings, executor: ExecutorConfigSchema.parse(body.value) }
    else if (block === 'eval') server.settings = { ...server.settings, eval: EvalConfigSchema.parse(body.value) }
    else if (kind && instance) {
      const { enabled, config: value } = SourceSave.parse(body.value)
      const config = kind.schema.parse(value)
      // As on the server, a changed CLI that fails its check refuses the save with the setup problem.
      if (config.cli === 'lark-broken') {
        const refused = new SetupError('feishuCliFailed', { output: 'lark-cli: app secret missing' })
        return refuse(400, refused.message, { setup: refused.problem })
      }
      restarting = (config.cli ?? '') !== (instance.config.cli ?? '')
      server.settings = { ...server.settings, sources: { ...server.settings.sources, [id!]: { ...instance, enabled, config } } }
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
  'GET prompts': { query: ['revision', 'offset'], answer: () => server.prompts },
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
  'POST prompts/preview': { body: true, answer: ({ body }) => {
    const skills = [...server.setup.accounts?.feishu ? ['feishu'] : [], 'github', ...Object.keys(body.skills)].map(name => [name,
      composeSkill(body, name)])
    // The generated parts from their templates, without variables or rules.
    const environment = environmentSection(body, []), policy = policySection(SettingsSchema.parse({ policy: { rules: [] } }), body)
    return { parts: { orchestrator: promptParts(body, 'orchestrator', environment, policy), worker: promptParts(body, 'worker', environment) },
      skills: Object.fromEntries(skills),
      orchestrator: composePrompt(body, 'orchestrator'), worker: composePrompt(body, 'worker'), scope: '' }
  } },
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
