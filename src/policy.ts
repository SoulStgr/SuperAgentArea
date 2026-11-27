/**
 * Runtime settings schemas, assessment validation, and policy gate evaluation.
 * Who may originate work is configured per Source in that Source's own identities; the Policy never maps a person across Sources.
 */
import { LIMITS } from './limits.ts'
import { z } from 'zod'
import { ADMISSION_DEFAULTS, type Admission, type AdmissionCell, type AdmissionRow } from './admission.ts'
import { key, type AssessmentOutcome, type Mandate, type PersonRef, type Policy, type PolicyEffect, type ProjectProposal, type ProjectLocation,
  type SourceScope, type Strength, type Thread, type Ticket, type Trigger, type ActorRef, type GateResult } from './core/index.ts'
import { sameName } from './infra/text.ts'
import { WORKER_COMMANDS } from './infra/environment.ts'

export const RuleIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
export const RuleMatchSchema = z.object({ rule_id: RuleIdSchema, reason: z.string().trim().min(1).max(500) }).strict()
export type RuleMatch = z.infer<typeof RuleMatchSchema>
export const RuleAssessmentSchema = RuleMatchSchema.extend({ matched: z.boolean() }).strict()
export type RuleAssessment = z.infer<typeof RuleAssessmentSchema>
export const AdmissionDirectionSchema = z.object({
  implementation_requested: z.boolean(),
  target_basis: z.enum(['specified', 'existing-standard', 'undetermined']),
  requires_design_decision: z.boolean(),
  evidence: z.string().trim().min(1).max(700),
}).strict()
export type AdmissionDirection = z.infer<typeof AdmissionDirectionSchema>
/** Check whether an assessment established implementation intent and a settled target without open design decisions. */
export function directionAllowed(value: unknown): value is AdmissionDirection {
  const result = AdmissionDirectionSchema.safeParse(value)
  return result.success && result.data.implementation_requested && result.data.target_basis !== 'undetermined' && !result.data.requires_design_decision
}
/** A person an assessment names, by the id its Source knows them by, with the name that Source shows. */
export interface AssessedPerson { id: string; name?: string }
export interface Assessment {
  decision: 'accept' | 'ignore' | 'unavailable' | 'needsProject'; rule_assessments: RuleAssessment[]; direction: unknown
  title: string; scope: string; reason: string; intent_evidence?: string | null; acknowledgement?: string | null; worktree_name?: string
  /** The Source id of who reports accepted work, and the Source ids of the people the discussion asks to look at it. */
  reporter?: AssessedPerson | string | null; mentions?: (AssessedPerson | string)[] | null
  /** A new workstation's name and address the discussion suggests; only a person's confirmation creates it. */
  proposal?: { name: string; address?: string } | null
  /** This Trigger is a person's explicit confirmation of the Thread's pending proposal. */
  confirm_proposal?: boolean | null
}
/**
 * Validate an assessment against enabled rules and convert it into an engine `AssessmentOutcome`.
 * Acceptance requires a settled direction, at least one matched enabled rule, and `intent_evidence`, and accepts an
 * inferred candidate only in `auto` mode (otherwise recording it as `would_accept`). A `needsProject` outcome records the
 * refusal before any rule check and turns the proposed address into a Project location; `source` gives the Source the
 * assessed people belong to, and people are kept only when it is given.
 * @throws when `rule_assessments` does not cover every enabled rule exactly once, or an accept omits `intent_evidence`.
 */
export function assessmentOutcome(assessment: Assessment, settings: Pick<Settings, 'policy' | 'eval'>, strength: Strength,
  source?: string): AssessmentOutcome {
  const enabled = rulesFor(settings, source).filter(rule => rule.enabled)
  const judged = assessment.rule_assessments
  const ids = new Set(judged.map(item => item.rule_id))
  if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some(rule => !ids.has(rule.id))) {
    throw new Error('Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed')
  }
  const matches = judged.filter(item => item.matched).map(({ rule_id, reason }) => ({ rule_id, reason }))
  const evidence = assessment.intent_evidence ? { intent_evidence: assessment.intent_evidence } : {}
  const audit = { matches, rule_assessments: judged, direction: assessment.direction, ...evidence }
  // A Project the host must resolve before work: the assessment proposes an address, and only a person confirms it.
  if (assessment.decision === 'needsProject') {
    const proposal = assessment.proposal ? { name: assessment.proposal.name, location: locationOf(assessment.proposal.address) } : undefined
    return { kind: 'needsProject', reason: assessment.reason, audit, ...proposal ? { proposal } : {} }
  }
  if (assessment.decision !== 'accept') return { kind: assessment.decision, reason: assessment.reason, audit }
  if (!directionAllowed(assessment.direction)) return { kind: 'ignore', audit, reason: { code: 'directionUnsettled' } }
  if (!matches.length) return { kind: 'ignore', audit, reason: { code: 'noRuleMatched' } }
  if (!assessment.intent_evidence) throw new Error('Acceptance requires intent_evidence')
  const { title, scope, worktree_name: name } = assessment
  if (strength === 'inferred' && settings.eval.mode !== 'auto') {
    const proposal = { title, scope, worktree_name: name }
    return { kind: 'ignore', audit: { ...audit, would_accept: true, proposal }, reason: { code: 'observed', values: { text: assessment.reason } } }
  }
  const person = (value: AssessedPerson | string | null | undefined): PersonRef | undefined => {
    if (!source || value == null) return undefined
    const id = typeof value === 'string' ? value.trim() : value.id.trim()
    const shown = typeof value === 'string' ? undefined : value.name
    return id ? { source, id, ...shown ? { name: shown } : {} } : undefined
  }
  const mentions = source && assessment.mentions ? assessment.mentions.flatMap(value => person(value) ?? []) : undefined
  const reporter = person(assessment.reporter)
  return { kind: 'accept', title, scope, reason: assessment.reason, ...(assessment.acknowledgement ? { acknowledgement: assessment.acknowledgement } : {}),
    rules: matches.map(match => match.rule_id), audit, ...(name ? { name } : {}), ...(reporter ? { reporter } : {}),
    ...(mentions?.length ? { mentions } : {}) }
}
/** The location an assessment's proposed address names: a repository for a protocol or scp address, otherwise a folder. */
function locationOf(address: string | undefined): ProjectLocation {
  const trimmed = address?.trim() ?? ''
  if (!trimmed) return { type: 'managed' }
  return /^(?:https|ssh|file):\/\/|^[\w.-]+@[\w.-]+:/.test(trimmed) ? { type: 'repo', url: trimmed } : { type: 'folder', path: trimmed }
}
/**
 * An assessment rule; its instruction may also specify PR reviewers and whether to wait for their approval.
 * Rules only decide whether a proactive candidate may be accepted: they neither create a workstation nor move work into
 * one or choose where deliverables land (the host asks a person when a new workstation is needed).
 */
export const RuleSchema = z.object({ id: RuleIdSchema, name: z.string().trim().min(1).max(LIMITS.ruleName), enabled: z.boolean(),
  instruction: z.string().trim().min(1).max(LIMITS.ruleInstruction) }).strict()
export type Rule = z.infer<typeof RuleSchema>
/**
 * The admission rules a new installation starts with, in English: the categories of proactive candidate the main Session
 * may accept. They affect proactive candidate acceptance only: they never create a workstation, and a request that needs
 * one is left to the host, which asks a person for its name and address. A person's own rule set replaces these defaults
 * for a Source instance; an installation an earlier build configured keeps its customized rules.
 */
export const DEFAULT_RULES: Rule[] = [
  { id: 'workstation-work', name: 'Workstation work', enabled: true,
    instruction: 'An explicit request for concrete work in an existing workstation: a code, configuration, documentation, copy or visual change, or another deliverable a person can check. The discussion settles which workstation, which target and what result is wanted, and the change is clearly separable and verifiable against the repository, the running product or another named deliverable. Do not invent design, product, rendering or interaction decisions the request leaves open; a reported defect does not authorize adjacent undefined restyling, and while direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question.' },
  { id: 'new-workstation', name: 'New workstation', enabled: true,
    instruction: 'A person asks for long-term work that should live in a workstation of its own rather than in a single change. Accept only what the discussion settles: the purpose of the workstation and the work it will hold. If the discussion does not state the workstation\'s name or address, do not invent either: the host asks a person, and only a person\'s answer creates the workstation. This rule never creates a workstation or moves existing work into one; it only decides whether this candidate may be accepted once a person has settled where the work belongs.' },
  { id: 'investigation', name: 'Investigation', enabled: true,
    instruction: 'An explicit request to investigate a problem, review a change, or analyze a behaviour and report a conclusion: find a cause, judge code or a pull request, measure something, or answer a question with evidence. The deliverable is the finding, review or analysis itself, not an implementation; the discussion names what to examine and which question to answer, and the conclusion can be checked against the repository, logs, tests or another named source. An open-ended look at a topic with no question to answer is not a match: do not invent the question or the expected conclusion, and observe only.' },
  { id: 'one-off-task', name: 'One-off task', enabled: true,
    instruction: 'An explicit request for one temporary piece of work with a clear end, such as converting one file, producing one report, running one check or making one hotfix, that does not continue the ongoing work of any workstation. The request names the deliverable and what finished means. This work lands in the workspace unless a person places it in a workstation; do not create or propose a workstation for it, and do not treat repeated or open-ended work as one-off.' },
]
/**
 * The admission rules installations of versions through 0.3.21 started with: copy and visual fixes. The one-time migration
 * replaces stored rules that are exactly these, and only these; a rule a person wrote is never rewritten.
 */
export const LEGACY_DEFAULT_RULES: readonly Rule[] = [
  { id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning.' },
  { id: 'visual', name: 'Visual fixes', enabled: true, instruction: 'Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question.' },
]
/** A Source instance's own rules: when present they replace the installation's default rules for that Source. */
export const RuleArraySchema = z.array(RuleSchema).refine(rules => new Set(rules.map(rule => rule.id)).size === rules.length, 'Duplicate rule IDs')
export const RoleModelSchema = z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1), reasoningEffort: z.string().trim().min(1).optional() }).strict()
export type RoleModel = z.infer<typeof RoleModelSchema>

export const AllowedSchema = z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()
const Weak = z.enum(['inferred', 'ignore'])
export const AdmissionRowSchema: z.ZodType<AdmissionRow> = z.object({ listedUnaddressed: Weak.optional(), unlistedAddressed: z.enum(['explicit', 'inferred', 'ignore']).optional(), unlistedUnaddressed: Weak.optional() }).strict()
export const AdmissionTableSchema = z.record(z.string(), AdmissionRowSchema)
export const SourcePolicySchema = z.object({ allowed: z.array(AllowedSchema).default([]), admission: AdmissionTableSchema.default({}),
  /** This Source instance's own admission rules; absent means the installation's default rules apply. */
  rules: RuleArraySchema.optional() }).catchall(z.unknown())
export type SourcePolicy = z.infer<typeof SourcePolicySchema>
/** A Source instance's id: a kind id, or `<kind>:<key>` for a named instance (old data keeps the bare kind). */
export const SourceInstanceIdSchema = z.string().regex(/^[a-z][a-z0-9-]*(?::[a-z0-9-]+)?$/)
/**
 * A stored conversation results are also delivered to, such as a monitored web Source's report destination. The
 * address is a frozen Channel address: a QQ or DingTalk conversation without its one-shot reply ids or expiring
 * session webhook, so the delivery is proactive. It never carries a credential.
 */
export const DeliveryTargetSchema = z.object({
  source: SourceInstanceIdSchema,
  thread: z.string().trim().min(1).max(500),
  address: z.record(z.string(), z.string().max(2_000)),
  /** A display name the panel shows for the destination; optional because a saved target may predate one. */
  label: z.string().trim().max(100).optional(),
}).strict()
export type DeliveryTarget = z.infer<typeof DeliveryTargetSchema>
export const PolicyConfigSchema = z.object({
  rules: RuleArraySchema.default(DEFAULT_RULES),
  sources: z.record(SourceInstanceIdSchema, SourcePolicySchema).default({}),
}).strict()
export const EvalConfigSchema = z.object({
  mode: z.enum(['off', 'observe', 'auto']).default('observe'),
  timeoutSeconds: z.number().int().min(LIMITS.evalTimeoutSeconds.min).max(LIMITS.evalTimeoutSeconds.max).default(120),
  model: RoleModelSchema.nullable().default(null),
}).strict()
const CommandNameSchema = z.string().regex(/^[A-Za-z0-9._-]+$/).refine(name => name !== '.' && name !== '..', 'Not a command name')
  .refine(name => !WORKER_COMMANDS.includes(name), `${WORKER_COMMANDS.join(', ')} cannot be blocked`)
/** Executor settings: worker model, concurrency, ticket directory root (empty defaults to `<stateDir>/area`), `prepare` command, and blocked commands. */
export const ExecutorConfigSchema = z.object({
  model: RoleModelSchema.nullable().default(null),
  maxWorkers: z.number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max).default(3),
  directory: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'An absolute path, or empty for <stateDir>/area').default(''),
  prepare: z.string().max(LIMITS.prepareCommand).default(''),
  blockedCommands: z.array(CommandNameSchema).default([]),
}).strict()
/**
 * A configured Source instance: `kind` names the installed kind whose schema validates `config`, the single instance's
 * configuration. Older databases stored only `{enabled, config}` under the kind id; the migration adds `kind`.
 */
export const SourceInstanceSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9-]*$/),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Human-readable name for the panel; instances without one show their kind's title and key. */
  label: z.string().trim().max(100).optional(),
  /** The Project that owns work from this instance (P2), kept as stored here. */
  defaultProjectId: z.string().trim().optional(),
  /** The conversation this instance's Ticket results are also delivered to, when its own Source has no reply route. */
  reportTo: DeliveryTargetSchema.optional(),
}).strict()
export const SettingsSchema = z.object({
  paused: z.boolean().default(false),
  /** Every configured Source instance by instance id (`<kind>` for an old single instance, else `<kind>:<key>`). */
  sources: z.record(SourceInstanceIdSchema, SourceInstanceSchema).default({}),
  policy: PolicyConfigSchema.default(() => PolicyConfigSchema.parse({})),
  eval: EvalConfigSchema.default(() => EvalConfigSchema.parse({})),
  executor: ExecutorConfigSchema.default(() => ExecutorConfigSchema.parse({})),
}).strict()
export type Settings = z.infer<typeof SettingsSchema>
export type SettingsBlock = 'policy' | 'eval' | 'executor' | `source:${string}` | `policy:${string}`
export type SettingsSave = SettingsBlock | 'pause'
export type SettingsOrigin = 'panel' | 'tool' | 'sync' | 'migration'

/**
 * The admission rules that apply to work from `source`: a Source instance's own rules when it has saved any, else the
 * installation's default rules. An unknown or absent source id falls back to the default rules.
 */
export function rulesFor(settings: Pick<Settings, 'policy'>, source?: string): Rule[] {
  const own = source === undefined ? undefined : settings.policy.sources[source]?.rules
  return own ?? settings.policy.rules
}

export const POLICY_REVISION = 'mandate-v3'
/**
 * Compute a version hash for settings that affect work authorization.
 * Changes to models, concurrency, pause state, or polling intervals do not invalidate existing decisions.
 */
export function policyVersion(settings: Settings): string {
  return key(POLICY_REVISION, JSON.stringify({ rules: settings.policy.rules, mode: settings.eval.mode, sources: settings.policy.sources }))
}
export function allowedSender(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  return settings.policy.sources[actor.source]?.allowed.find(entry => sameName(entry.id, actor.id))
}
/** Look up `actor` in the Source's `bots` policy list (validated by the Source's kind), whose messages are admitted as inferred candidates at most. */
export function listedBot(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  const bots = z.array(AllowedSchema).catch([]).parse(settings.policy.sources[actor.source]?.bots ?? [])
  return bots.find(entry => sameName(entry.id, actor.id))
}
export const anyoneAllowed = (settings: Settings): boolean => Object.values(settings.policy.sources).some(part => part.allowed.length > 0)
const senderName = (entry: z.infer<typeof AllowedSchema>): string => entry.name || entry.id

/** Check whether a thread has tickets of its own (excluding context-only subscriptions). */
const participating = (thread: Thread, tickets: Ticket[]): boolean =>
  [...thread.subscriptions, ...tickets.map(ticket => ticket.id)].some(id => !thread.context?.includes(id))
const listened = (sources: SourceScope, source: string, meta: Record<string, unknown>) => sources.scope({ source, meta })

function admissionCell(allowed: boolean, addressed: boolean): AdmissionCell | undefined {
  return allowed ? addressed ? undefined : 'listedUnaddressed' : addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
}
function admissionOf(settings: Settings, source: string, row: string | undefined, cell: AdmissionCell): Admission {
  return (row === undefined ? undefined : settings.policy.sources[source]?.admission[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell]
}
const STRENGTH: Readonly<Record<Admission, number>> = { ignore: 0, inferred: 1, explicit: 2 }

/** Compute how a settings change from `old` to `now` affects the authorization or matched rules of each open ticket. */
export function policyEffects(tickets: readonly Ticket[], old: Settings, now: Settings, scope: (settings: Settings) => SourceScope):
  Map<string, PolicyEffect> {
  const before = settingsPolicy(old, scope(old)), after = settingsPolicy(now, scope(now))
  const effects = new Map<string, PolicyEffect>()
  /** `settings` with `source`'s effective rules replaced, so a Mandate is rechecked as it was allowed under the old rules. */
  const withRules = (settings: Settings, source: string, rules: Rule[]): Settings => ({ ...settings, policy: { ...settings.policy,
    sources: { ...settings.policy.sources, [source]: { ...(settings.policy.sources[source] ?? { allowed: [], admission: {} }), rules } } } })
  for (const ticket of tickets) {
    const source = ticket.mandate.basis.source
    const oldRules = rulesFor(old, source), newRules = rulesFor(now, source)
    const rules = (ticket.mandate.basis.rules ?? []).flatMap((id): NonNullable<PolicyEffect['rules']> => {
      const was = oldRules.find(rule => rule.id === id), is = newRules.find(rule => rule.id === id)
      if (!is?.enabled) return was?.enabled ? [{ id, name: was.name, change: 'disabled' }] : []
      return JSON.stringify(was) === JSON.stringify(is) ? [] : [{ id, name: is.name, change: 'changed', instruction: is.instruction }]
    })
    const effect: PolicyEffect = rules.length ? { rules } : {}
    if (before.revalidate(ticket.mandate) && !after.revalidate(ticket.mandate)) {
      // With the previous accept mode and rules, the Mandate holds unless the sender or receiving scope lost authorization.
      // A record without a Source keeps the installation's rules, which it was admitted under.
      const asBefore = source === undefined ? { ...now, eval: old.eval, policy: { ...now.policy, rules: old.policy.rules } }
        : withRules({ ...now, eval: old.eval }, source, oldRules)
      if (!settingsPolicy(asBefore, scope(now)).revalidate(ticket.mandate)) {
        Object.assign(effect, { requesterAllowed: false, requester: ticket.mandate.actor })
      } else if (ticket.mandate.strength === 'inferred' && old.eval.mode === 'auto' && now.eval.mode !== 'auto') effect.proactive = false
    }
    if (Object.keys(effect).length) effects.set(ticket.id, effect)
  }
  return effects
}
/** Build the active Policy for gating incoming Triggers and revalidating existing Ticket Mandates. */
export function settingsPolicy(settings: Settings, sources: SourceScope): Policy {
  const version = policyVersion(settings)
  const mode = settings.eval.mode
  /** Gate non-human triggers: only listed bots (as inferred candidates) and senderless system/CI events may pass; other bots are rejected. */
  const machineGate = (trigger: Trigger): GateResult => {
    const bot = trigger.actor.id ? listedBot(settings, trigger.actor) : undefined
    if (trigger.actor.id && !bot) return { admissible: false, reason: 'not_human' }
    const scope = listened(sources, trigger.source, trigger.meta)
    if (!scope.listened || !(trigger.addressed || scope.observed)) return { admissible: false, reason: 'not_human' }
    const recorded = { source: trigger.source, scope: trigger.meta, ...scope.row === undefined ? {} : { row: scope.row } }
    const addressed = trigger.addressed ? { addressed: trigger.addressed } : {}
    if (bot) {
      if (mode === 'off') return { admissible: false, reason: 'admission_ignored' }
      const basis = { ...recorded, via: 'bot' as const, sender: senderName(bot), ...addressed, observation: { mode } }
      return { admissible: true, strength: 'inferred', basis }
    }
    const cell = 'unlistedUnaddressed' as const
    if (admissionOf(settings, trigger.source, scope.row, cell) !== 'inferred' || mode === 'off') {
      return { admissible: false, reason: 'admission_ignored' }
    }
    return { admissible: true, strength: 'inferred', basis: { ...recorded, via: 'admission', cell, observation: { mode } } }
  }
  return {
    version, paused: settings.paused, evalTimeoutMs: settings.eval.timeoutSeconds * 1000,
    gate(trigger: Trigger, thread, tickets) {
      if (!trigger.human) return machineGate(trigger)
      const allowed = allowedSender(settings, trigger.actor)
      const scope = listened(sources, trigger.source, trigger.meta)
      const row = scope.listened ? scope.row : undefined
      const recorded = { source: trigger.source, scope: trigger.meta, ...row === undefined ? {} : { row }, ...allowed ? { sender: senderName(allowed) } : {} }
      if (allowed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...recorded, via: 'addressed', addressed: trigger.addressed } }
      const cell = admissionCell(!!allowed, !!trigger.addressed)!
      // Unaddressed messages only use the admission table when the Source observes all messages in that scope.
      const receivable = !!trigger.addressed || (scope.listened && scope.observed)
      const admission = receivable ? admissionOf(settings, trigger.source, row, cell) : 'ignore'
      const basis = { ...recorded, via: 'admission' as const, cell, ...trigger.addressed ? { addressed: trigger.addressed } : {} }
      // Check explicit admission cells before thread follow-ups so a thread's tickets never weaken an explicit request to a follow-up.
      if (admission === 'explicit') return { admissible: true, strength: 'explicit', basis }
      // Direct-message threads belong to one sender (no follow-up for others), and inferred follow-ups require an accept mode other than off (when off, the table decides).
      if (!(trigger.addressed === 'direct' && !allowed) && (allowed || mode !== 'off') && participating(thread, tickets)) {
        return { admissible: true, strength: allowed ? 'explicit' : 'inferred', basis: { ...recorded, via: 'followup' } }
      }
      if (admission === 'inferred' && mode !== 'off') return { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode } } }
      return { admissible: false, reason: !allowed ? 'not_a_member' : receivable && admission === 'ignore' ? 'admission_ignored' : 'no_mention' }
    },
    admitsInferred: (rules, source) => mode === 'auto' && rules.length > 0
      && rules.every(id => rulesFor(settings, source).some(rule => rule.enabled && rule.id === id)),
    revalidate(mandate: Mandate) {
      // Revalidation rules follow docs/002 (Eval path; Resume revalidates).
      const { basis } = mandate
      const { source } = basis
      const current = source && basis.scope ? listened(sources, source, basis.scope) : undefined
      if (current && !current.listened) return false
      /** This Source instance's rules, which its Mandate was admitted under. */
      const sourceRules = rulesFor(settings, source)
      const rulesOn = (rules: string[] | undefined) => (rules ?? []).every(id => sourceRules.some(rule => rule.enabled && rule.id === id))
      // Explicit follow-ups remain valid; inferred follow-ups require auto mode and enabled matched rules.
      if (basis.via === 'followup') return mandate.strength === 'explicit' || (mode === 'auto' && rulesOn(basis.rules))
      // A bot's candidate holds only while the bot remains on its Source's bot list and passes the observation checks below.
      if (basis.via === 'bot' && !listedBot(settings, mandate.actor)) return false
      // An admission-table Mandate holds while the sender's current cell still grants at least the original strength.
      if (basis.via === 'admission') {
        const { cell } = basis
        const listed = !!allowedSender(settings, mandate.actor)
        // A listed sender who addresses the agent is always explicit and uses no table cell.
        if (cell === 'unlistedAddressed' && listed) return true
        // A sender added to the allowed list since acceptance moves to the listed cell, and still undergoes observation checks below.
        const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
        if (now === 'listedUnaddressed' && !listed) return false
        const admission = admissionOf(settings, source ?? '', current?.listened ? current.row : undefined, now)
        if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false
        if (mandate.strength === 'explicit') return true
      } else if (basis.via !== 'bot' && !allowedSender(settings, mandate.actor)) return false
      // Observed/inferred Mandates hold only while auto mode is active and all matched rules remain enabled.
      if ((basis.via === 'admission' || basis.via === 'listed' || basis.via === 'bot') && basis.observation) return mode === 'auto' && rulesOn(basis.rules)
      return true
    },
  }
}
