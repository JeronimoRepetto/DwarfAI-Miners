#!/usr/bin/env node
// The production-dependency licence report (20 §2.4, §2.5; 18 C-35, C-36; ISSUE-272).
//
//   node scripts/release/licenses.mjs [--root <dir>] [--out <dir>]
//
// Reads the root importer's `dependencies` and `optionalDependencies` from pnpm-lock.yaml, follows them through the
// lockfile's snapshots, and reads each package's licence from its installed package.json in the pnpm virtual store
// (node_modules/.pnpm). Nothing is fetched: the lockfile and the installed metadata are the only inputs. Writes
// <out>/licenses.json (default release/licenses/) and exits 1 when a licence is denied by
// scripts/release/licenses.denied.json, is not an SPDX expression, or cannot be read, or when package.json does not
// state the product licence.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { allowanceFor, checkAllowance } from './lockfile-provider-scan.mjs'

/** The product licence (OQ-52, `20` §2.4). */
export const PRODUCT_LICENSE = 'GPL-3.0-or-later'

export const DENIED_FILE = path.join('scripts', 'release', 'licenses.denied.json')
export const DEFAULT_OUT = path.join('release', 'licenses')
export const REPORT_FILE = 'licenses.json'
export const ALLOWANCE_FILE = path.join('scripts', 'release', 'provider-scan.allowance.json')

/** The denied list: `{ denied: [{ id, why }] }`, as a Set of SPDX ids with the file's own fields kept. */
export function readDenied(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  return { ...parsed, ids: new Set(parsed.denied.map((entry) => entry.id)) }
}

// ---------------------------------------------------------------------------------------------------------------
// The lockfile. pnpm writes lockfile v9 as block YAML: maps nested by two spaces, scalar values, and flow values
// (`{integrity: ...}`, `[x64]`) on one line. That subset is all this reads, so no YAML library is needed.

function unquote(text) {
  const t = text.trim()
  return (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))
    ? t.slice(1, -1)
    : t
}

function scalar(text) {
  const t = text.trim()
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim()
    return inner === '' ? [] : inner.split(',').map(unquote)
  }
  if (t === '{}') return {}
  return unquote(t)
}

/** The lockfile as nested objects: `{ importers, packages, snapshots }` and the other top-level keys. */
export function parseLockfile(text) {
  const root = {}
  const stack = [{ indent: -1, node: root }]
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    if (line.startsWith('- ')) {
      // A block sequence item: the key just opened holds a list, not a map.
      while (stack.at(-1).indent >= indent) stack.pop()
      const frame = stack.at(-1)
      if (!frame.parent) throw new Error(`pnpm-lock.yaml: a list item outside a key: "${line}"`)
      if (!Array.isArray(frame.node)) {
        frame.node = []
        frame.parent[frame.key] = frame.node
      }
      frame.node.push(scalar(line.slice(2)))
      continue
    }
    // A quoted key ends at its closing quote; a plain key at the first ": " or a trailing ":".
    const match = line.match(/^('[^']*'|"[^"]*"|.+?):(?: +(.*))?$/)
    if (!match) throw new Error(`pnpm-lock.yaml: cannot read line "${line}"`)
    while (stack.at(-1).indent >= indent) stack.pop()
    const parent = stack.at(-1).node
    const key = unquote(match[1])
    if (match[2] === undefined || match[2].trim() === '') {
      parent[key] = {}
      stack.push({ indent, node: parent[key], parent, key })
    } else {
      parent[key] = scalar(match[2])
    }
  }
  return { importers: {}, packages: {}, snapshots: {}, ...root }
}

/** `1.0.0(peer@2.0.0)` → `1.0.0`: the package version without pnpm's peer suffix. */
function bareVersion(version) {
  const at = version.indexOf('(')
  return at === -1 ? version : version.slice(0, at)
}

function edges(entry) {
  return [
    ...Object.entries(entry?.dependencies ?? {}),
    ...Object.entries(entry?.optionalDependencies ?? {})
  ].map(([name, value]) => [name, typeof value === 'string' ? value : value.version])
}

/**
 * Every package the root importer's `dependencies` and `optionalDependencies` reach, as `{ name, version }`
 * sorted by name then version; one entry per name and version, whatever peers it resolved with. Linked
 * workspace packages (`link:`) are the project's own code and are skipped.
 */
export function productionPackages(lock) {
  const seen = new Map()
  const queue = edges(lock.importers['.'])
  while (queue.length > 0) {
    const [name, version] = queue.shift()
    if (version.startsWith('link:') || version.startsWith('file:')) continue
    const snapshotKey = `${name}@${version}`
    if (seen.has(snapshotKey)) continue
    seen.set(snapshotKey, { name, version: bareVersion(version) })
    queue.push(...edges(lock.snapshots[snapshotKey]))
  }
  const unique = new Map([...seen.values()].map((p) => [`${p.name}@${p.version}`, p]))
  return [...unique.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name < b.name ? -1 : 1
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Installed metadata.

/**
 * Each package installed in the pnpm virtual store, keyed `name@version`, with its folder and package.json. A
 * store folder's `node_modules` holds the package itself and links to its dependencies; only the real folder is
 * read, so a link never stands in for the package it points at.
 */
export function indexInstalled(rootDir) {
  const store = path.join(rootDir, 'node_modules', '.pnpm')
  const installed = new Map()
  if (!existsSync(store)) return installed
  const read = (dir) => {
    const manifest = path.join(dir, 'package.json')
    if (!existsSync(manifest)) return
    const json = JSON.parse(readFileSync(manifest, 'utf8'))
    if (json.name && json.version)
      installed.set(`${json.name}@${json.version}`, { dir, manifest: json })
  }
  for (const entry of readdirSync(store)) {
    const modules = path.join(store, entry, 'node_modules')
    if (!existsSync(modules)) continue
    for (const name of readdirSync(modules)) {
      const full = path.join(modules, name)
      if (lstatSync(full).isSymbolicLink()) continue
      if (name.startsWith('@')) {
        for (const scoped of readdirSync(full)) {
          const inner = path.join(full, scoped)
          if (!lstatSync(inner).isSymbolicLink()) read(inner)
        }
      } else if (!name.startsWith('.')) {
        read(full)
      }
    }
  }
  return installed
}

/** A package.json's licence as one string: `license`, the old `license: { type }`, or the old `licenses` array. */
export function licenceOf(manifest) {
  if (typeof manifest.license === 'string') return manifest.license.trim() || null
  if (manifest.license && typeof manifest.license.type === 'string') return manifest.license.type
  if (Array.isArray(manifest.licenses) && manifest.licenses.length > 0) {
    const types = manifest.licenses
      .map((l) => (typeof l === 'string' ? l : l?.type))
      .filter(Boolean)
    return types.length > 1 ? `(${types.join(' OR ')})` : (types[0] ?? null)
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// SPDX expressions.

const ID = /^(?:LicenseRef-[A-Za-z0-9.-]+|[A-Za-z0-9][A-Za-z0-9.-]*\+?)$/

function tokenize(expression) {
  return expression.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').split(/\s+/).filter(Boolean)
}

/** Parses an SPDX expression to a tree, or returns null when it is not one. */
function parseSpdx(expression) {
  const tokens = tokenize(expression)
  let at = 0
  const peek = () => tokens[at]
  function primary() {
    const token = tokens[at++]
    if (token === '(') {
      const inner = or()
      if (tokens[at++] !== ')') throw new Error('unclosed')
      return inner
    }
    if (!token || ['AND', 'OR', 'WITH', ')'].includes(token) || !ID.test(token))
      throw new Error('id')
    if (peek() === 'WITH') {
      at++
      const exception = tokens[at++]
      if (!exception || !ID.test(exception)) throw new Error('exception')
    }
    return { id: token.endsWith('+') ? token.slice(0, -1) : token }
  }
  function and() {
    const terms = [primary()]
    while (peek() === 'AND') {
      at++
      terms.push(primary())
    }
    return terms.length === 1 ? terms[0] : { and: terms }
  }
  function or() {
    const terms = [and()]
    while (peek() === 'OR') {
      at++
      terms.push(and())
    }
    return terms.length === 1 ? terms[0] : { or: terms }
  }
  try {
    const tree = or()
    return at === tokens.length ? tree : null
  } catch {
    return null
  }
}

/** The denied ids a tree cannot avoid: every denied term of an AND, and of an OR only when all choices are denied. */
function unavoidable(tree, ids) {
  if (tree.id) return ids.has(tree.id) ? [tree.id] : []
  if (tree.and) return tree.and.flatMap((t) => unavoidable(t, ids))
  const choices = tree.or.map((t) => unavoidable(t, ids))
  return choices.some((c) => c.length === 0) ? [] : choices.flat()
}

/**
 * The verdict on one licence expression: `allowed`, `denied` (with the ids that cannot be avoided) or `unknown`
 * when it is not an SPDX expression. A WITH exception never removes a denial of its base licence.
 */
export function judgeLicence(expression, denied) {
  const tree =
    typeof expression === 'string' && expression.trim() !== '' ? parseSpdx(expression) : null
  if (!tree) return { verdict: 'unknown' }
  const hits = unavoidable(tree, denied.ids)
  return hits.length > 0 ? { verdict: 'denied', denied: hits } : { verdict: 'allowed' }
}

// ---------------------------------------------------------------------------------------------------------------
// The report.

/**
 * The licence report of a project: the product line, one row per production package, the failures, and the
 * packages that pass only by the legacy allowance. `installed` may be passed in when the caller already indexed the
 * store.
 *
 * `allowance` is ISSUE-273's provider-scan.allowance.json, checked by its own checkAllowance: while the legacy Agent
 * SDK path exists, a package it names (only `@anthropic-ai/claude-agent-sdk*`) whose licence would fail is listed in
 * `allowed` with verdict `allowance` instead, never hidden. Once that path is gone the allowance is stale: that is a
 * failure, and the packages fail on their licence again.
 */
export function buildLicenceReport({
  rootDir,
  denied,
  allowance = null,
  installed = indexInstalled(rootDir)
}) {
  const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
  const lock = parseLockfile(readFileSync(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8'))
  const failures = []
  if (pkg.license !== PRODUCT_LICENSE) {
    failures.push(`package.json license is "${pkg.license}", but the product is ${PRODUCT_LICENSE}`)
  }
  const allowed = []
  let entries = []
  if (allowance) {
    const checked = checkAllowance(allowance, { rootDir })
    failures.push(...checked.errors.map((error) => `allowance: ${error}`))
    entries = checked.entries
  }
  const packages = productionPackages(lock).map(({ name, version }) => {
    const key = `${name}@${version}`
    const found = installed.get(key)
    if (!found) {
      failures.push(`${key}: not installed, so its licence cannot be read`)
      return { name, version, license: null, verdict: 'unknown', dir: null }
    }
    const license = licenceOf(found.manifest)
    if (license === null) {
      failures.push(`${key}: package.json declares no licence`)
      return { name, version, license, verdict: 'unknown', dir: found.dir }
    }
    const judged = judgeLicence(license, denied)
    const entry = judged.verdict === 'allowed' ? null : allowanceFor(name, entries)
    if (entry) {
      allowed.push(`${key} by the legacy allowance ${entry.pattern} (removedBy ${entry.removedBy})`)
      return { name, version, license, verdict: 'allowance', dir: found.dir }
    }
    if (judged.verdict === 'denied') {
      failures.push(`${key}: licence "${license}" is denied (${judged.denied.join(', ')})`)
    } else if (judged.verdict === 'unknown') {
      failures.push(`${key}: licence "${license}" is not an SPDX expression`)
    }
    return { name, version, license, verdict: judged.verdict, dir: found.dir }
  })
  return {
    product: { name: pkg.name, version: pkg.version, license: pkg.license },
    packages,
    allowed,
    failures
  }
}

/** The licenses.json document: no machine paths, so it is the same on every runner. */
export function reportDocument(report) {
  return {
    product: report.product,
    packages: report.packages.map(({ name, version, license, verdict }) => ({
      name,
      version,
      license,
      verdict
    })),
    allowed: report.allowed,
    failures: report.failures
  }
}

/** `--name value` pairs of a command line. */
export function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined)
      throw new Error(`bad argument "${argv[i]}"`)
    args[argv[i].slice(2)] = argv[i + 1]
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const rootDir = path.resolve(args.root ?? '.')
  const out = path.resolve(rootDir, args.out ?? DEFAULT_OUT)
  const report = buildLicenceReport({
    rootDir,
    denied: readDenied(path.join(rootDir, DENIED_FILE)),
    allowance: JSON.parse(readFileSync(path.join(rootDir, ALLOWANCE_FILE), 'utf8'))
  })
  mkdirSync(out, { recursive: true })
  writeFileSync(path.join(out, REPORT_FILE), `${JSON.stringify(reportDocument(report), null, 2)}\n`)
  const counts = {}
  for (const p of report.packages)
    counts[p.license ?? 'none'] = (counts[p.license ?? 'none'] ?? 0) + 1
  console.log(`${report.product.name} ${report.product.version}: ${report.product.license}`)
  console.log(`${report.packages.length} production packages: ${JSON.stringify(counts)}`)
  console.log(`wrote ${path.join(out, REPORT_FILE)}`)
  for (const line of report.allowed) console.log(`allowed: ${line}`)
  for (const failure of report.failures) console.error(`FAIL ${failure}`)
  process.exitCode = report.failures.length > 0 ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
