#!/usr/bin/env node
/**
 * Traceability extractor (testing strategy `17` §3.2).
 *
 * The test title is the only source of "which test proves which requirement": every `it` and
 * `test` title starts with its ids in brackets, `[<id>, <id>…] <behaviour>` (`17` §2.2). This
 * script reads every test file of the repository as text (the census's approach: regex and a small
 * scanner over the file, never importing or executing it), collects the ids of each title and
 * writes `traceability.json`: `{ id → [{ file, title, layer }] }`, a git-ignored build output that
 * `check.mjs` compares with the id catalogs.
 *
 * - Walked: `src/`, `scripts/`, `e2e/`, `spikes/` (the spike harnesses kept as regression
 *   tests, `17` §4) and `perf/` (the perf runner's own test, `17` §1.11). Test data under a
 *   `__fixtures__/` folder (`17` §2.2 "Fixtures") and `node_modules/` are not test files;
 *   symbolic links and junctions are never followed.
 * - Test files (`17` §2.2): `*.test.ts`, `*.test.mjs` (so `*.os.test.*` and `*.golden.test.mjs`),
 *   `*.contract.ts` suites and `*.e2e.ts`.
 * - Layer, from the path and suffix first: `*.os.test.*` → L8 (`17` §1.8), `e2e/**` and `*.e2e.ts`
 *   → L9 (§1.9), `host/platform/sqlite/**` → L5 (§1.5), `*.conformance.test.*` → L4 (§1.4, §3.3),
 *   `*.contract.ts` → L3 (§1.3), `host/modules/<m>/domain/**` and `host/kernel/domain/**` → L1
 *   (§1.1), `host/modules/<m>/application/**` and `host/wiring/flows/**` → L2 (§1.2); else a
 *   `// layer: L<n>` line comment in the file's leading comment block; else `null`.
 *
 * Usage: node scripts/traceability/extract.mjs [--root <repository root>] [--out <file>]
 *   (defaults: this repository, `<root>/traceability.json`)
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WALKED_ROOTS = ['src', 'scripts', 'e2e', 'spikes', 'perf']
const SKIPPED_FOLDERS = new Set(['__fixtures__', 'node_modules'])
const TEST_FILE = /(?:\.test\.(?:ts|mjs)|\.contract\.ts|\.e2e\.ts)$/

/** Path and suffix rules, first match wins (see the header). */
const LAYER_RULES = [
  [/\.os\.test\.(?:ts|mjs)$/, 'L8'],
  [/(?:^e2e\/|\.e2e\.ts$)/, 'L9'],
  [/(?:^|\/)host\/platform\/sqlite\//, 'L5'],
  [/\.conformance\.test\.(?:ts|mjs)$/, 'L4'],
  [/\.contract\.ts$/, 'L3'],
  [/(?:^|\/)host\/(?:modules\/[^/]+|kernel)\/domain\//, 'L1'],
  [/(?:^|\/)host\/(?:modules\/[^/]+\/application|wiring\/flows)\//, 'L2']
]
const LAYER_COMMENT = /^\/\/\s*layer:\s*(L(?:1[0-3]|[1-9]))\s*$/

/** An `it` or `test` call as written; `describe` is not a test, and `.it(` / `submit(` are not it. */
const TEST_CALL = /(?<![\w$.])(?:it|test)\b/g
const CHAIN_MEMBER = /^\s*\.\s*([A-Za-z_$][\w$]*)/

/** Every test file under the walked roots of `root`, as sorted posix paths relative to `root`. */
function testFilesUnder(root) {
  const files = []
  const walk = (relativeDir) => {
    let entries
    try {
      entries = readdirSync(path.join(root, relativeDir), { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const relative = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) walk(relative)
      } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
        files.push(relative)
      }
    }
  }
  for (const walked of WALKED_ROOTS) walk(walked)
  return files.sort()
}

/**
 * The index just past the string or template literal that opens at `start`, or -1 when it does
 * not close.
 */
function skipLiteral(source, start) {
  const quote = source[start]
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === '\\') i += 1
    else if (source[i] === quote) return i + 1
    else if (quote !== '`' && source[i] === '\n') return -1
  }
  return -1
}

/** The index just past the parenthesised argument list that opens at `start`, or -1. */
function skipArguments(source, start) {
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (char === "'" || char === '"' || char === '`') {
      const end = skipLiteral(source, i)
      if (end === -1) return -1
      i = end - 1
    } else if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** The decoded text of the literal between `start` and `end` (quotes included). */
function literalText(source, start, end) {
  return source.slice(start + 1, end - 1).replace(/\\(.)/g, '$1')
}

/**
 * The title of the test call whose `it` / `test` name ends at `index`, or null when the call has
 * no literal title. Modifiers are followed as written: `it.skip(`, `test.only(`,
 * `it.runIf(cond)(`, `it.each(table)(`, `it.each\`table\`(`.
 */
function titleAt(source, index) {
  let i = index
  for (;;) {
    const member = CHAIN_MEMBER.exec(source.slice(i, i + 64))
    if (!member) break
    i += member[0].length
    const next = source.slice(i).match(/^\s*/)[0].length + i
    if (source[next] === '`') {
      const end = skipLiteral(source, next)
      if (end === -1) return null
      i = end
    } else if (source[next] === '(' && /^(?:runIf|skipIf|each|for)$/.test(member[1])) {
      const end = skipArguments(source, next)
      if (end === -1) return null
      i = end
    }
  }
  const open = source.slice(i).match(/^\s*\(\s*/)
  if (!open) return null
  const start = i + open[0].length
  if (!["'", '"', '`'].includes(source[start])) return null
  const end = skipLiteral(source, start)
  return end === -1 ? null : literalText(source, start, end)
}

/** Every literal `it` / `test` title of a test file's text, in order of appearance. */
export function extractTitles(source) {
  const titles = []
  for (const match of source.matchAll(TEST_CALL)) {
    const title = titleAt(source, match.index + match[0].length)
    if (title !== null) titles.push(title)
  }
  return titles
}

/** The ids in the leading brackets of a title, split on commas and trimmed; none without them. */
export function parseIds(title) {
  const bracket = /^\[([^\]]*)\]/.exec(title)
  if (!bracket) return []
  return bracket[1]
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')
}

/** The `// layer: L<n>` value of the file's leading comment block, or null. */
function layerComment(source) {
  let inBlock = false
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (inBlock) {
      if (line.includes('*/')) inBlock = false
      continue
    }
    if (line === '' || line.startsWith('#!')) continue
    if (line.startsWith('/*')) {
      inBlock = !line.includes('*/', 2)
      continue
    }
    if (!line.startsWith('//')) return null
    const layer = LAYER_COMMENT.exec(line)
    if (layer) return layer[1]
  }
  return null
}

/** The test layer (`17` §1) of the test file at `file` (posix, repository-relative). */
export function inferLayer(file, source) {
  for (const [pattern, layer] of LAYER_RULES) {
    if (pattern.test(file)) return layer
  }
  return layerComment(source)
}

/** `{ id → [{ file, title, layer }] }` for every test file of the repository at `root`. */
export function extractTraceability(root) {
  const mapped = new Map()
  for (const file of testFilesUnder(root)) {
    const source = readFileSync(path.join(root, ...file.split('/')), 'utf8')
    const layer = inferLayer(file, source)
    for (const title of extractTitles(source)) {
      for (const id of parseIds(title)) {
        if (!mapped.has(id)) mapped.set(id, new Map())
        mapped.get(id).set(`${file}\n${title}`, { file, title, layer })
      }
    }
  }
  const byFileThenTitle = (a, b) =>
    a.file === b.file ? compare(a.title, b.title) : compare(a.file, b.file)
  return Object.fromEntries(
    [...mapped.keys()]
      .sort(compare)
      .map((id) => [id, [...mapped.get(id).values()].sort(byFileThenTitle)])
  )
}

/** Code-unit order: the same on every OS and locale, so the output is byte-stable. */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.resolve(optionValue(argv, '--root') ?? path.join(here, '..', '..'))
  const out = path.resolve(optionValue(argv, '--out') ?? path.join(root, 'traceability.json'))
  const traceability = extractTraceability(root)
  writeFileSync(out, `${JSON.stringify(traceability, null, 2)}\n`)
  const entries = Object.values(traceability).reduce((sum, list) => sum + list.length, 0)
  process.stdout.write(
    `traceability: ${Object.keys(traceability).length} id(s), ${entries} mapping(s) → ${path.relative(process.cwd(), out) || out}\n`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`traceability extractor: ${error.message}\n`)
    process.exitCode = 1
  }
}
