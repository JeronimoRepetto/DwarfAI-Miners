#!/usr/bin/env node
// The `host.revert-integrations` records of the UI's log segments (hostLauncher/revertIntegrations.ts; 19 §2), read
// by the Windows package leg's Scoop check (scoop-check.ps1) to tell which Scoop step ran `--revert-integrations`.
//
//   node scripts/release/scoop/revert-log.mjs <logs dir>   prints the records as one JSON array
//
// Only `ui-<seq>.jsonl` segments are read: the UI writes the record whether the Host copy's revert succeeded or not.
// A line that is not JSON is skipped; a missing folder holds no record.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const EVENT = 'host.revert-integrations'
const UI_SEGMENT = /^ui-\d+\.jsonl$/

/** The revert records of `logDir`, oldest segment first, as `{ outcome, errCode }`. */
export function readRevertEntries(logDir) {
  let entries
  try {
    entries = readdirSync(logDir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && UI_SEGMENT.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => readFileSync(path.join(logDir, name), 'utf8').split(/\r?\n/))
    .flatMap((line) => {
      try {
        const record = JSON.parse(line)
        return record?.event === EVENT
          ? [{ outcome: record.outcome ?? null, errCode: record.errCode ?? null }]
          : []
      } catch {
        return []
      }
    })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [logDir] = process.argv.slice(2)
  if (!logDir) {
    console.error('usage: node scripts/release/scoop/revert-log.mjs <logs dir>')
    process.exit(2)
  }
  console.log(JSON.stringify(readRevertEntries(logDir)))
}
