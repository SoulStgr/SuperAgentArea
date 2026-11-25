/**
 * Projects (workstations) and their directories: the built-in workspace, the area layout P1a gives its tickets, the key and
 * area layout of a new station, and the checks a person's address has to pass before one is created.
 */
import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { UserError, WORKSPACE_PROJECT_ID, WORKSPACE_PROJECT_KEY, type ProjectKind, type ProjectLocation, type ProjectRecord,
  type ProjectValue } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import { executionRoot } from './execution-environment.ts'

/** The directory model of one Project: its deliverables, its working copies, and its fixed rules. */
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

/** The slug a Project's name gives its key: lowercase letters, digits and Han characters, other runs as one dash. */
export function projectKey(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return slug || 'station'
}

/** The key a Project takes: `name`'s slug, with `-2`, `-3` and so on while an existing Project holds it. */
export function uniqueProjectKey(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base = projectKey(name)
  let key = base
  for (let suffix = 2; used.has(key); suffix += 1) key = `${base}-${suffix}`
  return key
}

/** The directories a Project of one kind and address gets: deliverables, working copies, and the fixed rules directory. */
export function projectDirectories(location: ProjectLocation, kind: ProjectKind, key: string, settings: Settings,
  stateDir: string): ProjectDirectories {
  const area = areaRoot(settings, stateDir)
  const scratchDir = kind === 'adhoc' && location.type === 'folder'
    ? join(area, WORKSPACE_PROJECT_KEY, '.work')
    : join(area, `${key}.work`)
  const outputDir = location.type === 'managed' ? join(area, key)
    : location.type === 'folder' ? resolve(location.path)
    : location.path ? join(resolve(location.path), 'artifacts')
    // A remote repository has no local directory yet: its deliverables go to the Project's area directory.
    : join(area, key)
  return { outputDir, scratchDir, rulesDir: join(scratchDir, 'rules') }
}

/** A normalized form of a local path for comparisons: forward slashes, lower case, and a trailing separator. */
export const normalizedPath = (path: string): string => {
  const resolved = resolve(path).replaceAll('\\', '/').toLowerCase()
  return resolved.endsWith('/') ? resolved : `${resolved}/`
}
/** Whether `path` lies under `root`, after normalization; a trailing separator keeps `/etc` from matching `/etcetera`. */
export const underPath = (path: string, root: string): boolean => normalizedPath(path).startsWith(normalizedPath(root))
/** Whether a path is a filesystem root, whose exact form is reserved but whose contents are a person's to use. */
const filesystemRoot = (path: string): boolean => resolve(path) === resolve(path, '..')
/** The roots a person cannot name as a Project's address: the filesystem roots and the operating system's own directories. */
export function reservedRoots(): string[] {
  if (process.platform === 'win32') {
    const windows = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
    const roots = [windows, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
    return [...new Set(roots.filter((root): root is string => !!root))]
  }
  return ['/', '/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys', '/root', '/lib', '/lib64', '/var']
}
/** Whether a local address is one of the reserved system directories, or a filesystem root itself. */
export function reservedPath(path: string): boolean {
  const target = normalizedPath(path)
  return reservedRoots().some(root => target === normalizedPath(root) || (!filesystemRoot(root) && underPath(path, root)))
}
/** Why a local address cannot hold a Project, or undefined when it can: absolute, outside system directories, and writable. */
export function pathProblem(path: string, label = 'path'): string | undefined {
  const trimmed = path.trim()
  if (!trimmed) return `the ${label} is empty`
  if (!isAbsolute(trimmed)) return `the ${label} must be an absolute path: ${trimmed}`
  if (reservedPath(trimmed)) return `the ${label} is a system directory: ${trimmed}`
  const target = resolve(trimmed)
  // An address that does not exist yet may be created, so its nearest existing parent must be writable.
  let existing = target
  while (!existsSync(existing)) {
    const parent = resolve(existing, '..')
    if (parent === existing) break
    existing = parent
  }
  try {
    if (!statSync(existing).isDirectory()) return `the ${label} is not a directory: ${trimmed}`
    accessSync(existing, constants.W_OK)
  } catch (error) {
    return `the ${label} is not writable (${existing}): ${error instanceof Error ? error.message : String(error)}`
  }
  return undefined
}
/** Why a repository address is not one this plugin clones from, or undefined when it is: an https, ssh or file address. */
export function repositoryUrlProblem(url: string): string | undefined {
  const trimmed = url.trim()
  if (!trimmed) return 'the repository address is empty'
  if (/^https:\/\/[^\s]+$/i.test(trimmed) || /^ssh:\/\/[^\s]+$/i.test(trimmed) || /^file:\/\/[^\s]+$/i.test(trimmed)
    || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(trimmed)) return undefined
  return `the repository address must use https, ssh or file: ${trimmed}`
}

/** What an address needs to check, by its form: local paths for a folder or a local repository, an address for a remote one. */
export function locationProblem(location: ProjectLocation): string | undefined {
  if (location.type === 'managed') return undefined
  if (location.type === 'folder') return pathProblem(location.path, 'folder')
  if (location.path) return pathProblem(location.path, 'repository folder')
  return location.url ? repositoryUrlProblem(location.url) : 'a repository needs a local path or an address'
}
/**
 * Validates a person's Project address and prepares its directories: an absolute, writable local address outside system
 * directories, or a repository address of a supported protocol. Directories are created as the Project needs them.
 * @throws UserError `projectLocationInvalid` with the reason, for an address that cannot hold a Project.
 */
export function prepareProjectDirectories(location: ProjectLocation, kind: ProjectKind, key: string, settings: Settings,
  stateDir: string): ProjectDirectories {
  const problem = locationProblem(location)
  if (problem) throw new UserError('projectLocationInvalid', { reason: problem })
  const directories = projectDirectories(location, kind, key, settings, stateDir)
  for (const path of [directories.outputDir, directories.scratchDir, directories.rulesDir]) mkdirSync(path, { recursive: true, mode: 0o700 })
  return directories
}

/** A Project's name as a person wrote it, shortened to what a Project row holds; the key carries the slug. */
export const projectName = (name: string): string => name.trim().slice(0, 100)
