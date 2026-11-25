/**
 * Artifact delivery: a worker's final deliverables are the files under its ticket directory's `deliver/`. On a `ready` report
 * the executor collects them, promotes them into its Project's output directory (the built-in workspace's for P1a), indexes
 * each one in the artifact table, keeps the folder Source's outbox copy that carries the result reply, and posts that reply
 * naming them. Collection is idempotent: the same content hashes to the same record, a file already present with the same
 * content is left alone, and a name already taken by other content is promoted with the ticket's short id in its name.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative } from 'node:path'
import { artifactRecordId, WORKSPACE_PROJECT_ID, type ArtifactRecord, type ReplyRequest, type Ticket, type Trigger } from '../core/index.ts'
import { KV, type Key } from '../kv.ts'

/** One deliverable file: its path relative to `deliver/` with forward slashes, content hash, size, and collection time. */
export interface Artifact { name: string; hash: string; size: number; at: string }

const sha = (content: Buffer): string => createHash('sha256').update(content).digest('hex').slice(0, 16)
/** How many characters of a ticket id a promoted file's conflict suffix uses. */
const SUFFIX_CHARS = 8

/** Reads every file under `<directory>/deliver/`, recursively; an absent directory yields nothing. */
export async function collectDeliverables(directory: string): Promise<Artifact[]> {
  const root = join(directory, 'deliver')
  const walk = async (dir: string): Promise<Artifact[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const nested = await Promise.all(entries.map(async entry => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return walk(path)
      if (!entry.isFile()) return []
      const content = await readFile(path)
      const info = await stat(path)
      return [{ name: relative(root, path).replaceAll('\\', '/'), hash: sha(content), size: content.length, at: info.mtime.toISOString() }]
    }))
    return nested.flat()
  }
  return (await walk(root)).sort((a, b) => a.name.localeCompare(b.name))
}

/** Copies deliverables to `target`, skipping a file already present with the same hash; returns the copied names. */
export async function copyArtifacts(directory: string, artifacts: readonly Artifact[], target: string): Promise<string[]> {
  const copied: string[] = []
  for (const artifact of artifacts) {
    const file = join(target, artifact.name)
    const existing = await readFile(file).catch(() => undefined)
    if (existing && sha(existing) === artifact.hash) continue
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, await readFile(join(directory, 'deliver', artifact.name)))
    copied.push(artifact.name)
  }
  return copied
}

/** The name a deliverable takes where its own name already holds other content: `<stem>.<suffix><extension>`. */
export function conflictName(name: string, suffix: string): string {
  const extension = extname(name)
  return extension ? `${name.slice(0, -extension.length)}.${suffix}${extension}` : `${name}.${suffix}`
}

/**
 * Promotes a ticket's deliverables into its Project's output directory, which is where people find them: a file already
 * there with the same content is left alone, and one whose name already holds other content is written as `conflictName`.
 * Returns the names it wrote, relative to `target`, so a caller can say where each file landed.
 */
export async function promoteArtifacts(directory: string, artifacts: readonly Artifact[], target: string, suffix: string): Promise<string[]> {
  const written: string[] = []
  for (const artifact of artifacts) {
    const taken = await readFile(join(target, artifact.name)).catch(() => undefined)
    if (taken && sha(taken) === artifact.hash) continue
    const name = taken ? conflictName(artifact.name, suffix) : artifact.name
    const file = join(target, name)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, await readFile(join(directory, 'deliver', artifact.name)))
    written.push(name)
  }
  return written
}

/** The result reply that names the deliverables and where they were delivered. */
export function artifactNotice(artifacts: readonly Artifact[], target?: string): string {
  const lines = artifacts.map(artifact => `- ${artifact.name} (${artifact.size} bytes, sha256:${artifact.hash})`)
  return [`Artifacts delivered:`, ...lines, ...(target ? [`Delivered to: ${target}`] : [])].join('\n')
}

/** Host dependencies of one artifact delivery: the ticket's records, the artifact index, the reply, and the Project's output root. */
export interface ArtifactHost {
  readonly store: {
    tickets: { get(id: string): Ticket | undefined }
    triggers: { get(id: string): Trigger | undefined }
    artifacts: { add(artifact: ArtifactRecord): void }
    set<V>(key: Key<V>, value: V): void
  }
  readonly engine: { reply(request: ReplyRequest): unknown }
  /** The Project directory the deliverables are promoted into, such as `<stateDir>/area/workspace`. */
  readonly targetRoot: string
}

/**
 * Collects a ticket's deliverables once its worker reported ready: records them under `KV.artifacts` for the stages that still
 * read it, promotes them into `host.targetRoot`, keeps the folder Source's outbox copy when the origin Trigger names one,
 * indexes each file as an artifact row, and posts the result reply naming them. Returns the number of artifacts; zero when
 * there is nothing.
 */
export async function deliverArtifacts(host: ArtifactHost, ticketId: string): Promise<number> {
  const ticket = host.store.tickets.get(ticketId)
  const directory = ticket?.execution?.directory
  if (!ticket || !directory) return 0
  const artifacts = await collectDeliverables(directory)
  if (!artifacts.length) return 0
  host.store.set(KV.artifacts(ticketId), artifacts)
  const trigger = host.store.triggers.get(ticket.origin.triggerId)
  const outbox = typeof trigger?.meta.outbox === 'string' && trigger.meta.outbox ? join(trigger.meta.outbox, ticketId, 'artifacts') : undefined
  await promoteArtifacts(directory, artifacts, host.targetRoot, ticketId.slice(0, SUFFIX_CHARS))
  if (outbox) await copyArtifacts(directory, artifacts, outbox)
  const project = ticket.projectId ?? WORKSPACE_PROJECT_ID
  const source = ticket.sourceId ?? trigger?.source ?? ''
  for (const artifact of artifacts) {
    host.store.artifacts.add({ id: artifactRecordId(ticketId, artifact.name), ticket: ticketId, project, source, name: artifact.name,
      value: { hash: artifact.hash, size: artifact.size, at: artifact.at, targetRoot: host.targetRoot, ...outbox ? { deliveredTo: outbox } : {} },
      at: artifact.at })
  }
  host.engine.reply({ purpose: 'result', ticketId, text: artifactNotice(artifacts, host.targetRoot) })
  return artifacts.length
}
