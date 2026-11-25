/**
 * The Project registry's behaviour: resolving the Project a Trigger belongs to (its instance's default, the event's hints,
 * or the registered names and addresses), creating the station a person answered with, and keeping the answer a thread
 * gave until a Project resolves it. An assessment may propose an address, but only a person's answer creates one.
 */
import { threadKey, type Decision, type PersonRef, type ProjectCandidate, type ProjectHint, type ProjectKind,
  type ProjectLocation, type ProjectProposal, type ProjectRecord, type Trigger } from '../core/index.ts'
import { UserError } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Settings } from '../policy.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { prepareProjectDirectories, projectName, normalizedPath, underPath, uniqueProjectKey, type ProjectDirectories } from './projects.ts'
import type { Store } from './store.ts'

/** The person a management-panel answer is recorded as: the panel authenticates the machine, not one person. */
export const PANEL_PERSON: PersonRef = { source: 'panel', id: 'panel', name: 'panel' }
/** The person an assessment's proposal is recorded as: the agent proposes, and only a person confirms. */
export const ASSESSOR_PERSON: PersonRef = { source: 'orchestrator', id: 'orchestrator', name: 'agent' }

/** What the Project service reads and writes: Projects, Decisions, Triggers, the answer records, and the current settings. */
export interface ProjectHost {
  readonly store: Pick<Store, 'projects' | 'decisions' | 'triggers' | 'get' | 'set'>
  readonly sources: Pick<SourceRegistry, 'projectHints'>
  settings(): Settings
  readonly stateDir: string
  now?(): string
}
/** How a Trigger's Project was resolved; `undefined` when no registered Project fits. */
export interface Resolution {
  project?: ProjectRecord
  /** The active stations the question offers as candidates, newest first. */
  candidates: ProjectCandidate[]
  /** What the Source stated about the Project: a name, a local path, or a repository address, marked when it states one outright. */
  hints: ProjectHint[]
  /** The hints that state a Project outright, such as a `PROJECT.md`, a bracketed task name or a chat title. */
  strongHints: ProjectHint[]
  /**
   * Whether the Trigger names a Project no registered one fits: the request is asked about instead of continuing in the
   * workspace. A Trigger that only hints at one, or states nothing, still belongs to the workspace.
   */
  needsQuestion: boolean
  via?: 'answer' | 'default' | 'match'
}
/** The question a Thread waits to answer: the `needsProject` Decision, its Trigger, and what it offers. */
export interface PendingProject {
  decision: Decision
  trigger: Trigger
  candidates: ProjectCandidate[]
  proposal?: ProjectProposal
}
/** A new Project a person named: its name, its address, and (for `adhoc`) its kind. */
export interface NewProject { name: string; location: ProjectLocation; kind?: Extract<ProjectKind, 'station' | 'adhoc'>; sourceIds?: string[]
  specifiedBy?: PersonRef; confirmedBy?: PersonRef }
/** A person's answer to a Project question: an existing Project, a new one, or the assessment's proposal confirmed. */
export type ProjectAnswer = { projectId: string } | { new: NewProject } | { confirmProposal: true }

/** The active stations a question offers: the built-in workspace is not a station, so it is not a candidate. */
export function projectCandidates(projects: readonly ProjectRecord[], limit = 20): ProjectCandidate[] {
  return projects.filter(project => project.status === 'active' && project.value.kind !== 'workspace')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit).map(project => ({ id: project.id, name: project.value.name, kind: project.value.kind }))
}
/** The candidates and proposal a `needsProject` Decision carries, or undefined for another Decision. */
export function needsProjectValues(decision: Decision): { candidates: ProjectCandidate[]; proposal?: ProjectProposal } | undefined {
  if (decision.kind !== 'stop') return undefined
  const reason = decision.reason.find(item => item.code === 'needsProject')
  if (!reason) return undefined
  const values = reason.values ?? {}
  const candidates = Array.isArray(values.candidates) ? values.candidates.flatMap((item): ProjectCandidate[] => {
    if (!item || typeof item !== 'object') return []
    const candidate = item as Record<string, unknown>
    return typeof candidate.id === 'string' && typeof candidate.name === 'string' && typeof candidate.kind === 'string'
      ? [{ id: candidate.id, name: candidate.name, kind: candidate.kind as ProjectKind }] : []
  }) : []
  const proposal = proposalOf(values.proposal)
  return { candidates, ...proposal ? { proposal } : {} }
}
/** A `ProjectProposal` from stored reason values, or undefined when the value is not one. */
function proposalOf(value: unknown): ProjectProposal | undefined {
  if (!value || typeof value !== 'object') return undefined
  const proposal = value as Record<string, unknown>
  const location = locationOf(proposal.location)
  return typeof proposal.name === 'string' && proposal.name.trim() && location ? { name: proposal.name, location } : undefined
}
/** A `ProjectLocation` from stored or submitted values, or undefined when the value is not one. */
export function locationOf(value: unknown): ProjectLocation | undefined {
  if (!value || typeof value !== 'object') return undefined
  const location = value as Record<string, unknown>
  const text = (item: unknown): string | undefined => typeof item === 'string' && item.trim() ? item.trim() : undefined
  if (location.type === 'managed') return { type: 'managed' }
  if (location.type === 'folder') return text(location.path) ? { type: 'folder', path: text(location.path)! } : undefined
  if (location.type === 'repo') {
    const path = text(location.path), url = text(location.url), branch = text(location.branch)
    if (!path && !url) return undefined
    return { type: 'repo', ...path ? { path } : {}, ...url ? { url } : {}, ...branch ? { branch } : {} }
  }
  return undefined
}
/** Whether an address reads as a repository rather than a local folder, by its protocol or scp form. */
export const repositoryAddress = (address: string): boolean => /^(?:https|ssh|file):\/\/|^[\w.-]+@[\w.-]+:/.test(address.trim())
/**
 * The address an assessment proposed as a Project location: a repository for an address with a protocol or scp form, a
 * folder for any other absolute path, and a managed directory when none is given. The validity of the address is checked
 * when a person's confirmation creates the Project.
 */
export function locationOfAddress(address?: string): ProjectLocation {
  const trimmed = address?.trim()
  if (!trimmed) return { type: 'managed' }
  return repositoryAddress(trimmed) ? { type: 'repo', url: trimmed } : { type: 'folder', path: trimmed }
}

/** A normalized form of a Project name for matching: case and whitespace do not matter. */
const normalizedName = (name: string): string => name.toLowerCase().replace(/\s+/g, '')
/** A normalized repository address, so https, ssh and scp forms of one repository compare equal. */
export function normalizedRepository(url: string): string {
  const trimmed = url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(trimmed)
  if (scp) return `${scp[1]}/${scp[2]}`
  return trimmed.replace(/^(?:https?|ssh|git|file):\/\//, '').replace(/^git@/, '').replace(/\/+$/, '')
}
/** The Project a hint names: its key, name or an alias, then its folder path or its repository address. */
export function matchProject(projects: readonly ProjectRecord[], hint: ProjectHint): ProjectRecord | undefined {
  const text = (value: string | undefined): string => normalizedName(value ?? '')
  if (hint.name) {
    const name = text(hint.name)
    const named = projects.find(project => [project.key, project.value.name, ...project.value.aliases].some(value => text(value) === name))
    if (named) return named
  }
  if (hint.path) {
    const path = normalizedPath(hint.path)
    const folder = projects.find(project => {
      if (project.value.location.type !== 'folder') return false
      const root = normalizedPath(project.value.location.path)
      return path === root || underPath(hint.path!, project.value.location.path)
    })
    if (folder) return folder
  }
  if (hint.url) {
    const url = normalizedRepository(hint.url)
    const repository = projects.find(project => project.value.location.type === 'repo'
      && !!project.value.location.url && normalizedRepository(project.value.location.url) === url)
    if (repository) return repository
  }
  return undefined
}

/**
 * Resolves the Project a Trigger belongs to, before any ticket exists (see plan §2.5): the answer its Thread already gave,
 * then its Source instance's default Project, then what the event itself states. A Trigger whose event states a Project
 * no registered one fits is asked about (`needsQuestion`, the `needsProject` refusal), while one that only hints at a
 * Project, or states none, belongs to no station and continues in the workspace.
 */
export class ProjectService {
  constructor(private readonly host: ProjectHost) {}
  private now(): string { return this.host.now?.() ?? new Date().toISOString() }
  private active(projectId: string | undefined): ProjectRecord | undefined {
    const project = projectId ? this.host.store.projects.get(projectId) : undefined
    return project?.status === 'active' ? project : undefined
  }
  /** The active stations a question offers. */
  candidates(): ProjectCandidate[] { return projectCandidates(this.host.store.projects.list()) }
  /** Resolves a Trigger's Project: a Thread's answer, its instance's default, then its hints against the registry. */
  resolve(trigger: Trigger): Resolution {
    const candidates = this.candidates()
    const answered = this.active(this.host.store.get(KV.projects.answers(threadKey(trigger.threads[0]!))))
    if (answered) return { project: answered, candidates, hints: [], strongHints: [], needsQuestion: false, via: 'answer' }
    const { defaultProjectId, hints } = this.host.sources.projectHints(trigger, this.host.settings())
    const strongHints = hints.filter(hint => hint.strong)
    const fallback = this.active(defaultProjectId)
    if (fallback) return { project: fallback, candidates, hints, strongHints, needsQuestion: false, via: 'default' }
    const projects = this.host.store.projects.list('active')
    for (const hint of hints) {
      const project = matchProject(projects, hint)
      if (project) return { project, candidates, hints, strongHints, needsQuestion: false, via: 'match' }
    }
    return { candidates, hints, strongHints, needsQuestion: strongHints.length > 0 }
  }
  /**
   * The Thread's unanswered Project question: its newest Decision is a `needsProject` stop, with that Decision, the Trigger
   * it refused, and what it offered. A Trigger on such a Thread may answer it; the panel answers the refused one.
   */
  pending(trigger: Trigger): PendingProject | undefined {
    const decisions = this.host.store.decisions.byThread(threadKey(trigger.threads[0]!))
    const decision = decisions.at(-1)
    const values = decision ? needsProjectValues(decision) : undefined
    const refused = decision?.triggerIds.map(id => this.host.store.triggers.get(id)).find((item): item is Trigger => !!item)
    return decision && values && refused ? { decision, trigger: refused, ...values } : undefined
  }
  /**
   * Answers a Thread's Project question: an existing Project, a new station the person named, or the assessment's proposal
   * the person confirmed. The answer is remembered for the Thread and the Trigger goes back to Eval, which then resolves the
   * Project and accepts it.
   * @throws UserError `unknownTrigger`, `notNeedsProject`, `projectUnknown` or `projectLocationInvalid`.
   */
  answer(triggerId: string, answer: ProjectAnswer): { resolved: string; triggerId: string } {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    const pending = this.pending(trigger)
    // The panel answers the Trigger the question refused; another Trigger on the Thread is not waiting for it.
    if (!pending || !pending.decision.triggerIds.includes(trigger.id)) throw new UserError('notNeedsProject')
    let project: ProjectRecord
    if ('projectId' in answer) {
      const found = this.active(answer.projectId)
      if (!found) throw new UserError('projectUnknown', { project: answer.projectId })
      project = found
    } else if ('new' in answer) {
      project = this.create({ ...answer.new, sourceIds: answer.new.sourceIds ?? [trigger.source],
        specifiedBy: answer.new.specifiedBy ?? PANEL_PERSON, confirmedBy: answer.new.confirmedBy ?? PANEL_PERSON })
    } else {
      if (!pending.proposal) throw new UserError('projectUnknown', { project: 'proposal' })
      project = this.create({ ...pending.proposal, kind: 'station', sourceIds: [trigger.source], specifiedBy: ASSESSOR_PERSON,
        confirmedBy: PANEL_PERSON })
    }
    this.host.store.set(KV.projects.answers(threadKey(trigger.threads[0]!)), project.id)
    return { resolved: project.id, triggerId }
  }
  /**
   * Creates a Project from a person's answer: validates its address, lays out its directories, and records who named and who
   * confirmed it. A model's proposal alone is never enough: an external address without a person's confirmation is refused.
   * @throws UserError `projectLocationInvalid` or `projectSpecifiedByModel`.
   */
  create(request: NewProject): ProjectRecord {
    if (request.specifiedBy?.source === ASSESSOR_PERSON.source && !request.confirmedBy) {
      throw new UserError('projectSpecifiedByModel')
    }
    const name = projectName(request.name)
    if (!name) throw new UserError('projectLocationInvalid', { reason: 'the Project needs a name' })
    const kind: ProjectKind = request.kind ?? 'station'
    const settings = this.host.settings()
    const projects = this.host.store.projects.list()
    const projectKey = uniqueProjectKey(name, projects.map(project => project.key))
    const directories: ProjectDirectories = prepareProjectDirectories(request.location, kind, projectKey, settings, this.host.stateDir)
    const at = this.now()
    const project: ProjectRecord = { id: `prj_${projectKey}`, key: projectKey, status: 'active', createdAt: at, updatedAt: at,
      value: { name, kind, location: request.location, ...directories, sourceIds: [...request.sourceIds ?? []], aliases: [],
        ...request.specifiedBy ? { specifiedBy: request.specifiedBy } : {}, ...request.confirmedBy ? { confirmedBy: request.confirmedBy } : {} } }
    this.host.store.projects.save(project)
    return project
  }
}
