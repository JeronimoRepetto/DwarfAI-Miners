#!/usr/bin/env node
// The provider scan before packaging (`20` §2.3 P-03, §8 R-05; ADR-008 items 1-2; ADR-009 D5; OQ-52; ISSUE-273):
// the provider list of provider-scan.list.json over the lockfile's production dependencies and over the production
// sources, so a provider CLI, the Agent SDK or `claude-agent-acp` stops the build before electron-builder starts,
// and so does a production source that reads a provider's credential store or runs a provider login of its own.
//
//   node scripts/release/lockfile-provider-scan.mjs [--root <repo root>]
//
// It prints every package that passes by the legacy allowance (`allowed: <name>@<version> ...`), one line per
// finding, and exits 1 on any finding or allowance error. It reads files only. The packaged check P-03
// (packaged/p03-no-provider-binaries.packaged.mjs) runs the same list over every packed app, and both read the one
// legacy allowance, provider-scan.allowance.json, through checkAllowance below. Since ISSUE-184 deleted the legacy
// Agent SDK path (step 3a) the allowance is closed: it is empty, and any entry fails.
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(here, '..', '..')

/** The only pattern the allowance may ever hold; it can only shrink from here, to empty (review R7B-10). */
const ALLOWABLE_PATTERNS = new Set(['@anthropic-ai/claude-agent-sdk*'])

export async function loadScanList(file = path.join(here, 'provider-scan.list.json')) {
  return JSON.parse(await readFile(file, 'utf8'))
}

export async function loadAllowance(file = path.join(here, 'provider-scan.allowance.json')) {
  return JSON.parse(await readFile(file, 'utf8'))
}

// A list pattern: `*` at the end matches any suffix, `@*/` at the start matches any scope.
function matches(name, pattern) {
  const anyScope = pattern.startsWith('@*/')
  const subject = anyScope ? name.replace(/^@[^/]+\//, '@*/') : name
  if (anyScope && subject === name) return false
  return pattern.endsWith('*') ? subject.startsWith(pattern.slice(0, -1)) : subject === pattern
}

/** The list pattern a package name matches, or null. */
export function forbiddenPackage(name, list) {
  return list.packages.find((pattern) => matches(name, pattern)) ?? null
}

/** The provider executable a file name is, whatever its case and executable extension, or null. */
export function forbiddenExecutable(fileName, list) {
  const lower = fileName.toLowerCase()
  const extension = path.extname(lower)
  if (extension !== '' && !list.executableExtensions.includes(extension)) return null
  const stem = lower.slice(0, lower.length - extension.length)
  return list.executables.includes(stem) ? stem : null
}

/**
 * Checks the legacy allowance. It returns its errors and the entries that apply, which are none: the allowance held
 * only while the legacy Agent SDK path existed, and ISSUE-184 deleted it (step 3a; 21 §2 row 3a), so a non-empty
 * allowance is an error itself. AMENDED for ISSUE-184 (was: an entry applied while `LEGACY_SDK_PATH`,
 * `src/main/sessionLaunch/sdkHeldSession.ts`, existed under `rootDir`); the second argument is kept for the callers.
 */
export function checkAllowance(allowance, _tree = {}) {
  const errors = []
  const seen = new Set()
  for (const entry of allowance.entries ?? []) {
    const pattern = entry?.pattern
    if (!ALLOWABLE_PATTERNS.has(pattern)) {
      errors.push(
        `allowance entry ${pattern} is not allowed: only ${[...ALLOWABLE_PATTERNS].join(', ')} may pass`
      )
    } else if (seen.has(pattern)) {
      errors.push(`allowance entry ${pattern} is listed twice`)
    } else if (!entry.reason || !entry.removedBy) {
      errors.push(`allowance entry ${pattern} needs a reason and a removedBy step`)
    }
    seen.add(pattern)
  }
  if (errors.length === 0) {
    for (const entry of allowance.entries ?? []) {
      errors.push(
        `the legacy allowance is closed: ISSUE-184 deleted the Agent SDK path (step 3a), remove ${entry.pattern} (removedBy ${entry.removedBy})`
      )
    }
  }
  return { errors, entries: [] }
}

/** The allowance entry a package name passes by, or null. */
export function allowanceFor(name, entries) {
  return entries.find((entry) => matches(name, entry.pattern)) ?? null
}

/**
 * The pnpm lockfile as nested maps. A pnpm 9 lockfile is block YAML of `key: value` and `key:` lines only (flow
 * values such as `{integrity: ...}` stay raw strings, which this scan never reads), so indentation is its structure.
 */
function parseLockfile(text) {
  const root = {}
  const stack = [{ indent: -1, node: root }]
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const match = /^('(?:[^']|'')*'|"[^"]*"|[^:]+):(?:\s+(.*))?$/.exec(line.trim())
    if (!match) continue
    const key = match[1]
      .replace(/^'(.*)'$/s, (_, inner) => inner.replace(/''/g, "'"))
      .replace(/^"(.*)"$/s, '$1')
    while (stack.at(-1).indent >= indent) stack.pop()
    const parent = stack.at(-1).node
    if (match[2] === undefined || match[2] === '') {
      parent[key] = {}
      stack.push({ indent, node: parent[key] })
    } else {
      parent[key] = match[2].replace(/^'(.*)'$/, '$1')
    }
  }
  return root
}

/**
 * Scans the production dependencies of the lockfile's root importer (`dependencies` and `optionalDependencies`,
 * followed through every snapshot's own dependencies; `devDependencies` never ship). A package that passes by the
 * allowance is reported in `allowed`, and its own dependencies are still scanned.
 */
export function scanLockfile({ lockfileText, list, allowance }) {
  const lock = parseLockfile(lockfileText)
  const importer = lock.importers?.['.'] ?? {}
  const snapshots = lock.snapshots ?? {}
  const queue = []
  for (const kind of ['dependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(importer[kind] ?? {}))
      queue.push([name, spec.version])
  }
  const seen = new Set()
  const findings = []
  const allowed = []
  while (queue.length > 0) {
    const [name, version] = queue.shift()
    if (typeof version !== 'string' || version.startsWith('link:')) continue
    const key = `${name}@${version}`
    if (seen.has(key)) continue
    seen.add(key)
    const label = `${name}@${version.replace(/\(.*$/, '')}`
    const pattern = forbiddenPackage(name, list)
    const entry = pattern === null ? null : allowanceFor(name, allowance)
    if (entry !== null)
      allowed.push({ name, where: label, pattern: entry.pattern, removedBy: entry.removedBy })
    else if (pattern !== null) findings.push({ kind: 'package', name, where: label, pattern })
    const snapshot = snapshots[key] ?? {}
    for (const kind of ['dependencies', 'optionalDependencies']) {
      for (const [child, childVersion] of Object.entries(snapshot[kind] ?? {}))
        queue.push([child, childVersion])
    }
  }
  return { findings, allowed, scannedPackages: seen.size }
}

/** Test code and doubles, which never ship (the R14 paths of .dependency-cruiser.cjs, plus contract suites). */
const TEST_CODE = /\.test\.|\.contract\.ts$|\/testing\/|\/fakes\//
const SOURCE_FILE = /\.(ts|mts|cts|js|mjs|cjs|vue)$/

/**
 * The string literals of a script: quoted strings and whole template literals, never comments, so a comment that
 * names a store it never reads is not a finding. A `.vue` file contributes only its `<script>` blocks.
 */
function stringLiterals(code) {
  const literals = []
  let i = 0
  while (i < code.length) {
    const char = code[i]
    if (char === '/' && code[i + 1] === '/') {
      i = code.indexOf('\n', i)
      if (i === -1) break
    } else if (char === '/' && code[i + 1] === '*') {
      i = code.indexOf('*/', i + 2)
      if (i === -1) break
      i += 2
    } else if (char === "'" || char === '"' || char === '`') {
      let end = i + 1
      while (end < code.length && code[end] !== char && (char === '`' || code[end] !== '\n')) {
        end += code[end] === '\\' ? 2 : 1
      }
      literals.push(code.slice(i + 1, end))
      i = end + 1
    } else {
      i += 1
    }
  }
  return literals
}

function scriptOf(file, text) {
  if (!file.endsWith('.vue')) return text
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map((block) => block[1])
    .join('\n')
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

/**
 * Scans every production source under `<rootDir>/src` for a provider credential location (`credentialLocations`)
 * or a provider login endpoint (`loginEndpoints`) inside a string literal (ADR-008 item 2).
 */
export async function scanSources({ rootDir, list }) {
  const findings = []
  let scannedFiles = 0
  for await (const file of walk(path.join(rootDir, 'src'))) {
    const relative = path.relative(rootDir, file).split(path.sep).join('/')
    if (!SOURCE_FILE.test(relative) || TEST_CODE.test(relative)) continue
    scannedFiles += 1
    const literals = stringLiterals(scriptOf(relative, await readFile(file, 'utf8')))
    for (const [kind, needles] of [
      ['credential', list.credentialLocations],
      ['login', list.loginEndpoints]
    ]) {
      for (const needle of needles) {
        if (literals.some((literal) => literal.includes(needle)))
          findings.push({ kind, name: needle, where: relative })
      }
    }
  }
  return { findings, scannedFiles }
}

function parseArgs(argv) {
  const args = { rootDir: REPO_ROOT }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      args.rootDir = path.resolve(argv[i + 1])
      i += 1
    }
  }
  return args
}

async function main() {
  const { rootDir } = parseArgs(process.argv.slice(2))
  const list = await loadScanList()
  const { errors, entries } = checkAllowance(await loadAllowance(), { rootDir })
  for (const error of errors) console.error(`allowance error: ${error}`)
  const lockfileText = await readFile(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8')
  const lock = scanLockfile({ lockfileText, list, allowance: entries })
  const sources = await scanSources({ rootDir, list })
  for (const { where, pattern, removedBy } of lock.allowed) {
    console.log(`allowed: ${where} by the legacy allowance ${pattern} (removedBy ${removedBy})`)
  }
  const findings = [...lock.findings, ...sources.findings]
  for (const { kind, name, where } of findings) console.error(`FAIL ${kind} ${name}: ${where}`)
  if (errors.length > 0 || findings.length > 0) return 1
  console.log(
    `provider scan ok: ${lock.scannedPackages} production packages, ${sources.scannedFiles} source files, ` +
      `no provider binary, Agent SDK, claude-agent-acp, provider CLI package, credential store or login`
  )
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
