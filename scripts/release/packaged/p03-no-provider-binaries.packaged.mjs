// P-03 (`20` §2.3, §8 R-05; ADR-008 item 1; ADR-009 D5; OQ-52; `18` C-35; ISSUE-273): no provider binary, no Agent
// SDK and no `claude-agent-acp` in the artifact. Every packed app electron-builder left in the artifact folder (each
// `*-unpacked` folder and `.app` bundle, the trees every archive target of that OS is built from) is scanned whole:
// its files on disk, `app.asar.unpacked` among them, and the files inside each `app.asar`. A file fails by its name
// (a provider executable of provider-scan.list.json, whatever its case and executable extension), a package by its
// manifest name or by its `node_modules` folder. Packages of the one legacy allowance pass, with everything they
// carry, while the legacy Agent SDK path exists, and the detail names them; a folder with no packed app fails, so a
// broken build never passes. It reads files only.
import { open, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  REPO_ROOT,
  allowanceFor,
  checkAllowance,
  forbiddenExecutable,
  forbiddenPackage,
  loadAllowance,
  loadScanList
} from '../lockfile-provider-scan.mjs'

export const id = 'P-03'

/** A folder on disk as the scan's tree: children by name, each a folder or a file whose bytes can be read. */
async function diskNode(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const children = new Map()
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    // Symbolic links (the frameworks of a macOS `.app`) point inside the same bundle: never followed.
    if (entry.isDirectory()) children.set(entry.name, { dir: () => diskNode(full) })
    else if (entry.isFile()) children.set(entry.name, { read: () => readFile(full), disk: full })
  }
  return children
}

/**
 * The tree inside an asar archive (the @electron/asar layout: an 8-byte size pickle holding the header pickle's
 * length; the header pickle's string, at byte 16, is the JSON header; a file's bytes start at
 * `8 + headerSize + offset`). Entries marked `unpacked` live in `app.asar.unpacked`, which the disk walk scans.
 */
async function asarNode(file) {
  const handle = await open(file, 'r')
  try {
    const prefix = Buffer.alloc(16)
    await handle.read(prefix, 0, 16, 0)
    const headerSize = prefix.readUInt32LE(4)
    const json = Buffer.alloc(prefix.readUInt32LE(12))
    await handle.read(json, 0, json.length, 16)
    const header = JSON.parse(json.toString('utf8'))
    const base = 8 + headerSize
    const toNode = (files) => {
      const children = new Map()
      for (const [name, entry] of Object.entries(files)) {
        if (entry.unpacked || entry.link !== undefined) continue
        if (entry.files) children.set(name, { dir: async () => toNode(entry.files) })
        else
          children.set(name, {
            read: () => readRange(file, base + Number(entry.offset), entry.size)
          })
      }
      return children
    }
    return toNode(header.files)
  } finally {
    await handle.close()
  }
}

async function readRange(file, position, size) {
  const handle = await open(file, 'r')
  try {
    const bytes = Buffer.alloc(size)
    await handle.read(bytes, 0, size, position)
    return bytes
  } finally {
    await handle.close()
  }
}

/** The package names a folder is: its manifest's `name` and, inside `node_modules`, its folder name. */
async function packageNames(children, segments) {
  const names = new Set()
  const manifest = children.get('package.json')
  if (manifest?.read) {
    try {
      const { name } = JSON.parse((await manifest.read()).toString('utf8'))
      if (typeof name === 'string') names.add(name)
    } catch {
      // Not a package manifest (a fixture, a template): the folder name below still counts.
    }
  }
  const [last, parent, grandparent] = [segments.at(-1), segments.at(-2), segments.at(-3)]
  if (parent === 'node_modules' && last !== undefined && !last.startsWith('@')) names.add(last)
  if (grandparent === 'node_modules' && parent?.startsWith('@')) names.add(`${parent}/${last}`)
  return [...names]
}

/**
 * Scans the packed apps in `artifactDir` against `list`, letting the packages of the effective `allowance` entries
 * pass. Returns the findings, the packages that passed by the allowance, the packages scanned and the apps found.
 */
export async function scanArtifact({ artifactDir, list, allowance }) {
  const result = { findings: [], allowed: [], scannedPackages: 0, apps: 0 }

  async function visit(children, segments, where, allowedBy) {
    let entry = allowedBy
    const names = await packageNames(children, segments)
    if (names.length > 0) {
      result.scannedPackages += 1
      for (const name of names) {
        if (forbiddenPackage(name, list) === null) continue
        const passing = allowanceFor(name, allowance)
        if (passing !== null) {
          result.allowed.push({ kind: 'package', name, where, removedBy: passing.removedBy })
          entry = passing
        } else {
          result.findings.push({ kind: 'package', name, where })
        }
        break
      }
    }
    for (const [name, child] of [...children].sort(([a], [b]) => a.localeCompare(b))) {
      const childWhere = `${where}/${name}`
      if (child.dir) {
        // A package's own dependencies are packages of their own, allowed or not.
        await visit(
          await child.dir(),
          [...segments, name],
          childWhere,
          name === 'node_modules' ? null : entry
        )
      } else if (name === 'app.asar' && child.disk) {
        result.apps += 1
        await visit(await asarNode(child.disk), [], childWhere, null)
      } else if (entry === null) {
        const executable = forbiddenExecutable(name, list)
        if (executable !== null)
          result.findings.push({ kind: 'executable', name: executable, where: childWhere })
      }
    }
  }

  await visit(await diskNode(artifactDir), [], path.basename(artifactDir), null)
  return result
}

export default async function check({ artifactDir }) {
  const list = await loadScanList()
  const { errors, entries } = checkAllowance(await loadAllowance(), { rootDir: REPO_ROOT })
  if (errors.length > 0) return { ok: false, detail: errors.join('; ') }
  const { findings, allowed, scannedPackages, apps } = await scanArtifact({
    artifactDir,
    list,
    allowance: entries
  })
  if (apps === 0) return { ok: false, detail: `no packed app (app.asar) in ${artifactDir}` }
  if (findings.length > 0) {
    return {
      ok: false,
      detail: findings.map(({ kind, name, where }) => `${kind} ${name} at ${where}`).join('; ')
    }
  }
  const passing = [...new Set(allowed.map(({ name }) => name))].sort()
  return {
    ok: true,
    detail:
      `${apps} packed apps, ${scannedPackages} packages, no provider binary, Agent SDK, claude-agent-acp or ` +
      `provider CLI package` +
      (passing.length > 0 ? `; passed by the legacy allowance: ${passing.join(', ')}` : '')
  }
}
