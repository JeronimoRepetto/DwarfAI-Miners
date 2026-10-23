#!/usr/bin/env node
// The packaged-artifact check runner (`20` §2.1 `package`, §2.3; ISSUE-268): runs every P check against the folder
// electron-builder wrote, on the runner of the OS that built it.
//
//   pnpm test:packaged [<artifact dir>] [--checks <dir>] [--release [--required <file>]]
//
// The artifact folder defaults to `release` (package.json `build.directories.output`). Each check is a module named
// `p<nn>-<name>.packaged.mjs` beside this file (or in `--checks <dir>`) that exports its P id as `id` and, as its
// default export, an async function `({ artifactDir }) => ({ ok, detail })`. The runner prints one line per check,
// `<id> ok: <detail>` or `<id> FAIL: <detail>`, and exits 1 when any check fails, when it finds no check, or when the
// artifact folder is missing, so an empty run never passes. A check that a spike blocks answers `ok: false` with
// `blocked: { by, owner }` (the spike id and who must record it, ISSUE-270): it is never green, the runner prints
// `<id> blocked: <detail>`, and outside `--release` that line does not fail the run. With `--release` the run is also
// held to `required.json` (`--required <file>` names another): every P id it lists must have a check file here and
// pass; a missing or failing id fails the run, named with the issue that owns it, and a spike-blocked one fails naming
// the spike and its owner (ISSUE-271; `20` §2.3). Without the flag the runner runs what is present. It reads files
// only.
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CHECK_FILE = /^p\d+-[\w-]+\.packaged\.mjs$/

function parseArgs(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const args = {
    artifactDir: 'release',
    checksDir: here,
    release: false,
    requiredFile: path.join(here, 'required.json')
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--checks') {
      args.checksDir = argv[i + 1]
      i += 1
    } else if (argv[i] === '--required') {
      args.requiredFile = argv[i + 1]
      i += 1
    } else if (argv[i] === '--release') {
      args.release = true
    } else {
      args.artifactDir = argv[i]
    }
  }
  return args
}

/** Every P check module of `checksDir`, in file-name order (so P ids print in order). */
async function discoverChecks(checksDir) {
  const files = (await readdir(checksDir)).filter((file) => CHECK_FILE.test(file)).sort()
  const checks = []
  for (const file of files) {
    const module = await import(pathToFileURL(path.join(checksDir, file)).href)
    checks.push({ file, id: module.id, check: module.default })
  }
  return checks
}

/** Runs every check against `artifactDir`; one result per check, a thrown error counting as a failure. */
export async function runPackagedChecks({ artifactDir, checksDir }) {
  const checks = await discoverChecks(checksDir)
  const results = []
  for (const { file, id, check } of checks) {
    if (typeof id !== 'string' || typeof check !== 'function') {
      results.push({
        id: id ?? file,
        ok: false,
        detail: `${file} exports no id and check function`
      })
      continue
    }
    try {
      const { ok, detail, blocked } = await check({ artifactDir })
      const result = { id, ok: ok === true, detail }
      if (ok !== true && isBlocked(blocked))
        result.blocked = { by: blocked.by, owner: blocked.owner }
      results.push(result)
    } catch (error) {
      results.push({
        id,
        ok: false,
        detail: `threw ${error instanceof Error ? error.message : String(error)}`
      })
    }
  }
  return results
}

/** A spike block as a check reports it: the spike id and its owner, both named. */
function isBlocked(blocked) {
  return (
    typeof blocked?.by === 'string' &&
    blocked.by !== '' &&
    typeof blocked?.owner === 'string' &&
    blocked.owner !== ''
  )
}

/**
 * The ids of `required` (`[{ id, issue }]`) that release mode fails: one `{ id, ok: false, detail }` per id with no
 * result (no check file) or a failed one (a check that throws is a failure), each naming its owning issue. A required
 * id that passed is not listed; the results of the checks present are reported as they ran.
 */
export function releaseGaps({ required, results }) {
  const gaps = []
  for (const { id, issue } of required) {
    const found = results.filter((result) => result.id === id)
    const pattern = `p${id.slice(2)}-*.packaged.mjs`
    if (found.length === 0) {
      gaps.push({ id, detail: `missing, no ${pattern} check; owned by ${issue}` })
    } else if (!found.some((result) => result.ok)) {
      const spike = found.find((result) => result.blocked !== undefined)
      gaps.push({
        id,
        detail:
          spike === undefined
            ? `blocked, the check does not pass; owned by ${issue}`
            : `blocked by ${spike.blocked.by}, owned by ${spike.blocked.owner}: ${spike.detail}`
      })
    }
  }
  return gaps
}

async function readRequired(file) {
  const required = JSON.parse(await readFile(file, 'utf8'))
  const valid =
    Array.isArray(required) &&
    required.length > 0 &&
    required.every((entry) => typeof entry?.id === 'string' && typeof entry?.issue === 'string')
  if (!valid) throw new Error(`${file} is not a list of { id, issue }`)
  return required
}

async function main() {
  const { artifactDir, checksDir, release, requiredFile } = parseArgs(process.argv.slice(2))
  const folder = await stat(artifactDir).catch(() => null)
  if (!folder?.isDirectory()) {
    console.error(`packaged checks: no artifact folder at ${artifactDir}`)
    return 1
  }
  const results = await runPackagedChecks({ artifactDir, checksDir })
  if (results.length === 0) {
    console.error(`packaged checks: no p*.packaged.mjs check in ${checksDir}`)
    return 1
  }
  for (const { id, ok, detail, blocked } of results) {
    if (ok) console.log(`${id} ok: ${detail}`)
    // In release mode the gap below prints the blocked id as a failure, naming the spike and its owner.
    else if (blocked !== undefined) {
      if (!release) console.log(`${id} blocked: ${detail}`)
    } else console.error(`${id} FAIL: ${detail}`)
  }
  let complete = true
  if (release) {
    const required = await readRequired(requiredFile).catch((error) => {
      console.error(`packaged checks: cannot read the required ids: ${error.message}`)
      return null
    })
    if (required === null) return 1
    for (const { id, detail } of releaseGaps({ required, results })) {
      console.error(`${id} FAIL: ${detail}`)
      complete = false
    }
  }
  return complete && results.every((result) => result.ok || result.blocked !== undefined) ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
