// @vitest-environment jsdom
// The 产物 page: the artifact index with its filters and empty state, one artifact's reverse chain, and its entries elsewhere.
import { act } from 'react'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, click, type, text, field, at } from './fixtures/panel.tsx'
import { server, artifactDetail, artifactRow } from './fixtures/panel-server.ts'

usePanel()

/** The downloads the page handed to the browser, captured in place of the anchor navigation jsdom cannot follow. */
const downloads: { name: string; href: string }[] = []
const createObjectURL = vi.fn(() => 'blob:artifact')
const writeText = vi.fn(async () => {})
beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, href: this.href })
  })
})
beforeEach(() => { downloads.length = 0; createObjectURL.mockClear(); writeText.mockClear() })
afterAll(() => { vi.restoreAllMocks() })

const rowNames = () => all('.dt-artifact-row .dt-row-title button').map(button => button.textContent)
const sectionNames = () => all('.dt-section-name').map(item => item.textContent)

it('lists artifacts with their Project, Source, Ticket, size and time, and downloads one', async () => {
  server.artifacts = [artifactRow(), artifactRow({ id: 'a2', name: 'nested/data.csv', ticket: 't-old', ticketTitle: '旧工单',
    project: 'prj_workspace', projectName: 'workspace', source: 'github', sourceLabel: { zh: 'GitHub', en: 'GitHub' },
    size: 2048, hash: 'ff00000000000000', at: '2026-09-22T00:00:00Z' })]
  server.artifactFiles = { a1: { name: 'report.md', body: 'done' } }
  await mount()
  await click(zh['tab.artifacts'])
  expect(document.querySelector('#dt-tab-artifacts')?.getAttribute('aria-selected')).toBe('true')
  expect(rowNames()).toEqual(['report.md', 'nested/data.csv'])
  expect(text()).toContain(zh.artifactCount.replace('{count}', '2'))
  const first = all('.dt-artifact-row')[0]!
  expect(first.textContent).toContain('aps')
  expect(first.textContent).toContain('飞书')
  expect(first.textContent).toContain('修复回归')
  expect(first.textContent).toContain('120 B')
  expect(all('.dt-artifact-row')[1]!.textContent).toContain('2.0 KB')
  expect(all('.dt-artifact-row')[1]!.textContent).toContain('workspace')
  // The row's download fetches its file with the panel header and saves it under its own name.
  await click(find(zh.artifactDownload, '.dt-artifact-row button'))
  expect(server.downloads).toEqual(['a1'])
  await vi.waitFor(() => expect(downloads).toEqual([{ name: 'report.md', href: 'blob:artifact' }]))
})

it('filters the index by Project, Source and a name or hash, and keeps the filters in the route', async () => {
  server.artifacts = [artifactRow(), artifactRow({ id: 'a2', name: 'old.csv', ticket: 't-old', ticketTitle: '旧工单',
    project: 'prj_workspace', projectName: 'workspace', source: 'github', sourceLabel: { zh: 'GitHub', en: 'GitHub' },
    hash: 'ff00000000000000', at: '2026-09-22T00:00:00Z' })]
  await mount()
  await click(zh['tab.artifacts'])
  // The Project dropdown lists the built-in workspace first and then the active station.
  const projects = field<HTMLSelectElement>(zh.artifactFilterProject)
  expect([...projects.options].map(option => option.textContent)).toEqual([zh.artifactAllProjects, 'workspace', 'aps'])
  await type(projects, 'prj_workspace')
  expect(server.requests.filter(request => request.path === 'artifacts?project=prj_workspace&limit=20')).toHaveLength(1)
  expect(rowNames()).toEqual(['old.csv'])
  // A Source filter narrows further, down to no row and the filters' own empty state.
  const sources = field<HTMLSelectElement>(zh.artifactFilterSource)
  expect([...sources.options].map(option => option.textContent)).toEqual([zh.artifactAllSources, '飞书', 'GitHub'])
  await type(sources, 'feishu')
  expect(server.requests.some(request => request.path === 'artifacts?project=prj_workspace&source=feishu&limit=20')).toBe(true)
  expect(rowNames()).toEqual([])
  expect(text()).toContain(zh.artifactFilterNone)
  await click(find(zh.artifactClearFilters, 'button'))
  expect(rowNames()).toEqual(['report.md', 'old.csv'])
  // The search matches a hash, and the route remembers it across a remount with the page and both language of its filters.
  await type(field<HTMLInputElement>(zh.artifactSearchLabel), 'ff')
  await act(async () => { field<HTMLInputElement>(zh.artifactSearchLabel).closest('form')!.requestSubmit() })
  await settle()
  expect(server.requests.some(request => request.path === 'artifacts?q=ff&limit=20')).toBe(true)
  expect(rowNames()).toEqual(['old.csv'])
  await remount()
  expect(document.querySelector('#dt-tab-artifacts')?.getAttribute('aria-selected')).toBe('true')
  expect(field<HTMLInputElement>(zh.artifactSearchLabel).value).toBe('ff')
  expect(rowNames()).toEqual(['old.csv'])
})

it('says how artifacts appear when there are none, and how to clear filters that match none', async () => {
  await mount()
  await click(zh['tab.artifacts'])
  expect(rowNames()).toEqual([])
  expect(text()).toContain(zh.artifactEmpty)
  await type(field<HTMLSelectElement>(zh.artifactFilterProject), 'prj_workspace')
  expect(text()).toContain(zh.artifactFilterNone)
  await click(find(zh.artifactClearFilters, 'button'))
  expect(text()).toContain(zh.artifactEmpty)
})

it('opens one artifact with its metadata, delivery and reverse chain, and opens the worker Session', async () => {
  server.artifacts = [artifactRow()]
  server.artifactDetails = { a1: artifactDetail() }
  server.artifactFiles = { a1: { name: 'report.md', body: 'done' } }
  await mount()
  await click(zh['tab.artifacts'])
  await click(find('report.md', '.dt-artifact-row button'))
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('report.md')
  expect(server.requests.some(request => request.path === 'artifacts/a1')).toBe(true)
  expect(sectionNames()).toEqual([zh.artifactFileTitle, zh.artifactDeliveryTitle, zh.artifactChain])
  // Metadata, where it landed, the reply that carried it, and the chain back to the work.
  expect(text()).toContain('abcdef0123456789')
  expect(text()).toContain('/srv/aps/report.md')
  expect(text()).toContain(zh.artifactReadableYes)
  expect(text()).toContain('reply-a1')
  expect(text()).toContain('修复回归')
  expect(text()).toContain('worker-t1')
  expect(text()).toContain('working')
  // The Worker Session step opens the Session the Ticket's Assignments ran in.
  await click(find(zh.openSession, '.dt-section button'))
  expect(server.opened).toEqual(['worker-t1'])
  // Copying the path, the Ticket and the Project are offered on the page.
  expect(find(zh.openTicket, '.dt-page-title button')).toBeTruthy()
  expect(find(zh.artifactOpenProject, '.dt-page-title button')).toBeTruthy()
  await click(find(zh.artifactCopyPath, '.dt-page-title button'))
  expect(writeText).toHaveBeenCalledWith('/srv/aps/report.md')
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.copied)
  // Its download fetches the same file as the list.
  await click(find(zh.artifactDownload, '.dt-page-title button'))
  expect(server.downloads).toEqual(['a1'])
  await vi.waitFor(() => expect(downloads).toEqual([{ name: 'report.md', href: 'blob:artifact' }]))
})

it('opens the Ticket and the Project an artifact belongs to', async () => {
  server.artifacts = [artifactRow()]
  server.artifactDetails = { a1: artifactDetail() }
  await mount()
  await click(zh['tab.artifacts'])
  await click(find('report.md', '.dt-artifact-row button'))
  await click(find(zh.openTicket, '.dt-page-title button'))
  expect(server.requests.some(request => request.path === 'tickets/t1')).toBe(true)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('修复回归')
  await click(find(zh['term.artifact'], '.dt-page-head button'))
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('report.md')
  await click(find(zh.artifactOpenProject, '.dt-page-title button'))
  expect(server.requests.some(request => request.path === 'projects/prj_aps')).toBe(true)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('aps')
})

it('lists a Ticket\'s artifacts on its page and opens one', async () => {
  server.artifacts = [artifactRow()]
  server.artifactDetails = { a1: artifactDetail() }
  at({ page: 'execution', id: 't1' })
  await mount()
  expect(sectionNames()).toContain(zh.artifactTicketTitle)
  expect(text()).toContain('report.md')
  await click(find('report.md', '.dt-section button'))
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('report.md')
})

it('opens the artifact index filtered by a workstation from its artifact count', async () => {
  server.artifacts = [artifactRow()]
  await mount()
  await click(zh['tab.workstations'])
  await click(all('.dt-project-card').find(card => card.querySelector('.dt-project-title')?.textContent === 'aps')!
    .querySelector('.dt-project-title')!)
  const count = all('.dt-lv').find(item => item.querySelector('.dt-lv-label')?.textContent === zh.projectArtifacts)!
  await click(count.querySelector('button')!)
  expect(document.querySelector('#dt-tab-artifacts')?.getAttribute('aria-selected')).toBe('true')
  expect(server.requests.some(request => request.path === 'artifacts?project=prj_aps&limit=20')).toBe(true)
  expect(rowNames()).toEqual(['report.md'])
})

it('shows the recent artifacts on the overview and opens one', async () => {
  server.artifacts = [artifactRow(), artifactRow({ id: 'a2', name: 'old.csv', project: 'prj_workspace', projectName: 'workspace',
    at: '2026-09-22T00:00:00Z' })]
  server.artifactDetails = { a1: artifactDetail() }
  await mount()
  const section = all('.dt-section').find(item => item.querySelector('.dt-section-name')?.textContent === zh.recentArtifacts)!
  expect(section.querySelector('.dt-count')?.textContent).toBe('2')
  expect([...section.querySelectorAll('.dt-row-title button')].map(button => button.textContent)).toEqual(['report.md', 'old.csv'])
  await click(section.querySelector('.dt-row-title button')!)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe('report.md')
})
