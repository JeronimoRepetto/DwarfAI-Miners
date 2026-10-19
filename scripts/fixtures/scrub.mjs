#!/usr/bin/env node
/**
 * Turns one recorded case into a committable fixture set (17 §1.4 recording steps 4–5).
 *
 * Usage: node scripts/fixtures/scrub.mjs <case>.raw.* [--keep-raw]
 *
 * Input, in one `fixtures/<provider>/<driver>/<providerVersion>/` folder (written by `record.mjs`):
 * - `<case>.raw.<ext>` and `<case>.raw.<stream>.<ext>`: the recorded streams (`.jsonl` or `.json`);
 * - `<case>.raw.meta.json`: what the recorder knew (provider version, OS, capabilities, the
 *   throwaway repository's path, the capture date).
 *
 * Output, beside them: `<case>.<ext>` and `<case>-<stream>.<ext>` scrubbed (`lib/scrubRules.mjs`),
 * each with its `-with-extra` variant (an unknown field added to every object, HR T1) and, for
 * JSONL, its `-crlf` variant (HO-37); and `meta.json` with `scrubbed: true` and the role
 * `maintainer` as `capturedBy`, written only when the folder has none yet.
 *
 * Before writing anything, every output is checked again: when any rule would still change a line
 * (a personal value or a secret survived), the run prints `<file>:<line>: <rule> survived` (never
 * the value), writes nothing and exits 1. After a successful write the raw files are deleted
 * (17 §5.5), unless `--keep-raw` is given. Exit code 2 is a usage error.
 *
 * The maintainer's identity (home, user and host name) comes from `node:os`; no provider config,
 * credential file or keychain entry is read (ADR-008 item 2).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findSurvivors, scrubFixtureSet } from './lib/scrubRules.mjs'

/** `capturedBy` is a role, never a person (17 §1.4). */
export const CAPTURED_BY = 'maintainer'

/** The field the `-with-extra` variant adds to every object: unknown to every driver. */
export const EXTRA_FIELD = 'dwarfaiUnknownField'

const RAW_NAME = /^(?<caseName>.+?)\.raw\.(?:(?<stream>[A-Za-z0-9_-]+)\.)?(?<ext>jsonl|json)$/
const META_STREAM = 'meta'

/** The output name of one raw stream file. */
function outputName(caseName, stream, ext) {
  return stream === undefined ? `${caseName}.${ext}` : `${caseName}-${stream}.${ext}`
}

/** Adds the unknown field to every object of a parsed JSON value. */
function withExtraField(value) {
  if (Array.isArray(value)) return value.map(withExtraField)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = withExtraField(item)
    out[EXTRA_FIELD] = 'extra'
    return out
  }
  return value
}

/** The `-with-extra` text of one scrubbed document; a line that is not JSON stays as it is. */
function withExtraText(name, text) {
  const extend = (chunk, indent) => {
    try {
      return JSON.stringify(withExtraField(JSON.parse(chunk)), null, indent)
    } catch {
      return chunk
    }
  }
  if (name.endsWith('.jsonl')) {
    return text
      .split('\n')
      .map((line) => (line === '' ? line : extend(line)))
      .join('\n')
  }
  return `${extend(text.trim(), 2)}\n`
}

/** `name.ext` → `name<suffix>.ext`. */
function suffixed(name, suffix) {
  const ext = path.extname(name)
  return `${name.slice(0, -ext.length)}${suffix}${ext}`
}

/**
 * The files one case produces, from its raw files (pure). `meta` is the recorder's raw meta.
 *
 * @param {{ caseName: string, streams: { name: string, text: string }[], meta: object }} capture
 * @param {object} identity
 * @param {(documents: object[], identity: object) => object[]} scrubSet
 * @returns {{ name: string, text: string }[]}
 */
export function planOutputs(capture, identity, scrubSet = scrubFixtureSet) {
  const { meta } = capture
  const fullIdentity = { ...identity, repoRoot: meta.repoRoot }
  const scrubbed = scrubSet(capture.streams, fullIdentity)
  const outputs = []
  for (const document of scrubbed) {
    outputs.push(document)
    outputs.push({
      name: suffixed(document.name, '-with-extra'),
      text: withExtraText(document.name, document.text)
    })
    if (document.name.endsWith('.jsonl')) {
      outputs.push({
        name: suffixed(document.name, '-crlf'),
        text: document.text.replace(/\n/g, '\r\n')
      })
    }
  }
  // The recorded values go through the rules too; the capture date is a day, not an instant of
  // the session, so it is set after scrubbing and never shifted.
  const [scrubbedMeta] = scrubSet(
    [
      {
        name: 'meta.json',
        text: JSON.stringify({
          providerVersion: meta.providerVersion,
          os: meta.os,
          capabilities: meta.capabilities
        })
      }
    ],
    fullIdentity
  )
  const recorded = JSON.parse(scrubbedMeta.text)
  const metaJson = {
    providerVersion: recorded.providerVersion,
    capturedAt: `${meta.capturedAt}T00:00:00.000Z`,
    capturedBy: CAPTURED_BY,
    os: recorded.os,
    scrubbed: true,
    capabilities: recorded.capabilities
  }
  outputs.push({
    name: 'meta.json',
    text: `${JSON.stringify(metaJson, null, 2)}
`
  })
  return outputs
}

/** Reads and groups the raw files of one case; throws a usage error message. */
function readCapture(rawPaths) {
  const dirs = new Set(rawPaths.map((p) => path.dirname(path.resolve(p))))
  if (dirs.size !== 1) throw new Error('all raw files must be in one fixture folder')
  const parsed = rawPaths.map((p) => ({ path: p, match: RAW_NAME.exec(path.basename(p)) }))
  const unknown = parsed.find(({ match }) => match === null)
  if (unknown) throw new Error(`not a raw capture file: ${path.basename(unknown.path)}`)
  const caseNames = new Set(parsed.map(({ match }) => match.groups.caseName))
  if (caseNames.size !== 1) throw new Error('all raw files must belong to one case')
  const [caseName] = caseNames
  const metaFile = parsed.find(
    ({ match }) => match.groups.stream === META_STREAM && match.groups.ext === 'json'
  )
  if (!metaFile) throw new Error(`${caseName}.raw.meta.json is missing`)
  const streams = parsed
    .filter((file) => file !== metaFile)
    .map(({ path: p, match }) => ({
      name: outputName(caseName, match.groups.stream, match.groups.ext),
      text: readFileSync(p, 'utf8')
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (streams.length === 0) throw new Error(`no recorded stream for ${caseName}`)
  const meta = JSON.parse(readFileSync(metaFile.path, 'utf8'))
  return { dir: [...dirs][0], caseName, streams, meta }
}

/** The maintainer's identity, from the OS: no provider file is read (ADR-008 item 2). */
export function machineIdentity() {
  return { home: homedir(), user: userInfo().username, host: hostname() }
}

/**
 * Scrubs one case. Returns the exit code: 0 written, 1 a value survived (nothing written),
 * 2 usage error.
 *
 * @param {string[]} rawPaths
 * @param {{ identity?: object, scrubSet?: Function, keepRaw?: boolean, log?: (line: string) => void }} [options]
 */
export function runScrub(rawPaths, options = {}) {
  const {
    identity = machineIdentity(),
    scrubSet = scrubFixtureSet,
    keepRaw = false,
    log = (line) => process.stderr.write(`${line}\n`)
  } = options
  let capture
  try {
    capture = readCapture(rawPaths)
  } catch (error) {
    log(`scrub: ${error.message}`)
    return 2
  }
  const outputs = planOutputs(capture, identity, scrubSet)
  const fullIdentity = { ...identity, repoRoot: capture.meta.repoRoot }
  let survived = 0
  for (const { name, text } of outputs) {
    for (const { rule, line } of findSurvivors(text, fullIdentity)) {
      log(`${name}:${line}: ${rule} survived`)
      survived++
    }
  }
  if (survived > 0) {
    log(`scrub: ${survived} value(s) survived; nothing was written`)
    return 1
  }
  for (const { name, text } of outputs) {
    const target = path.join(capture.dir, name)
    if (name === 'meta.json' && existsSync(target)) {
      log('scrub: meta.json already exists and was kept; review its capabilities by hand')
      continue
    }
    writeFileSync(target, text)
  }
  if (!keepRaw) for (const rawPath of rawPaths) rmSync(rawPath, { force: true })
  log(`scrub: wrote ${outputs.length} file(s) for ${capture.caseName}; read them before committing`)
  return 0
}

function main(argv) {
  const keepRaw = argv.includes('--keep-raw')
  const rawPaths = argv.filter((arg) => arg !== '--keep-raw')
  if (rawPaths.length === 0) {
    process.stderr.write('usage: node scripts/fixtures/scrub.mjs <case>.raw.* [--keep-raw]\n')
    process.exitCode = 2
    return
  }
  process.exitCode = runScrub(rawPaths, { keepRaw })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
