/**
 * The shared engine of the stub-CLI kit (`Stub<Provider>Cli`, testing strategy `17` §1.9, §1.10).
 *
 * Each stub in `fixtures/bin/<name>/` is a thin wrapper that calls `runStubCli` with its name, the
 * environment variable naming its provider directory and its default script. The engine holds no
 * provider code and makes no network call (ADR-008): it only answers `--version`, writes the
 * scripted records into files under the provider directory, and exits as scripted.
 *
 * A script (`_kit/scripts/<name>.json`, or the file `DWARFAI_STUB_<NAME>_SCRIPT` names):
 *
 * ```json
 * { "version": "…", "help": "…", "replay": [{ "file": "…", "records": […] } | { "stdout": "…" } | { "exit": 7 }], "exitCode": 0, "ignoreStdin": false }
 * ```
 *
 * - `version`: printed verbatim, with a newline, for `--version`; nothing else happens then.
 * - `help`: a protocol fixture under `fixtures/` (a posix path relative to it), printed byte for
 *   byte for `--help`; nothing else happens then. A script without it runs its replay as before.
 * - `replay`: the steps, in order. A `{ file, records }` step writes its records into `file`, a
 *   relative posix path under the provider directory, by extension: `.jsonl` appends one JSON line
 *   per record; `.json` writes its single record; `.db` runs each record, an SQL statement, on that
 *   SQLite file in one transaction, so a failing statement leaves none of the step's rows
 *   (provider stores are SQL text, `17` §1.4). A `{ stdout }` step writes a protocol fixture under
 *   `fixtures/` to stdout byte for byte (ISSUE-150's stream-json replay). An `{ exit }` step stops
 *   the stub there with that code (CH-04).
 * - `exitCode`: the code once every step ran.
 * - `ignoreStdin`: after the replay the stub reads nothing and stays alive until it is killed
 *   (CH-05), instead of exiting.
 *
 * Fail closed: a script that does not parse, a provider directory variable that is unset, or a
 * replay file outside the provider directory ends the stub with `USAGE_EXIT` before any write, so a
 * stub never writes into the person's real provider data.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The exit code of a stub that refuses its script or its environment. */
export const USAGE_EXIT = 64

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts')
/** The repository's `fixtures/` folder: the only place a `help` or `stdout` fixture is read from. */
const FIXTURES_DIR = path.resolve(SCRIPTS_DIR, '..', '..', '..')
const PROTOCOL_FIXTURE = /\.(?:jsonl|json)$/

/** The environment variable that names a script replacing `name`'s default one. */
export function scriptEnvVar(name) {
  return `DWARFAI_STUB_${name.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}_SCRIPT`
}

class ScriptError extends Error {}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The script in `text`, checked. Throws a `ScriptError` naming the first problem.
 *
 * @returns {{ version: string, help?: string, replay: Array<{ file: string, records: unknown[] } | { stdout: string } | { exit: number }>, exitCode: number, ignoreStdin: boolean }}
 */
export function parseScript(text) {
  let script
  try {
    script = JSON.parse(text)
  } catch (error) {
    throw new ScriptError(`the script is not valid JSON (${error.message})`)
  }
  if (!isObject(script)) throw new ScriptError('the script is not a JSON object')
  const { version, help, replay = [], exitCode = 0, ignoreStdin = false } = script
  if (typeof version !== 'string' || version === '') {
    throw new ScriptError('the script has no "version" string')
  }
  if (help !== undefined && (typeof help !== 'string' || !PROTOCOL_FIXTURE.test(help))) {
    throw new ScriptError('"help" is not a .jsonl or .json fixture path')
  }
  if (!Array.isArray(replay)) throw new ScriptError('"replay" is not an array')
  if (!Number.isInteger(exitCode)) throw new ScriptError('"exitCode" is not an integer')
  if (typeof ignoreStdin !== 'boolean') throw new ScriptError('"ignoreStdin" is not a boolean')
  replay.forEach((step, index) => {
    const where = `replay step ${index}`
    if (isObject(step) && 'exit' in step) {
      if (!Number.isInteger(step.exit)) throw new ScriptError(`${where}: "exit" is not an integer`)
      return
    }
    if (isObject(step) && 'stdout' in step) {
      if (typeof step.stdout !== 'string' || !PROTOCOL_FIXTURE.test(step.stdout)) {
        throw new ScriptError(`${where}: "stdout" is not a .jsonl or .json fixture path`)
      }
      return
    }
    if (!isObject(step) || typeof step.file !== 'string' || !Array.isArray(step.records)) {
      throw new ScriptError(`${where} is neither { file, records }, { stdout } nor { exit }`)
    }
    if (!/\.(?:jsonl|json|db)$/.test(step.file)) {
      throw new ScriptError(`${where}: ${step.file} is not a .jsonl, .json or .db file`)
    }
    if (step.file.endsWith('.json') && step.records.length !== 1) {
      throw new ScriptError(`${where}: a .json file takes exactly one record`)
    }
    if (step.file.endsWith('.db') && !step.records.every((record) => typeof record === 'string')) {
      throw new ScriptError(`${where}: every record of a .db file is an SQL statement`)
    }
  })
  return { version, ...(help === undefined ? {} : { help }), replay, exitCode, ignoreStdin }
}

/** The bytes of a protocol fixture under `fixtures/`, as text; throws when the path leaves it. */
function fixtureText(file) {
  const segments = file.split('/')
  const target = path.resolve(FIXTURES_DIR, ...segments)
  const relative = path.relative(FIXTURES_DIR, target)
  if (
    path.posix.isAbsolute(file) ||
    path.win32.isAbsolute(file) ||
    segments.includes('..') ||
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new ScriptError(`the fixture ${file} is outside fixtures/`)
  }
  return readFileSync(target, 'utf8')
}

/** The absolute path of `file` under `home`; throws when it would leave `home`. */
function targetOf(home, file) {
  const segments = file.split('/')
  const target = path.resolve(home, ...segments)
  const relative = path.relative(home, target)
  if (
    path.posix.isAbsolute(file) ||
    path.win32.isAbsolute(file) ||
    segments.includes('..') ||
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new ScriptError(`the replay file ${file} is outside the provider directory`)
  }
  return target
}

function writeStep(target, file, records) {
  mkdirSync(path.dirname(target), { recursive: true })
  if (file.endsWith('.jsonl')) {
    appendFileSync(target, records.map((record) => `${JSON.stringify(record)}\n`).join(''))
  } else if (file.endsWith('.json')) {
    writeFileSync(target, `${JSON.stringify(records[0], null, 2)}\n`)
  } else {
    // Loaded only here: node:sqlite prints an experimental warning, which --version must not.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const db = new DatabaseSync(target)
    try {
      // One transaction for the step, as a provider writes a turn: one commit and its two disk
      // flushes, not a commit per statement. On a stalling Windows runner disk the 15 autocommits
      // of the OpenCode default script ran its stub past the OS lane's 10 s child bound (run
      // 37284110939), while the stubs that only append took under a second together.
      db.exec('BEGIN')
      for (const statement of records) db.exec(statement)
      db.exec('COMMIT')
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    } finally {
      db.close()
    }
  }
}

/**
 * One run of a stub, without touching the process it runs in: reads the script, answers
 * `--version` or writes the replay under the provider directory, and returns what the program
 * prints, its exit code and whether it stays alive afterwards (`ignoreStdin`, CH-05). Tests run
 * the engine in process through it; `runStubCli` applies it to the real process.
 *
 * @returns {{ exitCode: number, stdout: string, stderr: string, stayAlive: boolean }}
 */
export function playStub({ name, homeEnv, defaultScript, argv, env }) {
  const done = (exitCode, output = {}) => ({
    exitCode,
    stdout: output.stdout ?? '',
    stderr: output.stderr ?? '',
    stayAlive: output.stayAlive ?? false
  })
  const fail = (message) => done(USAGE_EXIT, { stderr: `${name} stub: ${message}\n` })

  let script
  const scriptFile = env[scriptEnvVar(name)] || path.join(SCRIPTS_DIR, `${defaultScript}.json`)
  try {
    script = parseScript(readFileSync(scriptFile, 'utf8'))
  } catch (error) {
    return fail(`cannot use the script ${path.basename(scriptFile)}: ${error.message}`)
  }

  if (argv[0] === '--version') return done(0, { stdout: `${script.version}\n` })
  if (script.help !== undefined && argv.includes('--help')) {
    try {
      return done(0, { stdout: fixtureText(script.help) })
    } catch (error) {
      return fail(error.message)
    }
  }

  // Resolve every target (and read every stdout fixture) before the first write, so a refused
  // script writes and prints nothing.
  const writes = script.replay.some((step) => 'file' in step)
  const home = env[homeEnv]
  if (writes && !home) {
    return fail(`${homeEnv} is not set; a stub never writes into the real provider directory`)
  }
  let steps
  try {
    steps = script.replay.map((step) => {
      if ('exit' in step) return step
      if ('stdout' in step) return { text: fixtureText(step.stdout) }
      return { ...step, target: targetOf(path.resolve(home), step.file) }
    })
  } catch (error) {
    return fail(error.message)
  }

  let stdout = ''
  for (const step of steps) {
    if ('exit' in step) return done(step.exit, { stdout })
    if ('text' in step) {
      stdout += step.text
      continue
    }
    writeStep(step.target, step.file, step.records)
  }
  return done(script.exitCode, { stdout, stayAlive: script.ignoreStdin })
}

/**
 * Runs one stub: `name` (the real binary's name), `homeEnv` (the variable naming its provider
 * directory) and `defaultScript` (a script name in `_kit/scripts/`). Sets `process.exitCode`, or
 * keeps the process alive when the script ignores stdin.
 */
export function runStubCli({
  name,
  homeEnv,
  defaultScript,
  argv = process.argv.slice(2),
  env = process.env
}) {
  const run = playStub({ name, homeEnv, defaultScript, argv, env })
  if (run.stdout !== '') process.stdout.write(run.stdout)
  if (run.stderr !== '') process.stderr.write(run.stderr)
  if (run.stayAlive) {
    // A hung provider (CH-05): nothing reads stdin and the timer keeps the process alive.
    setInterval(() => {}, 2 ** 30)
    return
  }
  process.exitCode = run.exitCode
}
