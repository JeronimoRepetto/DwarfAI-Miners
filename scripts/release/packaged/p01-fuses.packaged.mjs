// P-01 (`20` §2.3; ADR-019 item 5; `18` C-09; ISSUE-269): the Electron fuses of every packaged artifact, read back from
// the binary, equal the set recorded for its target in scripts/release/fuses.expected.json (spike S-019-2), with
// RunAsNode on (ADR-002 D1). A target that silently does not flip a fuse fails the package job.
//
// It reads every packed app electron-builder left in the artifact folder, the trees each archive target of that OS
// (zip, nsis, dmg, AppImage, deb) is built from: in each `win-*unpacked` folder the `.exe` files, in each
// `linux-*unpacked` folder the files with no extension, and in each `mac*` folder the `Electron Framework` of every
// `.app`, where macOS keeps the wire. Of those, every binary that holds a fuse wire is compared; a packed app with
// none fails, and so does a folder with no packed app, so a broken build never passes. The known limits of the
// targets read are printed for the release notes (R-16). It reads files only.
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { expectedFusesFor, loadExpectedFuses } from '../fuses.mjs'
import { compareFuses, readFuseWire } from './fuses.mjs'

export const id = 'P-01'

const UNPACKED = /^(win|linux)(?:-[\w]+)?-unpacked$/
const MAC_OUTPUT = /^mac(?:-[\w]+)?$/
const MAC_FRAMEWORK = [
  'Contents',
  'Frameworks',
  'Electron Framework.framework',
  'Electron Framework'
]

async function entriesOf(dir) {
  return (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
}

/** Every packed app in `artifactDir`: `{ target, where, candidates }`, candidates being the paths that may hold the wire. */
async function findPackedApps(artifactDir) {
  const apps = []
  for (const entry of await entriesOf(artifactDir)) {
    if (!entry.isDirectory()) continue
    const dir = path.join(artifactDir, entry.name)
    const unpacked = UNPACKED.exec(entry.name)
    if (unpacked) {
      const target = unpacked[1] === 'win' ? 'win32' : 'linux'
      const isBinary =
        target === 'win32'
          ? (name) => name.toLowerCase().endsWith('.exe')
          : (name) => !name.includes('.')
      const candidates = (await entriesOf(dir))
        .filter((file) => file.isFile() && isBinary(file.name))
        .map((file) => path.join(dir, file.name))
      apps.push({ target, where: entry.name, candidates })
    } else if (MAC_OUTPUT.test(entry.name)) {
      for (const bundle of await entriesOf(dir)) {
        if (!bundle.isDirectory() || !bundle.name.endsWith('.app')) continue
        apps.push({
          target: 'darwin',
          where: `${entry.name}/${bundle.name}`,
          candidates: [path.join(dir, bundle.name, ...MAC_FRAMEWORK)]
        })
      }
    }
  }
  return apps
}

/** The problems of one binary's wire against its target's expected fuses; empty when it matches. */
function problemsOf(wire, fuses) {
  const problems = []
  if (wire.slicesAgree === false) problems.push('slices disagree')
  for (const { name, expected, actual } of compareFuses(wire.fuses, fuses)) {
    problems.push(`${name} expected ${expected}, found ${actual}`)
  }
  return problems
}

export default async function check({ artifactDir, expected = loadExpectedFuses() }) {
  const apps = await findPackedApps(artifactDir)
  if (apps.length === 0) return { ok: false, detail: `no packed app in ${artifactDir}` }
  const failures = []
  const passed = []
  const limits = new Map()
  for (const { target, where, candidates } of apps) {
    let fuses
    try {
      const recorded = expectedFusesFor(expected, target)
      fuses = recorded.fuses
      for (const { fuse, limit } of recorded.knownLimits) limits.set(`${target}: ${fuse}`, limit)
    } catch (error) {
      failures.push(`${where}: ${error.message}`)
      continue
    }
    let wires = 0
    for (const file of candidates) {
      const bytes = await readFile(file).catch(() => null)
      const wire = bytes === null ? { found: false } : readFuseWire(bytes)
      if (!wire.found) continue
      wires += 1
      const binary = path.relative(artifactDir, file).split(path.sep).join('/')
      const problems = problemsOf(wire, fuses)
      if (problems.length > 0) failures.push(`${binary} (${target}): ${problems.join(', ')}`)
      else passed.push(`${binary} (${target})`)
    }
    if (wires === 0) failures.push(`${where}: no Electron binary with a fuse wire`)
  }
  if (failures.length > 0) return { ok: false, detail: failures.join('; ') }
  const knownLimits = [...limits].map(([key, limit]) => `known limit ${key} (${limit})`)
  return {
    ok: true,
    detail: [
      `${apps.length} packed apps carry their target's recorded fuse set: ${passed.join(', ')}`,
      ...knownLimits
    ].join('; ')
  }
}
