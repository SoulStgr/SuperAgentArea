/** Typed panel routes, route parser, and sessionStorage location history. */
import { THREAD_FILTERS, TICKET_FILTERS, type ThreadFilter, type TicketFilter } from '../app/api.ts'
import type { SetupPlace } from '../setup.ts'
import { DECISION_FILTERS, type DecisionFilter } from './api.ts'
import type { T } from './text.ts'

export const TABS = ['overview', 'source', 'workstations', 'artifacts', 'settings'] as const
export type Tab = typeof TABS[number]
/**
 * The Settings page's groups, the Source types and their accounts first: the accounts of every Source kind, routing and
 * Eval, the Executor with its environment, and Deployment.
 */
export const SETTINGS_GROUPS = ['sources', 'routing', 'execution', 'deployment'] as const
export type SettingsGroup = typeof SETTINGS_GROUPS[number]
/** The group Settings opens when no group was left open: the Source types and their accounts. */
export const DEFAULT_SETTINGS_GROUP: SettingsGroup = 'sources'
/** The sections of one Source instance's page: its last day and its settings. Its Policy and prompts have a page of their own. */
export const SOURCE_SEGMENTS = ['overview', 'config'] as const
export type SourceSegment = typeof SOURCE_SEGMENTS[number]
/** The two parts of a Source's Policy and prompts page: the rules its work is assessed by, and the prompts its workers read. */
export const GOVERNANCE_PARTS = ['policy', 'prompts'] as const
export type GovernancePart = typeof GOVERNANCE_PARTS[number]
/** The sections of one workstation's page: its Sources, Threads, Decisions, Tickets, settings and the agent placeholder. */
export const PROJECT_SEGMENTS = ['sources', 'triggers', 'decisions', 'tickets', 'settings', 'agent'] as const
export type ProjectSegment = typeof PROJECT_SEGMENTS[number]
export type Route = { page: 'overview'; id?: undefined; query?: undefined }
  | { page: 'source'; id?: undefined; query?: undefined }
  | { page: 'source'; id: string; query?: { segment?: SourceSegment } }
  | { page: 'governance'; id: string; query?: { part?: GovernancePart } }
  | { page: 'workstations'; id?: undefined; query?: undefined }
  | { page: 'workstations'; id: string; query?: { segment?: ProjectSegment } }
  | { page: 'artifacts'; id?: undefined; query?: { project?: string; source?: string; q?: string } }
  | { page: 'artifacts'; id: string; query?: undefined }
  | { page: 'decisions'; id?: undefined; query?: { filter?: DecisionFilter; window?: '24h' } }
  | { page: 'trigger'; id?: undefined; query?: { filter?: ThreadFilter } }
  | { page: 'trigger'; id: string; query?: { trigger?: string } }
  | { page: 'execution'; id?: undefined; query?: { filter?: TicketFilter } }
  | { page: 'execution'; id: string; query?: undefined }
  | { page: 'settings'; id?: undefined; query: { group: SettingsGroup } }
export const HOME: Route = { page: 'overview' }
export const settingsRoute = (group: SettingsGroup): Route => ({ page: 'settings', query: { group } })
/** One Source instance's page, at one of its sections: its last day or its settings. */
export const sourceRoute = (id: string, segment: SourceSegment = 'overview'): Route =>
  segment === 'overview' ? { page: 'source', id } : { page: 'source', id, query: { segment } }
/** One Source instance's Policy and prompts, a page of its own with the part it opens. */
export const governanceRoute = (id: string, part: GovernancePart = 'policy'): Route =>
  part === 'policy' ? { page: 'governance', id } : { page: 'governance', id, query: { part } }
/** The latest Decisions the Policy produced, by kind and to the last day; no tab of its own, reached from the overview. */
export const decisionsRoute = (query: { filter?: DecisionFilter; window?: '24h' } = {}): Route => {
  const value = compact(query)
  return value ? { page: 'decisions', query: value } : { page: 'decisions' }
}
/** Where a setup problem is fixed: Deployment, or the settings of the Source instance it names. */
export const setupPage = (place: SetupPlace): Route =>
  place === 'deployment' ? settingsRoute('deployment') : sourceRoute(place, 'config')
export const routeLabel = (t: T, route: Route): string =>
  route.id ? t(route.page === 'trigger' ? 'term.thread' : route.page === 'source' ? 'term.source'
    : route.page === 'governance' ? 'sourcePolicyPrompts'
    : route.page === 'workstations' ? 'tab.workstations' : route.page === 'artifacts' ? 'term.artifact' : 'term.ticket')
    : t(`tab.${route.page}`)

const pick = <V extends string>(values: readonly V[], value: unknown): V | undefined => values.find(item => item === value)
function compact<Q extends object>(query: Q): Q | undefined {
  const set = Object.entries(query).filter(([, value]) => value !== undefined)
  return set.length ? Object.fromEntries(set) as Q : undefined
}
/**
 * Validate and normalize a stored route, dropping unrecognized segments or removed pages. A Source's Policy and prompts
 * moved off its page onto a page of their own: an old `source?segment=governance` opens that page. Prompts and Policy are
 * no longer pages: an old Prompts route opens the Sources, an old Policy route opens the Sources too (a Source owns its
 * rules) except its Eval section, which opens the Routing and Eval settings, and its Decisions, which keep their page. An
 * old Eval route opens the Decisions. A Settings group that moved or no longer exists opens the Source types settings.
 */
export function parseRoute(value: unknown): Route | undefined {
  const { page, id, query } = (value ?? {}) as { page?: unknown; id?: unknown; query?: Record<string, unknown> }
  const text = (name: string) => typeof query?.[name] === 'string' ? query[name] as string : undefined
  const record = typeof id === 'string' && id ? id : undefined
  switch (page) {
    case 'overview': return { page }
    case 'source': return record ? query?.segment === 'governance' ? governanceRoute(record)
      : { page, id: record, query: compact({ segment: pick(SOURCE_SEGMENTS, query?.segment) }) } : { page }
    case 'governance': return record ? governanceRoute(record, pick(GOVERNANCE_PARTS, query?.part) ?? 'policy') : { page: 'source' }
    case 'workstations': return record ? { page, id: record, query: compact({ segment: pick(PROJECT_SEGMENTS, query?.segment) }) }
      : { page }
    case 'artifacts': return record ? { page, id: record }
      : { page, query: compact({ project: text('project'), source: text('source'), q: text('q') }) }
    case 'prompts': return { page: 'source' }
    case 'policy':
      if (query?.segment === 'eval') return settingsRoute('routing')
      if (query?.segment === 'decisions') return decisionsRoute({ filter: pick(DECISION_FILTERS, query?.filter),
        window: query?.window === '24h' ? '24h' : undefined })
      return { page: 'source' }
    case 'decisions': return decisionsRoute({ filter: pick(DECISION_FILTERS, query?.filter),
      window: query?.window === '24h' ? '24h' : undefined })
    case 'eval': return decisionsRoute({ filter: pick(DECISION_FILTERS, query?.filter),
      window: query?.window === '24h' ? '24h' : undefined })
    case 'trigger': return record ? { page, id: record, query: compact({ trigger: text('trigger') }) }
      : { page, query: compact({ filter: pick(THREAD_FILTERS, query?.filter) }) }
    case 'execution': return record ? { page, id: record } : { page, query: compact({ filter: pick(TICKET_FILTERS, query?.filter) }) }
    case 'settings': {
      const group = pick(SETTINGS_GROUPS, query?.group)
      if (group) return { page, query: { group } }
      // Older groups: Eval settings live in Routing and Eval, and the Source and Prompts groups open the Source types.
      if (query?.group === 'eval') return settingsRoute('routing')
      return query?.group === 'source' || query?.group === 'prompts' ? settingsRoute('sources')
        : settingsRoute(DEFAULT_SETTINGS_GROUP)
    }
    default: return undefined
  }
}

const ROUTE_KEY = 'dsh-superagentarea/route'
export interface Location { route: Route; stack: Route[]; group?: SettingsGroup | undefined }
export const lastSettingsGroup = ({ route, group }: Location): SettingsGroup => route.page === 'settings' ? route.query.group
  : group ?? DEFAULT_SETTINGS_GROUP
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
