/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { bundledSkills } from './skill-files.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { UserError, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { ProjectService } from './project-service.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { artifactDetail, artifactFile, artifactList, type ArtifactFile } from './views/artifacts.ts'
import { overview } from './views/overview.ts'
import { PROJECT_HISTORY, projectDecisionList, projectDetail, projectHistory, projectList, projectThreadList,
  projectTicketList } from './views/projects.ts'
import { settingsView } from './views/settings.ts'
import { sourceDetail, sourceKinds, sourcesStatus, type SetupState } from './views/sources.ts'
import { weixinLogins, weixinToken } from '../sources/im/weixin-login.ts'
import { dingtalkLogins } from '../sources/im/dingtalk-login.ts'
import { qqLogins } from '../sources/im/qq-login.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'

export interface HttpHost {
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged' | 'defaultSkills'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'add' | 'remove' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount'>
  /** Project ownership answers: the pending question of a Trigger, the Project a person answered with, and the panel's own workstations. */
  readonly projects: Pick<ProjectService, 'answer' | 'pending' | 'createStation' | 'update'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  /** Setup problems of named GitHub and Feishu instances, by instance id. */
  readonly setupProblems: Record<string, SetupProblem>
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
/** A filename that an HTTP header can carry as its plain fallback: printable ASCII, with quotes and backslashes replaced. */
const asciiFilename = (name: string): string => name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
/**
 * Answers with one artifact's bytes as a download: the filename is safe for both header forms, the length is the file's
 * own, and nothing is served for a file that disappeared between resolving and reading it.
 */
async function sendFile(res: ServerResponse, file: ArtifactFile): Promise<void> {
  let body: Buffer
  try {
    body = await readFile(file.path)
  } catch {
    throw new RouteError(404, 'Artifact not found')
  }
  const encoded = encodeURIComponent(file.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  res.writeHead(200, { 'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${asciiFilename(file.name)}"; filename*=UTF-8''${encoded}`,
    'content-length': String(body.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(body)
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof UserError) {
    // A Source whose work is still open is a conflict, not a malformed request; every other refusal is a bad request.
    const status = error.code === 'sourceInUse' ? 409 : error.missing ? 404 : 400
    return [status, { error: error.message, code: error.code, values: error.values }]
  }
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    problems: runtime.setupProblems,
    accounts: resolved ? { repository: resolved.repository, agent: resolved.github?.login ?? null, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem, problems: runtime.setupProblems })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number, source?: string) {
  const current = runtime.prompts.current(source)
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(source, revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, ...source === undefined ? {} : { source }, current: shown, defaults: defaultPrompts(),
    sections: TEAM_SECTIONS, skillName: SKILL_NAME.source, builtin: Object.keys(bundledSkills), skillPrefix: SKILL_PREFIX, parts,
    defaultSkills: runtime.prompts.defaultSkills(source), defaultChanged: runtime.prompts.defaultChanged(source, shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(source, offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), source: z.string().trim().optional(), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const SourcesQuery = z.object({ offset, limit: limit(20, 500) })
const ProjectsQuery = z.object({ status: z.enum(['active', 'archived']).catch('active') })
const ProjectTicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).optional().catch(undefined), offset, limit: limit(20, 500) })
const ProjectThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('all'), offset, limit: limit(20, 500) })
/** A Project's history lists stop at its limit; the agent section reads the default page without paging. */
const ProjectHistoryQuery = z.object({ limit: limit(PROJECT_HISTORY, 200) })
/** The artifact index's filters, its page, and the Assignment one artifact's chain shows when a person names one. */
const ArtifactsQuery = z.object({ q: z.string().trim().optional(), project: z.string().trim().optional(),
  source: z.string().trim().optional(), ticket: z.string().trim().optional(), offset, limit: limit(20, 200) })
const ArtifactQuery = z.object({ assignment: z.string().trim().min(1).optional() })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*(?::[a-z0-9-]+)?$/)])
/** A Source instance's own Policy part: its rules, allowed senders, kind-specific fields and admission table. */
const PolicyBlock = z.templateLiteral(['policy:', z.string().regex(/^[a-z][a-z0-9-]*(?::[a-z0-9-]+)?$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), SourceBlock, PolicyBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })
const NewSourceRequest = z.object({ kind: z.string().trim().min(1), key: z.string().trim().max(60).optional(),
  label: z.string().trim().max(100).optional(), config: z.record(z.string(), z.unknown()).default({}) }).strict()
const SourcePatchRequest = z.object({ enabled: z.boolean().optional(), label: z.string().trim().max(100).optional(),
  config: z.record(z.string(), z.unknown()).optional(), defaultProjectId: z.string().trim().max(200).optional() }).strict()
/**
 * Normalizes a key a person names a Source instance by: lower case, with every run of other characters as one dash, so the
 * instance id is `<kind>:<key>` and matches the settings block naming. A key that normalizes to nothing is refused.
 */
export function instanceKey(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
}
const ProjectLocationInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('managed') }).strict(),
  z.object({ type: z.literal('folder'), path: z.string().trim().min(1) }).strict(),
  z.object({ type: z.literal('repo'), path: z.string().trim().min(1).optional(), url: z.string().trim().min(1).optional(),
    branch: z.string().trim().max(200).optional() }).strict(),
])
/** A person's answer to a Trigger's Project question: an existing Project, a new one, or the assessment's proposal confirmed. */
const AnswerProjectRequest = z.union([
  z.object({ projectId: z.string().trim().min(1) }).strict(),
  z.object({ new: z.object({ name: z.string().trim().min(1).max(100), location: ProjectLocationInput,
    kind: z.enum(['station', 'adhoc']).optional() }).strict() }).strict(),
  z.object({ confirmProposal: z.literal(true) }).strict(),
])
/** The panel's new-workstation form: a name, an address, and the kind of Project it makes. */
const NewProjectRequest = z.object({ name: z.string().trim().min(1).max(100), location: ProjectLocationInput,
  kind: z.enum(['station', 'adhoc']).optional() }).strict()
/** What a Project's settings page changes; the directories are fixed when the Project is created. */
const ProjectPatchRequest = z.object({ name: z.string().trim().min(1).max(100).optional(),
  aliases: z.array(z.string().trim().max(100)).max(50).optional(), archived: z.boolean().optional(),
  sourceIds: z.array(z.string().trim().min(1).max(200)).max(100).optional() }).strict()

function routes(runtime: HttpHost): Routes {
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const project = (id: string) => { if (!store.projects.get(id)) throw new UserError('projectUnknown', { project: id }); return id }
  /** A Source instance id whose page or prompt configuration a route addresses. */
  const sourceOf = (id: string) => {
    if (!runtime.sources.instances().some(instance => instance.id === id)) throw new UserError('unknownSource', { source: id })
    return id
  }
  /**
   * A stored WeChat instance, as the sign-in routes require it: a configured instance whose kind is WeChat. The QR sign-in
   * only applies to a saved account, so an unsaved one is refused like any unknown Source.
   */
  const wechatOf = (id: string) => {
    const instance = runtime.sources.instances().find(item => item.id === id)
    if (!instance) throw new UserError('unknownSource', { source: id })
    if (runtime.sources.kind(id)?.kind !== 'wechat') throw new RouteError(400, 'The Source is not a WeChat instance')
    return instance
  }
  /**
   * Creates the DingTalk Source instance one completed QR sign-in provisioned: the first free id under `dingtalk`, the
   * scanned app's Client ID and Secret, and its AppKey as the Robot Code — DingTalk's own fallback when an app has no
   * separately named robot code. The secret goes only into this installation's settings.
   */
  const createScannedDingtalk = async (credentials: { clientId: string; clientSecret: string }): Promise<string> => {
    const kind = runtime.sources.kind('dingtalk')
    if (!kind || kind.kind !== 'dingtalk') throw new UserError('sourceNotInstalled', { source: 'dingtalk' })
    const taken = new Set(Object.keys(store.settings().sources))
    let id = 'dingtalk'
    for (let index = 2; taken.has(id); index += 1) id = `dingtalk-${index}`
    await runtime.settings.add({ id, kind: 'dingtalk', label: '钉钉（扫码）',
      config: { clientId: credentials.clientId, clientSecret: credentials.clientSecret, robotCode: credentials.clientId } })
    return id
  }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  /**
   * Creates the QQ Source instance one completed QR scan provisioned: the first free id under `qq`, the scanned bot's
   * AppID and AppSecret, the sandbox switch off (a person turns it on for a test bot in the account's settings), and the
   * scanning person's openid as the account's allowed sender so the first direct message is received without hunting for
   * the openid in a Trigger the account would otherwise never open. The secret goes only into this installation's settings.
   */
  const createScannedQq = async (credentials: { appId: string; appSecret: string; userOpenid?: string }): Promise<string> => {
    const kind = runtime.sources.kind('qq')
    if (!kind || kind.kind !== 'qq') throw new UserError('sourceNotInstalled', { source: 'qq' })
    const taken = new Set(Object.keys(store.settings().sources))
    let id = 'qq'
    for (let index = 2; taken.has(id); index += 1) id = `qq-${index}`
    await runtime.settings.add({ id, kind: 'qq', label: 'QQ（扫码）',
      config: { appId: credentials.appId, appSecret: credentials.appSecret, sandbox: false,
        ...credentials.userOpenid ? { allowedUserIds: credentials.userOpenid } : {} } })
    return id
  }
  return {
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET source-kinds': () => sourceKinds(runtime.sources),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    // One instance's page: its kind's fields and configuration, its own last day, and the Tickets it originated.
    'GET sources/:id': ({ params, query }) => {
      const { offset, limit } = SourcesQuery.parse(query)
      const detail = sourceDetail(views(runtime), params.id, runtime.health, setupState(runtime), offset, limit)
      if (!detail) throw new UserError('unknownSource', { source: params.id })
      return detail
    },
    // A person adds a Source: its kind must be installed and its configuration valid, and an optional key names it beside others of its kind.
    'POST sources': async ({ body }) => {
      const request = NewSourceRequest.parse(await body())
      const kind = runtime.sources.kind(request.kind)
      if (!kind || kind.kind !== request.kind) throw new UserError('sourceNotInstalled', { source: request.kind })
      const key = request.key === undefined ? undefined : instanceKey(request.key)
      if (request.key !== undefined && !key) throw new UserError('sourceKeyInvalid', { reason: 'use letters, digits and dashes' })
      const id = key ? `${kind.kind}:${key}` : kind.kind
      const added = await runtime.settings.add({ id, kind: kind.kind, config: request.config,
        ...request.label ? { label: request.label } : {} })
      return { id, ...added }
    },
    // A Source page's own changes: its switch, label, kind configuration, and default Project, validated as a settings save.
    'PATCH sources/:id': async ({ params, body }) => {
      const instance = runtime.sources.instances().find(item => item.id === params.id)
      if (!instance) throw new UserError('unknownSource', { source: params.id })
      const patch = SourcePatchRequest.parse(await body())
      if (patch.defaultProjectId && !store.projects.get(patch.defaultProjectId)) throw new UserError('projectUnknown', { project: patch.defaultProjectId })
      const saved = await runtime.settings.save(`source:${params.id}`, {
        enabled: patch.enabled ?? instance.enabled, config: patch.config ?? instance.config,
        label: 'label' in patch ? patch.label : instance.label,
        defaultProjectId: 'defaultProjectId' in patch ? patch.defaultProjectId : instance.defaultProjectId,
      }, store.blockRevision(`source:${params.id}`), 'panel')
      return { revision: saved.revision, restarting: saved.restarting }
    },
    // A person deletes a Source instance's configuration; its historical Tickets stay readable, and a live Ticket refuses.
    'DELETE sources/:id': ({ params }) => runtime.settings.remove(params.id),
    // WeChat sign-in: a saved instance starts a QR attempt, the panel polls it, and the confirmed token goes to the instance's
    // KV record. The responses carry the QR image and the account id only — never the token.
    'POST sources/:id/wechat/login': async ({ params }) => {
      const instance = wechatOf(params.id)
      const botType = typeof instance.config.botType === 'string' ? instance.config.botType : undefined
      return weixinLogins.start(instance.id, { ...botType === undefined ? {} : { botType },
        save: credential => store.set(weixinToken(instance.id), credential) })
    },
    'GET sources/:id/wechat/login/:loginId': ({ params }) => {
      wechatOf(params.id)
      return weixinLogins.status(params.id, params.loginId)
    },
    'GET sources/:id/wechat/status': ({ params }) => {
      wechatOf(params.id)
      const credential = store.get(weixinToken(params.id))
      return credential
        ? { loggedIn: true, ilinkBotId: credential.ilinkBotId, at: credential.at }
        : { loggedIn: false }
    },
    // DingTalk sign-in: a QR device registration that provisions an app's Client ID and Secret and creates its account.
    // No instance exists when the attempt starts, so both routes are installation-wide; the responses never carry the secret.
    'POST sources/dingtalk/login': () => {
      const kind = runtime.sources.kind('dingtalk')
      if (!kind || kind.kind !== 'dingtalk') throw new UserError('sourceNotInstalled', { source: 'dingtalk' })
      return dingtalkLogins.start({ create: createScannedDingtalk })
    },
    'GET sources/dingtalk/login/:loginId': ({ params }) => dingtalkLogins.poll(params.loginId),
    // QQ sign-in: a QR bind task whose confirmation provisions the bot's AppID and AppSecret and creates its account. Like
    // DingTalk's, both routes are installation-wide; the responses never carry the secret, the bind key or the task id.
    'POST sources/qq/login': () => {
      const kind = runtime.sources.kind('qq')
      if (!kind || kind.kind !== 'qq') throw new UserError('sourceNotInstalled', { source: 'qq' })
      return qqLogins.start({ create: createScannedQq })
    },
    'GET sources/qq/login/:loginId': ({ params }) => qqLogins.poll(params.loginId),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    // A person answered a Trigger's Project question in the panel: create or pick the Project, then queue its fresh Eval,
    // which resolves the Project and accepts. The same-origin check of every route is the panel's authentication.
    'POST triggers/:id/answer-project': async ({ params, body }) => {
      const { resolved } = runtime.projects.answer(params.id, AnswerProjectRequest.parse(await body()))
      runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { resolved }
    },
    // The workstations: every Project's card, one Project's page with the first page of each section, its paged sections,
    // and the two writes a person makes — creating a station, and changing one's settings or archive state.
    'GET projects': ({ query }) => projectList(views(runtime), ProjectsQuery.parse(query).status),
    'GET projects/:id': ({ params }) => {
      const detail = projectDetail(views(runtime), project(params.id), runtime.health, setupState(runtime))
      if (!detail) throw new UserError('projectUnknown', { project: params.id })
      return detail
    },
    'GET projects/:id/tickets': ({ params, query }) => {
      const { state, offset, limit } = ProjectTicketsQuery.parse(query)
      return projectTicketList(views(runtime), project(params.id), state, offset, limit)
    },
    'GET projects/:id/threads': ({ params, query }) => {
      const { filter, offset, limit } = ProjectThreadsQuery.parse(query)
      return projectThreadList(views(runtime), project(params.id), filter, offset, limit)
    },
    'GET projects/:id/decisions': ({ params, query }) => {
      const { offset, limit } = SourcesQuery.parse(query)
      return projectDecisionList(views(runtime), project(params.id), offset, limit)
    },
    // A Project's agent history: its Tickets, delivered artifacts and Assignment reports, each newest first.
    'GET projects/:id/history': ({ params, query }) => {
      const { limit } = ProjectHistoryQuery.parse(query)
      const detail = projectHistory(views(runtime), project(params.id), limit)
      if (!detail) throw new UserError('projectUnknown', { project: params.id })
      return detail
    },
    'POST projects': async ({ body }) => {
      const request = NewProjectRequest.parse(await body())
      return { project: runtime.projects.createStation({ name: request.name, location: request.location,
        ...request.kind ? { kind: request.kind } : {} }) }
    },
    'PATCH projects/:id': async ({ params, body }) =>
      ({ project: runtime.projects.update(project(params.id), ProjectPatchRequest.parse(await body())) }),
    // The artifact index: one page of delivered files, filtered by Project, Source, Ticket or a name or hash; and one
    // artifact's page with the chain back to its Ticket, Assignment and worker Session. Its file is served beside these routes.
    'GET artifacts': ({ query }) => {
      const { q, project: projectId, source, ticket, offset: from, limit: size } = ArtifactsQuery.parse(query)
      return artifactList(views(runtime), { q, project: projectId, source, ticket }, from, size)
    },
    'GET artifacts/:id': ({ params, query }) => {
      const detail = artifactDetail(views(runtime), params.id, ArtifactQuery.parse(query).assignment)
      if (!detail) throw new RouteError(404, 'Artifact not found')
      return detail
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, source, offset, limit } = TicketsQuery.parse(query)
      // An old bare kind names the kind's default instance, as the Source page links with instance ids.
      const instance = source ? runtime.sources.instanceFor(source)?.id ?? source : undefined
      return ticketList(views(runtime), state, offset, limit, instance)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      // A source's own block and a source's own policy part name a configured instance; a global block names no instance.
      const instance = block.startsWith('source:') ? block.slice('source:'.length)
        : block.startsWith('policy:') ? block.slice('policy:'.length) : undefined
      if (instance !== undefined && !runtime.sources.instances().some(item => item.id === instance)) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'GET models': () => runtime.models(),
    // One Source instance's prompt configuration: its Tickets' worker Sessions read it; an instance that never saved inherits the
    // installation's default configuration, which the routes below keep serving for the main Session and older tool calls.
    'GET sources/:id/prompts': ({ params, query }) => {
      const { revision, offset } = PromptsQuery.parse(query)
      const id = sourceOf(params.id)
      return { ...promptsView(runtime, revision, offset, id), source: id }
    },
    'PUT sources/:id/prompts': async input => {
      const id = sourceOf(input.params.id)
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel', id)
    },
    'POST sources/:id/prompts/preview': async input => runtime.prompts.preview(sourceOf(input.params.id), await promptBody(input)),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(undefined, await promptBody(input)),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  const table = routes(runtime)
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      try {
        await runtime.ready
        const segments = url.pathname.slice('/orchestrator/api/'.length).split('/')
        // An artifact download answers with the file's bytes, not the JSON of a management route; it keeps the same-origin
        // check above, so the panel fetches it with the request header and hands the bytes to the browser.
        if ((req.method ?? 'GET') === 'GET' && segments.length === 3 && segments[0] === 'artifacts' && segments[2] === 'file') {
          const file = artifactFile(runtime.store, decoded(segments[1]!))
          if (!file) throw new RouteError(404, 'Artifact not found')
          await sendFile(res, file)
          return
        }
        const route = match(table, req.method ?? 'GET', segments)
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => { for (const dispose of disposers) dispose() }
}
