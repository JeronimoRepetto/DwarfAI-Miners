#!/usr/bin/env node
// The packaged-artifact check runner (`20` §2.1 `package`, §2.3; ISSUE-268): runs every P check against the folder
// electron-builder wrote, on the runner of the OS that built it.
//
//   pnpm test:packaged [<artifact dir>] [--checks <dir>]
//
// The artifact folder defaults to `release` (package.json `build.directories.output`). Each check is a module named
// `p<nn>-<name>.packaged.mjs` beside this file (or in `--checks <dir>`) that exports its P id as `id` and, as its
// default export, an async function `({ artifactDir }) => ({ ok, detail })`. The runner prints one line per check,
// `<id> ok: <detail>` or `<id> FAIL: <detail>`, and exits 1 when any check fails, when it finds no check, or when the
// artifact folder is missing, so an empty run never passes. It reads files only.
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CHECK_FILE = /^p\d+-[\w-]+\.packaged\.mjs$/

function parseArgs(argv) {
  const args = { artifactDir: 'release', checksDir: path.dirname(fileURLToPath(import.meta.url)) }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--checks') {
      args.checksDir = argv[i + 1]
      i += 1
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
      const { ok, detail } = await check({ artifactDir })
      results.push({ id, ok: ok === true, detail })
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

async function main() {
  const { artifactDir, checksDir } = parseArgs(process.argv.slice(2))
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
  for (const { id, ok, detail } of results) {
    const line = `${id} ${ok ? 'ok' : 'FAIL'}: ${detail}`
    if (ok) console.log(line)
    else console.error(line)
  }
  return results.every((result) => result.ok) ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
