/** Settings view combining versioned configuration blocks, per-source forms and policy metadata, and execution environment details. */
import { SETUP_FIELDS } from '../../deployment.ts'
import { KV } from '../../kv.ts'
import { policyVersion, rulesFor, type Settings } from '../../policy.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import { declaredVariables, executionRoot } from '../execution-environment.ts'
import type { Store } from '../store.ts'
import { problemOf, sourceTitle, type HealthMap, type SetupState } from './sources.ts'

/**
 * One Source instance's policy: its kind's editable fields and rows, the sync state, and its own rules when it saved any —
 * `rules` is what applies to its work (own rules, else the installation's default), and `inherited` says which.
 */
function policyOf(sources: SourceRegistry, store: Store, settings: Settings, id: string, kind: string, health: HealthMap) {
  const policy = sources.kind(kind)?.policy
  if (!policy) return {}
  const part = sources.policyPart(id)!
  const config = sources.instance(id)?.config ?? {}
  const sync = policy.sync && { label: policy.sync.label, ready: policy.sync.ready(part), health: health[`sync:${id}`] }
  return { policy: { fields: policy.fields, explicit: policy.explicit, ...policy.rows ? { rows: policy.rows(config, id) } : {}, ...sync
    ? { sync } : {}, revision: store.blockRevision(`policy:${id}`), rules: rulesFor(settings, id),
  inherited: settings.policy.sources[id]?.rules === undefined, value: part } }
}
/** A kind's title, or a named instance's own title: its label, or its kind and key when it shares the kind with others. */
/**
 * Builds the settings view by block (`{ value, revision }`), per-Source configuration and restart-sensitive fields,
 * and execution environment details (`stateDir` provides the default ticket working directory root).
 */
export function settingsView(store: Store, sources: SourceRegistry, health: HealthMap, setup: SetupState, stateDir: string) {
  const settings = store.settings()
  const block = <V>(name: 'policy' | 'eval' | 'executor', value: V) => ({ value, revision: store.blockRevision(name) })
  const instances = sources.instances(settings)
  return {
    policyVersion: policyVersion(settings),
    blocks: { policy: block('policy', settings.policy), eval: block('eval', settings.eval), executor: block('executor',
      settings.executor) },
    sources: instances.map(instance => {
      const kind = sources.kind(instance.kind)
      const problem = problemOf(instance.id, setup) ?? problemOf(instance.kind, setup)
      const title = sourceTitle(kind, instance)
      return { id: instance.id, kind: instance.kind, title, description: kind?.description ?? { zh: '', en: '' }, installed: instance.installed,
        value: { enabled: instance.enabled, config: instance.config,
          ...instance.label !== undefined ? { label: instance.label } : {},
          ...instance.reportTo !== undefined ? { reportTo: instance.reportTo } : {} }, revision: store.blockRevision(`source:${instance.id}`),
        restarts: SETUP_FIELDS[instance.kind] ?? [], fields: kind?.fields ?? [], facts: kind?.facts?.(setup.deployment) ?? {},
        labels: store.get(KV.sources.labels(instance.id)) ?? {}, ...problem ? { problem } : {},
        ...policyOf(sources, store, settings, instance.id, instance.kind, health) }
    }),
    environment: { root: executionRoot(settings, stateDir), variables: declaredVariables(sources, settings) },
  }
}
export type SettingsView = ReturnType<typeof settingsView>
export type SourceSettingsView = SettingsView['sources'][number]
