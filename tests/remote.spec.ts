/**
 * The remote folder Source on a `SourceContext`, end to end over a real fake `sftp` process whose "remote" is a temporary
 * directory: configuration checks, Trigger translation, poll rounds (archive, limits, skips, deduplication), receipts, and the
 * plugin loop with its health thresholds.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, threadKey, type OutboundMessage, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { pollRemote, remoteInstanceOf, remoteKind, remoteTrigger, sendRemote, watchRemote, apply,
  type RemoteConfig, type RemoteInstance } from '../src/sources/remote.ts'
import { runCommand, type TransportOptions } from '../src/sources/remote-transport.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'

/**
 * A fake `sftp`: it ignores the SSH flags, records the program and argument array it got, reads the batch from stdin and runs
 * `ls/get/put/rename/mkdir/rm` inside `FAKE_SFTP_ROOT`, so remote `/srv/inbox` is `<root>/srv/inbox`. It also answers the
 * `ssh-keygen -F` fingerprint read with `FAKE_FINGERPRINT`, and fails a batch the way sftp does when a command without a `-`
 * prefix fails.
 */
const FAKE_SFTP = String.raw`
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
const root = process.env.FAKE_SFTP_ROOT || ''
const log = process.env.FAKE_SFTP_LOG || ''
const argv = process.argv.slice(2)
const program = argv.shift() || 'sftp'
if (log) appendFileSync(log, JSON.stringify({ program: program, args: argv }) + '\n')
if (program === 'ssh-keygen') {
  console.log('# Host found: line 1')
  console.log('256 ' + (process.env.FAKE_FINGERPRINT || '') + ' host (ED25519)')
  process.exit(0)
}
const map = path => {
  if (!path.startsWith('/')) throw new Error('not an absolute path: ' + path)
  return join(root, path.slice(1))
}
const run = (name, args) => {
  if (name === 'ls') {
    const dir = map(args[1])
    const entries = readdirSync(dir)
    if (args[0] === '-1') { for (const entry of entries) console.log(entry); return }
    for (const entry of entries) {
      const info = statSync(join(dir, entry))
      const mode = info.isDirectory() ? 'drwxr-xr-x' : '-rw-r--r--'
      console.log(mode + '    1 dsh-remote dsh-remote ' + String(info.size).padStart(10) + ' Jan  1 00:00 ' + entry)
    }
    return
  }
  if (name === 'get') { copyFileSync(map(args[0]), args[1]); return }
  if (name === 'put') { copyFileSync(args[0], map(args[1])); return }
  if (name === 'rename') { renameSync(map(args[0]), map(args[1])); return }
  if (name === 'mkdir') { mkdirSync(map(args[0])); return }
  if (name === 'rm') { try { rmSync(map(args[0])) } catch {} ; return }
  throw new Error('unknown command: ' + name)
}
let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
for (const line of input.split('\n')) {
  const text = line.trim()
  if (!text || text === 'bye') continue
  const ignore = text.startsWith('-')
  const body = ignore ? text.slice(1) : text
  const space = body.indexOf(' ')
  const name = space < 0 ? body : body.slice(0, space)
  const args = space < 0 ? [] : body.slice(space + 1).split(' ')
  try { run(name, args) } catch (error) {
    if (ignore) continue
    console.error('sftp: ' + name + ': ' + error.message)
    process.exit(1)
  }
}
`
const HOST = 'files.example'
const PORT = 2222
const INBOX = '/srv/inbox'
const OUTBOX = '/srv/outbox'
const FINGERPRINT = 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'

let dir: string, root: string, inboxDir: string, outboxDir: string, identityFile: string, knownHostsFile: string
let script: string, logFile: string
const stores: Store[] = []
const temporary = (): string => join(dir, 'area', 'remote.tmp', 'remote-ops')
/** A transport whose `sftp` and `ssh-keygen` are the fake process, run through the real shell-free command runner. */
const transport = (): TransportOptions => ({ run: (program, args, options) => {
  const call = { ...options }
  return runCommand(process.execPath, [script, program, ...args], call)
} })
/** A validated configuration; tests change one field to check a refusal or a round. */
const config = (overrides: Partial<RemoteConfig> = {}): RemoteConfig => remoteKind.schema.parse({
  host: HOST, port: PORT, username: 'dsh-remote', identityFile, knownHosts: knownHostsFile, inbox: INBOX, outbox: OUTBOX,
  operator: 'alice', pollSeconds: 5, maxFileBytes: 1024 * 1024, ...overrides,
})
const instance = (overrides: Partial<RemoteInstance> = {}): RemoteInstance =>
  ({ ...remoteInstanceOf('remote:ops', config()), ...overrides })
const inboxFile = (name: string, content: string | Buffer = ''): void => writeFileSync(join(inboxDir, name), content)
const sftpCalls = (): { program: string; args: string[] }[] => existsSync(logFile)
  ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { program: string; args: string[] })
  : []

const drop = { file: 'report.md', bytes: 12, hash: 'hash-1', at: '2026-11-26T00:00:00.000Z', text: 'fix the login bug', truncated: false }

/** The dependencies a remote Source context runs on, over `store` and the registry `sources`. */
function depsOf(store: Store, sources: SourceRegistry, overrides: Partial<SourceContextDeps> = {}) {
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment({ stateDir: dir }), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment({ stateDir: dir }), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { parts, engine, receive }
}
function host(sourceConfig: Partial<RemoteConfig> = {}, overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(dir, 'db.sqlite'))
  stores.push(store)
  store.saveSettings(SettingsSchema.parse({
    sources: { 'remote:ops': { kind: 'remote', enabled: true, config: { ...config(), ...sourceConfig } } },
    policy: { sources: { 'remote:ops': { allowed: [{ id: 'alice' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(remoteKind)
  const { parts, engine, receive } = depsOf(store, sources, overrides)
  return { ...parts, store, engine, receive, health: board.all, ctx: sourceContextOf(parts, remoteKind) }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remote-'))
  root = join(dir, 'remote')
  inboxDir = join(root, 'srv', 'inbox')
  outboxDir = join(root, 'srv', 'outbox')
  mkdirSync(inboxDir, { recursive: true }); mkdirSync(outboxDir, { recursive: true })
  identityFile = join(dir, 'id_ed25519')
  knownHostsFile = join(dir, 'known_hosts')
  writeFileSync(identityFile, 'PRIVATE KEY MATERIAL NEVER TO BE LOGGED\n', { mode: 0o600 })
  writeFileSync(knownHostsFile, `${HOST} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA\n`)
  script = join(dir, 'fake-sftp.mjs')
  writeFileSync(script, FAKE_SFTP)
  logFile = join(dir, 'sftp.jsonl')
  process.env.FAKE_SFTP_ROOT = root
  process.env.FAKE_SFTP_LOG = logFile
  process.env.FAKE_FINGERPRINT = FINGERPRINT
})
afterEach(() => {
  for (const name of ['FAKE_SFTP_ROOT', 'FAKE_SFTP_LOG', 'FAKE_FINGERPRINT']) delete process.env[name]
  for (const store of stores.splice(0)) store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('configuration', () => {
  it('fills the defaults, keeps its fields and order, and never declares a credential field', () => {
    expect(remoteKind.schema.parse({})).toEqual({ host: '', port: 22, username: '', identityFile: '', knownHosts: '',
      hostKeySha256: '', inbox: '', outbox: '', pollSeconds: 30, maxFileBytes: 1048576, operator: '' })
    expect(remoteKind).toMatchObject({ kind: 'remote', order: 2, health: ['remote'],
      title: { zh: '远程文件夹', en: 'Remote folder' } })
    expect(remoteKind.placeholder).toBeUndefined()
    expect(remoteKind.fields.map(field => field.key)).toEqual(['host', 'port', 'username', 'identityFile', 'knownHosts',
      'hostKeySha256', 'inbox', 'outbox', 'operator', 'pollSeconds', 'maxFileBytes'])
    // Only paths prove the connection: there is no password, token or private-key-content field at all.
    const text = remoteKind.fields.map(field => `${field.key} ${field.label.en}`).join(' ').toLowerCase()
    expect(text).not.toContain('password')
    expect(remoteKind.schema.parse({ host: HOST, username: 'dsh-remote', identityFile, knownHosts: knownHostsFile,
      inbox: INBOX, outbox: OUTBOX, hostKeySha256: FINGERPRINT })).toMatchObject({ port: 22, pollSeconds: 30 })
  })
  it('requires the key, known hosts file and inbox/outbox to be safe and present, and bounds the tunables', () => {
    const parse = (value: Record<string, unknown>) => (): RemoteConfig => remoteKind.schema.parse(value)
    // A key that cannot be read stops the save with the field and the path, so a later poll cannot fail for a typo alone.
    expect(parse({ identityFile: join(dir, 'missing'), knownHosts: knownHostsFile })).toThrow(/identityFile cannot be read/)
    expect(parse({ identityFile: 'id_ed25519', knownHosts: knownHostsFile })).toThrow(/identityFile must be an absolute local path/)
    expect(parse({ identityFile, knownHosts: join(dir, 'missing') })).toThrow(/knownHosts cannot be read/)
    expect(parse({ inbox: 'relative/inbox' })).toThrow(/inbox/)
    expect(parse({ inbox: '/srv/../etc' })).toThrow(/inbox/)
    expect(parse({ outbox: '/srv/out box' })).toThrow(/outbox/)
    expect(parse({ outbox: '/srv/out;rm' })).toThrow(/outbox/)
    expect(parse({ outbox: '/srv/out//x' })).toThrow(/outbox/)
    for (const port of [0, 65536, 2.5]) expect(parse({ port })).toThrow()
    expect(parse({ pollSeconds: 4 })).toThrow()
    expect(parse({ maxFileBytes: 1023 })).toThrow()
    expect(parse({ maxFileBytes: 16 * 1024 * 1024 + 1 })).toThrow()
    expect(parse({ host: 'bad host' })).toThrow(/host/)
    expect(parse({ username: 'bad user' })).toThrow(/username/)
    expect(parse({ hostKeySha256: 'SHA256:short' })).toThrow(/fingerprint/)
    expect(parse({ extra: 1 })).toThrow()
    expect(parse({})).not.toThrow()
  })
})

describe('translation', () => {
  it('names a stable id, the remote thread, the operator, and an address that carries no credential', () => {
    const trigger = remoteTrigger(drop, instance(), 'alice')
    expect(trigger.id).toBe(key('remote', 'remote:ops', 'report.md', 'hash-1'))
    expect(trigger.source).toBe('remote:ops')
    expect(trigger.threads).toEqual([{ source: 'remote:ops', id: 'report.md' }])
    expect(threadKey(trigger.threads[0]!)).toBe('remote:ops:report.md')
    expect(trigger.actor).toEqual({ source: 'remote:ops', id: 'alice' })
    expect(trigger).toMatchObject({ human: true, addressed: 'direct', text: 'fix the login bug' })
    expect(trigger.channel).toMatchObject({ source: 'remote:ops', thread: 'remote:ops:report.md' })
    expect(trigger.channel!.address).toEqual({ row: 'remote:ops', host: HOST, port: String(PORT), username: 'dsh-remote',
      identityFile, knownHosts: knownHostsFile, outbox: OUTBOX })
    expect(Object.keys(trigger.channel!.address).some(field => /pass|secret|private/i.test(field))).toBe(false)
    expect(trigger.meta).toMatchObject({ row: 'remote:ops', file: 'report.md', host: HOST, bytes: 12, hash: 'hash-1' })
    // The key's path travels; its content never enters a Trigger, a message or an error.
    expect(JSON.stringify(trigger)).not.toContain('PRIVATE KEY MATERIAL')
    expect(trigger.meta).not.toHaveProperty('password')
  })
  it('adds the pinned fingerprint to the address when one is configured, so every receipt checks it too', () => {
    const pinned = instance({ hostKeySha256: FINGERPRINT })
    expect(remoteTrigger(drop, pinned, 'alice').channel!.address.hostKeySha256).toBe(FINGERPRINT)
  })
  it('names the operator as a person, listens only when it names an inbox, and gives the instance an admission row', () => {
    expect(remoteKind.people!(config(), 'remote:ops')).toEqual([{ id: 'alice' }])
    expect(remoteKind.people!(config({ operator: '' }), 'remote:ops')).toEqual([])
    // The admission table keys a folder's row by its instance id; the remote folder mirrors that.
    expect(remoteKind.scope!({ meta: {}, instance: 'remote:ops' }, config()))
      .toEqual({ listened: true, observed: false, row: 'remote:ops' })
    expect(remoteKind.scope!({ meta: {}, instance: 'remote' }, config({ host: '', inbox: '' })))
      .toEqual({ listened: false, reason: 'remote_not_listed' })
    expect(remoteKind.policy!.rows!({}, 'remote:ops')).toEqual([{ id: 'remote:ops', label: 'remote:ops',
      note: { zh: '投件', en: 'Drops' }, cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } }])
    expect(remoteKind.policy!.explicit.en).toContain('remote inbox')
  })
})

describe('poll rounds', () => {
  it('reads a drop once, receives its Trigger and archives the source file under .done', async () => {
    const h = host()
    inboxFile('report.md', 'fix the login bug')
    const signal = new AbortController().signal
    expect(await pollRemote(h.ctx, instance(), 'alice', signal, transport()))
      .toEqual({ read: 1, received: 1, skipped: [], deferred: 0 })
    expect(h.receive).toHaveBeenCalledTimes(1)
    const trigger = h.receive.mock.calls[0]![0]
    expect(trigger).toMatchObject({ source: 'remote:ops', text: 'fix the login bug' })
    expect(threadKey(trigger.threads[0]!)).toBe('remote:ops:report.md')
    expect(trigger.channel!.address).toMatchObject({ host: HOST, outbox: OUTBOX })
    // The source file moved into .done and the temporary copy is gone; the seen hash keeps a reread a duplicate.
    expect(existsSync(join(inboxDir, 'report.md'))).toBe(false)
    expect(readFileSync(join(inboxDir, '.done', 'report.md'), 'utf8')).toBe('fix the login bug')
    expect(readdirSync(temporary())).toEqual([])
    expect(h.store.get(KV.remote.seen('remote:ops'))).toEqual({ 'report.md': expect.any(String) })
    // The next round lists the archived file's hidden .done directory and receives nothing.
    expect(await pollRemote(h.ctx, instance(), 'alice', signal, transport()))
      .toEqual({ read: 1, received: 0, skipped: [], deferred: 0 })
    // Every connection ran the argument array with key-only, strictly checked host authentication.
    const sftp = sftpCalls().filter(call => call.program === 'sftp')
    expect(sftp.length).toBeGreaterThan(0)
    for (const call of sftp) {
      const line = call.args.join(' ')
      expect(line).toContain('StrictHostKeyChecking=yes')
      expect(line).toContain('BatchMode=yes')
      expect(line).not.toContain('PasswordAuthentication')
      expect(line).not.toContain('accept-new')
    }
    expect(JSON.stringify(sftpCalls())).not.toContain('PRIVATE KEY MATERIAL')
  })
  it('skips hidden entries, invalid names and oversized files, and names them in the round', async () => {
    const h = host({ maxFileBytes: 1024 })
    inboxFile('.hidden', 'x')
    inboxFile('a;b.txt', 'x')
    inboxFile('big.bin', 'B'.repeat(2048))
    inboxFile('ok.txt', 'small')
    const round = await pollRemote(h.ctx, instance({ maxFileBytes: 1024 }), 'alice', new AbortController().signal, transport())
    expect(round).toMatchObject({ read: 4, received: 1 })
    expect(round.skipped).toEqual([{ file: 'a;b.txt', reason: 'invalid-name' }, { file: 'big.bin', size: 2048, reason: 'oversized' }])
    // The skipped files stay in the inbox for the operator; the valid one is archived.
    expect(existsSync(join(inboxDir, 'big.bin'))).toBe(true)
    expect(existsSync(join(inboxDir, 'a;b.txt'))).toBe(true)
    expect(existsSync(join(inboxDir, '.hidden'))).toBe(true)
    expect(existsSync(join(inboxDir, '.done', 'ok.txt'))).toBe(true)
    expect(h.receive.mock.calls[0]![0].text).toBe('small')
  })
  it('truncates a long file to 8000 characters and marks the Trigger truncated', async () => {
    const h = host()
    inboxFile('long.md', 'x'.repeat(9000))
    await pollRemote(h.ctx, instance(), 'alice', new AbortController().signal, transport())
    const trigger = h.receive.mock.calls[0]![0]
    expect(trigger.text).toHaveLength(8000)
    expect(trigger.meta.truncated).toBe(true)
    expect(trigger.meta.bytes).toBe(9000)
  })
  it('processes at most 20 files in a round and leaves the rest for the next one', async () => {
    const h = host()
    for (let index = 0; index < 22; index += 1) inboxFile(`drop-${String(index).padStart(2, '0')}.txt`, `work ${index}`)
    const signal = new AbortController().signal
    expect(await pollRemote(h.ctx, instance(), 'alice', signal, transport()))
      .toEqual({ read: 22, received: 20, skipped: [], deferred: 2 })
    // The next round reads the two files left and lists the new .done directory too.
    expect(await pollRemote(h.ctx, instance(), 'alice', signal, transport()))
      .toEqual({ read: 3, received: 2, skipped: [], deferred: 0 })
    expect(h.receive).toHaveBeenCalledTimes(22)
  })
  it('keeps the source file and reports a failed round, without creating a second event for it', async () => {
    const h = host()
    inboxFile('a.txt', 'work')
    // A file named `.done` makes the archive rename fail after the Trigger was received.
    inboxFile('.done', 'not a directory')
    const signal = new AbortController().signal
    const failed = await pollRemote(h.ctx, instance(), 'alice', signal, transport())
      .then(() => new Error('did not fail'), (error: unknown) => error as Error)
    expect(failed.message).toContain('exited with code 1')
    expect(failed.message).not.toContain('PRIVATE KEY MATERIAL')
    // The receive happened, but the seen hash was not stored with the failed round.
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.store.get(KV.remote.seen('remote:ops'))).toBeUndefined()
    expect(existsSync(join(inboxDir, 'a.txt'))).toBe(true)
    rmSync(join(inboxDir, '.done'))
    const recovered = await pollRemote(h.ctx, instance(), 'alice', signal, transport())
    expect(recovered.received).toBe(0)
    // The reread carries the same Trigger id, which the Engine refuses as a duplicate: one event, one decision.
    expect(h.receive).toHaveBeenCalledTimes(2)
    expect(h.receive.mock.calls[1]![0].id).toBe(h.receive.mock.calls[0]![0].id)
    expect(h.receive.mock.results[0]!.value).toBe('stored')
    expect(h.receive.mock.results[1]!.value).toBe('duplicate')
    expect(existsSync(join(inboxDir, '.done', 'a.txt'))).toBe(true)
    expect(h.store.get(KV.remote.seen('remote:ops'))).toEqual({ 'a.txt': expect.any(String) })
  })
})

describe('receipts', () => {
  const addressOf = (h: ReturnType<typeof host>) => h.receive.mock.calls[0]![0].channel!.address
  const message = (address: Record<string, string>, id: string, text: string): OutboundMessage =>
    ({ id, channel: { source: 'remote:ops', thread: 'remote:ops:report.md', address }, text, kind: 'reply', ticketId: 't1' })
  it('writes one receipt per message id, overwrites a retry of the same id, and allows only its own outbox', async () => {
    const h = host()
    inboxFile('report.md', 'fix it')
    await pollRemote(h.ctx, instance(), 'alice', new AbortController().signal, transport())
    const address = addressOf(h)
    expect(await sendRemote(message(address, 'm1', 'Done.'), transport())).toBe('sent')
    expect(readFileSync(join(outboxDir, 'm1.md'), 'utf8')).toBe('Done.')
    expect(await sendRemote(message(address, 'm1', 'Done again.'), transport())).toBe('sent')
    expect(readdirSync(outboxDir)).toEqual(['m1.md'])
    expect(readFileSync(join(outboxDir, 'm1.md'), 'utf8')).toBe('Done again.')
    expect(remoteKind.channel!.allowed!(address, config())).toBe(true)
    expect(remoteKind.channel!.allowed!({ ...address, outbox: '/srv/elsewhere' }, config())).toBe(false)
    expect(remoteKind.channel!.allowed!({ ...address, identityFile: join(dir, 'other') }, config())).toBe(false)
    expect(remoteKind.channel!.allowed!({ ...address, outbox: '' }, config())).toBe(false)
    // An SFTP outbox has no browser page; the label still names it, and there is no @ syntax.
    expect(remoteKind.channel!.link(address, {})).toMatchObject({ url: '', label: { zh: expect.stringContaining('remote:ops'),
      en: expect.stringContaining('remote:ops') } })
    expect(remoteKind.channel!.mention).toBeUndefined()
  })
  it('fails a receipt whose outbox is missing, and refuses an address that names another key', async () => {
    const h = host()
    inboxFile('report.md', 'fix it')
    await pollRemote(h.ctx, instance(), 'alice', new AbortController().signal, transport())
    const address = addressOf(h)
    rmSync(outboxDir, { recursive: true, force: true })
    await expect(sendRemote(message(address, 'm2', 'Lost'), transport())).rejects.toThrow('exited with code 1')
    await expect(sendRemote(message({ ...address, identityFile: join(dir, 'missing') }, 'm3', 'x'), transport()))
      .rejects.toThrow('unusable')
    await expect(sendRemote({ ...message(address, 'm4', 'x'), id: 'bad id' }, transport())).rejects.toThrow('message id')
  })
})

describe('the plugin loop', () => {
  /** Starts the loop and always stops it, also when an assertion fails, so no round touches a closed Store. */
  async function watching(h: ReturnType<typeof host>, run: () => Promise<void>): Promise<void> {
    const controller = new AbortController()
    const running = watchRemote(h.ctx, controller.signal, transport())
    try { await run() } finally { controller.abort(); await running }
  }
  it('waits for setup, reports ready rounds with their skips, and stops at once on abort', async () => {
    const waiting = host({}, { configured: () => false })
    await watchRemote(waiting.ctx, new AbortController().signal)
    expect(waiting.health['remote:ops']).toMatchObject({ state: 'paused', code: 'setupPending' })
    const h = host({ maxFileBytes: 1024 })
    inboxFile('ok.txt', 'work')
    inboxFile('big.bin', 'B'.repeat(2048))
    await watching(h, async () => {
      // The first round spawns the fake SFTP program; under a full parallel suite on Windows that can pass the default 1 s.
      await vi.waitFor(() => expect(h.health['remote:ops'])
        .toMatchObject({ state: 'ready', detail: '2 entries, 1 new drops; skipped big.bin (2048 bytes over the limit)' }), { timeout: 10_000 })
      expect(h.receive).toHaveBeenCalledTimes(1)
    })
  })
  it('reports paused with what an enabled but incomplete instance still needs', async () => {
    const h = host({ host: '', inbox: '' })
    await watching(h, async () => {
      await vi.waitFor(() => expect(h.health['remote:ops']).toMatchObject({ state: 'paused',
        detail: 'The remote folder is not configured: host, inbox' }))
    })
  }, 20_000)
  it('reports an error only after three consecutive failed rounds, and recovers on the next good one', async () => {
    const h = host()
    rmSync(inboxDir, { recursive: true, force: true })
    await watching(h, async () => {
      await vi.waitFor(() => expect(h.health['remote:ops']).toMatchObject({ state: 'error', code: 'pollFailures' }), { timeout: 30_000 })
      mkdirSync(inboxDir, { recursive: true })
      await vi.waitFor(() => expect(h.health['remote:ops']).toMatchObject({ state: 'ready' }), { timeout: 20_000 })
    })
  }, 60_000)
  it('registers its kind and starts its loop from the plugin entry', async () => {
    const store = new Store(join(dir, 'plugin.sqlite'))
    stores.push(store)
    store.saveSettings(SettingsSchema.parse({ sources: {
      'remote:ops': { kind: 'remote', enabled: true, config: config() } } }))
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    const { parts } = depsOf(store, sources)
    const disposers: (() => unknown)[] = []
    const ctx = { orchestrator: { sources,
      context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) },
      effect: (effect: () => () => unknown) => { disposers.push(effect()) } }
    apply(ctx as never, transport())
    await vi.waitFor(() => expect(board.all['remote:ops']).toMatchObject({ state: 'ready', detail: '0 entries, 0 new drops' }))
    expect(sources.kind('remote')).toBe(remoteKind)
    for (const dispose of disposers.reverse()) await dispose()
  }, 20_000)
})
