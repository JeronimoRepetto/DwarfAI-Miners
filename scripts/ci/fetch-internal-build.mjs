#!/usr/bin/env node
// Fetches an internal cut build to the owner's machine and removes it from GitHub (owner, 2026-10-02).
//
//   node scripts/ci/fetch-internal-build.mjs <run-id> <folder>
//
// The internal build (.github/workflows/internal-build.yml) leaves its installers as workflow artifacts. The repository
// is public, so any signed-in GitHub user could download them, and no build is public before cut 5 (OQ-66). This
// script, run from the repository checkout with the owner's own `gh` login:
// 1. lists the run's artifacts (`gh api repos/{owner}/{repo}/actions/runs/<id>/artifacts`);
// 2. downloads each into <folder>/<artifact name> (`gh run download <id> --name <name> --dir ...`);
// 3. verifies every file of each against that artifact's SHA256SUMS (scripts/ci/sha256sums.mjs);
// 4. only when all of them verified, deletes every artifact of the run
//    (`gh api -X DELETE repos/{owner}/{repo}/actions/artifacts/<id>`).
// A failed download or checksum keeps every artifact on GitHub (their retention is one day) and exits non-zero. Its
// only network access is `gh`; it reads no token itself.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifySha256Sums } from './sha256sums.mjs'

const USAGE = 'usage: node scripts/ci/fetch-internal-build.mjs <run-id> <folder>'

/** `<run-id> <folder>` from the command line. */
export function parseRunArgs(argv) {
  if (argv.length !== 2 || !/^\d+$/.test(argv[0]) || argv[1].trim() === '') throw new Error(USAGE)
  return { runId: argv[0], folder: argv[1] }
}

/** The artifacts of a `GET /repos/{owner}/{repo}/actions/runs/{id}/artifacts` answer. */
export function parseArtifactList(json) {
  let body
  try {
    body = JSON.parse(json)
  } catch {
    body = undefined
  }
  if (!body || !Array.isArray(body.artifacts)) {
    throw new Error(`gh did not answer an artifact list: ${String(json).slice(0, 200)}`)
  }
  return body.artifacts.map(({ id, name, expired }) => ({ id, name, expired: !!expired }))
}

/** The `gh` calls that download each artifact into its own folder and, later, delete it. */
export function planFetch({ runId, folder, artifacts }) {
  return {
    downloads: artifacts.map(({ name }) => {
      const dir = path.join(folder, name)
      return { name, dir, args: ['run', 'download', runId, '--name', name, '--dir', dir] }
    }),
    deletes: artifacts.map(({ id, name }) => ({
      id,
      name,
      args: ['api', '-X', 'DELETE', `repos/{owner}/{repo}/actions/artifacts/${id}`]
    }))
  }
}

const failed = (result) => (result.stderr || result.stdout || `exit ${result.status}`).trim()

/**
 * Downloads, verifies and deletes the artifacts of run `runId`. `gh(args)` runs `gh` and answers
 * `{ status, stdout, stderr }`; `log(line)` prints. Deletes nothing unless every artifact downloaded and verified.
 */
export function fetchInternalBuild({ runId, folder, gh, log }) {
  const result = { ok: false, downloaded: [], deleted: [], problems: [] }
  if (existsSync(folder) && readdirSync(folder).length > 0) {
    result.problems.push(`${folder} is not empty`)
    return result
  }

  const listed = gh(['api', `repos/{owner}/{repo}/actions/runs/${runId}/artifacts?per_page=100`])
  if (listed.status !== 0) {
    result.problems.push(`gh could not list the artifacts of run ${runId}: ${failed(listed)}`)
    return result
  }
  const artifacts = parseArtifactList(listed.stdout)
  if (artifacts.length === 0) {
    result.problems.push(`run ${runId} has no artifacts`)
    return result
  }
  for (const { name, expired } of artifacts) {
    if (expired) result.problems.push(`${name}: expired on GitHub`)
  }
  if (result.problems.length > 0) return result

  const plan = planFetch({ runId, folder, artifacts })
  for (const { name, dir, args } of plan.downloads) {
    const download = gh(args)
    if (download.status !== 0) {
      result.problems.push(`${name}: gh run download failed: ${failed(download)}`)
      continue
    }
    const check = verifySha256Sums(dir)
    for (const problem of check.problems) result.problems.push(`${name}: ${problem}`)
    for (const file of check.verified) {
      const shown = path.join(name, file)
      result.downloaded.push(shown)
      log(`verified ${shown}`)
    }
  }
  if (result.problems.length > 0) return result

  for (const { id, name, args } of plan.deletes) {
    const removal = gh(args)
    if (removal.status !== 0) {
      result.problems.push(`${name}: delete failed (id ${id}): ${failed(removal)}`)
      continue
    }
    result.deleted.push(name)
    log(`deleted artifact ${name} (id ${id})`)
  }
  result.ok = result.problems.length === 0
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args
  try {
    args = parseRunArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
  const gh = (ghArgs) => {
    const run = spawnSync('gh', ghArgs, { encoding: 'utf8', shell: false })
    if (run.error) return { status: 1, stdout: '', stderr: run.error.message }
    return { status: run.status ?? 1, stdout: run.stdout, stderr: run.stderr }
  }
  const outcome = fetchInternalBuild({ ...args, gh, log: (line) => console.log(line) })
  if (!outcome.ok) {
    for (const problem of outcome.problems) console.error(`refused: ${problem}`)
    if (outcome.deleted.length === 0) {
      console.error(
        'Nothing was deleted: the artifacts stay on GitHub until their one-day retention ends.'
      )
    }
    process.exit(1)
  }
  console.log(
    `Downloaded ${outcome.downloaded.length} verified file(s) to ${path.resolve(args.folder)}; ` +
      `deleted ${outcome.deleted.length} artifact(s) of run ${args.runId}.`
  )
}
