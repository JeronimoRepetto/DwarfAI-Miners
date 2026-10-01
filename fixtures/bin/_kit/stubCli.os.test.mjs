// layer: L8
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The stub-CLI kit as real processes (`Stub<Provider>Cli`, testing strategy `17` §1.8, §1.9).
 *
 * The engine's behaviour runs in process in `stubCli.test.mjs` (L7). This OS-lane file keeps what
 * only a real process shows: each stub program's own wiring, the network guard around a real run,
 * a hung stub staying alive, and starting through the platform's own form, the `.cmd` shim through
 * `%ComSpec% /d /s /c` on Windows (SP-04) and the executable wrapper on POSIX.
 *
 * Every child runs with `CHILD_TIMEOUT_MS` and every case's timeout is its sequential children
 * times that bound, so a hung child is reported by its own bound, with its stderr, rather than by
 * an anonymous test timeout.
 */

const KIT = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.dirname(KIT)
const IS_WINDOWS = process.platform === 'win32'

/**
 * A stub run is one `node` start plus a few small file writes: well under a second on this
 * machine and a few seconds on a cold, loaded CI runner. A child still running after 10 s is hung,
 * not slow.
 */
const CHILD_TIMEOUT_MS = 10_000

/** Each stub, the variable naming its provider directory and its default script (by hand). */
const STUBS = {
  claude: { homeEnv: 'CLAUDE_CONFIG_DIR', defaultScript: 'claude-session-one-turn' },
  codex: { homeEnv: 'CODEX_HOME', defaultScript: 'codex-rollout-one-turn' },
  opencode: { homeEnv: 'XDG_DATA_HOME', defaultScript: 'opencode-session-one-turn' }
}
const STUB_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_DATA_HOME']

/** A module preloaded into the stub that fails, and says so on stderr, on any network call. */
const NETWORK_GUARD = `
import net from 'node:net'
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
const deny = (what) => () => {
  process.stderr.write('NETWORK-CALL ' + what + '\\n')
  throw new Error('network call: ' + what)
}
net.connect = deny('net.connect')
net.createConnection = deny('net.createConnection')
net.Socket.prototype.connect = deny('net.Socket.connect')
dns.lookup = deny('dns.lookup')
http.request = deny('http.request')
http.get = deny('http.get')
https.request = deny('https.request')
https.get = deny('https.get')
globalThis.fetch = deny('fetch')
syncBuiltinESMExports()
`
const NETWORK_GUARD_IMPORT = `--import=data:text/javascript,${encodeURIComponent(NETWORK_GUARD)}`

let tempDirs = []
let children = []

afterEach(() => {
  for (const child of children) if (child.exitCode === null) child.kill()
  children = []
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'stub-cli-os-'))
  tempDirs.push(dir)
  return dir
}

/** The runner's environment without any provider directory or stub script variable. */
function baseEnv(extra = {}) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase()
    if (STUB_ENV.includes(upper) || upper.startsWith('DWARFAI_STUB_')) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

/** The runner's environment with `PATH` replaced by `dirs` (whatever its spelling on Windows). */
function envWithPath(dirs) {
  const env = baseEnv()
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
  env.PATH = dirs.join(path.delimiter)
  return env
}

const stubProgram = (name) => path.join(BIN, name, `${name}.mjs`)
const readScript = (name) =>
  JSON.parse(readFileSync(path.join(KIT, 'scripts', `${name}.json`), 'utf8'))
/** The records of a JSONL file the stub wrote; the file must exist. */
function readJsonl(file) {
  expect(existsSync(file), `${file} was written`).toBe(true)
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

/** Why a finished child failed, for an assertion message: its own timeout or its stderr. */
const why = (run) => run.error?.message ?? run.stderr

/** Runs a stub's Node program to its end. */
function runProgram(name, args, env, nodeArgs = []) {
  return spawnSync(process.execPath, [...nodeArgs, stubProgram(name), ...args], {
    env,
    cwd: tempDir(),
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS
  })
}

/** Starts a stub file with `shell: false`, the way the Host's launcher can. */
function runResolved(file, args, env) {
  if (IS_WINDOWS) {
    // Node refuses a .cmd without a shell (EINVAL, SP-04); %ComSpec% /d /s /c runs it. With /s,
    // cmd drops the outer quotes of the command line, so the quoted file keeps its own.
    const commandLine = [file, ...args].map((part) => `"${part}"`).join(' ')
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
      env,
      encoding: 'utf8',
      windowsVerbatimArguments: true,
      timeout: CHILD_TIMEOUT_MS
    })
  }
  return spawnSync(file, args, { env, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS })
}

/** Whether `check()` becomes true within `ms`, polling every 50 ms. */
async function eventually(check, ms) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return true
}

function stubProcessCases() {
  it(
    '[ADR-008] each stub program started by node replays its default script into the directory its variable names and exits 0',
    () => {
      for (const [name, { homeEnv, defaultScript }] of Object.entries(STUBS)) {
        const home = tempDir()
        const run = runProgram(name, [], baseEnv({ [homeEnv]: home }))

        expect(run.status, `${name}: ${why(run)}`).toBe(0)
        for (const { file, records } of readScript(defaultScript).replay) {
          const target = path.join(home, ...file.split('/'))
          if (file.endsWith('.db')) expect(existsSync(target), `${name} wrote ${file}`).toBe(true)
          else expect(readJsonl(target), `${name} wrote ${file}`).toEqual(records)
        }
      }
    },
    Object.keys(STUBS).length * CHILD_TIMEOUT_MS
  )

  it(
    '[ADR-008] the claude stub run under a network guard answers --version and makes no network call',
    () => {
      const run = runProgram('claude', ['--version'], baseEnv(), [NETWORK_GUARD_IMPORT])

      expect(run.stderr).not.toContain('NETWORK-CALL')
      expect(run.status, why(run)).toBe(0)
      expect(run.stdout).toBe(`${readScript(STUBS.claude.defaultScript).version}\n`)
    },
    CHILD_TIMEOUT_MS
  )

  it('[CH-05] a stub process scripted to ignore stdin is still running after stdin closes, until it is killed', async () => {
    const home = tempDir()
    const ready = path.join(home, 'ready.jsonl')
    const script = path.join(tempDir(), 'script.json')
    writeFileSync(
      script,
      JSON.stringify({
        version: '0.0.0-test',
        replay: [{ file: 'ready.jsonl', records: [{ ready: true }] }],
        exitCode: 0,
        ignoreStdin: true
      })
    )
    const child = spawn(process.execPath, [stubProgram('claude')], {
      env: baseEnv({ CLAUDE_CONFIG_DIR: home, DWARFAI_STUB_CLAUDE_SCRIPT: script }),
      cwd: tempDir(),
      stdio: ['pipe', 'ignore', 'ignore']
    })
    children.push(child)
    const exited = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal }))
    )

    const replayed = await eventually(
      () => existsSync(ready) && readFileSync(ready, 'utf8') !== '',
      15_000
    )
    expect(replayed, 'the stub replayed its records').toBe(true)
    child.stdin.write('{"type":"user","message":"are you there?"}\n')
    child.stdin.end()
    await new Promise((resolve) => setTimeout(resolve, 1_000))

    expect(child.exitCode, 'the stub is still running').toBeNull()
    expect(child.signalCode).toBeNull()
    child.kill()
    expect(await exited).toEqual({ code: null, signal: 'SIGTERM' })
  }, 30_000)

  // On Windows each stub starts twice: through its shim and through cmd.exe's bare-name lookup.
  it(
    '[ADR-008] every stub starts through its .cmd shim on Windows and its executable wrapper on POSIX and answers --version',
    () => {
      const env = envWithPath([
        ...Object.keys(STUBS).map((name) => path.join(BIN, name)),
        path.dirname(process.execPath)
      ])

      for (const name of Object.keys(STUBS)) {
        const file = path.join(BIN, name, IS_WINDOWS ? `${name}.cmd` : name)
        const version = `${readScript(STUBS[name].defaultScript).version}\n`

        const run = runResolved(file, ['--version'], env)
        expect(run.status, `${name}: ${why(run)}`).toBe(0)
        expect(run.stdout).toBe(version)

        if (IS_WINDOWS) {
          // cmd.exe's own lookup of the bare name reaches the same shim.
          const bare = spawnSync(
            process.env.ComSpec ?? 'cmd.exe',
            ['/d', '/s', '/c', `"${name} --version"`],
            {
              env,
              cwd: tempDir(),
              encoding: 'utf8',
              windowsVerbatimArguments: true,
              timeout: CHILD_TIMEOUT_MS
            }
          )
          expect(bare.status, `${name}: ${why(bare)}`).toBe(0)
          expect(bare.stdout).toBe(version)
        }
      }
    },
    Object.keys(STUBS).length * (IS_WINDOWS ? 2 : 1) * CHILD_TIMEOUT_MS
  )
}

describe.runIf(process.platform === 'win32')('stub CLI processes on Windows', stubProcessCases)
describe.runIf(process.platform === 'darwin')('stub CLI processes on macOS', stubProcessCases)
describe.runIf(process.platform === 'linux')('stub CLI processes on Linux', stubProcessCases)
