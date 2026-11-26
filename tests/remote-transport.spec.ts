/** The remote transport's security envelope: the sftp/ssh-keygen argument arrays, a shell-free spawn, path and batch checks, and the host key pin. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { archiveFiles, batchText, fetchFile, parseListing, remoteNameProblem, remotePathProblem, runSftp, sftpArgs,
  sshKeygenArgs, targetProblem, verifyHostKey, type RemoteTarget } from '../src/sources/remote-transport.ts'

interface Call { program: string; args: string[]; options: Record<string, unknown>; input?: string }
interface Answer { stdout?: string; stderr?: string; code?: number; hang?: boolean }
const command = vi.hoisted(() => {
  const calls: Call[] = []
  let answer: (call: Call) => Answer = () => ({ code: 0 })
  const spawn = vi.fn((program: string, args: string[], options: Record<string, unknown>) => {
    const call: Call = { program, args, options }
    calls.push(call)
    const listeners = new Map<string, ((...values: unknown[]) => void)[]>()
    const emit = (event: string, ...values: unknown[]): void => { for (const listener of listeners.get(event) ?? []) listener(...values) }
    const listen = (event: string, listener: (...values: unknown[]) => void): void => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }
    let announced = false
    const child = {
      stdin: { on: vi.fn(), end: (input?: string) => {
        call.input = input ?? ''
        if (announced) return
        announced = true
        // Answer after the caller attached its listeners, as a real child does.
        setTimeout(() => {
          const result = answer(call)
          if (result.hang) return
          if (result.stdout !== undefined) emit('stdout', Buffer.from(result.stdout))
          if (result.stderr !== undefined) emit('stderr', Buffer.from(result.stderr))
          emit('close', result.code ?? 0)
        }, 0)
      } },
      stdout: { on: (_event: string, listener: (...values: unknown[]) => void) => listen('stdout', listener) },
      stderr: { on: (_event: string, listener: (...values: unknown[]) => void) => listen('stderr', listener) },
      on: (event: string, listener: (...values: unknown[]) => void) => listen(event, listener),
      // A killed child ends a moment later, as a real one does.
      kill: vi.fn(() => { setTimeout(() => emit('close', null), 0) }),
    }
    return child
  })
  return { calls, spawn, answer: (next: (call: Call) => Answer) => { answer = next } }
})
vi.mock('node:child_process', () => ({ spawn: command.spawn }))

let dir: string, identityFile: string, knownHosts: string
const fingerprint = 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const target = (overrides: Partial<RemoteTarget> = {}): RemoteTarget =>
  ({ host: 'files.example', port: 2222, username: 'dsh-remote', identityFile, knownHosts, ...overrides })
const last = (): Call => command.calls[command.calls.length - 1]!
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remote-transport-'))
  identityFile = join(dir, 'id_ed25519')
  knownHosts = join(dir, 'known_hosts')
  writeFileSync(identityFile, 'PRIVATE KEY MATERIAL\n')
  writeFileSync(knownHosts, 'files.example ssh-ed25519 AAAA\n')
  command.calls.length = 0
  command.answer(() => ({ code: 0 }))
})
afterEach(() => {
  vi.clearAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('argument arrays', () => {
  it('calls sftp with a key-only, batch-mode login under a strictly checked host key and no password option', () => {
    const args = sftpArgs(target())
    expect(args).toEqual(['-q', '-P', '2222', '-i', identityFile, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'ConnectTimeout=15', '-b', '-',
      'dsh-remote@files.example'])
    const line = args.join(' ')
    expect(line).toContain('StrictHostKeyChecking=yes')
    expect(line).toContain('BatchMode=yes')
    // A connection that could fall back to a password or to another key would defeat the configured identity.
    expect(line).not.toContain('StrictHostKeyChecking=no')
    expect(line).not.toContain('accept-new')
    expect(line).not.toContain('PasswordAuthentication')
    expect(line).not.toContain('PreferredAuthentications=password')
    expect(args).not.toContain('password')
    // The batch comes from stdin, so no command of the batch is ever part of the argument list.
    expect(args[args.indexOf('-b') + 1]).toBe('-')
  })
  it('matches the known_hosts entry by host and port, as ssh writes a non-default port', () => {
    expect(sshKeygenArgs(target())).toEqual(['-F', '[files.example]:2222', '-f', knownHosts, '-l'])
    expect(sshKeygenArgs(target({ port: 22 }))[1]).toBe('files.example')
  })
  it('refuses a target whose key or known_hosts file is missing, relative or unreadable', () => {
    expect(targetProblem(target())).toBeUndefined()
    expect(targetProblem(target({ identityFile: '' }))).toContain('identityFile is not set')
    expect(targetProblem(target({ identityFile: 'id_ed25519' }))).toContain('must be an absolute local path')
    expect(targetProblem(target({ identityFile: join(dir, 'missing') }))).toContain('identityFile cannot be read')
    expect(targetProblem(target({ knownHosts: join(dir, 'missing') }))).toContain('knownHosts cannot be read')
    expect(targetProblem(target({ port: 0 }))).toContain('port')
    expect(targetProblem(target({ host: 'bad host' }))).toBeTruthy()
    expect(targetProblem(target({ username: 'bad user' }))).toBeTruthy()
    expect(() => sftpArgs(target({ identityFile: join(dir, 'missing') }))).toThrow('unusable')
  })
  it('refuses remote paths with .., empty segments, quotes, wildcards, spaces or newlines, and accepts safe ones', () => {
    for (const bad of ['', 'relative', '/', '/inbox/', '/a//b', '/a/../b', '/a/./b', '/a b', '/a;b', '/a"b', '/a*b',
      '/a\nb', '/a\\b', '/a`b', '/a$(x)']) expect(remotePathProblem(bad), bad).toBeTruthy()
    for (const good of ['/inbox', '/srv/drop.box/in-1/a_b.c', '/a-b_c.d/e']) expect(remotePathProblem(good), good).toBeUndefined()
    for (const bad of ['', '.', '..', 'a b', 'a;b', 'a/b', 'a"b', 'a*b', 'a\nb']) expect(remoteNameProblem(bad), bad).toBeTruthy()
    for (const good of ['note-1.md', '.done', 'a_b.c', 'REPORT']) expect(remoteNameProblem(good), good).toBeUndefined()
  })
})

describe('the command runner', () => {
  it('runs sftp through spawn with an argument array and shell false, and writes the batch to stdin', async () => {
    await runSftp(target(), ['ls -1 /inbox'])
    expect(command.spawn).toHaveBeenCalledTimes(1)
    const call = last()
    expect(call.program).toBe('sftp')
    expect(call.args).toEqual(sftpArgs(target()))
    expect(Array.isArray(call.args)).toBe(true)
    expect(call.args.every(part => typeof part === 'string')).toBe(true)
    expect(call.options).toMatchObject({ shell: false })
    expect(call.input).toBe('ls -1 /inbox\nbye\n')
  })
  it('refuses a batch line that is not one of its own commands before spawning anything', async () => {
    await expect(runSftp(target(), ['get /inbox/a.txt; touch /tmp/pwned'])).rejects.toThrow('batch line')
    await expect(runSftp(target(), ['rm -rf /'])).rejects.toThrow('batch line')
    await expect(runSftp(target(), ['ls -1 /inbox/../etc'])).rejects.toThrow('batch line')
    await expect(runSftp(target(), ['put a.txt /outbox/a.md\nrm -rf /'])).rejects.toThrow('batch line')
    expect(batchText(['ls -1 /inbox'])).toBe('ls -1 /inbox\nbye\n')
    expect(command.spawn).not.toHaveBeenCalled()
  })
  it('runs downloads and archiving with the local directory as the working directory and the verified target', async () => {
    await fetchFile(target(), '/srv/inbox', 'report.md', dir)
    expect(last()).toMatchObject({ program: 'sftp', args: sftpArgs(target()), options: { cwd: dir }, input: 'get /srv/inbox/report.md report.md\nbye\n' })
    await archiveFiles(target(), '/srv/inbox', ['a.md', 'b.md'])
    expect(last().input).toBe(['-mkdir /srv/inbox/.done', '-rm /srv/inbox/.done/a.md', '-rm /srv/inbox/.done/b.md',
      'rename /srv/inbox/a.md /srv/inbox/.done/a.md', 'rename /srv/inbox/b.md /srv/inbox/.done/b.md', 'bye'].join('\n') + '\n')
    // Refusing happens before the command: a file name with a shell character never reaches a batch.
    await expect(fetchFile(target(), '/srv/inbox', 'a;b', dir)).rejects.toThrow('file name')
    expect(command.spawn).toHaveBeenCalledTimes(2)
  })
  it('reports a timeout, kills the command, and keeps a failed command\'s stderr short and free of the key', async () => {
    command.answer(() => ({ hang: true }))
    await expect(runSftp(target(), ['ls -1 /inbox'], { timeoutMs: 20 })).rejects.toThrow('timed out after')
    const child = command.spawn.mock.results[0]!.value as { kill: ReturnType<typeof vi.fn> }
    expect(child.kill).toHaveBeenCalled()
    command.answer(() => ({ code: 1, stderr: `PRIVATE KEY MATERIAL ${'x'.repeat(2000)}` }))
    const error = await runSftp(target(), ['ls -1 /inbox']).then(() => new Error('did not fail'),
      (reason: unknown) => reason as Error)
    expect(error.message).toContain('sftp exited with code 1')
    expect(error.message.length).toBeLessThan(700)
    expect(error.message.endsWith('…')).toBe(true)
  })
})

describe('the host key pin', () => {
  it('compares the configured SHA256 fingerprint with a read-only ssh-keygen call before connecting', async () => {
    command.answer(() => ({ stdout: `# Host files.example found: line 1\n256 ${fingerprint} files.example (ED25519)\n` }))
    await verifyHostKey(target({ hostKeySha256: fingerprint }))
    const call = last()
    expect(call.program).toBe('ssh-keygen')
    expect(call.args).toEqual(['-F', '[files.example]:2222', '-f', knownHosts, '-l'])
    expect(call.options).toMatchObject({ shell: false })
    // Without a pin the known hosts check is left to sftp's own StrictHostKeyChecking.
    command.spawn.mockClear()
    await verifyHostKey(target())
    expect(command.spawn).not.toHaveBeenCalled()
  })
  it('fails when the known hosts file holds another fingerprint, or no entry for the host', async () => {
    command.answer(() => ({ stdout: `256 SHA256:otherfingerprintotherfingerprintotherfingerprint files.example (ED25519)\n` }))
    await expect(verifyHostKey(target({ hostKeySha256: fingerprint }))).rejects.toThrow('does not match hostKeySha256')
    command.answer(() => ({ code: 1, stderr: 'not found' }))
    await expect(verifyHostKey(target({ hostKeySha256: fingerprint }))).rejects.toThrow('cannot be read from the known hosts file')
    expect(command.calls.every(call => call.program === 'ssh-keygen')).toBe(true)
  })
})

describe('inbox listings', () => {
  it('reads the names of ls -1 and the sizes of ls -l without taking a prompt or a total for a file', () => {
    const listing = parseListing(['report.md', 'notes.txt', 'sftp> ls -1', 'total',
      '-rw-r--r--    1 dsh-remote dsh-remote     2048 Nov 26 10:00 report.md',
      '-rw-r--r--    1 dsh-remote dsh-remote       12 Nov 26 10:01 notes.txt', ''].join('\r\n'))
    expect(listing.names.sort()).toEqual(['notes.txt', 'report.md'])
    expect(listing.sizes.get('report.md')).toBe(2048)
    expect(listing.sizes.get('notes.txt')).toBe(12)
    expect(parseListing('').names).toEqual([])
  })
})
