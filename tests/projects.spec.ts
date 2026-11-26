/** The Project registry and the area layout a workspace ticket works and delivers in. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { WORKSPACE_PROJECT_ID, artifactRecordId, conversationDirectory, type ProjectRecord } from '../src/core/index.ts'
import { workspaceDirectories, workspaceProject, workspaceTicketDirectory } from '../src/app/projects.ts'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-projects-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const at = '2026-11-25T00:00:00.000Z'
/** A station Project around a folder a person named. */
const station = (id: string, key: string, fields: Partial<ProjectRecord> = {}): ProjectRecord => ({ id, key, status: 'active', createdAt: at, updatedAt: at,
  value: { name: key, kind: 'station', location: { type: 'folder', path: `/users/alice/${key}` }, outputDir: `/users/alice/${key}`,
    scratchDir: join(directory, 'area', `${key}.work`), rulesDir: join(directory, 'area', `${key}.work`, 'rules'), sourceIds: [], aliases: [] },
  ...fields })

it('works a Project conversation in its named folder, its local checkout, or its working copies', () => {
  const base = station('prj_aps', 'aps')
  expect(conversationDirectory(base)).toBe('/users/alice/aps')
  const repo = (path?: string): ProjectRecord => ({ ...base, value: { ...base.value,
    location: { type: 'repo', ...path ? { path } : {}, url: 'https://github.com/acme/aps.git' } } })
  expect(conversationDirectory(repo('/users/alice/aps-repo'))).toBe('/users/alice/aps-repo')
  expect(conversationDirectory(repo())).toBe(base.value.scratchDir)
  // The built-in workspace has no folder of its own: its conversation stays in its working copies.
  expect(conversationDirectory({ ...base, value: { ...base.value, kind: 'workspace', location: { type: 'managed' } } })).toBe(base.value.scratchDir)
})

it('describes the built-in workspace Project with the area layout under the state directory', () => {
  expect(workspaceProject('/state', at)).toEqual({ id: WORKSPACE_PROJECT_ID, key: 'workspace', status: 'active', createdAt: at, updatedAt: at,
    value: { name: 'workspace', kind: 'workspace', location: { type: 'managed' }, outputDir: join('/state', 'area', 'workspace'),
      scratchDir: join('/state', 'area', 'workspace', '.work'), rulesDir: join('/state', 'area', 'workspace', '.work', 'rules'), sourceIds: [], aliases: [] } })
  // An artifact row is named by its Ticket and file name, so re-delivering a name keeps one row.
  expect(artifactRecordId('t1', 'a.md')).toBe(artifactRecordId('t1', 'a.md'))
  expect(artifactRecordId('t1', 'a.md')).toMatch(/^[0-9a-f]{16}$/)
  expect(artifactRecordId('t1', 'a.md')).not.toBe(artifactRecordId('t2', 'a.md'))
})

it('puts a workspace ticket under the area root, and follows a configured execution directory', () => {
  const settings = SettingsSchema.parse({})
  expect(workspaceDirectories(settings, '/state')).toEqual({ outputDir: join('/state', 'area', 'workspace'),
    scratchDir: join('/state', 'area', 'workspace', '.work'), rulesDir: join('/state', 'area', 'workspace', '.work', 'rules') })
  expect(workspaceTicketDirectory(settings, '/state', 'fix-t1')).toBe(join('/state', 'area', 'workspace', '.work', 'fix-t1'))
  const configured = SettingsSchema.parse({ executor: { directory: '/srv/execution' } })
  expect(workspaceDirectories(configured, '/state').outputDir).toBe(join('/srv/execution', 'workspace'))
  expect(workspaceTicketDirectory(configured, '/state', 'fix-t1')).toBe(join('/srv/execution', 'workspace', '.work', 'fix-t1'))
})

it('creates the built-in workspace Project once, and lists, finds and saves Projects by id and key', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  expect(store.stateDir).toBe(directory)
  // The schema 12 migration left the workspace in place.
  expect(store.projects.get(WORKSPACE_PROJECT_ID)).toMatchObject({ key: 'workspace', status: 'active',
    value: { outputDir: join(directory, 'area', 'workspace'), scratchDir: join(directory, 'area', 'workspace', '.work') } })
  // Creating it again keeps the row, with its original creation time.
  const workspace = store.projects.ensureWorkspace('/elsewhere')!
  expect(store.projects.ensureWorkspace('/elsewhere')).toEqual(workspace)
  expect(store.projects.list()).toEqual([workspace])
  // A station a person named lives at its own address; the workspace sorts after it as it was changed earlier.
  const aps = station('prj_aps', 'aps', { updatedAt: '2099-01-01T00:00:00.000Z' })
  store.projects.save(aps)
  expect(store.projects.get('prj_aps')).toEqual(aps)
  expect(store.projects.byKey('aps')).toEqual(aps)
  expect(store.projects.list().map(project => project.id)).toEqual(['prj_aps', WORKSPACE_PROJECT_ID])
  expect(store.projects.list('archived')).toEqual([])
  // Archiving keeps the row and its history.
  const archived = { ...aps, status: 'archived' as const, updatedAt: '2099-01-02T00:00:00.000Z' }
  store.projects.save(archived)
  expect(store.projects.list('active').map(project => project.id)).toEqual([WORKSPACE_PROJECT_ID])
  expect(store.projects.list('archived')).toEqual([archived])
  // Saving a Project again keeps its place in the database.
  store.projects.save({ ...archived, status: 'active', updatedAt: '2099-01-03T00:00:00.000Z' })
  expect(store.projects.list()).toEqual([{ ...archived, status: 'active', updatedAt: '2099-01-03T00:00:00.000Z' }, workspace])
  store.close()
})
