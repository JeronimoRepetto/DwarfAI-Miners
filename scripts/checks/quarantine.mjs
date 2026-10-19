#!/usr/bin/env node
/**
 * Flake quarantine expiry rule (testing strategy `17` §5.4).
 *
 * `test-quarantine.json` at the repository root is the only way to stop a flaky test from blocking
 * (`it.skip` is forbidden). It is a JSON array; each entry names:
 *
 * - `title`: the full test title; `lane`: the test layer (`L1` … `L13`);
 * - `issue`: the issue link; `owner`: the owner role (a role, never a person);
 * - `added` and `expires`: `YYYY-MM-DD` dates, `expires` at most 14 days after `added`.
 *
 * The check fails on a malformed entry, on an entry longer than 14 days, and on an expired entry
 * (`expires` before today, in UTC), so a quarantine can never quietly become permanent.
 *
 * Usage: node scripts/checks/quarantine.mjs [<test-quarantine.json>]   (default: the root file)
 * Exit code 0 when every entry is valid, 1 with one line per problem on stderr.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MAX_QUARANTINE_DAYS = 14

const TEXT_FIELDS = ['title', 'lane', 'issue', 'owner']
const LANE = /^L(?:[1-9]|1[0-3])$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 24 * 60 * 60 * 1000

/** Epoch ms of a `YYYY-MM-DD` date at 00:00 UTC, or null when it is not a real calendar date. */
function parseDate(text) {
  const match = typeof text === 'string' ? DATE.exec(text) : null
  if (!match) return null
  const [year, month, day] = match.slice(1).map(Number)
  const ms = Date.UTC(year, month - 1, day)
  const date = new Date(ms)
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  return real ? ms : null
}

/** One printable line per problem of the quarantine list `entries`, judged on `today` (`YYYY-MM-DD`). */
export function checkQuarantine(entries, today) {
  if (!Array.isArray(entries)) return ['test-quarantine.json must be a JSON array of entries']
  const todayMs = parseDate(today)
  if (todayMs === null) throw new Error(`today is not a YYYY-MM-DD date: ${today}`)
  const problems = []
  entries.forEach((entry, index) => {
    const label = `entry ${index + 1}${typeof entry?.title === 'string' ? ` (${entry.title})` : ''}`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${label}: not a JSON object`)
      return
    }
    for (const field of TEXT_FIELDS) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        problems.push(`${label}: "${field}" must be a non-empty string`)
      }
    }
    if (typeof entry.lane === 'string' && entry.lane !== '' && !LANE.test(entry.lane)) {
      problems.push(`${label}: "lane" must be a test layer L1 to L13, not ${entry.lane}`)
    }
    const added = parseDate(entry.added)
    const expires = parseDate(entry.expires)
    if (added === null)
      problems.push(`${label}: "added" is not a date (YYYY-MM-DD): ${entry.added}`)
    if (expires === null) {
      problems.push(`${label}: "expires" is not a date (YYYY-MM-DD): ${entry.expires}`)
    }
    if (added === null || expires === null) return
    if (added > expires) problems.push(`${label}: added after it expires`)
    else if (expires - added > MAX_QUARANTINE_DAYS * DAY_MS) {
      problems.push(`${label}: quarantined for more than ${MAX_QUARANTINE_DAYS} days`)
    }
    if (expires < todayMs) {
      problems.push(
        `${label}: expired on ${entry.expires}; fix the test or remove it with its census entry`
      )
    }
  })
  return problems
}

/** Today's date in UTC, as `YYYY-MM-DD`. */
function utcToday() {
  return new Date().toISOString().slice(0, 10)
}

/** Runs the check as the command line does; returns the exit code. */
export function runQuarantineCheck(argv, io, today = utcToday()) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const file = path.resolve(argv[0] ?? path.join(here, '..', '..', 'test-quarantine.json'))
  if (!existsSync(file)) {
    io.err(`quarantine: file not found: ${file}`)
    return 1
  }
  let entries
  try {
    entries = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    io.err(`quarantine: not valid JSON: ${file}: ${error.message}`)
    return 1
  }
  const problems = checkQuarantine(entries, today)
  for (const problem of problems) io.err(`quarantine: ${problem}`)
  if (problems.length > 0) return 1
  io.out(`quarantine: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, none expired`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runQuarantineCheck(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`)
  })
}
