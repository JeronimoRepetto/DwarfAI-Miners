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
 * { "version": "…", "replay": [{ "file": "…", "records": […] } | { "exit": 7 }], "exitCode": 0, "ignoreStdin": false }
 * ```
 *
 * - `version`: printed verbatim, with a newline, for `--version`; nothing else happens then.
 * - `replay`: the steps, in order. A `{ file, records }` step writes its records into `file`, a
 *   relative posix path under the provider directory, by extension: `.jsonl` appends one JSON line
 *   per record; `.json` writes its single record; `.db` runs each record, an SQL statement, on that
 *   SQLite file (provider stores are SQL text, `17` §1.4). An `{ exit }` step stops the stub there
 *   with that code (CH-04).
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

/** The environment variable that names a script replacing `name`'s default one. */
export function scriptEnvVar(name) {
  return `DWARFAI_STUB_${name.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}_SCRIPT`
}

class ScriptError extends Error {}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * The script in `text`, checked. Throws a `ScriptError` naming the first problem.
 *
 * @returns {{ version: string, replay: Array<{ file: string, records: unknown[] } | { exit: number }>, exitCode: number, ignoreStdin: boolean }}
 */
export function parseScript(text) {
  let script
  try {
    script = JSON.parse(text)
  } catch (error) {
    throw new ScriptError(`the script is not valid JSON (${error.message})`)
  }
  if (!isObject(script)) throw new ScriptError('the script is not a JSON object')
  const { version, replay = [], exitCode = 0, ignoreStdin = false } = script
  if (typeof version !== 'string' || version === '') {
    throw new ScriptError('the script has no "version" string')
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
    if (!isObject(step) || typeof step.file !== 'string' || !Array.isArray(step.records)) {
      throw new ScriptError(`${where} is neither { file, records } nor { exit }`)
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
  return { version, replay, exitCode, ignoreStdin }
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
      for (const statement of records) db.exec(statement)
    } finally {
      db.close()
    }
  }
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
  const fail = (message) => {
    process.stderr.write(`${name} stub: ${message}\n`)
    process.exitCode = USAGE_EXIT
  }

  let script
  const scriptFile = env[scriptEnvVar(name)] || path.join(SCRIPTS_DIR, `${defaultScript}.json`)
  try {
    script = parseScript(readFileSync(scriptFile, 'utf8'))
  } catch (error) {
    return fail(`cannot use the script ${path.basename(scriptFile)}: ${error.message}`)
  }

  if (argv[0] === '--version') {
    process.stdout.write(`${script.version}\n`)
    process.exitCode = 0
    return
  }

  // Resolve every target before the first write, so a refused script writes nothing.
  const writes = script.replay.some((step) => 'file' in step)
  const home = env[homeEnv]
  if (writes && !home) {
    return fail(`${homeEnv} is not set; a stub never writes into the real provider directory`)
  }
  let steps
  try {
    steps = script.replay.map((step) =>
      'exit' in step ? step : { ...step, target: targetOf(path.resolve(home), step.file) }
    )
  } catch (error) {
    return fail(error.message)
  }

  for (const step of steps) {
    if ('exit' in step) {
      process.exitCode = step.exit
      return
    }
    writeStep(step.target, step.file, step.records)
  }

  if (script.ignoreStdin) {
    // A hung provider (CH-05): nothing reads stdin and the timer keeps the process alive.
    setInterval(() => {}, 2 ** 30)
    return
  }
  process.exitCode = script.exitCode
}
