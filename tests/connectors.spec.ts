/** The placeholder Source kinds: their catalog entries, their stored accounts, and the paused coming-soon state the views give them. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { sourcesStatus } from '../src/app/views/sources.ts'
import { SettingsSchema } from '../src/policy.ts'
import { connectorKinds } from '../src/sources/connectors.ts'
import { dingtalkKind } from '../src/sources/dingtalk.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { folderKind } from '../src/sources/folder.ts'
import { githubKind } from '../src/sources/github.ts'
import { HEALTH_TEXT } from '../src/sources/host.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { qqKind } from '../src/sources/qq.ts'
import { remoteKind } from '../src/sources/remote.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { webKind } from '../src/sources/web.ts'
import { wechatKind } from '../src/sources/wechat.ts'

const directories: string[] = []
const stores: Store[] = []
function storeOf(settings = SettingsSchema.parse({})): Store {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-superagentarea-connectors-'))
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
  it('declares four coming-soon kinds with both languages, credential fields, a parseable schema and no loops', () => {
    expect(connectorKinds.map(kind => kind.kind)).toEqual(['gitee', 'telegram', 'wecom', 'email'])
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
  it('offers the twelve kinds in the catalog, in plan order, marking the four placeholders', () => {
    const store = storeOf()
    const sources = new SourceRegistry(() => store.settings())
    for (const kind of [feishuKind, githubKind, folderKind, remoteKind, webKind, qqKind, dingtalkKind, wechatKind, ...connectorKinds] as SourceKind[]) {
      sources.register(kind)
    }
    const catalog = sources.catalog()
    expect(catalog.map(kind => kind.kind))
      .toEqual(['folder', 'remote', 'web', 'qq', 'dingtalk', 'wechat', 'wecom', 'email', 'feishu', 'github', 'gitee', 'telegram'])
    expect(catalog).toHaveLength(12)
    expect(catalog.filter(kind => kind.placeholder).map(kind => kind.kind))
      .toEqual(['wecom', 'email', 'gitee', 'telegram'])
    // The implemented kinds stay non-placeholder and keep their form defaults.
    expect(catalog.find(kind => kind.kind === 'folder')).toMatchObject({ placeholder: false, defaults: { pollSeconds: 10 } })
    expect(catalog.find(kind => kind.kind === 'remote'))
      .toMatchObject({ placeholder: false, defaults: { port: 22, pollSeconds: 30, maxFileBytes: 1048576 } })
    // The web Source is read-only and polls a public address on its own, with `latest` as the first-poll baseline.
    expect(catalog.find(kind => kind.kind === 'web')).toMatchObject({ placeholder: false, defaults: { url: '', format: 'auto',
      pollSeconds: 300, baseline: 'latest', maxItemsPerPoll: 10, jsonItemsPath: 'items', operator: 'web' } })
    expect(catalog.find(kind => kind.kind === 'qq')).toMatchObject({ placeholder: false,
      defaults: { appId: '', appSecret: '', allowedUserIds: [], sandbox: false } })
    expect(catalog.find(kind => kind.kind === 'dingtalk')).toMatchObject({ placeholder: false,
      defaults: { clientId: '', clientSecret: '', robotCode: '', allowedUserIds: [] } })
    // WeChat is a real kind now: one bot-type field and no credential in settings (the QR sign-in keeps its token in KV).
    expect(catalog.find(kind => kind.kind === 'wechat')).toMatchObject({ placeholder: false, defaults: { botType: '3' } })
  })
  it('shows a placeholder account as paused and coming soon, while its kind receives nothing', () => {
    const settings = SettingsSchema.parse({ sources: {
      'gitee:work': { kind: 'gitee', enabled: true, config: { token: 't', repository: 'acme/widgets' } },
      telegram: { kind: 'telegram', enabled: false, config: {} },
    } })
    const store = storeOf(settings)
    const sources = new SourceRegistry(() => store.settings())
    for (const kind of connectorKinds) sources.register(kind)
    const rows = sourcesStatus({ store, sources, links }, {}, {})
    expect(rows.map(row => [row.id, row.state])).toEqual([['gitee:work', 'paused'], ['telegram', 'off']])
    expect(rows.find(row => row.id === 'gitee:work')!.health)
      .toEqual([{ name: 'gitee:work', state: 'paused', detail: HEALTH_TEXT.placeholder, code: 'placeholder' }])
    // The instance is stored and configured, so the catalog's add form and the instance's data are available.
    expect(sources.instance('gitee:work')).toMatchObject({ kind: 'gitee', enabled: true })
    expect(sources.instances().map(instance => instance.id)).toEqual(['gitee:work', 'telegram'])
  })
})
