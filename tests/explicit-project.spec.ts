/**
 * An explicit request that names a Project no registered one fits: accepting it through `orchestrator_route` refuses it with
 * the same `needsProject` question an assessment asks, the folder Source writes that question to `QUESTION.md`, and answering
 * it by rewriting `PROJECT.md` and dropping the task again starts the ticket in that station. A drop that names no Project
 * still starts a workspace ticket, and asking twice keeps one Decision and one question.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { WORKSPACE_PROJECT_ID, type Trigger } from '../src/core/index.ts'
import { folderKind, folderTrigger, readDrop } from '../src/sources/folder.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
let inbox: string, outbox: string
beforeEach(async () => {
  h = await startRuntime()
  inbox = join(h.directory, 'inbox'); outbox = join(h.directory, 'outbox')
  mkdirSync(inbox, { recursive: true }); mkdirSync(outbox, { recursive: true })
  h.runtime.sources.register(folderKind)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources,
    'folder:ops': { kind: 'folder', enabled: true, config: { inbox, outbox, operator: 'alice' } } },
  policy: { ...settings.policy, sources: { ...settings.policy.sources, 'folder:ops': { allowed: [{ id: 'alice' }] } } } })
})
afterEach(async () => { await h.stop() })

/** A station Project, as the panel creates one. */
const station = (name: string) => h.runtime.projects.create({ name, location: { type: 'managed' }, specifiedBy: { source: 'panel', id: 'panel' } })
/** Writes a task folder into the inbox and returns the Trigger the folder Source receives for it. */
async function drop(name: string, files: Record<string, string> = {}): Promise<Trigger> {
  const folder = join(inbox, name)
  mkdirSync(folder, { recursive: true })
  for (const [file, text] of Object.entries(files)) writeFileSync(join(folder, file), text)
  return folderTrigger((await readDrop(inbox, name, 'dir'))!, { id: 'folder:ops', inbox, outbox }, 'alice')
}
/** The accept through `orchestrator_route` an operator's explicit drop would be routed with. */
const accept = (trigger: Trigger) => h.route({ kind: 'accept', trigger_id: trigger.id, title: '修复导出', worktree_name: 'fix-export',
  acknowledgement: '收到了，马上修导出。' })
/** The ticket an accepted routing created. */
const ticketOf = (result: Record<string, unknown>) => h.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!

it('refuses a drop whose PROJECT.md names no registered Project, asks in QUESTION.md, and accepts the drop that names one', async () => {
  const aps = station('aps')
  const first = await drop('fix-export', { 'TASK.md': '修复导出。\n', 'PROJECT.md': '报销系统\n' })
  h.runtime.receive(first); await h.runtime.idle()
  const refused = await accept(first)
  // No ticket, the same Decision an assessment's refusal records, and an answer to the model that says what happened.
  expect(refused).toMatchObject({ decision: 'stop', project_question: true })
  expect(String(refused.reason)).toContain('No ticket was created')
  expect(String(refused.reason)).toContain('folder:ops')
  expect(h.runtime.store.tickets.list()).toEqual([])
  const thread = 'folder:ops:fix-export'
  const recorded = h.runtime.store.decisions.byThread(thread).at(-1)!
  expect(recorded).toMatchObject({ kind: 'stop' })
  expect(recorded.reason).toContainEqual(expect.objectContaining({ code: 'needsProject',
    values: expect.objectContaining({ candidates: [expect.objectContaining({ id: aps.id, name: 'aps' })] }) }))
  // The folder Source answers the question in its outbox: what is unowned, the candidates, and how to answer it.
  await h.runtime.sendReplies()
  const asked = readFileSync(join(outbox, 'QUESTION.md'), 'utf8')
  expect(asked).toContain('# 项目未归属')
  expect(asked).toContain('投件：fix-export')
  expect(asked).toContain('aps')
  expect(asked).toContain('PROJECT.md')
  expect(asked).toContain('answer-project')
  // The person names the station in PROJECT.md and drops the task again: a new Trigger on the same Thread resolves the
  // station, so its accept starts the ticket there.
  writeFileSync(join(inbox, 'fix-export', 'PROJECT.md'), 'aps\n')
  const second = await drop('fix-export')
  expect(second.id).not.toBe(first.id)
  expect(second.threads).toEqual(first.threads)
  h.runtime.receive(second); await h.runtime.idle()
  const accepted = await accept(second)
  await h.runtime.idle()
  expect(ticketOf(accepted)).toMatchObject({ projectId: aps.id, sourceId: 'folder:ops' })
})

it('keeps one Decision and one question when the refused request is accepted again', async () => {
  station('aps')
  const trigger = await drop('fix-export', { 'TASK.md': '修复导出。\n', 'PROJECT.md': '报销系统\n' })
  h.runtime.receive(trigger); await h.runtime.idle()
  expect(await accept(trigger)).toMatchObject({ decision: 'stop', project_question: true })
  expect(await accept(trigger)).toMatchObject({ decision: 'stop', project_question: true })
  const stops = h.runtime.store.decisions.byThread('folder:ops:fix-export').filter(decision => decision.kind === 'stop')
  expect(stops).toHaveLength(1)
  expect(h.runtime.store.tickets.list()).toEqual([])
})

it('accepts a drop that names no Project into the built-in workspace, without asking', async () => {
  station('aps')
  const plain = await drop('notes', { 'TASK.md': '整理会议记录。\n' })
  h.runtime.receive(plain); await h.runtime.idle()
  const routed = await accept(plain)
  await h.runtime.idle()
  expect(ticketOf(routed).projectId).toBe('prj_workspace')
  await h.runtime.sendReplies()
  expect(existsSync(join(outbox, 'QUESTION.md'))).toBe(false)
})

it('answers an unregistered drop with the built-in workspace when the work needs no station', async () => {
  station('aps')
  const trigger = await drop('sort-files', { 'TASK.md': '整理这一批文件。\n', 'PROJECT.md': '报销系统\n' })
  h.runtime.receive(trigger); await h.runtime.idle()
  expect(await accept(trigger)).toMatchObject({ decision: 'stop', project_question: true })
  // The question offers the workspace as the answer for temporary work that needs no station.
  await h.runtime.sendReplies()
  expect(readFileSync(join(outbox, 'QUESTION.md'), 'utf8')).toContain('不需要工作站')
  // A person answers in the panel; the drop's fresh Eval resolves the workspace and its accept starts the ticket there.
  expect((await h.api('POST', `triggers/${trigger.id}/answer-project`, { workspace: true })).body).toEqual({ resolved: WORKSPACE_PROJECT_ID })
  await h.runtime.idle()
  const routed = await accept(trigger)
  await h.runtime.idle()
  expect(ticketOf(routed)).toMatchObject({ projectId: WORKSPACE_PROJECT_ID, sourceId: 'folder:ops' })
  expect(h.runtime.store.projects.list().filter(project => project.value.kind === 'station')).toHaveLength(1)
})
