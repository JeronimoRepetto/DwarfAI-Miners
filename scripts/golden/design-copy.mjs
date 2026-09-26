/*
 * `pnpm golden:design`: creates or refreshes `.design/`, a gitignored real COPY of the design
 * repository inside this checkout, so goldens run in a worktree too (PO ruling G-02, 2026-09-26).
 *
 * Never a link. `git worktree remove --force` follows a junction and empties its target; that
 * emptied a real folder on 2026-09-23. So the target is refused when it is a link, every link met
 * inside the source is skipped rather than recreated, and the copy is plain file bytes.
 *
 * The source is `DWARFAI_DESIGN_REPO` when set, else the main worktree's
 * `docs/dwarfai-miners-design` junction (git lists the main worktree first), whose target is the
 * design repository's `docs/`. Only what a golden run reads is copied: the docs with their
 * references, the tools, the stage CSS and the prototype's sample data; no art sources, no
 * node_modules, no .git.
 *
 * The planning half is pure over an injected port and pinned by design-copy.test.mjs; the bottom
 * of the file is the thin runner.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { COPY_DIR, DESIGN_ENV, checkRoot, nodeFs } from './design.mjs'

export const COPY_INCLUDE = [
  'docs',
  'tools',
  'prototype/kit.css',
  'prototype/foundations/tokens.css',
  'prototype/data'
]
const EXCLUDED_SEGMENTS = new Set(['node_modules', '.git'])

export function isExcluded(rel) {
  return rel.split('/').some((segment) => EXCLUDED_SEGMENTS.has(segment))
}

export function mainWorktree(porcelain) {
  const line = porcelain.split(/\r?\n/).find((l) => l.startsWith('worktree '))
  return line ? path.resolve(line.slice('worktree '.length).trim()) : null
}

export function findCopySource({ env, porcelain, fs: fsPort }) {
  const configured = (env[DESIGN_ENV] ?? '').trim()
  if (configured) return checkRoot(path.resolve(configured), 'env', fsPort)
  const main = mainWorktree(porcelain)
  if (main) {
    const junction = path.join(main, 'docs', 'dwarfai-miners-design')
    if (fsPort.isDirectory(junction)) {
      return checkRoot(path.dirname(fsPort.realpath(junction)), 'junction', fsPort)
    }
  }
  return { kind: 'absent' }
}

// tree: { kind(p) -> 'file' | 'dir' | 'link' | 'missing', list(p) -> names }
export function planCopy(source, tree) {
  const files = []
  const skippedLinks = []
  const missing = []
  const walk = (rel) => {
    if (isExcluded(rel)) return
    const kind = tree.kind(path.join(source, ...rel.split('/')))
    if (kind === 'file') files.push(rel)
    else if (kind === 'link') skippedLinks.push(rel)
    else if (kind === 'dir') {
      for (const name of tree.list(path.join(source, ...rel.split('/')))) walk(rel + '/' + name)
    }
  }
  for (const rel of COPY_INCLUDE) {
    if (tree.kind(path.join(source, ...rel.split('/'))) === 'missing') missing.push(rel)
    else walk(rel)
  }
  return { files, skippedLinks, missing }
}

const within = (child, parent) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function checkTarget({ source, target, targetKind }) {
  if (targetKind === 'link') {
    return (
      target +
      ' is a link. Remove the link itself (never its contents) and run again: the copy must be real files.'
    )
  }
  if (within(source, target))
    return 'the source ' + source + ' is the copy itself; nothing to copy.'
  if (within(target, source)) return 'the copy ' + target + ' would land inside its own source.'
  return null
}

/* ------------------------------------------------------------------ runner */

const realTree = {
  kind: (p) => {
    try {
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) return 'link'
      return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'missing'
    } catch {
      return 'missing'
    }
  },
  list: (p) => fs.readdirSync(p)
}

function run() {
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const target = path.join(checkout, COPY_DIR)
  let porcelain = ''
  try {
    porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: checkout,
      encoding: 'utf8'
    })
  } catch {
    // Not a git checkout: only the environment variable can name the source.
  }
  const found = findCopySource({ env: process.env, porcelain, fs: nodeFs })
  if (found.kind === 'absent') {
    throw new Error(
      'no design repository to copy from. Set ' +
        DESIGN_ENV +
        " to its root, or run this where the main checkout's docs/dwarfai-miners-design junction exists."
    )
  }
  if (found.kind === 'invalid') {
    throw new Error(
      found.root + ' is not the design repository; missing ' + found.missing.join(', ')
    )
  }
  const refusal = checkTarget({ source: found.root, target, targetKind: realTree.kind(target) })
  if (refusal) throw new Error(refusal)

  const plan = planCopy(found.root, realTree)
  if (plan.missing.length) {
    throw new Error(found.root + ' lacks ' + plan.missing.join(', ') + '; nothing was copied.')
  }
  fs.rmSync(target, { recursive: true, force: true })
  for (const rel of plan.files) {
    const to = path.join(target, ...rel.split('/'))
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(path.join(found.root, ...rel.split('/')), to)
  }
  console.log(
    'golden:design: copied ' +
      plan.files.length +
      ' files into ' +
      COPY_DIR +
      '/ (' +
      found.source +
      ').'
  )
  for (const rel of plan.skippedLinks) console.log('golden:design: skipped the link ' + rel)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    run()
  } catch (err) {
    console.error('golden:design: ' + err.message)
    process.exitCode = 1
  }
}
