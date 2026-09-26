/*
 * Where the golden UI tests (#634) find the private design repository, and whether a run may go
 * ahead without it.
 *
 * The references, the capture tools and the stage framing CSS live only in that repository and
 * are read at run time; nothing of the design is ever copied into this public tree. Three places
 * are tried, most explicit first, and a place that is configured but has the wrong shape FAILS
 * instead of letting the search fall through to the next one: a mistyped path that silently found
 * another copy would grade against references nobody meant (PO ruling G-02, 2026-09-26).
 *
 *   1. `DWARFAI_DESIGN_REPO`, the repository's root. Blank counts as unset, as in the config
 *      layers.
 *   2. `.design/` inside this checkout: a gitignored real COPY made by `pnpm golden:design`
 *      (design-copy.mjs), which is how a worktree gets goldens. Never a link.
 *   3. The main checkout's `docs/dwarfai-miners-design` junction, whose target is the design
 *      repository's `docs/`; its parent is the root. Only in the main checkout (`.git` is a
 *      directory there and a file in a worktree), because only the main checkout has it.
 *
 * Locally a missing design is a failure naming the command that fixes it: goldens must always
 * pass, worktrees included. Only CI skips, because the references never leave the maintainer's
 * machine.
 *
 * Pure apart from `nodeFs`: every filesystem question goes through the injected port, so the
 * ordinary suite pins all of this on every OS without a design repository.
 */
import fs from 'node:fs'
import path from 'node:path'

export const DESIGN_ENV = 'DWARFAI_DESIGN_REPO'
export const COPY_DIR = '.design'
export const FIX_COMMAND = 'pnpm golden:design'
const JUNCTION = ['docs', 'dwarfai-miners-design']

// What a run reads from the design repository; a root without all of them is the wrong shape.
export const REQUIRED_FILES = [
  'docs/reference/manifest.json',
  'docs/reference/capture.json',
  'tools/lib/cdp.js',
  'tools/lib/capture.js',
  'tools/compare-ref.js',
  'tools/snap-runtime.js',
  'prototype/kit.css',
  'prototype/foundations/tokens.css'
]

export const nodeFs = {
  isFile: (p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  },
  isDirectory: (p) => {
    try {
      return fs.statSync(p).isDirectory()
    } catch {
      return false
    }
  },
  realpath: (p) => fs.realpathSync(p)
}

export function missingFiles(root, fsPort) {
  return REQUIRED_FILES.filter((rel) => !fsPort.isFile(path.join(root, ...rel.split('/'))))
}

export function checkRoot(root, source, fsPort) {
  const missing = missingFiles(root, fsPort)
  return missing.length
    ? { kind: 'invalid', root, source, missing }
    : { kind: 'found', root, source }
}

export function locateDesign({ checkout, env, fs: fsPort }) {
  const configured = (env[DESIGN_ENV] ?? '').trim()
  if (configured) return checkRoot(path.resolve(configured), 'env', fsPort)

  const copy = path.join(checkout, COPY_DIR)
  if (fsPort.isDirectory(copy)) return checkRoot(copy, 'copy', fsPort)

  const junction = path.join(checkout, ...JUNCTION)
  if (fsPort.isDirectory(path.join(checkout, '.git')) && fsPort.isDirectory(junction)) {
    return checkRoot(path.dirname(fsPort.realpath(junction)), 'junction', fsPort)
  }
  return { kind: 'absent' }
}

export function isCi(env) {
  const value = (env.CI ?? '').trim().toLowerCase()
  return value !== '' && value !== 'false' && value !== '0'
}

const SOURCE_NAMES = {
  env: DESIGN_ENV,
  copy: 'the design copy in ' + COPY_DIR + '/',
  junction: "the main checkout's docs junction"
}
const SOURCE_FIXES = {
  env: 'Point ' + DESIGN_ENV + " at the design repository's root.",
  copy: 'Run `' + FIX_COMMAND + '` to refresh it.',
  junction:
    "Relink docs/dwarfai-miners-design to the design repository's docs/, or set " + DESIGN_ENV + '.'
}

export function decide(location, env) {
  if (location.kind === 'found') return { action: 'run', message: '' }
  if (location.kind === 'invalid') {
    return {
      action: 'fail',
      message:
        'golden: ' +
        SOURCE_NAMES[location.source] +
        ' (' +
        location.root +
        ') is not the design repository; missing ' +
        location.missing.join(', ') +
        '. ' +
        SOURCE_FIXES[location.source]
    }
  }
  if (isCi(env)) {
    return {
      action: 'skip',
      message:
        "golden: skipped on CI, which has no design repository (the references never leave the maintainer's machine)."
    }
  }
  return {
    action: 'fail',
    message:
      'golden: no design repository found. Run `' +
      FIX_COMMAND +
      '` to copy it into ' +
      COPY_DIR +
      '/ (it finds the design through ' +
      DESIGN_ENV +
      " or the main checkout's docs junction), or set " +
      DESIGN_ENV +
      " to the design repository's root."
  }
}
