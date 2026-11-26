/** Concurrency, retry, and validation tests for settings saves, pause toggling, and policy synchronization. */
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { UserError } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { Setup } from '../src/app/setup.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import { policyHistory } from '../src/app/settings-history.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { policyVersion } from '../src/policy.ts'
import { CHAT, MEMBER, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
/** A Source kind with one credential field, registered by the tests that check the settings history and account names. */
const vaultKind: SourceKind = {
  kind: 'vault', order: 90,
  title: { zh: '保险库', en: 'Vault' },
  description: { zh: '测试用的来源', en: 'A Source for tests' },
  schema: z.object({ token: z.string().default('') }),
  fields: [{ key: 'token', type: 'text', label: { zh: '令牌', en: 'Token' } }],
  health: ['vault'],
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}
const model = { provider: 'worker-provider', model: 'worker-model' }
/** Wait for the Policy syncs the Runtime runs as it starts, so a test's own save cannot race them. */
async function settled(host: Host) {
  await vi.waitFor(() => expect(host.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await host.runtime.idle()
}

it('refuses a save of a block that another save changed during its model or account check, and saves nothing of it', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const llm = (h.ctx as unknown as { llm: { resolveCallConfig: ReturnType<typeof vi.fn> } }).llm
  const check = deferred<unknown>()
  llm.resolveCallConfig.mockImplementationOnce(() => check.promise)
  const executor = store.settings().executor
  const revision = store.blockRevision('executor')
  const slow = settings.save('executor', { ...executor, model, maxWorkers: 5 }, revision, 'panel')
  await settings.save('executor', { ...executor, maxWorkers: 2 }, revision, 'panel')
  check.resolve(model)
  await expect(slow).rejects.toThrow(SettingsConflict)
  expect(store.settings().executor).toMatchObject({ maxWorkers: 2, model: executor.model })
  // An account check that a save of the same Source outruns is refused the same way.
  const accounts = deferred<void>()
  vi.spyOn(Setup.prototype, 'checkAccounts').mockImplementationOnce(() => accounts.promise)
  const github = settings.block('source:github')
  const value = github.value as { enabled: boolean; config: Record<string, unknown> }
  const moved = settings.save('source:github', { ...value, config: { ...value.config, cli: '/opt/bin/gh-other' } }, github.revision,
    'panel')
  await settings.save('source:github', { ...value, config: { ...value.config, pollSeconds: 90 } }, github.revision, 'panel')
  accounts.resolve()
  await expect(moved).rejects.toThrow(SettingsConflict)
  expect(store.settings().sources.github!.config).toMatchObject({ cli: value.config.cli, pollSeconds: 90 })
})

it('refuses a Policy sync that a Policy save outran, reports it on sync:feishu, and keeps the save', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const members = deferred<unknown>()
  vi.mocked(Commands.prototype.lark).mockImplementationOnce(() => members.promise as never)
  const syncing = settings.sync('feishu')
  const policy = store.settings().policy
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix docs' }]
  await settings.save('policy', { ...policy, rules }, store.blockRevision('policy'), 'panel')
  members.resolve({ users: [{ member_id: 'ou_alice', name: 'Alice' }, { member_id: 'ou_new', name: 'New' }], has_more: false })
  await expect(syncing).rejects.toThrow(SettingsConflict)
  expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error',
    detail: expect.stringContaining('Policy changed during synchronization') })
  expect(store.settings().policy).toMatchObject({ rules, sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } })
})

it('syncs a Policy part again after a failed sync, a minute later and then after a wait that doubles, until it succeeds', async () => {
  h = await startRuntime()
  const { settings } = h.runtime
  // The syncs the Runtime runs as it starts finish first.
  await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
  await h.runtime.idle()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const lark = vi.mocked(Commands.prototype.lark)
    lark.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'))
    await expect(settings.sync('feishu')).rejects.toThrow('network down')
    expect(h.runtime.health['sync:feishu']).toMatchObject({ state: 'error', detail: expect.stringContaining('network down') })
    const calls = () => lark.mock.calls.filter(([args]) => args.includes('+chat-members-list')).length
    const before = calls()
    await vi.advanceTimersByTimeAsync(60_000)
    // The first retry fails too, so the next waits two minutes.
    expect(calls()).toBe(before + 1)
    lark.mockResolvedValueOnce({ users: [{ member_id: 'ou_alice', name: 'Alice' }], has_more: false })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(before + 1)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(h!.runtime.health['sync:feishu']).toMatchObject({ state: 'ready' }))
    expect(calls()).toBe(before + 2)
    // A success ends the retries.
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(calls()).toBe(before + 2)
  } finally { vi.useRealTimers() }
})
it('records nothing for a pause that changes nothing, refuses a sync while setup waits, and names an unknown block', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  const revision = store.blockRevision('pause')
  const inject = h.agents.get(h.runtime.masterId)!.inject
  inject.mockClear()
  expect(await settings.pause(false, 'panel')).toEqual({ paused: false })
  await h.runtime.idle()
  expect([store.blockRevision('pause'), inject.mock.calls.length, h.runtime.effects.pending('notice')]).toEqual([revision, 0, false])
  vi.spyOn(Setup.prototype, 'configured').mockReturnValue(false)
  await expect(settings.sync('feishu')).rejects.toThrow(new UserError('nothingToSync', { source: 'feishu' }))
  vi.mocked(Setup.prototype.configured).mockRestore()
  expect(() => settings.block('source:x')).toThrow(new UserError('unknownBlock', { block: 'source:x' }))
})

it('deletes a Source instance and its Policy part, refusing while one of its Tickets is still open', async () => {
  h = await startRuntime()
  const { settings, store } = h.runtime
  await expect(settings.remove('missing')).rejects.toThrow(new UserError('unknownSource', { source: 'missing' }))
  const now = new Date().toISOString()
  const live = { id: 't1', title: 't1', decisionId: 'd', channels: [], undelivered: [], createdAt: now, updatedAt: now, sourceId: 'feishu',
    mandate: { strength: 'explicit' as const, policyVersion: '', basis: { via: 'listed' as const }, actor: { source: 'feishu', id: MEMBER },
      scope: '' }, origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [], inputs: [] }
  store.tickets.save(live)
  await expect(settings.remove('feishu')).rejects.toThrow(new UserError('sourceInUse', { source: 'feishu', count: '1' }))
  expect(store.settings().sources.feishu).toBeDefined()
  store.tickets.save({ ...live, ended: { at: now, by: 'human', outcome: 'stopped' } })
  expect(await settings.remove('feishu')).toEqual({ deleted: true })
  expect(store.settings().sources.feishu).toBeUndefined()
  expect(store.settings().policy.sources.feishu).toBeUndefined()
  // The deleted block no longer exists, while another instance's blocks stay saveable.
  expect(() => settings.block('source:feishu')).toThrow(new UserError('unknownBlock', { block: 'source:feishu' }))
  expect(settings.block('source:github')).toMatchObject({ block: 'source:github' })
})
it('saves one Source instance\'s own Policy part under its own block revision, keeping the kind fields and admission table', async () => {
  h = await startRuntime()
  await settled(h)
  const { settings, store } = h.runtime
  const initial = settings.block('policy:feishu') as { revision: number; value: Record<string, unknown> }
  expect(initial.value).toMatchObject({ allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT, admission: {} })
  expect(initial.value.rules).toBeUndefined()
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix documentation.' }]
  const policyRevision = store.blockRevision('policy'), defaultRules = store.settings().policy.rules
  const saved = await settings.save('policy:feishu', { ...initial.value, rules }, initial.revision, 'panel')
  expect(saved).toMatchObject({ saved: true, policy_changed: true, restarting: false })
  expect(store.settings().policy.sources.feishu).toMatchObject({ rules, allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT })
  expect(store.blockRevision('policy:feishu')).toBe(initial.revision + 1)
  // The installation's own `policy` block and its default rules are untouched.
  expect([store.blockRevision('policy'), store.settings().policy.rules]).toEqual([policyRevision, defaultRules])
  // A save against the old revision is refused as stale, while the stored part and its revision keep the last save.
  await expect(settings.save('policy:feishu', { ...initial.value, rules: [] }, initial.revision, 'panel')).rejects.toThrow(SettingsConflict)
  expect(store.settings().policy.sources.feishu!.rules).toEqual(rules)
  expect(settings.block('policy:feishu')).toMatchObject({ revision: initial.revision + 1,
    value: { rules, allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT } })
})

it('summarizes each Source\'s effective rules in the settings view, marking the ones that inherit the default rules', async () => {
  h = await startRuntime()
  await settled(h)
  const { settings, store } = h.runtime
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix documentation.' }]
  const block = settings.block('policy:feishu') as { revision: number; value: Record<string, unknown> }
  await settings.save('policy:feishu', { ...block.value, rules }, block.revision, 'panel')
  const view = settings.view()
  const summary = (rule: { id: string; name: string; enabled: boolean }) => ({ id: rule.id, name: rule.name, enabled: rule.enabled })
  expect(view.sources.find(item => item.id === 'feishu')).toMatchObject({ policy: { revision: block.revision + 1, inherited: false,
    rules: rules.map(summary), read: 'settings/policy:feishu' } })
  // A Source without its own rules inherits the installation's default ones.
  const github = view.sources.find(item => item.id === 'github')!
  expect(github.policy).toEqual({ revision: store.blockRevision('policy:github'), inherited: true,
    rules: store.settings().policy.rules.map(summary), read: 'settings/policy:github' })
})

it('keeps a Source\'s own rules through a save of the installation\'s Policy block, and validates a Source part against its kind', async () => {
  h = await startRuntime()
  await settled(h)
  const { settings, store } = h.runtime
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix documentation.' }]
  const block = settings.block('policy:feishu') as { revision: number; value: Record<string, unknown> }
  await settings.save('policy:feishu', { ...block.value, rules }, block.revision, 'panel')
  const policy = store.settings().policy
  const design = { id: 'design', name: 'Design', enabled: true, instruction: 'Adjust design.' }
  await settings.save('policy', { ...policy, rules: [...policy.rules, design] }, store.blockRevision('policy'), 'panel')
  expect(store.settings().policy).toMatchObject({ rules: [...policy.rules, design], sources: { feishu: { rules }, github: { allowed: [{ id: 'alice' }] } } })
  expect((settings.block('policy:github') as { value: Record<string, unknown> }).value.rules).toBeUndefined()
  // A kind-specific field is validated by the kind, and duplicate rule ids by the Policy's rule schema.
  const revision = (settings.block('policy:feishu') as { revision: number }).revision
  await expect(settings.save('policy:feishu', { ...block.value, syncChat: 'not a chat' }, revision, 'panel')).rejects.toThrow()
  await expect(settings.save('policy:feishu', { ...block.value, rules: [...rules, { ...rules[0]!, name: 'Again' }] }, revision, 'panel')).rejects.toThrow()
  await expect(settings.save('policy:missing', { allowed: [], admission: {} }, 0, 'panel'))
    .rejects.toThrow(new UserError('unknownSource', { source: 'missing' }))
})

it('syncs a Source\'s roster into its own Policy part without dropping its own rules', async () => {
  h = await startRuntime()
  await settled(h)
  const { settings, store } = h.runtime
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix documentation.' }]
  const block = settings.block('policy:feishu') as { revision: number; value: Record<string, unknown> }
  await settings.save('policy:feishu', { ...block.value, rules }, block.revision, 'panel')
  const before = store.blockRevision('policy:feishu'), policyRevision = store.blockRevision('policy')
  vi.mocked(Commands.prototype.lark).mockResolvedValueOnce({ users: [{ member_id: MEMBER, name: 'Alice' }, { member_id: 'ou_new', name: 'New' }], has_more: false })
  const synced = await settings.sync('feishu')
  expect(synced).toMatchObject({ rules, allowed: [{ id: MEMBER, name: 'Alice' }, { id: 'ou_new', name: 'New' }] })
  expect(store.settings().policy.sources.feishu).toMatchObject({ rules, allowed: [{ id: MEMBER, name: 'Alice' }, { id: 'ou_new', name: 'New' }] })
  // The synced part is its own block revision; the installation's Policy block is not rewritten.
  expect([store.blockRevision('policy:feishu'), store.blockRevision('policy')]).toEqual([before + 1, policyRevision])
})

it('shows a Source\'s own rule changes in the policy history without changing the global rule history', async () => {
  h = await startRuntime()
  await settled(h)
  const { settings, store } = h.runtime
  const history = () => policyHistory(store, h!.runtime.sources, policyVersion(store.settings()))
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix documentation.' }]
  const block = settings.block('policy:feishu') as { revision: number; value: Record<string, unknown> }
  await settings.save('policy:feishu', { ...block.value, rules }, block.revision, 'panel')
  expect(history().items[0]).toMatchObject({ block: 'policy:feishu' })
  // A Source that starts overriding the default rules reports the rules its work gains and loses.
  expect(history().items[0]!.changes).toEqual(expect.arrayContaining([
    { code: 'ruleAdded', name: 'Docs', source: 'feishu', part: true },
    { code: 'ruleRemoved', name: 'Copy fixes', source: 'feishu', part: true },
    { code: 'ruleRemoved', name: 'Visual fixes', source: 'feishu', part: true }]))
  const changed = settings.block('policy:feishu') as { revision: number; value: Record<string, unknown> }
  await settings.save('policy:feishu', { ...changed.value, rules: [{ ...rules[0]!, instruction: 'Fix docs only.', enabled: false }] }, changed.revision, 'panel')
  expect(history().items[0]!.changes).toEqual(expect.arrayContaining([
    { code: 'ruleInstruction', name: 'Docs', source: 'feishu', part: true },
    { code: 'ruleDisabled', name: 'Docs', source: 'feishu', part: true }]))
  const emptied = settings.block('policy:feishu') as { revision: number; value: Record<string, unknown> }
  await settings.save('policy:feishu', { ...emptied.value, rules: [] }, emptied.revision, 'panel')
  expect(history().items[0]!.changes).toEqual(expect.arrayContaining([{ code: 'ruleRemoved', name: 'Docs', source: 'feishu', part: true }]))
  // The installation's own rule history still reports its rules by name alone.
  const policy = store.settings().policy
  const design = { id: 'design', name: 'Design', enabled: true, instruction: 'Adjust design.' }
  await settings.save('policy', { ...policy, rules: [...policy.rules, design] }, store.blockRevision('policy'), 'panel')
  const changes = history().items[0]!.changes!
  expect(changes).toEqual(expect.arrayContaining([{ code: 'ruleAdded', name: 'Design' }]))
  expect(changes.filter(change => change.source === undefined && change.code === 'ruleAdded')).toEqual([{ code: 'ruleAdded', name: 'Design' }])
})

it('saves a Source Policy part through the panel settings route, and the settings view reports its rules and inheritance', async () => {
  h = await startRuntime()
  await settled(h)
  const { store } = h.runtime
  type SettingsBody = { sources: { id: string; policy: { revision: number; inherited: boolean; value: Record<string, unknown>;
    rules: { id: string; name: string; enabled: boolean }[] } }[] }
  const read = async () => (await h!.api('GET', 'settings')).body as SettingsBody
  const feishuOf = (body: SettingsBody) => body.sources.find(item => item.id === 'feishu')!
  const before = feishuOf(await read())
  expect(before.policy).toMatchObject({ inherited: true })
  expect(before.policy.rules.map(rule => rule.id)).toEqual(store.settings().policy.rules.map(rule => rule.id))
  const rules = [{ id: 'docs', name: 'Docs', enabled: true, instruction: 'Fix documentation.' }]
  const policyRevision = store.blockRevision('policy'), defaultRules = store.settings().policy.rules
  const saved = await h.api('PUT', 'settings/policy:feishu', { value: { ...before.policy.value, rules }, revision: before.policy.revision })
  expect(saved).toMatchObject({ status: 200, body: { saved: true, policy_changed: true } })
  const after = feishuOf(await read())
  expect(after.policy).toMatchObject({ revision: before.policy.revision + 1, inherited: false,
    rules: rules.map(({ id, name, enabled }) => ({ id, name, enabled })) })
  expect(store.settings().policy.sources.feishu!.rules).toEqual(rules)
  // The installation's own Policy block and its default rules stay as they were.
  expect([store.blockRevision('policy'), store.settings().policy.rules]).toEqual([policyRevision, defaultRules])
})

it('records a credential change in the configuration history as set, replaced or cleared, never by value', async () => {
  h = await startRuntime()
  await settled(h)
  h.runtime.sources.register(vaultKind)
  const { settings, store } = h.runtime
  const history = () => policyHistory(store, h!.runtime.sources, policyVersion(store.settings()))
  await settings.add({ id: 'vault', kind: 'vault', label: '凭证库', config: { token: 'first-secret' } })
  expect(history().items[0]!.changes).toContainEqual({ code: 'sourceSecretSet', source: 'vault', field: 'token' })
  type Block = { revision: number; value: { enabled: boolean; config: Record<string, unknown>; label?: string } }
  const block = settings.block('source:vault') as Block
  expect(block.value).toMatchObject({ label: '凭证库', config: { token: 'first-secret' } })
  await settings.save('source:vault', { ...block.value, config: { token: 'second-secret' } }, block.revision, 'panel')
  const changes = history().items[0]!.changes!
  expect(changes).toContainEqual({ code: 'sourceSecretChanged', source: 'vault', field: 'token' })
  expect(changes.some(change => change.code === 'sourceField' && change.field === 'token')).toBe(false)
  // Neither the current nor an older value passes through the history the panel reads.
  const json = JSON.stringify(history())
  expect(json).not.toContain('first-secret')
  expect(json).not.toContain('second-secret')
  // Clearing the credential is reported as cleared, still without the value it had.
  const next = settings.block('source:vault') as Block
  await settings.save('source:vault', { ...next.value, config: { token: '' } }, next.revision, 'panel')
  expect(history().items[0]!.changes).toContainEqual({ code: 'sourceSecretCleared', source: 'vault', field: 'token' })
})

it('renames a Source account through its settings block and refuses a name another account already uses', async () => {
  h = await startRuntime()
  await settled(h)
  h.runtime.sources.register(vaultKind)
  const { settings, store } = h.runtime
  type Block = { revision: number; value: { enabled: boolean; config: Record<string, unknown>; label?: string } }
  await settings.add({ id: 'vault:a', kind: 'vault', label: '主凭证', config: { token: 'a' } })
  await settings.add({ id: 'vault:b', kind: 'vault', label: '备用凭证', config: { token: 'b' } })
  const block = () => settings.block('source:vault:b') as Block
  // Creating another account with the same name, or renaming this one to it, is refused naming the account that has it.
  await expect(settings.add({ id: 'vault:c', kind: 'vault', label: '主凭证', config: {} }))
    .rejects.toThrow(new UserError('sourceLabelExists', { source: 'vault:a', label: '主凭证' }))
  const first = block()
  await expect(settings.save('source:vault:b', { ...first.value, label: ' 主凭证 ' }, first.revision, 'panel'))
    .rejects.toThrow(new UserError('sourceLabelExists', { source: 'vault:a', label: '主凭证' }))
  // The account's own name is not a duplicate, and a new name is saved and shown in the settings block.
  const current = block()
  await settings.save('source:vault:b', { ...current.value, label: '备用凭证' }, current.revision, 'panel')
  const renamed = block()
  await settings.save('source:vault:b', { ...renamed.value, label: '备份凭证' }, renamed.revision, 'panel')
  expect(store.settings().sources['vault:b']!.label).toBe('备份凭证')
  expect(block().value.label).toBe('备份凭证')
  expect(policyHistory(store, h.runtime.sources, policyVersion(store.settings())).items[0]!.changes)
    .toContainEqual({ code: 'sourceLabel', source: 'vault:b', from: '备用凭证', to: '备份凭证' })
  // Names differing only in case are the same name.
  await settings.add({ id: 'vault:d', kind: 'vault', label: 'Backup', config: {} })
  await expect(settings.add({ id: 'vault:e', kind: 'vault', label: ' backup ', config: {} }))
    .rejects.toThrow(new UserError('sourceLabelExists', { source: 'vault:d', label: 'backup' }))
})
