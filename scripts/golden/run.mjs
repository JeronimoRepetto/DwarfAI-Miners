/*
 * `pnpm test:golden` (#634). Decides whether the golden UI tests may run before starting
 * anything: with the design repository found it runs `vitest.golden.config.ts`; without it, it
 * fails locally with the command that fixes it, and on CI it prints one line and exits cleanly,
 * because the references never leave the maintainer's machine (PO ruling G-02, 2026-09-26). A
 * configured location with the wrong shape fails everywhere. design.mjs holds the rules. A found
 * design at any commit but the one design-pin.json names is refused before anything starts.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FIX_COMMAND, decide, locateDesign, nodeFs } from './design.mjs'
import { STAMP_FILE } from './design-copy.mjs'

// The design commit the goldens grade against (21 §6 "Golden tooling"; ADR-034). A run against a
// design at any other commit is refused: its references are not the ones the Panel is judged by.
export const PIN_FILE = 'design-pin.json'
const COMMIT_ID = /^[0-9a-f]{7,40}$/

/** The pinned commit id from design-pin.json's text, lower-cased; anything else throws. */
export function readPin(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  const design = typeof parsed?.design === 'string' ? parsed.design.trim().toLowerCase() : ''
  if (!COMMIT_ID.test(design)) {
    throw new Error(
      'golden: scripts/golden/' +
        PIN_FILE +
        ' must be { "design": "<commit id, 7 to 40 hex digits>" }.'
    )
  }
  return design
}

/** Null when `commit` is the pinned one, else the refusal; an unknown commit is refused too. */
export function checkPin({ pin, commit, root }) {
  if (commit === null) {
    return (
      'golden: cannot tell which design commit ' +
      root +
      ' holds, so it cannot be checked against the pin ' +
      pin +
      '. Run `' +
      FIX_COMMAND +
      '` to refresh the copy with its commit stamp.'
    )
  }
  if (commit.startsWith(pin)) return null
  return (
    'golden: the design at ' +
    root +
    ' is at commit ' +
    commit +
    ', not the pinned ' +
    pin +
    ' (scripts/golden/' +
    PIN_FILE +
    '). Check out the pinned commit in the design repository, then run `' +
    FIX_COMMAND +
    '` for a copy.'
  )
}

/**
 * The commit of the design a run would read, or null when it cannot be known: a repository root
 * answers through `git rev-parse HEAD`; a `.design/` copy, which has no .git, through the stamp
 * `pnpm golden:design` wrote into it.
 */
export function designCommit(location, { git, readFile }) {
  let commit
  try {
    commit =
      location.source === 'copy'
        ? JSON.parse(readFile(path.join(location.root, STAMP_FILE))).commit
        : git(location.root)
  } catch {
    return null
  }
  const id = typeof commit === 'string' ? commit.trim().toLowerCase() : ''
  return /^[0-9a-f]{40}$/.test(id) ? id : null
}

const realGit = (root) =>
  execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })

function main() {
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const location = locateDesign({ checkout, env: process.env, fs: nodeFs })
  const decision = decide(location, process.env)
  const refusal =
    decision.action === 'run'
      ? checkPin({
          pin: readPin(fs.readFileSync(path.join(checkout, 'scripts', 'golden', PIN_FILE), 'utf8')),
          commit: designCommit(location, {
            git: realGit,
            readFile: (p) => fs.readFileSync(p, 'utf8')
          }),
          root: location.root
        })
      : null

  if (refusal) {
    console.error(refusal)
    process.exitCode = 1
  } else if (decision.action === 'skip') {
    console.log(decision.message)
  } else if (decision.action === 'fail') {
    console.error(decision.message)
    process.exitCode = 1
  } else {
    // vitest's package exports hide its bin, so it is found through its package.json.
    const manifest = createRequire(import.meta.url).resolve('vitest/package.json')
    const vitest = path.join(path.dirname(manifest), 'vitest.mjs')
    const result = spawnSync(
      process.execPath,
      [vitest, 'run', '--config', 'vitest.golden.config.ts', ...process.argv.slice(2)],
      { cwd: checkout, stdio: 'inherit' }
    )
    process.exitCode = result.status ?? 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
