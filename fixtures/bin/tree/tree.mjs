#!/usr/bin/env node
// A stub process tree for the killTree OS lane (ISSUE-019; 17 §1.8: processes under test are
// stubs, never provider CLIs). Started as `node tree.mjs <mode> <recordFile> <capMs> [flags]` with
// no shell. Every process appends "<role> <pid>" to <recordFile> once it runs, so the test learns
// the pids, and stays alive until <capMs> pass, so a forgotten stub never outlives its test run.
//
//   terminal   stands for the person's terminal: starts `root` inside its own process group
//   root       starts `child`       (the provider CLI of a session)
//   child      starts `grandchild`
//   grandchild starts nothing
//
// Flags: --grandchild-ignores-term  the grandchild ignores SIGTERM (POSIX), so only SIGKILL ends it.
//
// Children are started with stdio ignored. On Windows they are started detached, which keeps them
// out of libuv's kill-on-close job: a real CLI's own children are not in it either, so the tree
// kill has to reach them itself. On POSIX they stay in the group of whoever started them.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const NEXT = { terminal: 'root', root: 'child', child: 'grandchild', grandchild: null }

const [mode, recordFile, capArg, ...flags] = process.argv.slice(2)
if (!(mode in NEXT) || recordFile === undefined) {
  process.stderr.write(
    `tree: usage: tree.mjs <terminal|root|child|grandchild> <recordFile> <capMs>\n`
  )
  process.exit(2)
}
const capMs = Number.isFinite(Number(capArg)) ? Number(capArg) : 60_000

if (mode === 'grandchild' && flags.includes('--grandchild-ignores-term')) {
  process.on('SIGTERM', () => {})
}

const next = NEXT[mode]
if (next !== null) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), next, recordFile, String(capMs), ...flags],
    { stdio: 'ignore', shell: false, windowsHide: true, detached: process.platform === 'win32' }
  )
  child.unref()
}

appendFileSync(recordFile, `${mode} ${process.pid}\n`)
setTimeout(() => process.exit(0), capMs)
