#!/usr/bin/env node
// The elevated half of ELEVATED_REFUSED on Windows CI (ADR-002 D6; 07 S12.03; 13 FM-011):
//
//   node scripts/ci/check-elevated-refusal.mjs --entry out/host/main.js
//
// Run as the job's own (elevated) user, never through run-unelevated.mjs. It reads this token's integrity level with
// System32's `whoami /groups`, starts the built Host once the way the launcher does (the installed Electron with
// ELECTRON_RUN_AS_NODE=1 and a fresh DWARFAI_HOST_DATA_DIR under the temp folder), and applies elevatedRefusal.mjs's
// verdict: exit 65 and nothing bound. A Host that has not exited within the budget is ended and fails the check.
// The temp folder is removed at the end. No secret is read or needed.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs, verdict } from './elevatedRefusal.mjs'
import { integrityRid, isElevatedRid } from './unelevated.mjs'

/** A refusing Host exits within its boot's first step; this bounds a Host that does not. */
const BUDGET_MS = 60_000

const args = parseArgs(process.argv.slice(2))
if (args.kind !== 'run' || process.platform !== 'win32') {
  console.error(
    'usage (Windows only): node scripts/ci/check-elevated-refusal.mjs --entry out/host/main.js'
  )
  process.exit(2)
}

const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
let rid = null
try {
  rid = integrityRid(
    execFileSync(
      path.join(systemRoot, 'System32', 'whoami.exe'),
      ['/groups', '/fo', 'csv', '/nh'],
      {
        encoding: 'utf8',
        windowsHide: true
      }
    )
  )
} catch {
  rid = null
}

// Not elevated (or unreadable): there is nothing to prove, and a Host must not be left starting on this machine.
if (rid === null || !isElevatedRid(rid)) {
  const refusal = verdict({
    rid,
    exit: 'timed-out',
    bound: { identityFile: false, uiToken: false }
  })
  console.error(`::error::check-elevated-refusal: ${refusal.message}`)
  process.exit(1)
}

const electron = createRequire(import.meta.url)('electron')
const root = mkdtempSync(path.join(tmpdir(), 'dwarfai-elevated-check-'))
const hostDataDir = path.join(root, 'host')

const exit = await new Promise((resolve, reject) => {
  const child = spawn(electron, [path.resolve(args.entry)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DWARFAI_HOST_DATA_DIR: hostDataDir },
    stdio: 'inherit',
    windowsHide: true,
    shell: false
  })
  const timer = setTimeout(() => {
    child.kill()
    resolve('timed-out')
  }, BUDGET_MS)
  child.once('error', (error) => {
    clearTimeout(timer)
    reject(error)
  })
  child.once('exit', (code) => {
    clearTimeout(timer)
    resolve({ code })
  })
})

const result = verdict({
  rid,
  exit,
  bound: {
    identityFile: existsSync(path.join(hostDataDir, 'run', 'host.identity')),
    uiToken: existsSync(path.join(hostDataDir, 'run', 'ui.token'))
  }
})
rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
if (result.ok) {
  console.log(`check-elevated-refusal: ${result.message}`)
} else {
  console.error(`::error::check-elevated-refusal: ${result.message}`)
  process.exitCode = 1
}
