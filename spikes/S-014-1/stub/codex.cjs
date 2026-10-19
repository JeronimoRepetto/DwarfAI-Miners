'use strict'
// Spike S-014-1: a stand-in for an observed provider CLI (17 §1.8: processes under test are stubs, never provider
// CLIs). It is named `codex.cjs` so its command line carries the provider stem `codex`, the way a script-launched
// CLI's does. Started as `node codex.cjs` with no shell, in the folder of the session it "observes".
//
// Environment:
//   S0141_SESSION_FILE  where to write the observed session: one Codex-shaped `session_meta` line whose `cwd` is this
//                       process's working folder and whose `timestamp` is the instant it was written
//   S0141_CHILD=1       also start one child with the same stem in the same folder (a wrapper and its native CLI)
//   S0141_MAX_MS        the cap on its life (default 30000), so a forgotten stub never outlives its test run
//
// Prints `{"ready":<pid>}` once its session line (and its child, when asked) exist; exits when stdin ends.
const { spawn } = process.getBuiltinModule('node:child_process')
const { writeFileSync } = process.getBuiltinModule('node:fs')

const maxMs = Number(process.env.S0141_MAX_MS || 30000)
const cap = setTimeout(() => process.exit(0), Number.isFinite(maxMs) ? maxMs : 30000)
let child = null

/** Ends after its child did, so no process of this stub still holds the working folder when the test removes it. */
function end() {
  clearTimeout(cap)
  if (child === null || child.exitCode !== null) process.exit(0)
  child.once('exit', () => process.exit(0))
  child.stdin.end()
  setTimeout(() => process.exit(0), 5000).unref()
}

function ready() {
  process.stdout.write(`${JSON.stringify({ ready: process.pid })}\n`)
}

if (process.env.S0141_SESSION_FILE) {
  const now = new Date().toISOString()
  const line = {
    timestamp: now,
    type: 'session_meta',
    payload: {
      id: '00000000-0000-4000-8000-000000000141',
      timestamp: now,
      cwd: process.cwd(),
      originator: 'dwarfai_spike_s0141',
      source: 'cli'
    }
  }
  writeFileSync(process.env.S0141_SESSION_FILE, `${JSON.stringify(line)}\n`)
}

if (process.env.S0141_CHILD === '1') {
  const env = { ...process.env }
  delete env.S0141_CHILD
  delete env.S0141_SESSION_FILE
  child = spawn(process.execPath, [__filename], {
    cwd: process.cwd(),
    env,
    shell: false,
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true
  })
  child.stdout.once('data', ready)
} else {
  ready()
}

process.stdin.on('end', end)
process.stdin.resume()
