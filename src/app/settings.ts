/** Block-scoped settings validation, optimistic concurrency saves, processing pause control, and source policy synchronization. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { UserError, type EngineForSettings, type PolicyEffect } from '../core/index.ts'
import { DeliveryTargetSchema, EvalConfigSchema, ExecutorConfigSchema, PolicyConfigSchema, SettingsSchema, SourcePolicySchema,
  policyEffects, policyVersion, rulesFor } from '../policy.ts'
import type { Settings as SettingsValue, SettingsBlock, SettingsOrigin, SettingsSave } from '../policy.ts'
import type { SourceHost } from '../sources/host.ts'
import type { HealthBoard, HealthEntry } from '../infra/health.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { resolveRoleModel } from './role-models.ts'
import { changedPaths, settingsNotice } from './notices.ts'
import type { Sessions } from './sessions.ts'
import { setupChanged, type Setup } from './setup.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'

/**
 * Indicates an optimistic concurrency conflict when saving or syncing a settings block against a stale revision.
 * Thrown by `Settings.save` and `Settings.sync` and translated into an HTTP 409 response by the management routes.
 */
export class SettingsConflict extends Error {}
const now = (): string => new Date().toISOString()
/** Executor settings that control shell execution paths, prepare commands, and command shims. */
const environment = ({ executor }: SettingsValue) => JSON.stringify([executor.directory, executor.prepare, executor.blockedCommands])
/** One Source instance's saved block: its switch and kind configuration, plus the optional label, default Project and report target its routes set. */
const SourceBlockValue = z.object({ enabled: z.boolean(), config: z.unknown(), label: z.string().trim().max(100).optional(),
  defaultProjectId: z.string().trim().max(200).optional(), reportTo: DeliveryTargetSchema.nullable().optional() })
/** A settings block's kind: the installation-wide `policy`/`eval`/`executor`, a Source instance's `source:<id>`, or its own `policy:<id>`. */
type BlockKind = 'policy' | 'eval' | 'executor' | 'source' | 'sourcePolicy'
/** Split a settings block into its kind and the Source instance id the `source:`/`policy:` blocks name. */
function blockOf(block: string): { kind: string; id: string } {
  if (block.startsWith('source:')) return { kind: 'source', id: block.slice('source:'.length) }
  if (block.startsWith('policy:')) return { kind: 'sourcePolicy', id: block.slice('policy:'.length) }
  return { kind: block, id: block }
}

/** Schema parser, settings merger, and non-panel origin guard for one settings block kind. */
interface Block {
  parse(value: unknown, sources: SourceRegistry, id: string): unknown
  merge(settings: SettingsValue, value: unknown, id: string): SettingsValue
  guard?(current: SettingsValue, candidate: SettingsValue, origin: SettingsOrigin): void
}
const BLOCKS: Record<BlockKind, Block> = {
  policy: {
    parse: (value, sources) => {
      const policy = PolicyConfigSchema.parse(value)
      return { ...policy, sources: sources.validatePolicy(policy.sources) }
    },
    merge: (settings, value) => ({ ...settings, policy: value as SettingsValue['policy'] }),
  },
  eval: { parse: value => EvalConfigSchema.parse(value), merge: (settings, value) => ({ ...settings, eval: value as SettingsValue['eval'] }) },
  executor: {
    parse: value => ExecutorConfigSchema.parse(value),
    merge: (settings, value) => ({ ...settings, executor: value as SettingsValue['executor'] }),
    // Only the management panel may modify shell execution paths or commands.
    guard: (current, candidate, origin) => { if (origin !== 'panel' && environment(current) !== environment(candidate)) throw new UserError('panelOnlyEnvironment') },
  },
  source: {
    // A save keeps the instance's kind and its optional label and default Project; the panel edits its switch and configuration.
    parse: (value, sources, id) => {
      const parsed = SourceBlockValue.parse(value)
      return { ...sources.validate(id, { enabled: parsed.enabled, config: parsed.config }),
        ...parsed.label !== undefined ? { label: parsed.label } : {},
        ...parsed.defaultProjectId !== undefined ? { defaultProjectId: parsed.defaultProjectId } : {},
        // `null` clears a saved target; an absent field keeps it, as a save of the rest of the form does.
        ...parsed.reportTo !== undefined ? { reportTo: parsed.reportTo ?? undefined } : {} }
    },
    merge: (settings, value, id) => ({ ...settings, sources: { ...settings.sources,
      [id]: { ...settings.sources[id], ...value as SettingsValue['sources'][string] } } }),
    // Only the management panel may switch source accounts.
    guard: (current, candidate, origin) => { if (origin !== 'panel' && setupChanged(current, candidate)) throw new UserError('panelOnlyAccounts') },
  },
  sourcePolicy: {
    // A Source's own Policy part: its rules and admission table (validated by the Policy's schemas) and its kind-specific fields
    // (validated by the kind), merged into the installation's Policy for that Source instance alone.
    parse: (value, sources, id) => sources.validatePolicy({ [id]: SourcePolicySchema.parse(value) })[id],
    merge: (settings, value, id) => ({ ...settings, policy: { ...settings.policy,
      sources: { ...settings.policy.sources, [id]: value as SettingsValue['policy']['sources'][string] } } }),
  },
}

/** Host dependencies used by `Settings`. */
export interface SettingsHost {
  readonly store: Pick<Store, 'settings' | 'saveSettings' | 'blockRevision' | 'atomic' | 'tickets' | 'get'>
  readonly sources: SourceRegistry
  /** Notified when a settings save changes the policy version. */
  readonly engine: EngineForSettings
  /** Health board where each source's policy sync reports under `sync:<id>`. */
  readonly health: Pick<HealthBoard, 'claim'>
  /** DSH Cordis context used to validate and resolve role models. */
  readonly context: Context
  readonly lifetime: AbortSignal
  /** Session manager through which the main Session is notified of saved settings. */
  readonly sessions: Pick<Sessions, 'notify' | 'delivery'>
  /** Source host passed to source kinds' policy syncs and label refreshes. */
  readonly sourceHost: SourceHost
  /** Setup state, account/command checks, and restart trigger when setup-read fields change. */
  readonly setup: Pick<Setup, 'configured' | 'checkAccounts' | 'blockCommands' | 'restart'>
  /** Triggers an immediate pass so work newly allowed by a settings save runs right away. */
  requestPass(): void
}

/**
 * Validates and persists block-scoped settings in `Store`, enforces origin guards, and manages source policy synchronization and label refreshes.
 * `Runtime`, management HTTP routes, and main-Session tools read and save settings through it.
 * Notifies `Engine` when the policy version changes, notifies the main Session via `Sessions`, and triggers `Setup` restarts or `Passes` runs when saved settings take effect.
 * Tracks per-source synchronization status in `HealthBoard` and retries failed syncs with exponential backoff.
 */
export class Settings {
  /** Per-source `sync:<id>` health entries, claimed lazily on each source's first policy sync. */
  private readonly syncs = new Map<string, HealthEntry>()
  /** Pending exponential-backoff retry timer and last wait duration (ms) per source after a failed sync. */
  private readonly retries = new Map<string, { timer: ReturnType<typeof setTimeout>; wait: number }>()
  constructor(private readonly host: SettingsHost) {
    host.lifetime.addEventListener('abort', () => { for (const { timer } of this.retries.values()) clearTimeout(timer) }, { once: true })
  }
  /** Schedule exponential backoff retries (1 minute up to 1 hour) after a failed source sync, or clear pending retries on success. */
  private retrySync(id: string, failed: boolean): void {
    const previous = this.retries.get(id)
    if (previous) clearTimeout(previous.timer)
    this.retries.delete(id)
    if (!failed || this.host.lifetime.aborted) return
    const wait = previous ? Math.min(previous.wait * 2, 3_600_000) : 60_000
    const timer = setTimeout(() => { this.sync(id).catch(() => { /* sync() records its failure in health. */ }) }, wait)
    timer.unref?.()
    this.retries.set(id, { timer, wait })
  }
  private syncHealth(id: string): HealthEntry {
    let entry = this.syncs.get(id)
    if (!entry) this.syncs.set(id, entry = this.host.health.claim(`sync:${id}`))
    return entry
  }
  /** Returns the current validated settings from `Store`. */
  current(): SettingsValue { return this.host.store.settings() }
  /**
   * Returns an overview of all settings blocks with their current block revisions: full values for `pause`, `eval`, and
   * `executor`; rule summaries and allowed-sender counts for `policy`; and instance status switches for `sources` (with
   * `read: 'settings/<block>'` paths for full block reads). A Source's `policy` part reports its effective rules, whether
   * it inherited the installation's default ones, and its own block revision.
   */
  view() {
    const { store, sources } = this.host
    const settings = store.settings(), revision = (block: SettingsSave) => store.blockRevision(block)
    const { rules, sources: parts } = settings.policy
    const summary = (value: readonly { id: string; name: string; enabled: boolean }[]) =>
      value.map(rule => ({ id: rule.id, name: rule.name, enabled: rule.enabled }))
    return { revision: store.get(KV.settings.revision) ?? 0,
      pause: { revision: revision('pause'), value: { paused: settings.paused } },
      eval: { revision: revision('eval'), value: settings.eval },
      executor: { revision: revision('executor'), value: settings.executor },
      policy: { revision: revision('policy'), rules: summary(rules),
        allowed: Object.fromEntries(Object.entries(parts).map(([id, part]) => [id, part.allowed.length])), read: 'settings/policy' },
      sources: sources.instances(settings).map(({ id, kind, enabled, installed }) =>
        ({ id, kind, enabled, installed, revision: revision(`source:${id}`), read: `settings/source:${id}`,
          // The rules that apply to this Source's work: its own when it saved any, else the installation's default rules.
          policy: { revision: revision(`policy:${id}`), inherited: parts[id]?.rules === undefined, rules: summary(rulesFor(settings, id)),
            read: `settings/policy:${id}` } })) }
  }
  /**
   * Returns one settings block as accepted by `save` (`policy`, `eval`, `executor`, `pause` holding `{ paused }`, `source:<id>`
   * holding `{ enabled, config }`, or `policy:<id>` holding that Source's Policy part including its own `rules`) along with its
   * current block revision.
   * @throws UserError (`unknownBlock`) when no such settings block exists.
   */
  block(block: string): { block: string; revision: number; value: unknown } {
    const { store, sources } = this.host
    const settings = store.settings()
    const { kind, id } = blockOf(block)
    const instance = kind === 'source' || kind === 'sourcePolicy' ? sources.instances(settings).find(item => item.id === id) : undefined
    const value = block === 'pause' ? { paused: settings.paused }
      : kind === 'policy' || kind === 'eval' || kind === 'executor' ? settings[kind]
        : kind === 'source' ? (instance ? { enabled: instance.enabled, config: instance.config,
          ...instance.label !== undefined ? { label: instance.label } : {},
          ...instance.reportTo !== undefined ? { reportTo: instance.reportTo } : {} } : undefined)
          : kind === 'sourcePolicy' ? (instance ? this.policyPart(id) : undefined) : undefined
    if (value === undefined) throw new UserError('unknownBlock', { block })
    return { block, revision: store.blockRevision(block as SettingsSave), value }
  }
  /** One Source instance's Policy part as `save` accepts it: its kind's fields with defaults, its admission table, and its own rules. */
  private policyPart(id: string): SettingsValue['policy']['sources'][string] {
    const { store, sources } = this.host
    const settings = store.settings()
    // `SourceRegistry.policyPart` validates the kind's fields and keeps a stored `rules`; an uninstalled kind keeps its part as stored.
    return sources.policyPart(id) ?? SourcePolicySchema.parse(settings.policy.sources[id] ?? {})
  }
  /**
   * Refuses a Source account's display name when another account already has it, comparing case-insensitively after
   * trimming (an account keeps its own name). An empty name means the account falls back to its kind's title, so it
   * never collides.
   * @throws UserError `sourceLabelExists` naming the account that has the name.
   */
  private assertLabelFree(settings: SettingsValue, id: string, label: string | undefined): void {
    const name = label?.trim().toLowerCase()
    if (!name) return
    const taken = Object.entries(settings.sources).find(([other, instance]) => other !== id
      && instance.label?.trim().toLowerCase() === name)
    if (taken) throw new UserError('sourceLabelExists', { source: taken[0], label: label!.trim() })
  }
  /**
   * Validates and saves one settings block against its `revision`; a no-op save records no new revision, a changed policy
   * version notifies affected open tickets, and changing a setup-read field (`SETUP_FIELDS`, such as an account CLI) or any
   * change saved while waiting for setup (`!this.host.setup.configured()`) restarts `dsh-superagentarea` so setup runs again.
   * @param origin - Caller origin; restricts execution-environment and account-CLI changes to `'panel'` (a guardrail against prompt-injected tool calls, not an OS security boundary, since agents run shell commands; `origin` has no default so no caller receives panel privileges implicitly).
   * @returns Save outcome with the block's current `revision`, whether `policy_changed`, whether `restarting`, and `context_delivery` status (`'injected'` or `'pending'`).
   * @throws SettingsConflict when `block`'s revision changed before or during validation checks.
   * @throws UserError | z.ZodError when `block` is unknown, the source is not installed, `value` is invalid (such as an `executor` block carrying `paused`, which only `pause` sets), a non-panel `origin` changes panel-only fields, or a role-model or account check fails.
   */
  async save(block: SettingsBlock, value: unknown, revision: number, origin: SettingsOrigin) {
    const { store, sources, engine, sessions } = this.host
    const stale = () => revision !== store.blockRevision(block)
    if (stale()) throw new SettingsConflict('Settings changed. Reload before saving.')
    const { kind, id } = blockOf(block)
    if (!(kind in BLOCKS)) throw new UserError('unknownBlock', { block })
    const rules = BLOCKS[kind as BlockKind]
    if (kind === 'source' || kind === 'sourcePolicy') {
      // Every configured instance, including a kind's synthesized default, is a saveable block; an orphaned instance keeps its stored configuration only.
      const instance = sources.instances().find(item => item.id === id)
      if (!instance) throw new UserError('unknownSource', { source: id })
      if (!instance.installed) throw new UserError('sourceNotInstalled', { source: id })
    }
    const parsed = rules.parse(value, sources, id)
    const current = store.settings()
    const candidate = rules.merge(current, parsed, id)
    const model = kind === 'eval' ? candidate.eval.model : kind === 'executor' ? candidate.executor.model : null
    const previous = kind === 'eval' ? current.eval.model : kind === 'executor' ? current.executor.model : null
    if (model && JSON.stringify(model) !== JSON.stringify(previous)) {
      try { await resolveRoleModel(this.host.context, model) }
      catch (error) { throw new UserError('modelUnavailable', { block, error: error instanceof Error ? error.message : String(error) }) }
    }
    rules.guard?.(current, candidate, origin)
    if (setupChanged(current, candidate)) await this.host.setup.checkAccounts(block, candidate)
    if (stale()) throw new SettingsConflict('Settings changed during the checks. Reload before saving.')
    // Re-read current settings after async checks in case unrelated blocks were saved concurrently.
    const old = store.settings()
    const settings = rules.merge(old, parsed, id)
    if (kind === 'source') this.assertLabelFree(settings, id, (parsed as { label?: string }).label)
    if (JSON.stringify(SettingsSchema.parse(settings)) === JSON.stringify(old)) {
      const delivery = await sessions.delivery(`settings:${block}`)
      return { saved: true, revision: store.blockRevision(block), policy_changed: false, restarting: false, context_delivery: delivery }
    }
    const restarting = setupChanged(old, settings) || !this.host.setup.configured()
    const before = policyVersion(old), after = policyVersion(settings)
    const scope = (version: SettingsValue) => ({
      scope: (input: { source: string; meta: Record<string, unknown> }) => this.host.sources.scope(input, version) })
    const effects = before === after ? new Map() : policyEffects(store.tickets.open(), old, SettingsSchema.parse(settings), scope)
    const notified = [...effects.keys()]
    store.atomic(() => {
      store.saveSettings(SettingsSchema.parse(settings), { source: origin, block, policyVersion: after, policyChanged: before !== after, notified })
      if (origin !== 'tool') sessions.notify(...settingsNotice(block, changedPaths(old, settings)))
      if (before !== after) engine.policyChanged(before, after, effects)
    })
    // Rewrite worker command shims immediately when `blockedCommands` changes.
    const blocked = settings.executor.blockedCommands
    const changed = blocked.join(' ') !== old.executor.blockedCommands.join(' ')
    if (changed) await this.host.setup.blockCommands(blocked)
    // When restarting, the notice stays pending until after the restart; `setup.restart()` defers until this call returns.
    const delivery = restarting ? 'pending' : await sessions.delivery(`settings:${block}`)
    if (restarting) this.host.setup.restart()
    else this.host.requestPass()
    return { saved: true, revision: store.blockRevision(block), policy_changed: before !== after, restarting, context_delivery: delivery }
  }
  /**
   * Creates a Source instance from the management panel: validates its configuration against its kind, stores it enabled
   * with the optional label, and records the save as the instance's own block revision. A kind whose setup fields change
   * restarts `dsh-superagentarea`, as any saved account change does; a folder instance takes effect on the next poll.
   * @throws UserError `sourceNotInstalled` for a kind that is not installed, or `sourceExists` when the id is taken.
   */
  async add(request: { id: string; kind: string; label?: string; config: unknown }): Promise<{ revision: number; restarting: boolean }> {
    const { store, sources, sessions } = this.host
    const kind = sources.kind(request.kind)
    if (!kind) throw new UserError('sourceNotInstalled', { source: request.kind })
    const current = store.settings()
    if (current.sources[request.id]) throw new UserError('sourceExists', { source: request.id })
    this.assertLabelFree(current, request.id, request.label)
    const value = { kind: kind.kind, enabled: true, config: kind.schema.parse(request.config ?? {}),
      ...request.label ? { label: request.label } : {} }
    const candidate = SettingsSchema.parse({ ...current, sources: { ...current.sources, [request.id]: value } })
    const block: SettingsBlock = `source:${request.id}`
    const restarting = setupChanged(current, candidate) || !this.host.setup.configured()
    if (setupChanged(current, candidate)) await this.host.setup.checkAccounts(block, candidate)
    store.atomic(() => {
      store.saveSettings(candidate, { source: 'panel', block, policyVersion: policyVersion(candidate), policyChanged: false, notified: [] })
      sessions.notify(...settingsNotice(block, changedPaths(current, candidate)))
    })
    const delivery = restarting ? 'pending' : await sessions.delivery(`settings:${block}`)
    if (restarting) this.host.setup.restart()
    else this.host.requestPass()
    return { revision: store.blockRevision(block), restarting }
  }
  /**
   * Deletes a Source instance's configuration, and its Policy part with it, so an instance later added under the same id
   * starts from the default Policy rather than inheriting the deleted one. Historical Tickets stay stored and readable; a
   * live Ticket of the instance keeps it from being deleted.
   * @throws UserError `unknownSource` for an id no configured instance has, or `sourceInUse` while one of its Tickets is open.
   */
  async remove(id: string): Promise<{ deleted: true }> {
    const { store, sources, sessions } = this.host
    if (!sources.instances().some(instance => instance.id === id)) throw new UserError('unknownSource', { source: id })
    const live = store.tickets.open().filter(ticket => ticket.sourceId === id)
    if (live.length) throw new UserError('sourceInUse', { source: id, count: String(live.length) })
    const current = store.settings()
    const { [id]: _source, ...sourceEntries } = current.sources
    const { [id]: _policy, ...policyEntries } = current.policy.sources
    const next = SettingsSchema.parse({ ...current, sources: sourceEntries, policy: { ...current.policy, sources: policyEntries } })
    const before = policyVersion(current), after = policyVersion(next)
    const scope = (version: SettingsValue) => ({ scope: (input: { source: string; meta: Record<string, unknown> }) =>
      this.host.sources.scope(input, version) })
    const effects = before === after ? new Map<string, PolicyEffect>() : policyEffects(store.tickets.open(), current, next, scope)
    const notified = [...effects.keys()]
    store.atomic(() => {
      store.saveSettings(next, { source: 'panel', block: `source:${id}`, policyVersion: after, policyChanged: before !== after, notified })
      sessions.notify(...settingsNotice(`source:${id}`, changedPaths(current, next)))
      if (before !== after) this.host.engine.policyChanged(before, after, effects)
    })
    return { deleted: true }
  }
  /**
   * Pauses or resumes processing (new evaluations, worker dispatch, and channel delivery, while Sources continue recording
   * Triggers); saved in its own `'pause'` block so concurrent `executor` edits remain valid across it.
   * @returns Whether processing is now paused (`{ paused }`).
   */
  async pause(paused: boolean, origin: SettingsOrigin): Promise<{ paused: boolean }> {
    const { store, sessions } = this.host
    const old = store.settings()
    if (old.paused === paused) return { paused }
    store.atomic(() => {
      const record = { source: origin, block: 'pause' as const, policyVersion: policyVersion(old), policyChanged: false, notified: [] }
      store.saveSettings({ ...old, paused }, record)
      if (origin !== 'tool') sessions.notify(...settingsNotice('pause', ['paused']))
    })
    await sessions.delivery('settings:pause')
    this.host.requestPass()
    return { paused }
  }
  /** Returns the IDs of installed, enabled Sources whose policy section can synchronize now (empty while setup is not configured). */
  syncable(): string[] {
    const { sources } = this.host
    if (!this.host.setup.configured()) return []
    return sources.instances().filter(instance => instance.installed && instance.enabled).flatMap(instance => {
      const sync = sources.kind(instance.id)?.policy?.sync
      const part = sources.policyPart(instance.id)
      return sync && part && sync.ready(part) ? [instance.id] : []
    })
  }
  /**
   * Synchronizes source `id`'s policy section from its external source of truth, saves it under that Source's own
   * `'policy:<id>'` block revision when changed, and records the outcome in the `sync:<id>` health entry (scheduling
   * exponential-backoff retries via `retrySync` on failure).
   * @returns The synchronized policy section for `id`.
   * @throws UserError (`nothingToSync`) when `id` cannot sync now, `SettingsConflict` if the installation's Policy or that Source's own part changed during synchronization, or the underlying sync error on failure.
   */
  async sync(id: string) {
    const { store, sources } = this.host
    if (!this.syncable().includes(id)) throw new UserError('nothingToSync', { source: id })
    const health = this.syncHealth(id)
    try {
      const block: SettingsBlock = `policy:${id}`
      const revision = store.blockRevision('policy'), partRevision = store.blockRevision(block)
      const part = await sources.kind(id)!.policy!.sync!.run(this.host.sourceHost, sources.policyPart(id)!, this.host.lifetime)
      // A save of either the installation's Policy or this Source's part during the read makes this synchronized part stale.
      if (revision !== store.blockRevision('policy') || partRevision !== store.blockRevision(block)) {
        throw new SettingsConflict('Policy changed during synchronization. Retry with the current settings.')
      }
      // Skip saving a new revision when the synchronized part is the one already stored for that Source; compare through the
      // registry so the same kind defaults and field order are read on both sides.
      if (JSON.stringify(part) !== JSON.stringify(sources.policyPart(id))) await this.save(block, part, partRevision, 'sync')
      health.set({ state: 'ready', detail: `${part.allowed.length} allowed`, at: now() })
      this.retrySync(id, false)
      return part
    } catch (error) {
      health.set({ state: 'error', detail: String(error), at: now() })
      this.retrySync(id, true)
      throw error
    }
  }
  /**
   * Rereads a Source's display names (such as Feishu chat names) immediately.
   * @returns Sorted display names (`{ added }`) that were not present in the stored label map before this read.
   * @throws UserError (`noLabels`) when the Source has no label refresh; rethrows a failed read, keeping the stored list.
   */
  async refreshLabels(id: string): Promise<{ added: string[] }> {
    const { store, sources } = this.host
    const instance = sources.instance(id)
    const kind = instance && sources.kind(instance.kind)
    if (!kind?.refreshLabels) throw new UserError('noLabels')
    const before = store.get(KV.sources.labels(id)) ?? {}
    const after = await kind.refreshLabels(this.host.sourceHost)
    return { added: Object.entries(after).filter(([key]) => !(key in before)).map(([, name]) => name).sort((a, b) => a.localeCompare(b)) }
  }
}
