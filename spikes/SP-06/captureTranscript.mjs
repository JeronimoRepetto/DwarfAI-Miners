#!/usr/bin/env node
/**
 * Captures one provider file of a throwaway session as the raw input of `scripts/fixtures/scrub.mjs` (17 §1.4
 * recording steps 2–4), for the observer fixtures of SP-06, S-021-1, S-021-2 and S-032-1. On the maintainer's
 * machine only, in the real-CLI lane (17 §5.5).
 *
 * The observer reads what a provider CLI wrote on disk (a transcript, a rollout) or on its event stream, so there is
 * no driver to tee: the CLI runs in the throwaway repository with a scripted prompt, then this copies the file it
 * wrote into the fixture folder under the recorder's raw names, beside the raw meta the scrubber needs.
 *
 * Usage:
 *   RUN_INTEGRATION=1 DWARFAI_REAL_CLI=<provider> node spikes/SP-06/captureTranscript.mjs \
 *     --provider <p> --version <providerVersion> --case <case> --repo <throwaway repo> --source <file> \
 *     [--stream <name>] [--sse]
 *
 * - Writes `fixtures/<p>/observer/<version>/<case>.raw.jsonl` (or `<case>.raw.<stream>.jsonl` with `--stream`, for a
 *   second file of the same case, such as the live stream SP-06 compares) and `<case>.raw.meta.json`.
 * - `--sse` reads a captured Server-Sent Events body (`data: {…}` lines) and keeps one JSON event per line.
 * - Refuses (exit 2) when `CI` is set, `RUN_INTEGRATION` is not `1` or the provider is not in `DWARFAI_REAL_CLI`.
 * - Reads only the `--source` file: never a provider config, credential file or keychain entry (ADR-008 item 2).
 *
 * Then: `node scripts/fixtures/scrub.mjs fixtures/<p>/observer/<version>/<case>.raw.*`, and read the output.
 */
import * as nodeFs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { laneRefusal } from '../../scripts/fixtures/record.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const RESERVED_STREAMS = new Set(['meta', 'sent', 'timing'])

/** The JSON events of an SSE body: every `data:` line that holds JSON, in order. */
export function sseToJsonl(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => {
      try {
        JSON.parse(data)
        return true
      } catch {
        return false
      }
    })
    .map((data) => `${data}\n`)
    .join('')
}

/**
 * Captures one file. Returns the exit code: 0 written, 1 the source could not be read, 2 refused or a usage error.
 *
 * @param {object} request
 * @param {string} request.provider
 * @param {string} request.version
 * @param {string} request.caseName
 * @param {string} request.repo the throwaway repository the session ran in (the scrubber's `<REPO>`)
 * @param {string} request.source
 * @param {string} [request.stream]
 * @param {boolean} [request.sse]
 * @param {Record<string, string | undefined>} [request.env]
 * @param {string} [request.fixturesRoot]
 * @param {() => number} [request.now]
 * @param {string} [request.platform]
 * @param {typeof nodeFs} [request.fs]
 * @param {(line: string) => void} [request.log]
 */
export function runCapture(request) {
  const {
    provider,
    version,
    caseName,
    repo,
    source,
    stream,
    sse = false,
    env = process.env,
    fixturesRoot = path.resolve(here, '..', '..', 'fixtures'),
    now = Date.now,
    platform = process.platform,
    fs = nodeFs,
    log = (line) => process.stderr.write(`${line}\n`)
  } = request
  const refusal = laneRefusal(env, provider)
  if (refusal !== null) {
    log(`capture: ${refusal}`)
    return 2
  }
  for (const [name, value] of [
    ['--provider', provider],
    ['--version', version],
    ['--case', caseName]
  ]) {
    if (typeof value !== 'string' || !SEGMENT.test(value)) {
      log(`capture: ${name} must be one path segment of letters, digits, ".", "_" or "-"`)
      return 2
    }
  }
  if (stream !== undefined && (!/^[A-Za-z0-9_-]+$/.test(stream) || RESERVED_STREAMS.has(stream))) {
    log(
      'capture: --stream must be a name of letters, digits, "_" or "-", other than meta, sent, timing'
    )
    return 2
  }
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) {
    log('capture: --repo must be the absolute path of the throwaway repository')
    return 2
  }
  let text
  try {
    text = fs.readFileSync(source, 'utf8')
  } catch (error) {
    log(`capture: could not read the source (${error.code ?? 'error'})`)
    return 1
  }
  const body = sse ? sseToJsonl(text) : text
  if (body.trim() === '') {
    log('capture: the source holds no record')
    return 1
  }
  const folder = path.join(fixturesRoot, provider, 'observer', version)
  fs.mkdirSync(folder, { recursive: true })
  const rawName = stream === undefined ? `${caseName}.raw.jsonl` : `${caseName}.raw.${stream}.jsonl`
  fs.writeFileSync(path.join(folder, rawName), body)
  const metaFile = path.join(folder, `${caseName}.raw.meta.json`)
  if (!fs.existsSync(metaFile)) {
    const meta = {
      provider,
      driver: 'observer',
      providerVersion: version,
      os: platform,
      capturedAt: new Date(now()).toISOString().slice(0, 10),
      capabilities: {},
      repoRoot: repo
    }
    fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`)
  }
  log(`capture: wrote ${rawName}; next, node scripts/fixtures/scrub.mjs on ${caseName}.raw.*`)
  return 0
}

function main(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--sse') args.sse = true
    else if (flag.startsWith('--') && argv[i + 1] !== undefined) args[flag.slice(2)] = argv[++i]
    else {
      args.bad = true
      break
    }
  }
  if (args.bad || !args.provider || !args.version || !args.case || !args.repo || !args.source) {
    process.stderr.write(
      'usage: node spikes/SP-06/captureTranscript.mjs --provider <p> --version <v> --case <case> ' +
        '--repo <throwaway repo> --source <file> [--stream <name>] [--sse]\n'
    )
    process.exitCode = 2
    return
  }
  process.exitCode = runCapture({
    provider: args.provider,
    version: args.version,
    caseName: args.case,
    repo: args.repo,
    source: args.source,
    stream: args.stream,
    sse: args.sse === true
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
