#!/usr/bin/env node
/**
 * OS-lane empty guard (testing strategy `17` §1.8, §1.13; HO-38).
 *
 * `pnpm test:os` (`vitest.os.config.ts`) writes a Vitest JSON report of the OS lane. This guard
 * reads it and fails the OS job when the lane executed zero tests: a test that `describe.runIf`
 * turned off for this platform is reported as skipped, and a skipped, todo or pending test never
 * counts as executed. So a mistyped platform guard cannot turn a lane into a silent pass.
 *
 * Usage: node scripts/checks/os-lane-guard.mjs [<report.json>]   (default: OS_LANE_REPORT)
 * Exit code 0 when at least one test executed (passed or failed; a failure is `pnpm test:os`'s to
 * report), 1 with the reason on stderr otherwise, or when the report is missing or unreadable.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where `vitest.os.config.ts` writes the report, relative to the repository root (git-ignored). */
export const OS_LANE_REPORT = 'coverage/os-lane/report.json'

/** The statuses of a test that ran; `skipped`, `pending`, `todo` and `disabled` did not. */
const EXECUTED = new Set(['passed', 'failed'])

/** The executed-test count of a Vitest JSON report and whether the lane passes the guard. */
export function checkOsLaneReport(report) {
  const files = Array.isArray(report?.testResults) ? report.testResults : []
  let executed = 0
  for (const file of files) {
    const results = Array.isArray(file?.assertionResults) ? file.assertionResults : []
    for (const result of results) if (EXECUTED.has(result?.status)) executed += 1
  }
  return { ok: executed > 0, executed }
}

/** Runs the guard as the command line does; returns the exit code. */
export function runOsLaneGuard(argv, io) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const reportPath = path.resolve(argv[0] ?? path.join(here, '..', '..', OS_LANE_REPORT))
  if (!existsSync(reportPath)) {
    io.err(`os-lane guard: report not found: ${reportPath} (did pnpm test:os run?)`)
    return 1
  }
  let report
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch (error) {
    io.err(`os-lane guard: report is not valid JSON: ${reportPath}: ${error.message}`)
    return 1
  }
  const { ok, executed } = checkOsLaneReport(report)
  if (!ok) {
    io.err(
      `os-lane guard: the OS lane executed zero tests on ${process.platform}; a lane that ran nothing must not pass (17 §1.8)`
    )
    return 1
  }
  io.out(`os-lane guard: ${executed} test(s) executed on ${process.platform}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runOsLaneGuard(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`)
  })
}
