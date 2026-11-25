/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
import type { ChannelRef, OutboundMessage, PersonRef, ProjectHint, ScopeResult, SourceScope, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { AdmissionTableSchema, RuleArraySchema, type Settings } from '../policy.ts'
import type { Health } from './host.ts'
import type { ChannelLink, ChannelLinks, FieldSpec, Localized, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.ts'

/** A stored Source instance: its kind, whether it runs, and its kind's single-instance configuration. */
type Stored = Settings['sources'][string]
/** An instance as the panel, the loops and the settings view read it, with whether its kind is installed. */
export type ResolvedInstance = SourceInstance & { installed: boolean }
/** The per-row hint an old Trigger or Channel names (a folder row), used to find its instance after migration. */
const rowHint = (meta: Record<string, unknown>): string | undefined => typeof meta.row === 'string' ? meta.row : undefined
/** The health entries one registration owns: the kind's declared entries and one entry per instance of it. */
interface HealthScope {
  /** The kind's declared entries, by name; the one named after the kind also serves as its default instance's entry. */
  readonly declared: Map<string, HealthEntry>
  /** The kind's instances' own entries, by instance id. */
  readonly instances: Map<string, HealthEntry>
  released: boolean
}

/**
 * Manages registered SourceKind plugins, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * Claims each registered kind's health entries, and one more per instance of it, on HealthBoard, and mediates access to source
 * channels, links, environment variables, and thread context readers for Runtime, Settings, Outbox, and MasterAssessor.
 */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  private readonly health = new Map<string, HealthScope>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {}) {}

  /**
   * Registers a SourceKind, claims its declared health entries and one entry per current instance on HealthBoard (rejecting
   * `sync:` prefixes owned by Settings), and returns an unregister disposer that releases them all.
   */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    const scope: HealthScope = { declared: new Map(), instances: new Map(), released: false }
    const release = () => {
      if (scope.released) return
      scope.released = true
      for (const entry of new Set([...scope.declared.values(), ...scope.instances.values()])) entry.release()
      scope.declared.clear(); scope.instances.clear()
      this.health.delete(kind.kind)
    }
    for (const name of kind.health) {
      try { scope.declared.set(name, this.board.claim(name, { state: 'starting', detail: '' })) }
      catch { release(); throw refused(name) }
    }
    this.health.set(kind.kind, scope)
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    // Claim one entry per instance; reading the instances later claims new ones and releases the ones that went.
    try { this.instancesOf(kind.kind) }
    catch (error) { this.kinds.delete(kind.kind); release(); throw error }
    const unregistered = this.registered(kind as unknown as SourceKind)
    return () => { if (!this.kinds.delete(kind.kind)) return; release(); unregistered() }
  }
  /** Claims one entry per instance of `kind`, releasing the entries of instances it no longer has; the default instance keeps the declared entry named after the kind. */
  private claimInstances(kind: string, ids: readonly string[]): void {
    const scope = this.health.get(kind)
    if (!scope || scope.released) return
    const wanted = new Set(ids)
    for (const [id, entry] of scope.instances) {
      if (wanted.has(id) || scope.declared.get(id) === entry) continue
      entry.release(); scope.instances.delete(id)
    }
    for (const id of ids) {
      if (!scope.instances.has(id)) scope.instances.set(id, scope.declared.get(id) ?? this.board.claim(id, { state: 'starting', detail: '' }))
    }
  }
  /**
   * Returns the active health entries for `names`, declared or owned by an instance. A Source context writes through the
   * entries it received when built, so reports sent after that registration ended do nothing even if the kind registers again.
   */
  healthEntries(names: readonly string[]): Map<string, HealthEntry> {
    const entries = new Map<string, HealthEntry>()
    for (const name of names) {
      for (const scope of this.health.values()) {
        const entry = scope.declared.get(name) ?? scope.instances.get(name)
        if (entry) { entries.set(name, entry); break }
      }
    }
    return entries
  }
  /**
   * The reporter of one registration: an instance's own entry (named by instance id, claimed when the instance appeared
   * after startup), or a declared entry of the kind. A report from a context whose registration ended writes nothing, and
   * a name of neither the kind nor one of its instances is refused.
   */
  healthReporter(kind: string): (entry: string, health: Health) => void {
    return (entry, health) => {
      const scope = this.health.get(kind)
      if (!scope || scope.released) return
      const own = scope.instances.get(entry) ?? scope.declared.get(entry)
      if (own) { own.set(health); return }
      if (entry !== kind && this.settings().sources[entry]?.kind !== kind) throw new Error(`The ${kind} Source has no health entry ${entry}`)
      const claimed = this.board.claim(entry, { state: 'starting', detail: '' })
      scope.instances.set(entry, claimed)
      claimed.set(health)
    }
  }
  /** The installed kind `id` names: a kind id, a stored instance id, or an old bare kind id. */
  kind(id: string, settings = this.settings()): SourceKind | undefined {
    const name = this.kindOf(id, settings)
    return name ? this.kinds.get(name) : undefined
  }
  /**
   * The kind a stored Source string names: the kind of the instance `source` ids, else `source` itself when it is a
   * registered kind (old data kept the bare kind), else undefined.
   */
  kindOf(source: string, settings = this.settings()): string | undefined {
    const stored = settings.sources[source]
    if (stored) return stored.kind
    return !source.includes(':') && this.kinds.has(source) ? source : undefined
  }
  /**
   * Every configured instance: registered kinds in kind order, each kind's instances in id order (a default instance when
   * a registered kind stores none), followed by stored instances whose kind is not installed (kept as stored).
   */
  instances(settings = this.settings()): ResolvedInstance[] {
    const installed = [...this.kinds.keys()].sort((a, b) => a.localeCompare(b))
      .flatMap(kind => this.instancesOf(kind, settings).map(instance => ({ ...instance, installed: true })))
    const orphaned = Object.entries(settings.sources).filter(([, stored]) => !this.kinds.has(stored.kind))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, stored]) => ({ id, kind: stored.kind, enabled: stored.enabled, config: stored.config,
        ...stored.label ? { label: stored.label } : {}, ...stored.defaultProjectId ? { defaultProjectId: stored.defaultProjectId } : {},
        installed: false }))
    return [...installed, ...orphaned]
  }
  /** Every configured instance of one registered kind, in id order; a synthesized default instance when none is stored. */
  instancesOf<C extends Record<string, unknown>>(kind: string, settings = this.settings()): SourceInstance<C>[] {
    const plugin = this.kinds.get(kind)
    if (!plugin) return []
    const stored = Object.entries(settings.sources).filter(([, instance]) => instance.kind === kind).sort(([a], [b]) => a.localeCompare(b))
    this.claimInstances(kind, stored.length ? stored.map(([id]) => id) : [kind])
    if (!stored.length) return [this.resolve(plugin, kind, undefined) as SourceInstance<C>]
    return stored.map(([id, instance]) => this.resolve(plugin, id, instance) as SourceInstance<C>)
  }
  /** Every installed kind in id order, with the form a new instance of it is configured by, as the panel's add-Source form reads it. */
  catalog(): { kind: string; title: Localized; description: Localized; fields: FieldSpec[]; defaults: Record<string, unknown> }[] {
    return [...this.kinds.keys()].sort((a, b) => a.localeCompare(b)).map(name => {
      const kind = this.kinds.get(name)!
      return { kind: kind.kind, title: kind.title, description: kind.description, fields: kind.fields, defaults: kind.schema.parse({}) }
    })
  }
  /** One instance by id: a stored instance, or the default instance of a registered kind (`id` is then the kind). */
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const stored = settings.sources[id]
    if (stored) {
      const kind = this.kinds.get(stored.kind)
      return kind ? this.resolve(kind, id, stored) as SourceInstance<C> : undefined
    }
    const kind = this.kinds.get(id)
    return kind ? this.resolve(kind, id, undefined) as SourceInstance<C> : undefined
  }
  /**
   * Resolves the instance a stored Source string names. Old values keep the bare kind; `hint` (a folder Trigger's
   * `meta.row` or a Channel's `address.row`) finds the instance a pre-migration row became.
   */
  instanceFor<C extends Record<string, unknown>>(source: string, hint?: string, settings = this.settings()):
  (SourceInstance<C> & { installed: true }) | undefined {
    const stored = settings.sources[source]
    if (stored) {
      const kind = this.kinds.get(stored.kind)
      return kind ? { ...this.resolve(kind, source, stored) as SourceInstance<C>, installed: true } : undefined
    }
    const plugin = this.kinds.get(source)
    if (!plugin) return undefined
    const candidates = this.instancesOf<C>(plugin.kind, settings)
    const hinted = hint && !hint.includes(':') ? candidates.find(instance => instance.id === `${plugin.kind}:${hint}`) : undefined
    const chosen = hinted ?? (candidates.length === 1 ? candidates[0] : undefined)
    return { ...(chosen ?? this.resolve(plugin, source, undefined) as SourceInstance<C>), installed: true }
  }
  validate(id: string, value: { enabled: boolean; config: unknown }): { kind: string; enabled: boolean; config: Record<string, unknown> } {
    const kind = this.kind(id)
    if (!kind) throw new Error(`Source kind not installed: ${id}`)
    return { kind: kind.kind, enabled: value.enabled, config: kind.schema.parse(value.config) }
  }
  /** Validates each Source instance's part of a submitted Policy against its kind; parts for uninstalled kinds are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kind(id)?.policy
      // `admission` and a source's own `rules` are validated by the Policy's own schemas (shared across all kinds), while the
      // kind validates the rest of its part.
      const { admission, rules, ...rest } = part
      const own = rules === undefined ? {} : { rules: RuleArraySchema.parse(rules) }
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}), ...own }
        : { ...part } as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kind(id, settings)?.policy
    if (!policy) return undefined
    const { admission, rules, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {},
      ...rules !== undefined && Array.isArray(rules) ? { rules } : {} }
  }
  /**
   * The default Project the Trigger's instance names and the Project hints its kind reads from the event (see plan §2.5):
   * a folder's `PROJECT.md` or task-folder name, an IM chat title. The Project registry resolves them; the hints carry names,
   * local paths and repository URLs, never a Project id.
   */
  projectHints(trigger: Trigger, settings = this.settings()): { defaultProjectId?: string; hints: ProjectHint[] } {
    const kind = this.kind(trigger.source, settings)
    const instance = this.instanceFor(trigger.source, rowHint(trigger.meta), settings)
    if (!kind || !instance) return { hints: [] }
    return { ...instance.defaultProjectId ? { defaultProjectId: instance.defaultProjectId } : {},
      hints: kind.projectHints?.(trigger, instance.config) ?? [] }
  }
  /** People the Trigger's instance itself knows beside the Policy's lists, such as a folder instance's operator. */
  people(trigger: Trigger, settings = this.settings()): PersonRef[] {
    const kind = this.kind(trigger.source, settings)
    const instance = this.instanceFor(trigger.source, rowHint(trigger.meta), settings)
    if (!kind || !instance) return []
    return (kind.people?.(instance.config, instance.id) ?? []).map(person => ({ source: instance.id, id: person.id,
      ...person.name ? { name: person.name } : {} }))
  }
  /** Renders `person` as the Channel's Source mentions people, or `''` when that kind has no mention support. */
  mention(person: PersonRef, channel: ChannelRef, settings = this.settings()): string {
    const kind = this.kind(channel.source, settings)
    if (!kind?.channel?.mention) return ''
    const instance = this.instanceFor(channel.source, channel.address.row, settings)
    return instance ? kind.channel.mention(person) : ''
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const kind = this.kind(channel.source, settings)
    if (!kind) return false
    const instance = this.instanceFor(channel.source, channel.address.row, settings)
    if (!instance) return false
    return instance.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.keys()].sort((a, b) => a.localeCompare(b)).flatMap(kind => {
      const environment = this.kinds.get(kind)!.environment
      return environment ? [{ kind, variables: environment.variables }] : []
    })
  }
  /**
   * Every enabled instance's environment values, with `trigger` narrowing its own kind to the instance that received it
   * (an old Trigger's row hint finds the folder instance its row became).
   */
  environments(settings = this.settings(), trigger?: Trigger) {
    const matched = trigger ? this.instanceFor(trigger.source, rowHint(trigger.meta), settings) : undefined
    return [...this.kinds.keys()].sort((a, b) => a.localeCompare(b)).flatMap(name => {
      const kind = this.kinds.get(name)!
      const environment = kind.environment
      if (!environment) return []
      const instances = this.instancesOf(name, settings)
      const chosen = !trigger ? instances : matched?.kind === kind.kind ? instances.filter(instance => instance.id === matched.id) : instances
      return chosen.filter(instance => instance.enabled).map(instance => ({ kind, instance: instance.id, environment, config: instance.config }))
    })
  }
  /**
   * Sends a message idempotently through its Channel's kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it.
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const kind = this.kind(message.channel.source)
    if (!kind) return 'waiting'
    if (!kind.channel) return 'gone'
    const instance = this.instanceFor(message.channel.source, message.channel.address.row)
    const scoped = instance && kind.commands ? kind.commands(instance.config, commands) : commands
    return kind.channel.send({ commands: scoped }, message)
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const kind = this.kind(channel.source)
    if (!kind) return { url: '', label: { zh: channel.source, en: channel.source } }
    const instance = this.instanceFor(channel.source, channel.address.row)
    const link = kind.channel?.link(channel.address, links, instance?.config ?? kind.schema.parse({}))
    return link ?? { url: '', label: { zh: kind.title.zh, en: kind.title.en } }
  }
  find(query: string): { threads: string[]; terms: string[] } {
    const found = [...this.kinds.keys()].sort((a, b) => a.localeCompare(b)).flatMap(name => {
      const kind = this.kinds.get(name)!
      const result = kind.find?.(query)
      if (!result) return []
      const ids = this.instancesOf(name).map(instance => instance.id)
      const prefix = `${kind.kind}:`
      // A kind names Threads by kind (`github:12`); each instance's Thread key carries its instance id instead.
      const threads = result.threads.flatMap(thread => thread.startsWith(prefix)
        ? ids.map(id => `${id}:${thread.slice(prefix.length)}`) : [thread])
      return [{ threads, terms: result.terms }]
    })
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  repliesTo(trigger: Trigger): string | undefined { return this.kind(trigger.source)?.repliesTo?.(trigger) }
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const kind = this.kind(trigger.source, settings)
    const context = kind?.threadContext
    if (!kind || !context) return undefined
    const instance = this.instanceFor(trigger.source, rowHint(trigger.meta), settings)
    if (!instance) return undefined
    const { config } = instance
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(kind.commands ? kind.commands(config, commands) : commands, trigger, part, cursor, config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, kind.commands ? kind.commands(config, commands) : commands, trigger, message, key, stateDir, signal)
      },
    }
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const kind = this.kind(input.source, settings)
    const stored = settings.sources[input.source]
    // Without its kind plugin the stored scope cannot be evaluated, so a configured Source whose plugin is missing listens to nothing.
    if (!kind) return stored || input.source.includes(':') ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = this.instanceFor(input.source, rowHint(input.meta), settings)
    if (!instance) return { listened: false, reason: 'source_not_installed' }
    if (!instance.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta, instance: instance.id }, instance.config) : { listened: true, observed: false }
  }
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve<C extends Record<string, unknown>>(kind: SourceKind<C>, id: string, stored: Stored | undefined): SourceInstance<C> {
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    return { id, kind: kind.kind, enabled: parsed.success && (stored?.enabled ?? true), config: parsed.success ? parsed.data : kind.schema.parse({}),
      ...stored?.label ? { label: stored.label } : {}, ...stored?.defaultProjectId ? { defaultProjectId: stored.defaultProjectId } : {} }
  }
}
