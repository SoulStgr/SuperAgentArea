/**
 * The default Sources a new installation starts with: one local folder instance, its operator's Policy, and the operator
 * the folder Source attributes drops to. Seeding runs once, after startup, and records that it did in KV, so removing the
 * instance afterwards never brings it back. Any failure leaves the record unwritten, so the next start tries again.
 */
import { mkdirSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { KV } from '../kv.ts'
import { SettingsSchema, policyVersion, type Settings } from '../policy.ts'
import type { Store } from './store.ts'

/** The default folder instance's id: the kind itself, as an installation's first instance always was. */
export const DEFAULT_FOLDER_ID = 'folder'
/** The default folder instance's label, the kind's own title. */
export const DEFAULT_FOLDER_LABEL = '本地文件夹'
/** The folders a new installation's single folder instance watches, under the state directory rather than the workspace. */
export const defaultFolderPaths = (stateDir: string) => ({ inbox: join(stateDir, 'area', 'local', 'inbox'),
  outbox: join(stateDir, 'area', 'local', 'outbox') })

/** The host of one seeding run: the Store the settings live in, the state directory and the operator to allow. */
export interface DefaultSourcesHost {
  readonly store: Pick<Store, 'get' | 'set' | 'settings' | 'saveSettings' | 'atomic' | 'blockRevision'>
  readonly stateDir: string
  /** Actor id of the local operator; the OS user name when omitted. */
  operator?: string
}

/** The OS user name a folder drop is attributed to, with a last resort for environments that report none. */
function operatorName(): string {
  return userInfo().username.trim() || process.env.USERNAME?.trim() || process.env.USER?.trim() || 'operator'
}

/**
 * Seeds the default folder Source once: when no folder instance is stored, adds the `folder` instance with its directories,
 * operator and polling interval, and its Policy part (`allowed` naming the operator and the admission table's defaults).
 * Writes `saa.defaults.seeded` only after the settings are saved, so a failure rolls back and a later start retries.
 * @returns Whether this call wrote the record; false once it was written before, or when only the record was left to write.
 */
export function ensureDefaultSources({ store, stateDir, operator = operatorName() }: DefaultSourcesHost): boolean {
  if (store.get(KV.runtime.defaultsSeeded)) return false
  const current = store.settings()
  const hasFolder = Object.values(current.sources).some(source => source.kind === DEFAULT_FOLDER_ID)
  let seeded: Settings | undefined
  if (!hasFolder) {
    const { inbox, outbox } = defaultFolderPaths(stateDir)
    // An upgrade may keep a legacy Policy part for the bare kind: keep the admission rows and the instance's own rules,
    // while the allowed list names exactly the operator whose drops the new instance attributes to itself.
    const policy = current.policy.sources[DEFAULT_FOLDER_ID]
    seeded = SettingsSchema.parse({ ...current,
      sources: { ...current.sources, [DEFAULT_FOLDER_ID]: { kind: DEFAULT_FOLDER_ID, enabled: true, label: DEFAULT_FOLDER_LABEL,
        config: { inbox, outbox, operator, pollSeconds: 10 } } },
      policy: { ...current.policy, sources: { ...current.policy.sources, [DEFAULT_FOLDER_ID]: { allowed: [{ id: operator }],
        admission: policy?.admission ?? {}, ...policy?.rules ? { rules: policy.rules } : {} } } } })
    // The folders exist before the first poll, so a drop can be placed as soon as the instance appears.
    mkdirSync(inbox, { recursive: true, mode: 0o700 })
    mkdirSync(outbox, { recursive: true, mode: 0o700 })
  }
  store.atomic(() => {
    if (seeded) {
      store.saveSettings(seeded, { source: 'migration', block: 'policy', policyVersion: policyVersion(seeded), policyChanged: false,
        notified: [] })
      store.set(KV.settings.block(`source:${DEFAULT_FOLDER_ID}`), store.blockRevision(`source:${DEFAULT_FOLDER_ID}`) + 1)
    }
    store.set(KV.runtime.defaultsSeeded, new Date().toISOString())
  })
  return true
}
