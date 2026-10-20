#!/usr/bin/env node
// The S-008-1 record check for bundled provider adapters and libraries (ADR-008 item 1; 20 §2.4, §2.5; 18 C-35;
// ISSUE-272).
//
//   node scripts/release/s008-records.mjs [--root <dir>]
//
// A provider adapter or library is bundled only when its S-008-1 row, for the exact version the lockfile pins,
// records it as GPL-3.0-or-later compatible and the owner decided to bundle it. The rows are the results table of
// docs/licenses/S-008-1.md, the record release/legal keeps (lead decision 2026-10-16; docs/licenses/README.md).
// Exits 1 when a production package in scope has no such row. Reads the lockfile and installed metadata only.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLicenceReport, DENIED_FILE, parseArgs, readDenied } from './licenses.mjs'

export const S008_RECORD = path.join('docs', 'licenses', 'S-008-1.md')

/**
 * The packages S-008-1 governs (its Question: each bundled provider adapter or library, and the keyring library of
 * SP-16). A package an S-008-1 row names is in scope too, so a row whose decision is "bundle: no" fails the day the
 * package is added. The issue that bundles a new adapter or library adds its name here with its row.
 */
export const S008_SCOPE = [
  { name: '@agentclientprotocol/sdk' },
  { name: '@napi-rs/keyring' },
  { prefix: '@napi-rs/keyring-' }
]

function cells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim())
}

const plain = (cell) => cell.replace(/\*\*/g, '').replace(/`/g, '').trim()

/**
 * The rows of the S-008-1 results table: `{ name, version, licence, compatible, bundle, notice }`. The table is
 * the one whose header names "Package and pinned version", "GPL-3.0-or-later compatible" and "Owner decision".
 */
export function parseS008Rows(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const rows = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue
    const header = cells(lines[i]).map((cell) => cell.toLowerCase())
    const col = (prefix) => header.findIndex((cell) => cell.startsWith(prefix))
    const at = {
      pkg: col('package and pinned version'),
      licence: col('license'),
      compatible: col('gpl-3.0-or-later compatible'),
      notice: col('notice'),
      decision: col('owner decision')
    }
    if (Object.values(at).some((index) => index === -1)) continue
    for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
      const row = cells(lines[i])
      const pkg = row[at.pkg].match(/^`([^`]+)`\s+(\S+)$/)
      if (!pkg) continue
      rows.push({
        name: pkg[1],
        version: pkg[2],
        licence: plain(row[at.licence]),
        compatible: /^yes\b/i.test(plain(row[at.compatible])),
        bundle: /\bbundle:\s*yes\b/i.test(plain(row[at.decision])),
        notice: plain(row[at.notice])
      })
    }
  }
  return rows
}

/** Whether a package name is governed by S-008-1. */
export function inS008Scope(name, rows = [], scope = S008_SCOPE) {
  return (
    rows.some((row) => row.name === name) ||
    scope.some((entry) => entry.name === name || (entry.prefix && name.startsWith(entry.prefix)))
  )
}

/**
 * Checks every production package in scope against the rows. Returns the packages checked and the failures, one
 * per package without a closed, GPL-compatible, "bundle: yes" row for its pinned version.
 */
export function checkS008Records({ packages, rows, scope = S008_SCOPE }) {
  const checked = []
  const failures = []
  for (const { name, version } of packages) {
    if (!inS008Scope(name, rows, scope)) continue
    const key = `${name}@${version}`
    checked.push(key)
    const row = rows.find((r) => r.name === name && r.version === version)
    if (!row) failures.push(`${key}: no S-008-1 row for this pinned version`)
    else if (!row.compatible)
      failures.push(`${key}: its S-008-1 row is not GPL-3.0-or-later compatible`)
    else if (!row.bundle) failures.push(`${key}: its S-008-1 row does not decide to bundle it`)
  }
  return { checked, failures }
}

/** The rows of a project's committed S-008-1 record. */
export function readS008Rows(rootDir) {
  return parseS008Rows(readFileSync(path.join(rootDir, S008_RECORD), 'utf8'))
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const rootDir = path.resolve(args.root ?? '.')
  const report = buildLicenceReport({
    rootDir,
    denied: readDenied(path.join(rootDir, DENIED_FILE))
  })
  const rows = readS008Rows(rootDir)
  const result = checkS008Records({ packages: report.packages, rows })
  console.log(
    `${rows.length} S-008-1 rows; ${result.checked.length} bundled adapter or library packages checked`
  )
  for (const key of result.checked) console.log(`  ${key}`)
  for (const failure of result.failures) console.error(`FAIL ${failure}`)
  process.exitCode = result.failures.length > 0 ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
