/**
 * Artifact delivery (fusion phase 1): a worker's final deliverables are the files under its ticket directory's `deliver/`.
 * On a `ready` report the executor collects them, records them on the ticket, copies them to the origin Source's outbox
 * (the folder Source's `<outbox>/<ticket>/artifacts/`), and posts one result reply listing them. Collection is idempotent:
 * the same content hashes to the same record, and a copy already present with the same hash is left alone.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { ReplyRequest, Ticket, Trigger } from '../core/index.ts'
import { KV, type Key } from '../kv.ts'

/** One deliverable file: its path relative to `deliver/` with forward slashes, content hash, size, and collection time. */
export interface Artifact { name: string; hash: string; size: number; at: string }

const sha = (content: Buffer): string => createHash('sha256').update(content).digest('hex').slice(0, 16)

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

/** The result reply that names the deliverables and where they were delivered. */
export function artifactNotice(artifacts: readonly Artifact[], target?: string): string {
  const lines = artifacts.map(artifact => `- ${artifact.name} (${artifact.size} bytes, sha256:${artifact.hash})`)
  return [`Artifacts delivered:`, ...lines, ...(target ? [`Delivered to: ${target}`] : [])].join('\n')
}

/** Host dependencies of one artifact delivery: the ticket's records and the Engine's result reply. */
export interface ArtifactHost {
  readonly store: {
    tickets: { get(id: string): Ticket | undefined }
    triggers: { get(id: string): Trigger | undefined }
    set<V>(key: Key<V>, value: V): void
  }
  readonly engine: { reply(request: ReplyRequest): unknown }
}

/**
 * Collects a ticket's deliverables once its worker reported ready, records them, copies them to the origin Source's
 * outbox when it names one, and posts the result reply. Returns the number of artifacts; zero when there is nothing.
 */
export async function deliverArtifacts(host: ArtifactHost, ticketId: string): Promise<number> {
  const ticket = host.store.tickets.get(ticketId)
  const directory = ticket?.execution?.directory
  if (!ticket || !directory) return 0
  const artifacts = await collectDeliverables(directory)
  if (!artifacts.length) return 0
  host.store.set(KV.artifacts(ticketId), artifacts)
  const outbox = host.store.triggers.get(ticket.origin.triggerId)?.meta.outbox
  const target = typeof outbox === 'string' && outbox ? join(outbox, ticketId, 'artifacts') : undefined
  if (target) await copyArtifacts(directory, artifacts, target)
  host.engine.reply({ purpose: 'result', ticketId, text: artifactNotice(artifacts, target) })
  return artifacts.length
}
