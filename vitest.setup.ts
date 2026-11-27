/**
 * Windows test environment: the prototype's subprocess tests use POSIX utilities (`sh`, `env`, `sleep`, `echo`).
 * Git for Windows ships them in <Git>/usr/bin; prepend that directory to PATH so those tests exercise real
 * subprocess behavior on Windows instead of being skipped. Tests that execute extension-less shebang scripts
 * through Node's CreateProcess-based spawn remain POSIX-only and are skipped per test (see plan/阶段0-基线报告.md).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// A host that already runs a superagent (this machine's desktop profile) sets these in the process that starts the tests.
// The suite asserts the environment a runtime writes and restores, so start from a clean one.
for (const name of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_TERMINAL_PROMPT']) delete process.env[name]
for (const name of Object.keys(process.env)) if (name.startsWith('DSH_SUPERAGENTAREA_') || name.startsWith('DSH_SUPERAGENT_')) delete process.env[name]

if (process.platform === 'win32') {
  const gitCmd = (process.env.PATH ?? '').split(';').find(entry => /[\\/]git[\\/]cmd$/i.test(entry))
  if (gitCmd) {
    const usrBin = join(gitCmd, '..', 'usr', 'bin')
    if (existsSync(join(usrBin, 'sh.exe'))) process.env.PATH = `${usrBin};${process.env.PATH}`
  }
}
