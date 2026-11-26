/** DOM rendering and interaction helpers for panel tests. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { caller } from '../../src/client/api.ts'
import { App } from '../../src/client/app.tsx'
import { usePageForm } from '../../src/client/deployment.tsx'
import { zh } from '../../src/client/locales.ts'
import { panelMessages } from '../../src/client/provider.tsx'
import type { T } from '../../src/client/text.ts'
import { archiveProjectSession, openProjectConversation, projectSessionId, type ProjectConversation,
  type SessionArchiver, type WorkspaceController } from '../../src/navigation.ts'
import { server, usePanelServer } from './panel-server.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

export const translator = (dictionary: Record<string, string>): T => ((key: string, params?: Record<string, unknown>) => {
  const template = dictionary[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as T
/** The fake Client sessions service: creating adds the Session to the host and its catalog, and an id the host holds is refused. */
function projectSessions(): Pick<ISessions, 'create' | 'list' | 'refresh'> {
  return {
    list: { getSnapshot: () => ({ phase: 'ready' as const, byId: Object.fromEntries([...server.sessions].map(id => [id, {}])) }) },
    refresh: async () => { server.sessions = new Set(server.hostSessions) },
    create: async (options: { sessionId?: string; cwd?: string; workspaceId?: string } = {}) => {
      const sessionId = options.sessionId!
      if (server.sessionCreateError) throw new Error(server.sessionCreateError)
      server.created.push({ sessionId, ...options.cwd === undefined ? {} : { cwd: options.cwd },
        ...options.workspaceId === undefined ? {} : { workspaceId: String(options.workspaceId) } })
      if (server.hostSessions.has(sessionId)) throw new Error(`session create failed: session/conflict: ${sessionId}`)
      server.hostSessions.add(sessionId)
      server.sessions.add(sessionId)
      return sessionId
    },
  } as unknown as Pick<ISessions, 'create' | 'list' | 'refresh'>
}
/** The fake Client Workspace Controller: creating records a new directory and answers its Workspace id, reusing one already owned. */
function projectWorkspaces(): Pick<WorkspaceController, 'create'> {
  return {
    create: async (input: { path: string }) => {
      await server.conversationWait?.()
      if (server.workspaceError) throw new Error(server.workspaceError)
      if (!server.workspaces.includes(input.path)) server.workspaces.push(input.path)
      return { workspaceId: `ws:${input.path}` }
    },
  }
}
/** The fake DSH workspace UI as the panel reaches it: a Session opens, and one is archived best effort. */
function projectUi(): Pick<SessionArchiver, 'archiveSession'> {
  return {
    archiveSession: async (id, options) => { server.archivedSessions.push({ id: String(id), ...options }) },
  }
}
function Panel({ t }: { t: T }) {
  const sessions = projectSessions()
  const call = caller(() => panelMessages(t))
  /** Deletes a Project, then archives the conversation Session it leaves behind, as the plugin entry does. */
  const deleteProject = async (project: ProjectConversation) => {
    await call('DELETE projects/:id', { id: project.id })
    await archiveProjectSession(projectUi(), projectSessionId(project.id, project.conversationGeneration ?? 0))
  }
  /** Starts a Project's conversation over, then archives its old Session, as the plugin entry does. */
  const resetProjectConversation = async (project: ProjectConversation) => {
    await call('POST projects/:id/conversation/reset', { id: project.id })
    await archiveProjectSession(projectUi(), projectSessionId(project.id, project.conversationGeneration ?? 0))
  }
  return <App t={t} openSession={async id => { server.opened.push(id) }}
    openProjectConversation={async (project: ProjectConversation) => {
      await openProjectConversation({ sessions, workspaces: projectWorkspaces(), open: target => { server.opened.push(target) } },
        project, new AbortController().signal)
    }} deleteProject={deleteProject} resetProjectConversation={resetProjectConversation} deploymentForm={usePageForm(server.form)} />
}
let root: Root | undefined
let container: HTMLElement | undefined
function unmount() {
  act(() => { root?.unmount() })
  root = undefined
  container?.remove()
}
export const usePanel = () => usePanelServer(unmount)

/** Flush pending fake-server responses and React state updates. */
export async function settle() {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(server.pending).toBe(0)
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
export async function mount(dictionary: Record<string, string> = zh) {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(<Panel t={translator(dictionary)} />) })
  await settle()
}
export async function remount(dictionary: Record<string, string> = zh) { unmount(); await mount(dictionary) }

export const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const CONTROLS = 'button, [role="button"], [role="tab"], [role="switch"], a'
export function find(name: string, selector = CONTROLS): HTMLElement {
  const match = all(selector).find(element => element.textContent?.trim() === name || element.getAttribute('aria-label') === name)
  if (!match) throw new Error(`No ${selector} named ${name}`)
  return match
}
export const tab = (name: string) => find(name, '[role="tab"]')
export async function click(target: string | HTMLElement) {
  const element = typeof target === 'string' ? find(target) : target
  await act(async () => { element.click() })
  await settle()
}
export async function type(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
  await settle()
}
/** The page's text without its stylesheet. */
export const text = () => [...document.body.querySelectorAll('style')].reduce((all, style) => all.replace(style.textContent ?? '', ''),
  document.body.textContent ?? '')
export function field<E extends HTMLElement>(label: string): E {
  const labelled = (element: HTMLElement) => !!element.id && all('label').some(item => (item as HTMLLabelElement).htmlFor === element.id
    && item.textContent === label)
  const match = all('input, textarea, select').find(element => element.getAttribute('aria-label') === label || labelled(element))
  if (!match) throw new Error(`No field ${label}`)
  return match as unknown as E
}
export const at = (route: object) => sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route, stack: [] }))
