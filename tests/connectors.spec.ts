/** The placeholder Source kinds: their catalog entries, their stored accounts, and the paused coming-soon state the views give them. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { sourcesStatus } from '../src/app/views/sources.ts'
import { SettingsSchema } from '../src/policy.ts'
import { connectorKinds } from '../src/sources/connectors.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { folderKind } from '../src/sources/folder.ts'
import { githubKind } from '../src/sources/github.ts'
import { HEALTH_TEXT } from '../src/sources/host.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { remoteKind } from '../src/sources/remote.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

const directories: string[] = []
const stores: Store[] = []
function storeOf(settings = SettingsSchema.parse({})): Store {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-connectors-'))
  directories.push(directory)
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  stores.push(store)
  store.saveSettings(settings)
  return store
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const links = () => ({ url: '', label: { zh: '', en: '' } })

describe('placeholder Source kinds', () => {
  it('declares seven coming-soon kinds with both languages, credential fields, a parseable schema and no loops', () => {
    expect(connectorKinds.map(kind => kind.kind)).toEqual(['gitee', 'wechat', 'dingtalk', 'qq', 'telegram', 'wecom', 'email'])
    for (const kind of connectorKinds) {
      expect(kind.placeholder, kind.kind).toBe(true)
      expect(kind.health).toEqual([kind.kind])
      expect([kind.title.zh, kind.title.en, kind.description.zh, kind.description.en].every(Boolean), kind.kind).toBe(true)
      expect(kind.fields.length, kind.kind).toBeGreaterThan(0)
      for (const field of kind.fields) expect(field.label.zh && field.label.en, `${kind.kind}.${field.key}`).toBeTruthy()
      // An account saves before the connection exists, so even an empty configuration parses.
      expect(kind.schema.parse({})).toEqual(expect.any(Object))
      // Nothing watches, sends or scopes a placeholder kind.
      expect(kind.channel, kind.kind).toBeUndefined()
      expect(kind.scope, kind.kind).toBeUndefined()
      expect(kind.threadContext, kind.kind).toBeUndefined()
    }
  })
  it('offers the eleven kinds in the catalog, in plan order, marking the seven placeholders', () => {
    const store = storeOf()
    const sources = new SourceRegistry(() => store.settings())
    for (const kind of [feishuKind, githubKind, folderKind, remoteKind, ...connectorKinds] as SourceKind[]) sources.register(kind)
    const catalog = sources.catalog()
    expect(catalog.map(kind => kind.kind))
      .toEqual(['folder', 'remote', 'qq', 'dingtalk', 'wechat', 'wecom', 'email', 'feishu', 'github', 'gitee', 'telegram'])
    expect(catalog.filter(kind => kind.placeholder).map(kind => kind.kind))
      .toEqual(['qq', 'dingtalk', 'wechat', 'wecom', 'email', 'gitee', 'telegram'])
    // The implemented kinds stay non-placeholder and keep their form defaults.
    expect(catalog.find(kind => kind.kind === 'folder')).toMatchObject({ placeholder: false, defaults: { pollSeconds: 10 } })
    expect(catalog.find(kind => kind.kind === 'remote'))
      .toMatchObject({ placeholder: false, defaults: { port: 22, pollSeconds: 30, maxFileBytes: 1048576 } })
  })
  it('shows a placeholder account as paused and coming soon, while its kind receives nothing', () => {
    const settings = SettingsSchema.parse({ sources: {
      'gitee:work': { kind: 'gitee', enabled: true, config: { token: 't', repository: 'acme/widgets' } },
      qq: { kind: 'qq', enabled: false, config: {} },
    } })
    const store = storeOf(settings)
    const sources = new SourceRegistry(() => store.settings())
    for (const kind of connectorKinds) sources.register(kind)
    const rows = sourcesStatus({ store, sources, links }, {}, {})
    expect(rows.map(row => [row.id, row.state])).toEqual([['gitee:work', 'paused'], ['qq', 'off']])
    expect(rows.find(row => row.id === 'gitee:work')!.health)
      .toEqual([{ name: 'gitee:work', state: 'paused', detail: HEALTH_TEXT.placeholder, code: 'placeholder' }])
    // The instance is stored and configured, so the catalog's add form and the instance's data are available.
    expect(sources.instance('gitee:work')).toMatchObject({ kind: 'gitee', enabled: true })
    expect(sources.instances().map(instance => instance.id)).toEqual(['gitee:work', 'qq'])
  })
})
