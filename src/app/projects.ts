/** The built-in workspace Project and the area layout P1a gives its tickets and deliverables: `<stateDir>/area/workspace`. */
import { join } from 'node:path'
import { WORKSPACE_PROJECT_ID, WORKSPACE_PROJECT_KEY, type ProjectRecord, type ProjectValue } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import { executionRoot } from './execution-environment.ts'

/** The directory model of one workspace Project: its deliverables, its working copies, and its fixed rules. */
export interface ProjectDirectories { outputDir: string; scratchDir: string; rulesDir: string }

/**
 * The area root holding every Project's directories: the configured execution root, which defaults to `<stateDir>/area`.
 * Deliverables are promoted into it, and each ticket works in a directory under it.
 */
export const areaRoot = (settings: Settings, stateDir: string): string => executionRoot(settings, stateDir)

/**
 * The workspace Project's directories under the area root: deliverables in `<area>/workspace/`, working copies in
 * `<area>/workspace/.work/`, and the fixed rules in `<area>/workspace/.work/rules/`.
 */
export function workspaceDirectories(settings: Settings, stateDir: string): ProjectDirectories {
  const outputDir = join(areaRoot(settings, stateDir), WORKSPACE_PROJECT_KEY)
  const scratchDir = join(outputDir, '.work')
  return { outputDir, scratchDir, rulesDir: join(scratchDir, 'rules') }
}

/** The directory a workspace ticket works in: `<area>/workspace/.work/<name>`, its name derived from the ticket. */
export const workspaceTicketDirectory = (settings: Settings, stateDir: string, name: string): string =>
  join(workspaceDirectories(settings, stateDir).scratchDir, name)

/** The workspace Project's attributes for the directories under `stateDir`; it manages its own area and has no external address. */
function workspaceValue(stateDir: string): ProjectValue {
  const outputDir = join(stateDir, 'area', WORKSPACE_PROJECT_KEY)
  const scratchDir = join(outputDir, '.work')
  return { name: WORKSPACE_PROJECT_KEY, kind: 'workspace', location: { type: 'managed' }, outputDir, scratchDir,
    rulesDir: join(scratchDir, 'rules'), sourceIds: [], aliases: [] }
}

/**
 * The built-in workspace Project's row for the state directory, created when the schema 12 migration runs; it takes the tickets
 * no station owns. Its directories record the default area layout under `stateDir`; the executor directory override moves a
 * ticket's working directory, and pointing the Project itself at it is left to the stage that owns Projects.
 */
export function workspaceProject(stateDir: string, at: string): ProjectRecord {
  return { id: WORKSPACE_PROJECT_ID, key: WORKSPACE_PROJECT_KEY, value: workspaceValue(stateDir), status: 'active', createdAt: at,
    updatedAt: at }
}
