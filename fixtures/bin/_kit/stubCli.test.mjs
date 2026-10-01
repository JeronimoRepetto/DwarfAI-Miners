// layer: L7
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The stub-CLI kit (`Stub<Provider>Cli`, testing strategy `17` §1.9, §1.10, §2.2).
 *
 * The subject is a set of executables, so each case runs them as child processes in a per-test
 * `mkdtemp` directory: the Node program directly, and, for resolution, through the platform's own
 * `PATH` lookup and the form a `shell: false` spawn can start (the `.cmd` shim through
 * `%ComSpec% /d /s /c` on Windows, SP-04; the executable wrapper on POSIX).
 */

const KIT = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.dirname(KIT)
const REPO = path.resolve(BIN, '..', '..')
const IS_WINDOWS = process.platform === 'win32'

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
  const dir = mkdtempSync(path.join(tmpdir(), 'stub-cli-'))
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

/** Runs a stub's Node program to its end. */
function runStub(name, args, env, nodeArgs = []) {
  return spawnSync(process.execPath, [...nodeArgs, stubProgram(name), ...args], {
    env,
    cwd: tempDir(),
    encoding: 'utf8',
    timeout: 30_000
  })
}

/** Writes `script` into a temp file and returns its path. */
function writeScript(script) {
  const file = path.join(tempDir(), 'script.json')
  writeFileSync(file, JSON.stringify(script))
  return file
}

/**
 * The first match of the platform's executable lookup for `name`, or `null`. Windows: each `PATH`
 * directory in order, each `PATHEXT` extension in order, as cmd.exe resolves a bare command (and as
 * SP-04 measured); `where.exe` is a file finder that also lists the extensionless POSIX wrapper,
 * which Windows cannot start. POSIX: the shell's own `command -v`.
 */
function platformLookup(name, env) {
  if (IS_WINDOWS) {
    const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
    const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
      for (const extension of extensions) {
        const candidate = path.join(dir, name + extension.toLowerCase())
        if (existsSync(candidate)) return candidate
      }
    }
    return null
  }
  const run = spawnSync('/bin/sh', ['-c', 'command -v -- "$1"', 'sh', name], {
    env,
    cwd: tempDir(),
    encoding: 'utf8'
  })
  if (run.status !== 0) return null
  return run.stdout.split('\n')[0].trim() || null
}

/** Starts a resolved stub file with `shell: false`, the way the Host's launcher can. */
function runResolved(file, args, env) {
  if (IS_WINDOWS) {
    // Node refuses a .cmd without a shell (EINVAL, SP-04); %ComSpec% /d /s /c runs it. With /s,
    // cmd drops the outer quotes of the command line, so the quoted file keeps its own.
    const commandLine = [file, ...args].map((part) => `"${part}"`).join(' ')
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
      env,
      encoding: 'utf8',
      windowsVerbatimArguments: true,
      timeout: 30_000
    })
  }
  return spawnSync(file, args, { env, encoding: 'utf8', timeout: 30_000 })
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

describe('stub CLI kit (17 §1.9)', () => {
  it('[ADR-008] the claude stub answers --version with its scripted version and runs no network call', () => {
    const run = runStub('claude', ['--version'], baseEnv(), [NETWORK_GUARD_IMPORT])

    expect(run.stderr).not.toContain('NETWORK-CALL')
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toBe(`${readScript(STUBS.claude.defaultScript).version}\n`)

    // No kit source can reach the network: no network module, no fetch, no socket.
    const sources = [
      path.join(KIT, 'stubCli.mjs'),
      ...Object.keys(STUBS).map((name) => stubProgram(name))
    ]
    for (const source of sources) {
      expect(readFileSync(source, 'utf8'), source).not.toMatch(
        /node:(?:net|http2?|https|dns|tls|dgram)\b|\bfetch\s*\(|WebSocket|undici/
      )
    }
  })

  it('[ADR-008] a replay script writes its transcript records into the directory CLAUDE_CONFIG_DIR names', () => {
    const home = tempDir()
    const run = runStub('claude', [], baseEnv({ CLAUDE_CONFIG_DIR: home }))

    expect(run.status, run.stderr).toBe(0)
    const script = readScript(STUBS.claude.defaultScript)
    for (const { file, records } of script.replay) {
      expect(readJsonl(path.join(home, ...file.split('/')))).toEqual(records)
    }
  })

  it('[ADR-008] a script named by DWARFAI_STUB_CLAUDE_SCRIPT replaces the default one', () => {
    const home = tempDir()
    // The permission-request script, made to exit after its replay instead of waiting.
    const script = readScript('claude-permission-request')
    const own = writeScript({ ...script, ignoreStdin: false })

    const run = runStub(
      'claude',
      [],
      baseEnv({ CLAUDE_CONFIG_DIR: home, DWARFAI_STUB_CLAUDE_SCRIPT: own })
    )

    expect(run.status, run.stderr).toBe(0)
    for (const { file, records } of script.replay) {
      expect(readJsonl(path.join(home, ...file.split('/')))).toEqual(records)
    }
    const defaultFile = readScript(STUBS.claude.defaultScript).replay[0].file
    expect(existsSync(path.join(home, ...defaultFile.split('/')))).toBe(false)
  })

  it('[ADR-008] the codex and opencode stubs replay their default sessions into CODEX_HOME and the OpenCode data dir', () => {
    const codexHome = tempDir()
    const codex = runStub('codex', [], baseEnv({ CODEX_HOME: codexHome }))
    expect(codex.status, codex.stderr).toBe(0)
    for (const { file, records } of readScript(STUBS.codex.defaultScript).replay) {
      expect(readJsonl(path.join(codexHome, ...file.split('/')))).toEqual(records)
    }

    const dataHome = tempDir()
    const opencode = runStub('opencode', [], baseEnv({ XDG_DATA_HOME: dataHome }))
    expect(opencode.status, opencode.stderr).toBe(0)
    const dbFile = path.join(dataHome, 'opencode', 'opencode.db')
    expect(existsSync(dbFile), 'opencode.db was written').toBe(true)
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
      expect(db.prepare('SELECT id, directory FROM session').all()).toEqual([
        { id: 'ses_sample0001', directory: '/work/sample-project' }
      ])
      expect([count('message'), count('part'), count('event')]).toEqual([2, 2, 4])
    } finally {
      db.close()
    }
  })

  it('[ADR-008] a stub whose provider directory variable is unset writes nothing and fails', () => {
    const home = tempDir()
    const run = runStub('claude', [], baseEnv({ HOME: home, USERPROFILE: home }))

    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('CLAUDE_CONFIG_DIR')
    expect(readdirSync(home)).toEqual([])
  })

  it('[ADR-008] a replay file outside the provider directory is refused before anything is written', () => {
    const parent = tempDir()
    const home = path.join(parent, 'home')
    const script = writeScript({
      version: '0.0.0-test',
      replay: [
        { file: 'inside.jsonl', records: [{ step: 1 }] },
        { file: '../outside.jsonl', records: [{ step: 2 }] }
      ],
      exitCode: 0,
      ignoreStdin: false
    })

    const run = runStub(
      'claude',
      [],
      baseEnv({ CLAUDE_CONFIG_DIR: home, DWARFAI_STUB_CLAUDE_SCRIPT: script })
    )

    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('../outside.jsonl')
    expect(readdirSync(parent)).toEqual([])
  })

  it('[CH-04] a stub scripted to exit at a step exits with that code after the records before it', () => {
    const home = tempDir()
    const script = writeScript({
      version: '0.0.0-test',
      replay: [
        { file: 'steps.jsonl', records: [{ step: 1 }, { step: 2 }] },
        { exit: 7 },
        { file: 'steps.jsonl', records: [{ step: 3 }] }
      ],
      exitCode: 0,
      ignoreStdin: false
    })

    const run = runStub(
      'claude',
      [],
      baseEnv({ CLAUDE_CONFIG_DIR: home, DWARFAI_STUB_CLAUDE_SCRIPT: script })
    )

    expect(run.status, run.stderr).toBe(7)
    expect(readJsonl(path.join(home, 'steps.jsonl'))).toEqual([{ step: 1 }, { step: 2 }])
  })

  it('[CH-05] a stub scripted to ignore stdin keeps running until killed', async () => {
    const home = tempDir()
    const ready = path.join(home, 'ready.jsonl')
    const script = writeScript({
      version: '0.0.0-test',
      replay: [{ file: 'ready.jsonl', records: [{ ready: true }] }],
      exitCode: 0,
      ignoreStdin: true
    })
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

  it('[ADR-008] every stub on Windows resolves through its .cmd shim and on POSIX through its executable wrapper', () => {
    const env = envWithPath([
      ...Object.keys(STUBS).map((name) => path.join(BIN, name)),
      path.dirname(process.execPath)
    ])

    for (const name of Object.keys(STUBS)) {
      const expected = path.join(realpathSync(BIN), name, IS_WINDOWS ? `${name}.cmd` : name)
      const resolved = platformLookup(name, env)

      expect(resolved, `${name} resolves on PATH`).not.toBeNull()
      expect(realpathSync(resolved)).toBe(expected)

      const version = `${readScript(STUBS[name].defaultScript).version}\n`
      const run = runResolved(resolved, ['--version'], env)
      expect(run.status, run.stderr).toBe(0)
      expect(run.stdout).toBe(version)

      if (IS_WINDOWS) {
        // cmd.exe's own lookup of the bare name reaches the same shim.
        const bare = spawnSync(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/s', '/c', `"${name} --version"`],
          { env, cwd: tempDir(), encoding: 'utf8', windowsVerbatimArguments: true, timeout: 30_000 }
        )
        expect(bare.status, bare.stderr).toBe(0)
        expect(bare.stdout).toBe(version)
      }
    }
  })

  it('[ADR-008] every POSIX wrapper starts node with shell built-ins only, never an external utility', () => {
    // A launcher may start the wrapper with a PATH that holds only the stub folder and node's
    // folder, so the wrapper may run nothing but `exec node`: no command substitution, and every
    // other line is a comment, a variable assignment or part of a `case`.
    const allowed = [
      /^[A-Za-z_][A-Za-z0-9_]*=\S*$/, // an assignment
      /^case\s.*\sin$/,
      /^\S+\)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s*)?;;$/, // a case branch that at most assigns
      /^esac$/,
      /^exec node\s/
    ]
    for (const name of Object.keys(STUBS)) {
      const wrapper = path.join(BIN, name, name)
      const lines = readFileSync(wrapper, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))

      expect(lines.at(-1), `${wrapper} ends by starting node`).toMatch(/^exec node\s/)
      for (const line of lines) {
        expect(line, `${wrapper}: no command substitution`).not.toMatch(/\$\(|`/)
        expect(
          allowed.some((pattern) => pattern.test(line)),
          `${wrapper}: "${line}" runs a command other than node`
        ).toBe(true)
      }
    }
  })

  it('[ADR-008] the kit holds no credential, home path or e-mail address, and nothing under fixtures/bin is packaged', () => {
    const files = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else files.push(full)
      }
    }
    walk(BIN)
    const scanned = files.filter((file) => !file.endsWith('.test.mjs'))
    const forbidden = [
      /[A-Za-z]:\\+Users\\+/, // a Windows home
      /\/(?:Users|home)\/[^/\s"']+/, // a macOS or Linux home
      /\bsk-[A-Za-z0-9_-]{8,}/, // an API key shape (ADR-026)
      /\bBearer\s+[A-Za-z0-9._-]{8,}/i,
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ // an e-mail address
    ]
    for (const file of scanned) {
      const text = readFileSync(file, 'utf8')
      for (const pattern of forbidden) expect(text, `${file} ${pattern}`).not.toMatch(pattern)
    }

    // The packaged app holds only what electron-builder's `files` and extra resources name.
    const { build } = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'))
    const patterns = [
      ...(build.files ?? []),
      ...[...(build.extraResources ?? []), ...(build.extraFiles ?? [])].map((entry) =>
        typeof entry === 'string' ? entry : entry.from
      )
    ].filter((pattern) => typeof pattern === 'string' && !pattern.startsWith('!'))
    const kitFiles = files.map((file) => path.relative(REPO, file).split(path.sep).join('/'))
    for (const pattern of patterns) {
      for (const file of kitFiles) {
        expect(path.matchesGlob(file, pattern), `${pattern} packages ${file}`).toBe(false)
      }
    }
  })
})
