/**
 * The remote folder's SFTP transport, kept apart from the Source kind so that every remote path, argument and batch line
 * passes one set of checks: an argument array (never a shell string), a key-only login (`BatchMode=yes`,
 * `IdentitiesOnly=yes`, an explicit `-i`), a strictly checked host key (`StrictHostKeyChecking=yes`, the configured
 * known_hosts file and the optional `hostKeySha256` pin), and only absolute POSIX paths made of `[A-Za-z0-9._/-]` with no
 * `..` or empty segment. The private key is read by `sftp` alone: this module never opens it, so its content cannot reach a
 * log, an error or a Trigger. Only `sftp` batch commands run on the host: no shell is executed.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/** How long one `sftp` batch may run; `ConnectTimeout=15` bounds the connection attempt inside it. */
export const SFTP_TIMEOUT_MS = 30_000
/** Files one poll round processes at most, so a full inbox cannot hold the loop for long. */
export const ROUND_FILE_LIMIT = 20
/** How much of a failed command's stderr an error keeps; a broken server must not flood the panel or the log. */
export const STDERR_LIMIT = 500
/** Names and paths a remote host may receive: one path segment's alphabet, with no space, quote, wildcard or newline. */
const SEGMENT = /^[A-Za-z0-9._-]+$/
const HOST = /^[A-Za-z0-9.-]+$/
const USERNAME = /^[A-Za-z0-9._-]+$/
/** The pinned fingerprint form `ssh-keygen -l` prints: `SHA256:` and the key's base64 digest. */
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/=]{32,64}$/
/** What one `sftp` connection authenticates to and which files prove who the host is. */
export interface RemoteTarget {
  host: string
  port: number
  username: string
  /** Absolute local path of the private key handed to `sftp` with `-i`. */
  identityFile: string
  /** Absolute local path of the known_hosts file `sftp` reads with `StrictHostKeyChecking=yes`. */
  knownHosts: string
  /** Optional `SHA256:...` fingerprint every round first compares against the known_hosts entry. */
  hostKeySha256?: string
}
/** How one command runs: its stdin, its working directory, how long it may take, and how a stop reaches it. */
export interface RunOptions { input?: string; cwd?: string; timeoutMs?: number; signal?: AbortSignal }
/** Runs one program with an argument array, never through a shell, and returns its captured output. */
export type CommandRunner = (program: string, args: readonly string[], options: RunOptions) => Promise<{ stdout: string; stderr: string }>
/** Programs and limits a kind's transport uses; tests replace `run` with a stand-in and production takes the defaults. */
export interface TransportOptions { run?: CommandRunner; timeoutMs?: number; signal?: AbortSignal }
/** Everything one inbox listing says: the names it holds and, from `ls -l`, the sizes it reports. */
export interface RemoteListing { names: string[]; sizes: Map<string, number> }

/** Keeps an error or diagnostic short; a batch's paths are visible, a private key never is. */
export const clip = (text: string, max = STDERR_LIMIT): string => text.length > max ? `${text.slice(0, max)}…` : text
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * The default command runner: `spawn` with the argument array and `shell: false`, so no metacharacter of a path or a batch
 * line can become a command. It writes `input` to stdin, bounds stdout and stderr, kills a command that outlives `timeoutMs`
 * (or is aborted) and reports a failure with the program name and the clipped stderr, never with the arguments.
 */
export const runCommand: CommandRunner = (program, args, options) => new Promise((resolve, reject) => {
  const timeoutMs = options.timeoutMs ?? SFTP_TIMEOUT_MS
  let child
  try {
    child = spawn(program, [...args], { shell: false, windowsHide: true, cwd: options.cwd, env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'], ...options.signal ? { signal: options.signal } : {} })
  } catch (error) {
    reject(new Error(`${program} could not be started: ${clip(messageOf(error))}`))
    return
  }
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let recorded = 0
  let timedOut = false
  let settled = false
  // One sandboxed command may print a lot; keep the head only, which is where a diagnostic starts.
  const record = (into: Buffer[]) => (chunk: Buffer) => {
    if (recorded >= 1024 * 1024) return
    into.push(chunk)
    recorded += chunk.length
  }
  const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
  timer.unref()
  const finish = (work: () => void): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    work()
  }
  child.stdout?.on('data', record(stdout))
  child.stderr?.on('data', record(stderr))
  // A command may exit before it reads its batch; that is reported through the close event instead.
  child.stdin?.on('error', () => {})
  child.on('error', (error: Error) => finish(() => reject(new Error(`${program} failed: ${clip(error.message)}`))))
  child.on('close', (code: number | null) => finish(() => {
    if (timedOut) { reject(new Error(`${program} timed out after ${Math.round(timeoutMs / 1000)} s`)); return }
    const errors = Buffer.concat(stderr).toString('utf8').trim()
    if (code !== 0) {
      reject(new Error(`${program} exited with code ${code}${errors ? `: ${clip(errors)}` : ''}`))
      return
    }
    resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: errors })
  }))
  child.stdin?.end(options.input ?? '')
})

/** Why a remote host is unusable, or undefined. */
export function hostProblem(host: string): string | undefined {
  if (!host) return 'the host is empty'
  if (host.length > 253) return 'the host is too long'
  if (!HOST.test(host)) return 'the host may hold only letters, digits, . and -'
  if (host.startsWith('.') || host.endsWith('.')) return 'the host must not start or end with .'
  if (host.includes('..')) return 'the host must not hold ..'
  return undefined
}
/** Why a remote user name is unusable, or undefined. */
export function usernameProblem(username: string): string | undefined {
  if (!username) return 'the user name is empty'
  if (username.length > 64) return 'the user name is too long'
  if (!USERNAME.test(username)) return 'the user name may hold only letters, digits, . _ and -'
  return undefined
}
/** Why a port is unusable, or undefined. */
export function portProblem(port: number): string | undefined {
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? undefined : 'the port must be a whole number from 1 to 65535'
}
/** Why a pinned fingerprint is unusable, or undefined; empty means no pin. */
export function fingerprintProblem(fingerprint: string): string | undefined {
  if (!fingerprint) return undefined
  return FINGERPRINT.test(fingerprint) ? undefined : 'the fingerprint must be SHA256: and the key digest'
}
/** Why a local file a connection needs is unusable, or undefined. */
export function localFileProblem(path: string, field: string): string | undefined {
  if (!path) return `The ${field} is not set`
  if (!isAbsolute(path)) return `The ${field} must be an absolute local path`
  try {
    if (!statSync(path).isFile()) return `The ${field} is not a file: ${path}`
    accessSync(path, constants.R_OK)
  } catch { return `The ${field} cannot be read: ${path}` }
  return undefined
}
/** Why an absolute POSIX path on the remote host is unusable, or undefined. */
export function remotePathProblem(path: string): string | undefined {
  if (!path) return 'a remote path is empty'
  if (path.length > 512) return 'a remote path is too long'
  if (!path.startsWith('/')) return 'a remote path must be absolute'
  if (path === '/') return 'a remote path must name a directory below /'
  if (path.endsWith('/')) return 'a remote path must not end with /'
  for (const segment of path.slice(1).split('/')) {
    if (!segment) return 'a remote path must not hold an empty segment'
    if (segment === '.' || segment === '..') return 'a remote path must not hold . or ..'
    if (!SEGMENT.test(segment)) return 'a remote path may hold only letters, digits, . _ - and /'
  }
  return undefined
}
/** Why a remote file name is unusable, or undefined. */
export function remoteNameProblem(name: string): string | undefined {
  if (!name) return 'a remote file name is empty'
  if (name.length > 255) return 'a remote file name is too long'
  if (name === '.' || name === '..') return 'a remote file name must not be . or ..'
  return SEGMENT.test(name) ? undefined : 'a remote file name may hold only letters, digits, . _ and -'
}
/** Why a connection target is unusable, or undefined. */
export function targetProblem(target: RemoteTarget): string | undefined {
  return hostProblem(target.host) ?? portProblem(target.port) ?? usernameProblem(target.username)
    ?? localFileProblem(target.identityFile, 'identityFile') ?? localFileProblem(target.knownHosts, 'knownHosts')
    ?? fingerprintProblem(target.hostKeySha256 ?? '')
}
/** The known_hosts pattern for a target: `host` for port 22, else the `[host]:port` form ssh writes. */
export const knownHostsPattern = (target: RemoteTarget): string =>
  target.port === 22 ? target.host : `[${target.host}]:${target.port}`

/**
 * The argument array of one `sftp` invocation: quiet, the configured port, the explicit key, key-only batch login, a strictly
 * checked host key read from the configured file, a bounded connection, and the batch on stdin. No password option exists,
 * and no shell ever parses these arguments.
 */
export function sftpArgs(target: RemoteTarget): string[] {
  const problem = targetProblem(target)
  if (problem) throw new Error(`The remote target is unusable: ${problem}`)
  return ['-q', '-P', String(target.port), '-i', target.identityFile, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${target.knownHosts}`, '-o', 'ConnectTimeout=15', '-b', '-',
    `${target.username}@${target.host}`]
}
/** The read-only `ssh-keygen` call that lists the fingerprints the known hosts file holds for the target's host. */
export function sshKeygenArgs(target: RemoteTarget): string[] {
  return ['-F', knownHostsPattern(target), '-f', target.knownHosts, '-l']
}
/** The line of the batch a command accepts, by the arguments it takes, so a line that is not one of them never runs. */
const BATCH_COMMANDS: Record<string, number> = { '-mkdir': 1, '-rm': 1, mkdir: 1, rm: 1, rename: 2, get: 2, put: 2, ls: 2 }
/** Why one batch line is not one of the commands this transport writes, or undefined. */
function batchLineProblem(line: string): string | undefined {
  if (line === 'bye') return undefined
  const [command, ...args] = line.split(' ')
  const expected = BATCH_COMMANDS[command ?? '']
  if (expected === undefined) return 'unknown command'
  if (args.length !== expected) return 'unexpected arguments'
  if (command === 'ls') return args[0] === '-1' || args[0] === '-l' ? remotePathProblem(args[1] ?? '') ? 'unsafe path' : undefined
    : 'unsupported option'
  for (const arg of args) if (remotePathProblem(arg) && remoteNameProblem(arg)) return 'unsafe argument'
  return undefined
}
const directory = (path: string, label: string): string => {
  const problem = remotePathProblem(path)
  if (problem) throw new Error(`Refusing the ${label} ${clip(JSON.stringify(path), 120)}: ${problem}`)
  return path
}
const name = (file: string): string => {
  const problem = remoteNameProblem(file)
  if (problem) throw new Error(`Refusing the remote file name ${clip(JSON.stringify(file), 120)}: ${problem}`)
  return file
}
/** The entire batch, checked line by line before `sftp` sees it. */
export function batchText(lines: readonly string[]): string {
  const all = [...lines, 'bye']
  for (const line of all) {
    const problem = batchLineProblem(line)
    if (problem) throw new Error(`Refusing an sftp batch line (${problem}): ${clip(JSON.stringify(line), 120)}`)
  }
  return `${all.join('\n')}\n`
}
/**
 * Runs one validated `sftp` batch and returns its stdout; a failure carries the clipped stderr alone. `cwd` is the command's
 * working directory, so a local file is named in the batch by its bare name and a local path with spaces never reaches it.
 */
export async function runSftp(target: RemoteTarget, lines: readonly string[], options: TransportOptions = {},
  cwd?: string): Promise<string> {
  const input = batchText(lines)
  const { stdout } = await (options.run ?? runCommand)('sftp', sftpArgs(target),
    { input, cwd, timeoutMs: options.timeoutMs ?? SFTP_TIMEOUT_MS, ...options.signal ? { signal: options.signal } : {} })
  return stdout
}
/**
 * Compares every fingerprint the configured known_hosts file holds for the host against `hostKeySha256`; a missing entry or
 * another key fails the round before `sftp` connects.
 */
export async function verifyHostKey(target: RemoteTarget, options: TransportOptions = {}): Promise<void> {
  const pinned = (target.hostKeySha256 ?? '').trim()
  if (!pinned) return
  const problem = targetProblem(target)
  if (problem) throw new Error(`The remote target is unusable: ${problem}`)
  let stdout: string
  try {
    stdout = (await (options.run ?? runCommand)('ssh-keygen', sshKeygenArgs(target),
      { timeoutMs: options.timeoutMs ?? SFTP_TIMEOUT_MS, ...options.signal ? { signal: options.signal } : {} })).stdout
  } catch (error) {
    throw new Error(`The host key of ${target.host} cannot be read from the known hosts file: ${clip(messageOf(error))}`)
  }
  const normalize = (value: string): string => value.trim().replace(/=+$/, '')
  const found = [...stdout.matchAll(/SHA256:[A-Za-z0-9+/=]+/g)].map(match => normalize(match[0]))
  if (!found.includes(normalize(pinned))) {
    throw new Error(`The host key of ${target.host} does not match hostKeySha256; refusing the connection`)
  }
}
/** Parses an `ls -1` and `ls -l` pair of one inbox: bare lines are names, long lines add their sizes. */
export function parseListing(output: string): RemoteListing {
  const names = new Set<string>()
  const sizes = new Map<string, number>()
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('sftp>') || line === 'total') continue
    const columns = line.split(/\s+/)
    const mode = columns[0] ?? ''
    if (columns.length >= 7 && /^[-dl][rwx-]{9}/.test(mode)) {
      const file = columns[columns.length - 1] ?? ''
      const size = Number(columns[4])
      if (!file || file === '.' || file === '..') continue
      names.add(file)
      if (Number.isFinite(size)) sizes.set(file, size)
      continue
    }
    if (columns.length === 1) names.add(line)
  }
  return { names: [...names], sizes }
}
/** Lists one inbox: the names it holds and the sizes `ls -l` reports, in one batch. */
export async function listInbox(target: RemoteTarget, inbox: string, options: TransportOptions = {}): Promise<RemoteListing> {
  const dir = directory(inbox, 'inbox')
  return parseListing(await runSftp(target, [`ls -1 ${dir}`, `ls -l ${dir}`], options))
}
/** Downloads one named file into `localDir`, the command's working directory, so no local path reaches the batch. */
export async function fetchFile(target: RemoteTarget, inbox: string, file: string, localDir: string,
  options: TransportOptions = {}): Promise<void> {
  const dir = directory(inbox, 'inbox')
  const remote = name(file)
  await runSftp(target, [`get ${dir}/${remote} ${remote}`], options, localDir)
}
/** Writes one local file into `outbox`, removing a receipt of the same message id first so a retry overwrites it. */
export async function putFile(target: RemoteTarget, outbox: string, file: string, localDir: string,
  options: TransportOptions = {}): Promise<void> {
  const dir = directory(outbox, 'outbox')
  const remote = name(file)
  await runSftp(target, [`-rm ${dir}/${remote}`, `put ${remote} ${dir}/${remote}`], options, localDir)
}
/**
 * Moves handled files into `<inbox>/.done`, creating it first; a name reused after archiving replaces the earlier archived
 * copy, which only marks that this inbox file was handled. Every rename is prefixed so one already-archived name does not
 * stop the others.
 */
export async function archiveFiles(target: RemoteTarget, inbox: string, files: readonly string[],
  options: TransportOptions = {}): Promise<void> {
  const dir = directory(inbox, 'inbox')
  const names = files.map(name)
  if (!names.length) return
  await runSftp(target, [`-mkdir ${dir}/.done`, ...names.map(file => `-rm ${dir}/.done/${file}`),
    ...names.map(file => `rename ${dir}/${file} ${dir}/.done/${file}`)], options)
}
