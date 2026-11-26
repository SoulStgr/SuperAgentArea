/** Project ownership: resolving a Trigger's Project, creating the station a person named, and answering a refusal. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { HealthBoard } from '../src/infra/health.ts'
import { conversationDirectory, key, threadKey, WORKSPACE_PROJECT_ID, type Decision, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { ASSESSOR_PERSON, PANEL_PERSON, ProjectService, matchProject, normalizedRepository } from '../src/app/project-service.ts'
import { projectKey, reservedPath, repositoryUrlProblem } from '../src/app/projects.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { feishuKind, feishuTrigger } from '../src/sources/feishu.ts'
import { folderKind, folderTrigger, readDrop } from '../src/sources/folder.ts'
import { githubKind } from '../src/sources/github.ts'

let directory: string
let store: Store
let projects: ProjectService
let sources: SourceRegistry
const CHAT = 'oc_team'
const MEMBER = 'ou_alice'
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orchestrator-resolve-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
  sources = new SourceRegistry(() => store.settings(), new HealthBoard())
  sources.register(feishuKind); sources.register(folderKind); sources.register(githubKind)
  const settings = SettingsSchema.parse({ sources: {
    feishu: { kind: 'feishu', enabled: true, config: { cli: 'lark-bot' } },
    'folder:ops': { kind: 'folder', enabled: true, config: { inbox: join(directory, 'inbox'), outbox: join(directory, 'outbox') } },
    github: { kind: 'github', enabled: true, config: { repository: 'acme/widgets' } },
  }, policy: { sources: { feishu: { allowed: [{ id: MEMBER }] }, 'folder:ops': { allowed: [{ id: 'alice' }] }, github: { allowed: [{ id: 'alice' }] } } } })
  store.saveSettings(settings)
  projects = new ProjectService({ store, sources, settings: () => store.settings(), stateDir: directory })
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

const feishu = (id: string, meta: Record<string, unknown> = {}): Trigger => feishuTrigger({ message_id: `om_${id}`, chat_id: CHAT, chat_type: 'group',
  sender_id: MEMBER, sender_type: 'user', content: 'do this', create_time: '2026-09-09T00:00:00Z', mentions: [{ id: 'ou_bot' }], ...meta },
'ou_bot', 'cli_bot')!
const github = (id: string): Trigger => ({ id: `github-${id}`, source: 'github', threads: [{ source: 'github', id }], actor: { source: 'github', id: 'alice' },
  human: true, addressed: 'mention', at: '2026-09-09T00:00:00Z', text: 'do this', meta: { number: Number(id), kind: 'issue' } })
const settingsWith = (patch: (value: ReturnType<Store['settings']>) => unknown) => store.saveSettings(patch(store.settings()))

it('resolves the instance default first, then what the event states, and offers candidates when nothing matches', () => {
  const aps = projects.create({ name: 'aps', location: { type: 'managed' }, specifiedBy: PANEL_PERSON })
  // The Feishu instance's default Project owns its work.
  settingsWith(settings => ({ ...settings, sources: { ...settings.sources,
    feishu: { ...settings.sources.feishu!, defaultProjectId: aps.id } } }))
  expect(projects.resolve(feishu('1'))).toMatchObject({ project: { id: aps.id }, via: 'default' })
  expect(projects.candidates()).toContainEqual({ id: aps.id, name: 'aps', kind: 'station' })
  // Without a default, the chat's title names the Project.
  settingsWith(({ sources: { feishu: _feishu, ...others }, ...settings }) => ({ ...settings, sources: others }))
  const trigger = feishu('2', {})
  trigger.meta.chatName = 'APS 填报群'
  expect(projects.resolve(trigger)).toMatchObject({ project: { id: aps.id }, via: 'match' })
  // A registered Project nobody names is no candidate for the resolved case, and a GitHub Trigger states nothing by itself.
  const unresolved = projects.resolve(github('7'))
  expect(unresolved).toMatchObject({ candidates: [{ id: aps.id }], hints: [] })
  expect(unresolved.project).toBeUndefined()
  expect(projects.pending(feishu('8'))).toBeUndefined()
})

it('resolves a folder task by its PROJECT.md, its task-folder name and its path', async () => {
  const folderProject = projects.create({ name: 'ops', location: { type: 'folder', path: mkdir(join(directory, 'work', 'ops')) },
    specifiedBy: PANEL_PERSON })
  const task = mkdir(join(directory, 'inbox', 'fix-login'))
  writeFileSync(join(task, 'TASK.md'), 'Fix the login bug.\n')
  writeFileSync(join(task, 'PROJECT.md'), 'ops\n')
  const drop = (await readDrop(join(directory, 'inbox'), 'fix-login', 'dir'))!
  expect(drop.project).toEqual({ name: 'ops' })
  const trigger = folderTrigger(drop, { id: 'folder:ops', inbox: join(directory, 'inbox'), outbox: join(directory, 'outbox') }, 'alice')
  expect(trigger.meta.projectHints).toContainEqual({ name: 'ops', strong: true })
  expect(sources.projectHints(trigger).hints).toContainEqual({ name: 'ops', strong: true })
  expect(projects.resolve(trigger)).toMatchObject({ project: { id: folderProject.id }, via: 'match' })
  // A bracketed task-folder name and the drop's path are hints too, so a Project inside the inbox's parent matches by address.
  const parent = projects.create({ name: 'parent', location: { type: 'folder', path: mkdir(join(directory, 'inbox', 'nested')) },
    specifiedBy: PANEL_PERSON })
  mkdir(join(directory, 'inbox', 'nested', '[parent]task'))
  writeFileSync(join(directory, 'inbox', 'nested', '[parent]task', 'TASK.md'), 'Work.\n')
  const nested = (await readDrop(join(directory, 'inbox', 'nested'), '[parent]task', 'dir'))!
  expect(nested.project).toBeUndefined()
  const nestedTrigger = folderTrigger(nested, { id: 'folder:ops', inbox: join(directory, 'inbox', 'nested'), outbox: join(directory, 'outbox') }, 'alice')
  expect(projects.resolve(nestedTrigger).project?.id).toBe(parent.id)
})

it('tells the hints that name a Project outright from those that only help a match', async () => {
  const aps = projects.create({ name: 'aps', location: { type: 'managed' }, specifiedBy: PANEL_PERSON })
  const instance = { id: 'folder:ops', inbox: join(directory, 'inbox'), outbox: join(directory, 'outbox') }
  const dropOf = async (name: string, projectFile?: string) => {
    const task = mkdir(join(instance.inbox, name))
    writeFileSync(join(task, 'TASK.md'), 'Work.\n')
    if (projectFile) writeFileSync(join(task, 'PROJECT.md'), `${projectFile}\n`)
    return (await readDrop(instance.inbox, name, 'dir'))!
  }
  // A PROJECT.md that names no registered Project is a strong hint: the request is asked about, not left to the workspace.
  const named = folderTrigger(await dropOf('explain', 'financial reports'), instance, 'alice')
  expect(projects.resolve(named)).toMatchObject({ needsQuestion: true })
  expect(projects.resolve(named).project).toBeUndefined()
  expect(projects.resolve(named).strongHints).toContainEqual({ name: 'financial reports', strong: true })
  // A `[project]` task-folder name is strong too, whether a registered Project fits it or not.
  expect(projects.resolve(folderTrigger(await dropOf('[financial reports]budget'), instance, 'alice')).needsQuestion).toBe(true)
  expect(projects.resolve(folderTrigger(await dropOf('[aps]budget'), instance, 'alice')))
    .toMatchObject({ project: { id: aps.id }, via: 'match', needsQuestion: false })
  // A plain file or folder name only helps a match: nothing asks about it, and a matching one resolves.
  expect(projects.resolve(folderTrigger(await dropOf('notes'), instance, 'alice'))).toMatchObject({ strongHints: [], needsQuestion: false })
  writeFileSync(join(instance.inbox, 'report.txt'), 'numbers\n')
  expect(projects.resolve(folderTrigger((await readDrop(instance.inbox, 'report.txt', 'file'))!, instance, 'alice')))
    .toMatchObject({ strongHints: [], needsQuestion: false })
  expect(projects.resolve(folderTrigger(await dropOf('aps'), instance, 'alice')))
    .toMatchObject({ project: { id: aps.id }, via: 'match', needsQuestion: false })
  // A chat title states a Project too, while a GitHub Trigger states none: its instance's default maps the repository.
  const chat = feishu('3', {})
  chat.meta.chatName = 'Billing 群'
  const titled = projects.resolve(chat)
  expect(titled).toMatchObject({ needsQuestion: true })
  expect(titled.strongHints).toContainEqual({ name: 'Billing 群', strong: true })
  expect(projects.resolve(github('9'))).toMatchObject({ hints: [], strongHints: [], needsQuestion: false })
})

it('matches a Project by an alias, a folder path and a normalized repository address', () => {
  expect(normalizedRepository('git@github.com:acme/aps.git')).toBe(normalizedRepository('https://github.com/acme/aps'))
  const alias = projects.create({ name: 'aps', location: { type: 'managed' }, specifiedBy: PANEL_PERSON })
  store.projects.save({ ...alias, value: { ...alias.value, aliases: ['APS-Web'] } })
  expect(matchProject(store.projects.list(), { name: ' aps-web ' })?.id).toBe(alias.id)
  const folder = projects.create({ name: 'folder station', location: { type: 'folder', path: mkdir(join(directory, 'projects', 'folder')) },
    specifiedBy: PANEL_PERSON })
  expect(matchProject(store.projects.list(), { path: join(directory, 'projects', 'folder', 'ticket') })?.id).toBe(folder.id)
  const repository = projects.create({ name: 'repo station', location: { type: 'repo', url: 'https://github.com/acme/aps.git' },
    specifiedBy: PANEL_PERSON })
  expect(matchProject(store.projects.list(), { url: 'git@github.com:acme/aps.git' })?.id).toBe(repository.id)
})

it('creates managed, folder, repository and adhoc Projects, with unique keys and the directories each needs', () => {
  const managed = projects.create({ name: 'API 服务', location: { type: 'managed' }, specifiedBy: PANEL_PERSON })
  expect(managed).toMatchObject({ id: `prj_${projectKey('API 服务')}`, key: projectKey('API 服务'), status: 'active',
    value: { name: 'API 服务', kind: 'station', location: { type: 'managed' }, specifiedBy: PANEL_PERSON } })
  expect([managed.value.outputDir, managed.value.scratchDir, managed.value.rulesDir])
    .toEqual([join(directory, 'area', managed.key), join(directory, 'area', `${managed.key}.work`),
      join(directory, 'area', `${managed.key}.work`, 'rules')])
  expect([managed.value.outputDir, managed.value.scratchDir, managed.value.rulesDir].every(path => existsSync(path))).toBe(true)
  // A repeated name takes a suffixed key, and its id follows the key.
  const again = projects.create({ name: 'API 服务', location: { type: 'managed' }, specifiedBy: PANEL_PERSON })
  expect(again.key).toBe(`${projectKey('API 服务')}-2`)
  expect(again.id).not.toBe(managed.id)
  // A named folder's deliverables land in the folder itself; a local repository's in its artifacts directory.
  const folderPath = join(directory, 'external', 'aps')
  const folder = projects.create({ name: 'aps folder', location: { type: 'folder', path: folderPath }, specifiedBy: PANEL_PERSON })
  expect(folder.value).toMatchObject({ outputDir: folderPath, scratchDir: join(directory, 'area', `${folder.key}.work`) })
  expect(existsSync(folderPath)).toBe(true)
  const repoPath = mkdir(join(directory, 'git', 'aps'))
  const repository = projects.create({ name: 'aps repo', location: { type: 'repo', path: repoPath }, specifiedBy: PANEL_PERSON })
  expect(repository.value.outputDir).toBe(join(repoPath, 'artifacts'))
  expect(existsSync(join(repoPath, 'artifacts'))).toBe(true)
  const remote = projects.create({ name: 'aps remote', location: { type: 'repo', url: 'https://github.com/acme/aps.git' },
    specifiedBy: PANEL_PERSON })
  expect(remote.value.outputDir).toBe(join(directory, 'area', remote.key))
  // An adhoc task shares the workspace's scratch area and keeps its deliverables where the person named them.
  const adhocPath = join(directory, 'adhoc', 'sort')
  const adhoc = projects.create({ name: 'sort files', kind: 'adhoc', location: { type: 'folder', path: adhocPath }, specifiedBy: PANEL_PERSON })
  expect(adhoc.value).toMatchObject({ kind: 'adhoc', outputDir: adhocPath, scratchDir: join(directory, 'area', 'workspace', '.work') })
})

it('refuses an address the plugin cannot use, and an address only a model named', () => {
  const invalid = (location: Parameters<ProjectService['create']>[0]['location']) => () =>
    projects.create({ name: 'bad', location, specifiedBy: PANEL_PERSON })
  expect(invalid({ type: 'folder', path: 'relative/path' })).toThrow('absolute path')
  expect(invalid({ type: 'repo', url: 'ftp://example.com/aps' })).toThrow('https, ssh or file')
  expect(repositoryUrlProblem('https://github.com/acme/aps.git')).toBeUndefined()
  expect(repositoryUrlProblem('ssh://git@github.com/acme/aps.git')).toBeUndefined()
  expect(repositoryUrlProblem('git@github.com:acme/aps.git')).toBeUndefined()
  const system = process.platform === 'win32' ? 'C:\\Windows\\aps' : '/etc/aps'
  expect(reservedPath(system)).toBe(true)
  expect(invalid({ type: 'folder', path: system })).toThrow('system directory')
  // An assessment may propose an external address but never create one; only a person's confirmation does.
  expect(() => projects.create({ name: 'model station', location: { type: 'managed' }, specifiedBy: ASSESSOR_PERSON }))
    .toThrow('Only a person may name')
  expect(projects.create({ name: 'confirmed station', location: { type: 'managed' }, specifiedBy: ASSESSOR_PERSON,
    confirmedBy: PANEL_PERSON }).value.confirmedBy).toEqual(PANEL_PERSON)
})

/** A `needsProject` stop of `trigger`, as the Eval records it with the candidates and proposal a person may answer. */
function refuse(trigger: Trigger, proposal?: { name: string; location: { type: 'managed' } | { type: 'folder'; path: string } }): Decision {
  store.triggers.save(trigger)
  const decision: Decision = { id: key('decision', trigger.id), evalId: key('eval', trigger.id), threadKey: threadKey(trigger.threads[0]!),
    triggerIds: [trigger.id], policyVersion: 'v', at: '2026-09-09T00:00:01Z', kind: 'stop', strength: 'inferred',
    reason: [{ code: 'needsProject', values: { candidates: [], ...proposal ? { proposal } : {} } }] }
  store.decisions.save(decision)
  return decision
}

it('answers a needsProject question with a Project, a new station or a confirmed proposal, and remembers the answer', () => {
  const aps = projects.create({ name: 'aps', location: { type: 'managed' }, specifiedBy: PANEL_PERSON })
  const existing = feishu('11', {})
  refuse(existing)
  expect(projects.pending(existing)?.decision.triggerIds).toEqual([existing.id])
  expect(projects.answer(existing.id, { projectId: aps.id })).toEqual({ resolved: aps.id, triggerId: existing.id })
  expect(store.get(KV.projects.answers(threadKey(existing.threads[0]!)))).toBe(aps.id)
  expect(projects.resolve(existing)).toMatchObject({ project: { id: aps.id }, via: 'answer' })
  // The panel may name a new station, whose address it validated before this call.
  const fresh = feishu('12', {})
  refuse(fresh)
  const panelPath = join(directory, 'panel', 'new')
  const created = projects.answer(fresh.id, { new: { name: 'new station', location: { type: 'folder', path: panelPath } } })
  expect(store.projects.get(created.resolved)!.value).toMatchObject({ name: 'new station', location: { type: 'folder', path: panelPath },
    specifiedBy: PANEL_PERSON, confirmedBy: PANEL_PERSON })
  // An assessment's proposal is created only when the person confirms it.
  const proposed = feishu('13', {})
  const proposal = { name: 'aps 填报', location: { type: 'folder' as const, path: join(directory, 'proposed', 'aps') } }
  refuse(proposed, proposal)
  expect(projects.pending(proposed)?.proposal).toEqual(proposal)
  const confirmed = projects.answer(proposed.id, { confirmProposal: true })
  expect(store.projects.get(confirmed.resolved)!.value).toMatchObject({ name: 'aps 填报', location: proposal.location,
    specifiedBy: ASSESSOR_PERSON, confirmedBy: PANEL_PERSON })
  // The panel answers the refused Trigger, not another one on its Thread, and only while its question is newest.
  const other = feishu('14', { root_id: 'om_13' })
  store.triggers.save(other)
  expect(() => projects.answer(other.id, { projectId: aps.id })).toThrow('not waiting for a Project')
  const unanswered = feishu('15')
  store.triggers.save(unanswered)
  expect(() => projects.answer(unanswered.id, { projectId: aps.id })).toThrow('not waiting for a Project')
})

it('creates, renames, aliases and archives a Project from the panel, refusing a taken name or an unknown Source', () => {
  const aps = projects.createStation({ name: 'aps', location: { type: 'managed' } })
  expect(aps).toMatchObject({ id: 'prj_aps', key: 'aps', status: 'active',
    value: { name: 'aps', kind: 'station', specifiedBy: PANEL_PERSON, confirmedBy: PANEL_PERSON, sourceIds: [], aliases: [] } })
  // A name another Project answers to is refused, so the key is the name's own slug rather than one with a suffix.
  expect(() => projects.createStation({ name: 'APS', location: { type: 'managed' } })).toThrow('already called that')
  expect(() => projects.createStation({ name: ' ', location: { type: 'managed' } })).toThrow('needs a name')
  expect(() => projects.createStation({ name: 'bad', location: { type: 'folder', path: 'relative/path' } })).toThrow('absolute path')
  // The name and the aliases change in place; the key stays through a rename, and aliases lose blanks and repetitions.
  const renamed = projects.update(aps.id, { name: 'APS 填报', aliases: ['aps', 'aps', ' 填报 ', ''] })
  expect(renamed).toMatchObject({ id: aps.id, key: 'aps', value: { name: 'APS 填报', aliases: ['aps', '填报'] } })
  const other = projects.createStation({ name: 'another', location: { type: 'managed' } })
  expect(() => projects.update(aps.id, { name: 'another' })).toThrow('already called that')
  // Sources are the configured instances alone, and a repeated one counts once.
  expect(projects.update(aps.id, { sourceIds: ['folder:ops', 'folder:ops'] }).value.sourceIds).toEqual(['folder:ops'])
  expect(() => projects.update(aps.id, { sourceIds: ['folder:gone'] })).toThrow('Unknown Source: folder:gone')
  // Archiving keeps the Project and records when; restoring clears it.
  const archived = projects.update(aps.id, { archived: true })
  expect(archived.status).toBe('archived')
  expect(archived.value.archivedAt).toBeTruthy()
  expect(store.projects.list('active').map(project => project.id)).not.toContain(aps.id)
  const restored = projects.update(aps.id, { archived: false })
  expect(restored).toMatchObject({ id: aps.id, status: 'active' })
  expect(restored.value).not.toHaveProperty('archivedAt')
  // The workstation agent's requirements are trimmed and deduplicated, and an empty list clears them.
  const withRules = projects.update(aps.id, { agentRules: [' 先读 AGENTS.md ', '先读 AGENTS.md', '', ' 用中文回复 '] })
  expect(withRules.value.agentRules).toEqual(['先读 AGENTS.md', '用中文回复'])
  expect(projects.update(aps.id, { agentRules: [] }).value).not.toHaveProperty('agentRules')
  // The built-in workspace is fixed: it is never archived and never renamed, though its aliases may change.
  expect(() => projects.update(WORKSPACE_PROJECT_ID, { archived: true })).toThrow('built-in workspace is fixed')
  expect(() => projects.update(WORKSPACE_PROJECT_ID, { name: 'main' })).toThrow('built-in workspace is fixed')
  expect(projects.update(WORKSPACE_PROJECT_ID, { aliases: ['ws'] }).value.aliases).toEqual(['ws'])
  expect(() => projects.update('prj_gone', { name: 'x' })).toThrow('Unknown Project: prj_gone')
  expect(other.value.name).toBe('another')
})

/** Makes a directory and returns its path, for fixtures that name one. */
function mkdir(path: string): string { mkdirSync(path, { recursive: true }); return path }
