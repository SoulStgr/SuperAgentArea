/** The default Sources a new installation starts with: one local folder instance, its operator's Policy, and the one-time record. */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FOLDER_ID, DEFAULT_FOLDER_LABEL, defaultFolderPaths, ensureDefaultSources } from '../src/app/defaults.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-defaults-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('default Sources', () => {
  it('seeds one local folder instance with its operator, Policy and directories, and records it once', () => {
    expect(ensureDefaultSources({ store, stateDir: directory, operator: 'alice' })).toBe(true)
    const settings = store.settings()
    const { inbox, outbox } = defaultFolderPaths(directory)
    expect(DEFAULT_FOLDER_ID).toBe('folder')
    expect(DEFAULT_FOLDER_LABEL).toBe('本地文件夹')
    expect(settings.sources.folder).toEqual({ kind: 'folder', enabled: true, label: '本地文件夹',
      config: { inbox, outbox, operator: 'alice', pollSeconds: 10 } })
    // Only the listed operator's direct drops can start work; the admission table keeps its defaults.
    expect(settings.policy.sources.folder).toEqual({ allowed: [{ id: 'alice' }], admission: {} })
    expect(existsSync(inbox)).toBe(true)
    expect(existsSync(outbox)).toBe(true)
    expect(store.get(KV.runtime.defaultsSeeded)).toEqual(expect.any(String))
    // A later call writes nothing, not even with another operator.
    expect(ensureDefaultSources({ store, stateDir: directory, operator: 'bob' })).toBe(false)
    expect(store.settings()).toEqual(settings)
  })
  it('never brings the folder instance back once a person deleted it', () => {
    ensureDefaultSources({ store, stateDir: directory, operator: 'alice' })
    const settings = store.settings()
    store.saveSettings({ ...settings, sources: {}, policy: { ...settings.policy, sources: {} } })
    expect(ensureDefaultSources({ store, stateDir: directory, operator: 'alice' })).toBe(false)
    expect(store.settings().sources).toEqual({})
    expect(store.get(KV.runtime.defaultsSeeded)).toEqual(expect.any(String))
  })
  it('only records the marker when a folder instance already exists, changing neither its instance nor its Policy', () => {
    const existing = SettingsSchema.parse({ sources: { 'folder:ops': { kind: 'folder', enabled: false,
      config: { inbox: '/in/ops', outbox: '/out/ops', operator: 'bob' } } },
    policy: { sources: { 'folder:ops': { allowed: [{ id: 'bob' }] } } } })
    store.saveSettings(existing)
    expect(ensureDefaultSources({ store, stateDir: directory, operator: 'alice' })).toBe(true)
    expect(store.settings()).toEqual(existing)
    expect(store.get(KV.runtime.defaultsSeeded)).toEqual(expect.any(String))
    // No default directories are made when nothing is seeded.
    expect(existsSync(join(directory, 'area', 'local', 'inbox'))).toBe(false)
  })
  it('leaves no marker when saving fails, so the next start seeds', () => {
    const save = vi.spyOn(store, 'saveSettings').mockImplementationOnce(() => { throw new Error('disk full') })
    expect(() => ensureDefaultSources({ store, stateDir: directory, operator: 'alice' })).toThrow('disk full')
    save.mockRestore()
    expect(store.get(KV.runtime.defaultsSeeded)).toBeUndefined()
    expect(store.settings().sources).toEqual({})
    expect(ensureDefaultSources({ store, stateDir: directory, operator: 'alice' })).toBe(true)
    expect(store.settings().sources.folder).toBeDefined()
    expect(store.get(KV.runtime.defaultsSeeded)).toBeDefined()
  })
})
