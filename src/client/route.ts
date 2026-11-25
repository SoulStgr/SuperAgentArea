/** Typed panel routes, route parser, and sessionStorage location history. */
import { THREAD_FILTERS, TICKET_FILTERS, type ThreadFilter, type TicketFilter } from '../app/api.ts'
import type { SetupPlace } from '../setup.ts'
import { DECISION_FILTERS, type DecisionFilter } from './api.ts'
import type { T } from './text.ts'

export const TABS = ['overview', 'source', 'workstations', 'artifacts', 'prompts', 'policy'] as const
export type Tab = typeof TABS[number]
/** The Settings page's groups; Source, Eval and Prompts settings moved to their own pages. */
export const SETTINGS_GROUPS = ['execution', 'deployment'] as const
export type SettingsGroup = typeof SETTINGS_GROUPS[number]
/** The sections of the Policy page: rules and admission, Eval settings, and the latest Decisions. */
export const POLICY_SEGMENTS = ['rules', 'eval', 'decisions'] as const
export type PolicySegment = typeof POLICY_SEGMENTS[number]
/** The sections of one workstation's page: its Sources, Threads, Decisions, Tickets, settings and the agent placeholder. */
export const PROJECT_SEGMENTS = ['sources', 'triggers', 'decisions', 'tickets', 'settings', 'agent'] as const
export type ProjectSegment = typeof PROJECT_SEGMENTS[number]
export type Route = { page: 'overview'; id?: undefined; query?: undefined }
  | { page: 'source'; id?: undefined; query?: undefined }
  | { page: 'source'; id: string; query?: undefined }
  | { page: 'workstations'; id?: undefined; query?: undefined }
  | { page: 'workstations'; id: string; query?: { segment?: ProjectSegment } }
  | { page: 'artifacts'; id?: undefined; query?: { project?: string; source?: string; q?: string } }
  | { page: 'artifacts'; id: string; query?: undefined }
  | { page: 'prompts'; id?: undefined; query?: undefined }
  | { page: 'policy'; id?: undefined; query?: { segment?: PolicySegment; filter?: DecisionFilter; window?: '24h'; version?: string } }
  | { page: 'trigger'; id?: undefined; query?: { filter?: ThreadFilter } }
  | { page: 'trigger'; id: string; query?: { trigger?: string } }
  | { page: 'execution'; id?: undefined; query?: { filter?: TicketFilter } }
  | { page: 'execution'; id: string; query?: undefined }
  | { page: 'settings'; id?: undefined; query: { group: SettingsGroup } }
export const HOME: Route = { page: 'overview' }
export const settingsRoute = (group: SettingsGroup): Route => ({ page: 'settings', query: { group } })
/** The Policy page's route; a Decision filter and the 24-hour window belong to its latest-Decisions section. */
export const policyRoute = (query: { segment?: PolicySegment; filter?: DecisionFilter; window?: '24h'; version?: string } = {}): Route => {
  const value = compact(query)
  return value ? { page: 'policy', query: value } : { page: 'policy' }
}
/** Where a setup problem is fixed: Deployment, or the page of the Source instance it names. */
export const setupPage = (place: SetupPlace): Route =>
  place === 'deployment' ? settingsRoute('deployment') : { page: 'source', id: place }
export const routeLabel = (t: T, route: Route): string =>
  route.id ? t(route.page === 'trigger' ? 'term.thread' : route.page === 'source' ? 'term.source'
    : route.page === 'workstations' ? 'tab.workstations' : route.page === 'artifacts' ? 'term.artifact' : 'term.ticket')
    : t(`tab.${route.page}`)

const pick = <V extends string>(values: readonly V[], value: unknown): V | undefined => values.find(item => item === value)
function compact<Q extends object>(query: Q): Q | undefined {
  const set = Object.entries(query).filter(([, value]) => value !== undefined)
  return set.length ? Object.fromEntries(set) as Q : undefined
}
/**
 * Validate and normalize a stored route, dropping unrecognized query filters or removed tabs. An old `eval` route opens
 * the Policy page's latest Decisions, and an old Settings group (Source, Eval or Prompts) opens Execution settings.
 */
export function parseRoute(value: unknown): Route | undefined {
  const { page, id, query } = (value ?? {}) as { page?: unknown; id?: unknown; query?: Record<string, unknown> }
  const text = (name: string) => typeof query?.[name] === 'string' ? query[name] as string : undefined
  const record = typeof id === 'string' && id ? id : undefined
  switch (page) {
    case 'overview': return { page }
    case 'source': return record ? { page, id: record } : { page }
    case 'workstations': return record ? { page, id: record, query: compact({ segment: pick(PROJECT_SEGMENTS, query?.segment) }) }
      : { page }
    case 'artifacts': return record ? { page, id: record }
      : { page, query: compact({ project: text('project'), source: text('source'), q: text('q') }) }
    case 'prompts': return { page }
    case 'policy': return policyRoute({ segment: pick(POLICY_SEGMENTS, query?.segment), filter: pick(DECISION_FILTERS, query?.filter),
      window: query?.window === '24h' ? '24h' : undefined, version: text('version') })
    case 'eval': return policyRoute({ segment: 'decisions', filter: pick(DECISION_FILTERS, query?.filter),
      window: query?.window === '24h' ? '24h' : undefined })
    case 'trigger': return record ? { page, id: record, query: compact({ trigger: text('trigger') }) }
      : { page, query: compact({ filter: pick(THREAD_FILTERS, query?.filter) }) }
    case 'execution': return record ? { page, id: record } : { page, query: compact({ filter: pick(TICKET_FILTERS, query?.filter) }) }
    case 'settings': return { page, query: { group: pick(SETTINGS_GROUPS, query?.group) ?? 'execution' } }
    default: return undefined
  }
}

const ROUTE_KEY = 'dsh-superagent/route'
export interface Location { route: Route; stack: Route[]; group?: SettingsGroup | undefined }
export const lastSettingsGroup = ({ route, group }: Location): SettingsGroup => route.page === 'settings' ? route.query.group
  : group ?? 'execution'
export function initialLocation(): Location {
  try {
    const stored = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? 'null') as { route?: unknown; stack?: unknown; group?: unknown } | null
    const route = parseRoute(stored?.route)
    const stack = Array.isArray(stored?.stack) ? stored.stack as unknown[] : []
    if (route) return { route, stack: stack.flatMap(item => parseRoute(item) ?? []), group: pick(SETTINGS_GROUPS, stored?.group) }
  } catch (error) {
    // Route memory is a convenience; an unreadable value falls back to HOME.
    void error
  }
  return { route: HOME, stack: [] }
}
export function remember(location: Location): void {
  try { sessionStorage.setItem(ROUTE_KEY, JSON.stringify(location)) } catch (failure) { void failure /* Route memory is a convenience. */ }
}
