#!/usr/bin/env node
/**
 * Cross-OS parity of a golden run (BR-24: anything a person can see differ between Windows, macOS
 * and Linux is a defect; NFR-PLAT-01; testing strategy `17` §1.13).
 *
 * Each OS leg of a golden run writes one report of what a person can see, per screen:
 *
 *   { "screens": { "<screen id>": { "visibleText": ["…"], "controls": ["<role>:<name>"] } } }
 *
 * as `<reports dir>/win32.json`, `darwin.json` and `linux.json`. This check compares the three and
 * fails on every screen that is missing on a leg or whose `visibleText` or `controls` list differs
 * between legs, naming the screen, the field and the legs. Images are not compared here: pixel
 * differences between OSes (fonts, anti-aliasing) are the golden lane's own tolerance question.
 *
 * The golden lane runs only on the maintainer's machine, never in CI (`17` §0, §1.9), so where the
 * reports folder is absent the check prints "golden lane reports not present: cross-OS parity
 * skipped" and exits 0. A present folder must hold all three legs.
 *
 * Usage: node scripts/checks/cross-os-parity.mjs [--reports <dir>]   (default: PARITY_REPORTS)
 * Exit code 0 when the three legs agree (or no reports exist), 1 with one line per difference.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PARITY_SKIP_NOTICE = 'golden lane reports not present: cross-OS parity skipped'

/** Where the golden lane leaves the three legs' reports, relative to the repository root. */
export const PARITY_REPORTS = 'golden-results/parity'

/** The three legs, in the order differences are reported. */
export const LEGS = ['win32', 'darwin', 'linux']

const FIELDS = ['visibleText', 'controls']

/** A list field as a comparable string, or null when it is not a list of strings. */
function listKey(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? JSON.stringify(value)
    : null
}

/** One printable line per difference between the legs' reports (`{ win32, darwin, linux }`). */
export function compareParityReports(reports) {
  const differences = []
  const screensOf = (leg) => reports[leg]?.screens ?? {}
  const ids = [...new Set(LEGS.flatMap((leg) => Object.keys(screensOf(leg))))].sort()
  for (const id of ids) {
    const missing = LEGS.filter((leg) => !Object.hasOwn(screensOf(leg), id))
    if (missing.length > 0) {
      differences.push(`screen ${id}: missing on ${missing.join(', ')}`)
      continue
    }
    for (const field of FIELDS) {
      const keys = LEGS.map((leg) => listKey(screensOf(leg)[id]?.[field]))
      const invalid = LEGS.filter((_, index) => keys[index] === null)
      if (invalid.length > 0) {
        differences.push(`screen ${id}: ${field} is not a list of strings on ${invalid.join(', ')}`)
        continue
      }
      if (new Set(keys).size === 1) continue
      const byLeg = LEGS.map((leg, index) => `${leg} ${keys[index]}`).join(' | ')
      differences.push(`screen ${id}: ${field} differs between legs: ${byLeg}`)
    }
  }
  return differences
}

class ParityError extends Error {}

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new ParityError(`${name} needs a value`)
  return value
}

function readReport(dir, leg) {
  const file = path.join(dir, `${leg}.json`)
  if (!existsSync(file)) throw new ParityError(`${leg}.json is missing from ${dir}`)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new ParityError(`${leg}.json is not valid JSON: ${error.message}`)
  }
}

/** Runs the check as the command line does; returns the exit code. */
export function runCrossOsParity(argv, io) {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const dir = path.resolve(
      optionValue(argv, '--reports') ?? path.join(here, '..', '..', PARITY_REPORTS)
    )
    if (!existsSync(dir)) {
      io.out(PARITY_SKIP_NOTICE)
      return 0
    }
    const reports = Object.fromEntries(LEGS.map((leg) => [leg, readReport(dir, leg)]))
    const differences = compareParityReports(reports)
    for (const difference of differences) io.err(`cross-OS parity: ${difference}`)
    if (differences.length > 0) return 1
    io.out(`cross-OS parity: the ${LEGS.join(', ')} reports agree`)
    return 0
  } catch (error) {
    if (!(error instanceof ParityError)) throw error
    io.err(`cross-OS parity: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCrossOsParity(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`)
  })
}
