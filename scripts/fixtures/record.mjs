#!/usr/bin/env node
/**
 * Records one provider session for a fixture (17 §1.4 recording steps 2–3), on the maintainer's
 * machine only, in the real-CLI lane (17 §5.5).
 *
 * Usage:
 *   RUN_INTEGRATION=1 DWARFAI_REAL_CLI=<provider list> \
 *     node scripts/fixtures/record.mjs --provider <p> --driver <d> --case <case>
 *
 * 1. Refuses unless the lane is on: `CI` unset, `RUN_INTEGRATION=1`, the provider in
 *    `DWARFAI_REAL_CLI` (comma-separated). CI can never record: no login exists there (ADR-008).
 * 2. Reads the scripted scenario `scripts/fixtures/scenarios/<case>.json`: the prompts come from
 *    it, never from free text, so no personal content can enter a fixture.
 * 3. Creates a throwaway Git repository `<tmp>/dwarfai-rec-<n>/` holding the scenario's files.
 * 4. Asks the driver's recording adapter for the installed provider version and capabilities, and
 *    runs the scenario through it with a tee transport: every byte the CLI writes goes to
 *    `<case>.raw.jsonl`, every byte DwarfAI sends to `<case>.raw.sent.jsonl`, any other stream to
 *    `<case>.raw.<stream>.jsonl`, and the instant of each chunk and mark (spawn, exit) to
 *    `<case>.raw.timing.jsonl`; `<case>.raw.meta.json` holds what the scrubber needs. All of them sit
 *    in `fixtures/<provider>/<driver>/<providerVersion>/`, git-ignored (`fixtures/**\/*.raw.*`).
 * 5. Deletes the throwaway repository; on a failure, deletes the partial raw capture too.
 *
 * Then `node scripts/fixtures/scrub.mjs <folder>/<case>.raw.*` writes the committable fixture set.
 *
 * A recording adapter is `{ detect(), run({ repoDir, scenario, tee, env }) }`, registered in
 * `RECORDING_ADAPTERS` under `<provider>/<driver>` by the driver issue that records with it
 * (ISSUE-150…ISSUE-158); until then no provider can be recorded. The harness reads no provider
 * config, credential file or keychain entry (ADR-008 item 2): an adapter that needs a config
 * directory points the CLI at a temporary one inside the throwaway repository, where the provider
 * supports it (17 §5.5).
 *
 * Exit codes: 0 recorded, 1 the recording failed, 2 refused or a usage error.
 */
import { execFileSync } from 'node:child_process'
import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** `<provider>/<driver>` → recording adapter. Each driver issue adds its own entry. */
export const RECORDING_ADAPTERS = Object.freeze({})

const here = path.dirname(fileURLToPath(import.meta.url))
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const RESERVED_STREAMS = new Set(['meta', 'sent', 'timing'])
const SCENARIO_FIELDS = new Set(['case', 'description', 'repoFiles', 'turns'])

/**
 * Why the lane refuses to record, or null when it may (17 §5.5). `CI` counts as set whatever its
 * value, `false` included: fail closed.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} provider
 * @returns {string | null}
 */
export function laneRefusal(env, provider) {
  if (env.CI !== undefined && env.CI !== '') {
    return 'refused: CI is set; fixtures are recorded only on the maintainer machine (17 §5.5)'
  }
  if (env.RUN_INTEGRATION !== '1') {
    return 'refused: the real-CLI lane is opt-in; set RUN_INTEGRATION=1 (17 §5.5)'
  }
  const listed = (env.DWARFAI_REAL_CLI ?? '').split(',').map((name) => name.trim())
  if (!listed.includes(provider)) {
    return `refused: ${provider} is not in DWARFAI_REAL_CLI (comma-separated providers to run)`
  }
  return null
}

const isRepoRelative = (file) =>
  file !== '' &&
  !path.isAbsolute(file) &&
  !/^[A-Za-z]:/.test(file) &&
  !file.split(/[\\/]/).some((segment) => segment === '..')

/**
 * A scripted scenario, validated: `{ case, description, repoFiles, turns }`, nothing else.
 *
 * @param {string} caseName
 * @param {string} text the scenario file
 * @returns {{ case: string, description: string, repoFiles: Record<string, string>, turns: { text: string }[] }}
 */
export function parseScenario(caseName, text) {
  const scenario = JSON.parse(text)
  const fail = (message) => {
    throw new Error(`scenario ${caseName}: ${message}`)
  }
  if (scenario === null || typeof scenario !== 'object' || Array.isArray(scenario)) {
    fail('not a JSON object')
  }
  for (const key of Object.keys(scenario)) {
    if (!SCENARIO_FIELDS.has(key)) fail(`unknown field "${key}"`)
  }
  if (scenario.case !== caseName) fail(`"case" must be "${caseName}"`)
  if (typeof scenario.description !== 'string' || scenario.description.trim() === '') {
    fail('"description" must be a non-empty string')
  }
  const files = scenario.repoFiles ?? {}
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    fail('"repoFiles" must be an object of relative path to content')
  }
  for (const [file, content] of Object.entries(files)) {
    if (!isRepoRelative(file) || typeof content !== 'string') {
      fail(`"repoFiles" entry "${file}" must be a relative path inside the repository with text`)
    }
  }
  const { turns } = scenario
  const validTurn = (turn) =>
    turn !== null &&
    typeof turn === 'object' &&
    Object.keys(turn).length === 1 &&
    typeof turn.text === 'string' &&
    turn.text.trim() !== ''
  if (!Array.isArray(turns) || turns.length === 0 || !turns.every(validTurn)) {
    fail('"turns" must be a non-empty list of { "text": "<scripted prompt>" }')
  }
  return scenario
}

/** Creates `<tmp>/dwarfai-rec-<n>/` with the first free n, claimed atomically. */
function createThrowawayDir(fs, tmp) {
  for (let n = 1; ; n++) {
    const dir = path.join(tmp, `dwarfai-rec-${n}`)
    try {
      fs.mkdirSync(dir)
      return dir
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
}

/**
 * Makes `dir` a Git repository with one commit of the scenario's files. The commit identity is a
 * fixed placeholder and signing is off, so no person's Git identity enters what a provider reads.
 *
 * Automatic maintenance and garbage collection are off for every command: otherwise `git commit`
 * leaves a detached `git maintenance run --auto` behind that still writes under `.git/objects`
 * when the recorder deletes the repository, and the recursive delete can then fail or, on Linux,
 * return without error and leave the repository in place.
 *
 * @param {string} dir
 * @param {NodeJS.ProcessEnv} [env] the environment the git commands run with
 */
export function initThrowawayRepo(dir, env = process.env) {
  const git = (args) =>
    execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
      cwd: dir,
      env,
      shell: false,
      stdio: 'ignore'
    })
  git(['init', '-q'])
  git(['add', '-A'])
  git([
    '-c',
    'user.name=DwarfAI recorder',
    '-c',
    'user.email=recorder@invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'Throwaway repository for a fixture recording'
  ])
}

/**
 * The tee transport: appends every chunk, as the bytes flowed, to its stream's raw file, and its
 * instant to the timing file. An adapter writes what the CLI wrote to `received`, what DwarfAI
 * sent to `sent`, anything else to `stream(<name>)`, and marks process events with `mark`.
 */
export function createTeeTransport({ fs, folder, caseName, now }) {
  const rawFile = (stream) =>
    path.join(
      folder,
      stream === undefined ? `${caseName}.raw.jsonl` : `${caseName}.raw.${stream}.jsonl`
    )
  const timing = rawFile('timing')
  const written = new Set()
  const append = (file, text) => {
    fs.appendFileSync(file, text)
    written.add(file)
  }
  const writer = (stream) => ({
    write(chunk) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      append(rawFile(stream), text)
      append(
        timing,
        `${JSON.stringify({ at: now(), stream: stream ?? 'received', bytes: Buffer.byteLength(text) })}\n`
      )
    }
  })
  return {
    received: writer(undefined),
    sent: writer('sent'),
    stream(name) {
      if (!SEGMENT.test(name) || RESERVED_STREAMS.has(name)) {
        throw new Error(`invalid stream name "${name}"`)
      }
      return writer(name)
    },
    mark(event, detail = {}) {
      append(timing, `${JSON.stringify({ at: now(), event, ...detail })}\n`)
    },
    /** Every raw file written so far. */
    files: () => [...written]
  }
}

/** How often, and how long apart, the recorder tries to delete the throwaway repository. */
const REMOVE_ATTEMPTS = 5
const REMOVE_BACKOFF_MS = 50

/**
 * Deletes the throwaway repository and checks that it is gone. A recursive `rmSync` can return
 * without error and leave the directory in place when an entry vanishes under it (ENOENT), or
 * throw when one appears (ENOTEMPTY, EPERM): a background process still writing there (a provider
 * CLI's child) causes both. So each attempt is checked, and retried after a growing pause.
 *
 * @returns {Promise<boolean>} whether the directory is gone
 */
async function removeThrowawayDir(fs, dir) {
  for (let attempt = 1; attempt <= REMOVE_ATTEMPTS; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Retried below, like a delete that returned with the directory still there.
    }
    if (!fs.existsSync(dir)) return true
    await new Promise((resolve) => setTimeout(resolve, REMOVE_BACKOFF_MS * attempt))
  }
  return false
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)

/**
 * Records one case. Returns the exit code.
 *
 * @param {object} request
 * @param {string} request.provider
 * @param {string} request.driver
 * @param {string} request.caseName
 * @param {Record<string, string | undefined>} [request.env]
 * @param {Record<string, { detect: Function, run: Function }>} [request.adapters]
 * @param {string} [request.fixturesRoot] the repository's `fixtures/`
 * @param {string} [request.scenariosDir]
 * @param {string} [request.tmp] where the throwaway repository is created
 * @param {typeof nodeFs} [request.fs]
 * @param {(dir: string) => void} [request.initRepo]
 * @param {() => number} [request.now]
 * @param {string} [request.platform]
 * @param {(line: string) => void} [request.log]
 * @returns {Promise<number>}
 */
export async function runRecord(request) {
  const {
    provider,
    driver,
    caseName,
    env = process.env,
    adapters = RECORDING_ADAPTERS,
    fixturesRoot = path.resolve(here, '..', '..', 'fixtures'),
    scenariosDir = path.join(here, 'scenarios'),
    tmp = tmpdir(),
    fs = nodeFs,
    initRepo = initThrowawayRepo,
    now = Date.now,
    platform = process.platform,
    log = (line) => process.stderr.write(`${line}\n`)
  } = request

  const refusal = laneRefusal(env, provider)
  if (refusal !== null) {
    log(`record: ${refusal}`)
    return 2
  }
  for (const [name, value] of [
    ['--provider', provider],
    ['--driver', driver],
    ['--case', caseName]
  ]) {
    if (typeof value !== 'string' || !SEGMENT.test(value)) {
      log(`record: ${name} must be one path segment of letters, digits, ".", "_" or "-"`)
      return 2
    }
  }
  const adapter = Object.hasOwn(adapters, `${provider}/${driver}`)
    ? adapters[`${provider}/${driver}`]
    : undefined
  if (adapter === undefined) {
    log(`record: no recording adapter for ${provider}/${driver} yet; its driver issue adds one`)
    return 2
  }
  let scenario
  try {
    scenario = parseScenario(
      caseName,
      fs.readFileSync(path.join(scenariosDir, `${caseName}.json`), 'utf8')
    )
  } catch (error) {
    log(`record: ${error.message}`)
    return 2
  }

  const { providerVersion, capabilities } = await adapter.detect({ env })
  if (typeof providerVersion !== 'string' || !SEGMENT.test(providerVersion)) {
    log('record: the adapter reported no usable provider version')
    return 1
  }
  const folder = path.join(fixturesRoot, provider, driver, providerVersion)
  fs.mkdirSync(folder, { recursive: true })
  const tee = createTeeTransport({ fs, folder, caseName, now })
  const repoDir = createThrowawayDir(fs, tmp)
  let exitCode
  try {
    for (const [file, content] of Object.entries(scenario.repoFiles ?? {})) {
      const target = path.join(repoDir, ...file.split(/[\\/]/))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content)
    }
    initRepo(repoDir)
    const metaFile = path.join(folder, `${caseName}.raw.meta.json`)
    fs.writeFileSync(
      metaFile,
      `${JSON.stringify(
        {
          provider,
          driver,
          providerVersion,
          os: platform,
          capturedAt: isoDay(now()),
          capabilities,
          repoRoot: repoDir
        },
        null,
        2
      )}\n`
    )
    await adapter.run({ repoDir, scenario, tee, env })
    log(`record: wrote the raw capture of ${caseName} to ${folder}`)
    log(`record: next, node scripts/fixtures/scrub.mjs ${path.join(folder, `${caseName}.raw.*`)}`)
    exitCode = 0
  } catch (error) {
    for (const file of [...tee.files(), path.join(folder, `${caseName}.raw.meta.json`)]) {
      fs.rmSync(file, { force: true })
    }
    log(`record: the recording failed and its raw capture was deleted: ${error.message}`)
    exitCode = 1
  }
  if (!(await removeThrowawayDir(fs, repoDir))) {
    log(`record: could not delete the throwaway repository ${repoDir}; delete it by hand`)
    return 1
  }
  return exitCode
}

/** `--name value` pairs. */
function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) return null
    args[argv[i].slice(2)] = argv[i + 1]
  }
  return args
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args === null || !args.provider || !args.driver || !args.case) {
    process.stderr.write(
      'usage: node scripts/fixtures/record.mjs --provider <p> --driver <d> --case <case>\n'
    )
    process.exitCode = 2
    return
  }
  process.exitCode = await runRecord({
    provider: args.provider,
    driver: args.driver,
    caseName: args.case
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
