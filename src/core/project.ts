/** Projects (workstations) and the artifact index: the domain shapes of the schema 12 `project` and `artifact` rows. */
import { createHash } from 'node:crypto'

/** A person as one Source knows them; the same person on another Source is a different reference. */
export interface PersonRef { source: string; id: string; name?: string }
/** The kind of a Project: the built-in workspace, a station around a folder or repository, or one temporary task. */
export type ProjectKind = 'workspace' | 'station' | 'adhoc'
/**
 * Where a Project's deliverables come from: nothing the plugin manages (`managed`, the default), a folder a person named,
 * or a repository, local (`path`) or remote (`url` and `branch`).
 */
export type ProjectLocation =
  | { type: 'managed' }
  | { type: 'folder'; path: string }
  | { type: 'repo'; path?: string; url?: string; branch?: string }
export type ProjectStatus = 'active' | 'archived'
/**
 * A Project's stored attributes, the `project.value` JSON: what it is called, where its deliverables and working copies live,
 * which Sources feed it, and the names a Source may call it by. `specifiedBy` records the person who named an external address,
 * which only a person may do; `adhoc` Projects also record when they were archived and how long they are kept.
 */
export interface ProjectValue {
  name: string
  kind: ProjectKind
  location: ProjectLocation
  /** Where its deliverables are promoted, as an absolute path resolved when the Project was created. */
  outputDir: string
  /** Where its tickets' working copies, scripts and logs live, as an absolute path. */
  scratchDir: string
  /** The fixed rules (`AGENTS.md`, acceptance criteria) a worker is given, by default `<scratchDir>/rules`. */
  rulesDir: string
  sourceIds: string[]
  aliases: string[]
  specifiedBy?: PersonRef
  archivedAt?: string
  retentionUntil?: string
}
/** One `project` row: its stable id, its slug `key`, its attributes, its status, and when it was created and last changed. */
export interface ProjectRecord {
  id: string
  key: string
  value: ProjectValue
  status: ProjectStatus
  createdAt: string
  updatedAt: string
}
/**
 * An artifact row's `value` JSON: the content hash and size of a delivered file, when it was collected, the working root it was
 * promoted to, the folder Source's copy that went out with the result reply, and the message that carried that reply.
 */
export interface ArtifactValue {
  hash: string
  size: number
  /** Collection time. */
  at: string
  /** The Project directory the file was promoted to; empty for artifacts indexed before Projects recorded one. */
  targetRoot: string
  deliveredTo?: string
  messageId?: string
}
/** One `artifact` row: the index of a delivered file, by the Ticket it was delivered for, its Project and its Source. */
export interface ArtifactRecord {
  /** `artifactRecordId` of the Ticket and the file's name. */
  id: string
  ticket: string
  /** The Project it belongs to; absent on rows of tickets stored before Projects existed. */
  project?: string
  /** The Source instance the Ticket came from. */
  source: string
  /** Its path under the Ticket's `deliver/`, with forward slashes. */
  name: string
  value: ArtifactValue
  /** Collection time, kept as a column so artifacts are listed by time without reading their JSON. */
  at: string
}

/** The built-in workspace Project: it takes the tickets no station owns and is fixed first in the Project list. */
export const WORKSPACE_PROJECT_ID = 'prj_workspace'
/** The workspace Project's slug, which is also its directory's name under the area root. */
export const WORKSPACE_PROJECT_KEY = 'workspace'
/** Whether a Project is the built-in workspace. */
export const isWorkspaceProject = (project: Pick<ProjectRecord, 'id' | 'key'>): boolean =>
  project.id === WORKSPACE_PROJECT_ID || project.key === WORKSPACE_PROJECT_KEY

/** The id of a delivered file's artifact row: a hash of its Ticket and name, so re-delivering a name updates that row. */
export const artifactRecordId = (ticket: string, name: string): string =>
  createHash('sha1').update(`${ticket}:${name}`).digest('hex').slice(0, 16)
