// layer: L7
import { spawnSync } from 'node:child_process'
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
import { playStub } from './stubCli.mjs'

/**
 * The stub-CLI kit (`Stub<Provider>Cli`, testing strategy `17` §1.9, §1.10, §2.2).
 *
 * The engine's behaviour (replay, script override, refusals, scripted exit, staying alive) runs in
 * this process through `playStub`, each case in its own `mkdtemp` directory, so no case waits
 * on a child process: starting `node` on a loaded CI runner took seconds and ran these cases past
 * Vitest's 5000 ms. What only a real process can show (each stub program's own wiring, the network
 * guard at run time, a hung stub staying alive, starting through the `.cmd` shim or the POSIX
 * wrapper) is the OS lane's, `stubCli.os.test.mjs` (`17` §1.8). Resolution on `PATH` and the
 * kit's static properties stay here.
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

let tempDirs = []

afterEach(() => {
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

/** Runs `name`'s engine in this process with its own settings, as its Node program would. */
function playAs(name, argv, env) {
  return playStub({ name, ...STUBS[name], argv, env })
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

describe('stub CLI kit (17 §1.9)', () => {
  it('[ADR-008] the claude stub answers --version with its scripted version and runs no network call', () => {
    const run = playAs('claude', ['--version'], baseEnv())

    // The network guard around a real run is the OS lane's (stubCli.os.test.mjs).
    expect(run.stderr).toBe('')
    expect(run.exitCode, run.stderr).toBe(0)
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
    const run = playAs('claude', [], baseEnv({ CLAUDE_CONFIG_DIR: home }))

    expect(run.exitCode, run.stderr).toBe(0)
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

    const run = playAs(
      'claude',
      [],
      baseEnv({ CLAUDE_CONFIG_DIR: home, DWARFAI_STUB_CLAUDE_SCRIPT: own })
    )

    expect(run.exitCode, run.stderr).toBe(0)
    for (const { file, records } of script.replay) {
      expect(readJsonl(path.join(home, ...file.split('/')))).toEqual(records)
    }
    const defaultFile = readScript(STUBS.claude.defaultScript).replay[0].file
    expect(existsSync(path.join(home, ...defaultFile.split('/')))).toBe(false)
  })

  it('[ADR-008] the codex and opencode stubs replay their default sessions into CODEX_HOME and the OpenCode data dir', () => {
    const codexHome = tempDir()
    const codex = playAs('codex', [], baseEnv({ CODEX_HOME: codexHome }))
    expect(codex.exitCode, codex.stderr).toBe(0)
    for (const { file, records } of readScript(STUBS.codex.defaultScript).replay) {
      expect(readJsonl(path.join(codexHome, ...file.split('/')))).toEqual(records)
    }

    const dataHome = tempDir()
    const opencode = playAs('opencode', [], baseEnv({ XDG_DATA_HOME: dataHome }))
    expect(opencode.exitCode, opencode.stderr).toBe(0)
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

  it('[ADR-008] a .db step is written as one transaction, so a statement that fails leaves none of its rows', () => {
    const dataHome = tempDir()
    const script = writeScript({
      version: '0.0.0-test',
      replay: [
        {
          file: 'opencode/opencode.db',
          records: [
            'CREATE TABLE session (id TEXT PRIMARY KEY)',
            "INSERT INTO session VALUES ('ses_one')",
            'INSERT INTO no_such_table VALUES (1)'
          ]
        }
      ],
      exitCode: 0,
      ignoreStdin: false
    })

    expect(() =>
      playAs(
        'opencode',
        [],
        baseEnv({ XDG_DATA_HOME: dataHome, DWARFAI_STUB_OPENCODE_SCRIPT: script })
      )
    ).toThrow(/no_such_table/)
    const db = new DatabaseSync(path.join(dataHome, 'opencode', 'opencode.db'), { readOnly: true })
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('[ADR-008] a stub whose provider directory variable is unset writes nothing and fails', () => {
    const home = tempDir()
    const run = playAs('claude', [], baseEnv({ HOME: home, USERPROFILE: home }))

    expect(run.exitCode).not.toBe(0)
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

    const run = playAs(
      'claude',
      [],
      baseEnv({ CLAUDE_CONFIG_DIR: home, DWARFAI_STUB_CLAUDE_SCRIPT: script })
    )

    expect(run.exitCode).not.toBe(0)
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

    const run = playAs(
      'claude',
      [],
      baseEnv({ CLAUDE_CONFIG_DIR: home, DWARFAI_STUB_CLAUDE_SCRIPT: script })
    )

    expect(run.exitCode, run.stderr).toBe(7)
    expect(readJsonl(path.join(home, 'steps.jsonl'))).toEqual([{ step: 1 }, { step: 2 }])
  })

  it('[CH-05] a stub scripted to ignore stdin keeps running until killed', () => {
    const home = tempDir()
    const script = writeScript({
      version: '0.0.0-test',
      replay: [{ file: 'ready.jsonl', records: [{ ready: true }] }],
      exitCode: 0,
      ignoreStdin: true
    })

    const run = playAs(
      'claude',
      [],
      baseEnv({ CLAUDE_CONFIG_DIR: home, DWARFAI_STUB_CLAUDE_SCRIPT: script })
    )

    // The engine replays, then tells its program to stay alive instead of exiting; that the real
    // process then runs until killed, whatever arrives on stdin, is the OS lane's.
    expect(readJsonl(path.join(home, 'ready.jsonl'))).toEqual([{ ready: true }])
    expect(run.stayAlive, 'the stub stays alive after its replay').toBe(true)
  })

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
      // Starting the resolved file, and cmd.exe's own lookup of the bare name, are the OS lane's.
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
