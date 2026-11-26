/** Browser plugin entry point registering the sidebar icon, main management panel, and Plugin Manager config view. */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { archiveProjectSession, openKnownSession, openProjectConversation as openConversation, projectSessionId,
  SessionNavigationError, type ProjectConversation, type WorkspaceController } from '../navigation.ts'
import { caller } from './api.ts'
import { App } from './app.tsx'
import { PluginConfig, usePageForm } from './deployment.tsx'
import { en, zh } from './locales.ts'
import { panelMessages } from './provider.tsx'
import type { T } from './text.ts'

type ClientContext = Context & { sessions: ISessions }
const NS = 'dshSuperagent'
const PANEL_ID = 'dsh-superagent' as MainPanelId
const ENTRY = 'dsh-superagent'

function HammerIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3.5h9l3.5 1.75v2.5L15 9.5H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" /><path d="M10 9.5v10.25a1.75 1.75 0 0 0 3.5 0V9.5" /><path d="M10 15.5h3.5" />
  </svg>
}

/** The panel's wording for a Session that cannot be opened yet, or the original failure as it happened. */
const navigationFailure = (t: T, error: unknown): unknown => error instanceof SessionNavigationError
  ? new Error(t(error.code === 'not-ready' ? 'sessionListNotReady' : 'sessionNotListed')) : error
/** Mounted panel wrapper; cancels any pending Session navigation when a new one starts or the panel unmounts. */
function Mounted({ ctx, t }: { ctx: ClientContext; t: T }) {
  const pending = useRef<AbortController>(undefined)
  // Calls the management API with the wording of the interface language, which a locale switch may change between calls.
  const copy = useRef(t)
  copy.current = t
  const call = useMemo(() => caller(() => panelMessages(copy.current)), [])
  useEffect(() => () => { pending.current?.abort() }, [])
  const openSession = useCallback(async (id: string) => {
    pending.current?.abort()
    const request = new AbortController(); pending.current = request
    try {
      await openKnownSession(ctx.sessions, id as SessionId, target => { ctx.uiWorkspace.openSession(target) }, request.signal)
    } catch (error) { throw navigationFailure(t, error) }
  }, [ctx, t])
  // A Project's conversation opens in its own directory without asking for a workspace: its Workspace is created for it first.
  const openProjectConversation = useCallback(async (project: ProjectConversation) => {
    pending.current?.abort()
    const request = new AbortController(); pending.current = request
    try {
      await openConversation({
        sessions: ctx.sessions,
        workspaces: ctx.get('workspaces') as Pick<WorkspaceController, 'create'> | undefined,
        open: target => { ctx.uiWorkspace.openSession(target) },
      }, project, request.signal)
    } catch (error) { throw navigationFailure(t, error) }
  }, [ctx, t])
  // Deleting a Project archives the conversation it leaves behind; the archive is best effort and never fails the deletion.
  const deleteProject = useCallback(async (project: ProjectConversation) => {
    await call('DELETE projects/:id', { id: project.id })
    await archiveProjectSession(ctx.uiWorkspace, projectSessionId(project.id, project.conversationGeneration ?? 0))
  }, [call, ctx])
  // Starting a conversation over leaves the old Session archived; the next open names a new one by generation.
  const resetProjectConversation = useCallback(async (project: ProjectConversation) => {
    await call('POST projects/:id/conversation/reset', { id: project.id })
    await archiveProjectSession(ctx.uiWorkspace, projectSessionId(project.id, project.conversationGeneration ?? 0))
  }, [call, ctx])
  const form = usePageForm(ctx.get('configForms')?.get<Record<string, unknown>>(ENTRY))
  return <App t={t} openSession={openSession} openProjectConversation={openProjectConversation} deleteProject={deleteProject}
    resetProjectConversation={resetProjectConversation} deploymentForm={form} />
}

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']
/** Registers the panel, sidebar icon, and Plugin Manager config view; `configForms` is optional (without it, machine settings are read-only). */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <Mounted ctx={ctx} t={props.t} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel'), locale: NS }, HammerIcon))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${ENTRY}#${ENTRY}`, locale: NS },
    (props: PluginConfigViewProps & { t: T }) => <PluginConfig t={props.t} view={props.view} form={props.form} />))
}
