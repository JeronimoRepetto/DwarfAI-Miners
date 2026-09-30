#!/usr/bin/env node
/**
 * L7 check of the repository-root `fixtures/` tree (testing strategy `17` §1.4, §1.5, §1.9, §2.2).
 *
 * It reads the tree as files and text only (nothing is imported or executed) and reports every
 * file that breaks the fixed layout:
 *
 * - `fixed-folder`: `db/`, `ipc/capabilities/` and `bin/` exist (`17` §2.2, §1.9).
 * - `layout`: a provider fixture sits at `<provider>/<driver>/<providerVersion>/<case>.{jsonl,json}`
 *   (`.sql` text dumps too, for an `observer` segment); nothing else sits at the root.
 * - `meta-json`, `meta-fields`, `scrubbed`, `captured-by-role`: every `<providerVersion>` folder has
 *   a `meta.json` with `providerVersion`, `capturedAt`, `capturedBy`, `os`, `scrubbed: true` and
 *   `capabilities`; `capturedBy` is a role (`maintainer`, `ci-synthetic`), never a person.
 * - `with-extra-variant`: every protocol fixture (a driver segment other than `observer`) has its
 *   `<case>-with-extra.<ext>` variant with unknown fields.
 * - `crlf-variant`: every LF JSONL case has a CRLF variant, recognised by content (the same lines
 *   ending in CRLF), whatever its file name.
 * - `no-agent-sdk`: there is no `claude/agent-sdk/` directory (OQ-52).
 * - `db-dump-text`: the DB ladder is text (`db/<release>.sql`), never a binary SQLite file (`17` §1.5).
 * - `raw-capture`: no `*.raw.*` recording is in the tree (`17` §1.4 recording step 3).
 *
 * Usage: node scripts/checks/fixtures-layout.mjs [<fixtures dir>]   (default: the repository's `fixtures/`)
 * Exit code 0 when the tree passes, 1 with one `<file>: <rule> — <message>` line per violation on stderr.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXED_FOLDERS = ['bin', 'db', 'ipc/capabilities']
const RESERVED_ROOT_FOLDERS = new Set(['bin', 'db', 'ipc'])
const ROOT_FILES = new Set(['README.md'])
const CAPTURED_BY_ROLES = new Set(['maintainer', 'ci-synthetic'])
const META_STRING_FIELDS = ['providerVersion', 'capturedAt', 'os']
const OBSERVER_SEGMENT = 'observer'
const WITH_EXTRA_SUFFIX = '-with-extra'
const RAW_CAPTURE = /\.raw\./
const SQLITE_BINARY = /\.(?:db|sqlite3?)$/i
const DRIVER_FIXTURE = /\.(?:jsonl|json)$/
const OBSERVER_FIXTURE = /\.(?:jsonl|json|sql)$/

/** Every file under `dir`, as posix paths relative to `root`, sorted. */
function filesUnder(root, dir = root) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(root, full))
    else files.push(path.relative(root, full).split(path.sep).join('/'))
  }
  return files.sort()
}

function isDirectory(full) {
  return existsSync(full) && statSync(full).isDirectory()
}

/** The problems of one `meta.json`, as `[rule, message]` pairs. */
function metaProblems(text) {
  let meta
  try {
    meta = JSON.parse(text)
  } catch {
    return [['meta-json', 'meta.json is not valid JSON']]
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return [['meta-json', 'meta.json is not a JSON object']]
  }
  const problems = []
  for (const field of META_STRING_FIELDS) {
    if (typeof meta[field] !== 'string' || meta[field] === '') {
      problems.push(['meta-fields', `meta.json lacks a non-empty string "${field}"`])
    }
  }
  const { capabilities } = meta
  if (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    problems.push(['meta-fields', 'meta.json lacks a "capabilities" object'])
  }
  if (meta.scrubbed !== true) {
    problems.push([
      'scrubbed',
      'meta.json does not say "scrubbed": true; only scrubbed fixtures are committed'
    ])
  }
  if (!CAPTURED_BY_ROLES.has(meta.capturedBy)) {
    problems.push([
      'captured-by-role',
      'meta.json "capturedBy" must be a role (maintainer, ci-synthetic), never a name or an account'
    ])
  }
  return problems
}

const toLf = (text) => text.replaceAll('\r\n', '\n')

/**
 * The violations of one `<provider>/<driver>/<providerVersion>/` folder, given the names of the
 * files directly inside it.
 */
function checkFixtureSet(root, folder, names, observer) {
  const violations = []
  const report = (name, rule, message) =>
    violations.push({ file: `${folder}/${name}`, rule, message })
  const read = (name) => readFileSync(path.join(root, ...folder.split('/'), name), 'utf8')

  if (names.includes('meta.json')) {
    for (const [rule, message] of metaProblems(read('meta.json')))
      report('meta.json', rule, message)
  } else {
    report('meta.json', 'meta-json', 'the fixture folder has no meta.json')
  }

  const cases = names.filter(
    (name) => name !== 'meta.json' && !name.endsWith('.expected.json') && !RAW_CAPTURE.test(name)
  )

  // A CRLF JSONL file is the CRLF variant of every LF JSONL case with the same lines.
  const jsonl = cases
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => ({ name, text: read(name) }))
  const lfCases = jsonl.filter(({ text }) => !text.includes('\r\n'))
  const crlfFiles = jsonl.filter(({ text }) => text.includes('\r\n'))
  const crlfVariants = new Set(
    crlfFiles
      .filter(({ text }) => lfCases.some((lf) => lf.text === toLf(text)))
      .map(({ name }) => name)
  )
  for (const lf of lfCases) {
    if (lf.name.endsWith(`${WITH_EXTRA_SUFFIX}.jsonl`)) continue
    if (!crlfFiles.some(({ text }) => toLf(text) === lf.text)) {
      report(
        lf.name,
        'crlf-variant',
        'the JSONL fixture has no CRLF variant (same lines ending in CRLF)'
      )
    }
  }

  if (!observer) {
    for (const name of cases) {
      if (crlfVariants.has(name)) continue
      const ext = path.extname(name)
      const base = name.slice(0, -ext.length)
      if (base.endsWith(WITH_EXTRA_SUFFIX)) continue
      if (!names.includes(`${base}${WITH_EXTRA_SUFFIX}${ext}`)) {
        report(
          name,
          'with-extra-variant',
          `the protocol fixture has no ${base}${WITH_EXTRA_SUFFIX}${ext} variant`
        )
      }
    }
  }
  return violations
}

/**
 * Checks a fixtures tree and returns its violations sorted by file, then rule. Paths are posix and
 * relative to `root`.
 *
 * @param {string} root
 * @returns {Array<{ file: string, rule: string, message: string }>}
 */
export function checkFixturesLayout(root) {
  const violations = []
  const report = (file, rule, message) => violations.push({ file, rule, message })

  for (const folder of FIXED_FOLDERS) {
    if (!isDirectory(path.join(root, ...folder.split('/')))) {
      report(folder, 'fixed-folder', `the fixed folder ${folder}/ is missing`)
    }
  }
  if (!isDirectory(root)) return violations

  if (isDirectory(path.join(root, 'claude', 'agent-sdk'))) {
    report('claude/agent-sdk', 'no-agent-sdk', 'there are no Claude Agent SDK fixtures (OQ-52)')
  }

  /** `<provider>/<driver>/<providerVersion>` → names of the files directly inside it. */
  const fixtureSets = new Map()

  for (const file of filesUnder(root)) {
    const segments = file.split('/')
    const name = segments[segments.length - 1]

    if (RAW_CAPTURE.test(name)) {
      report(file, 'raw-capture', 'a raw recording is never committed; scrub it first')
      continue
    }
    if (segments.length === 1) {
      if (!ROOT_FILES.has(name)) report(file, 'layout', 'only README.md sits at the fixtures root')
      continue
    }
    const [top, driver] = segments
    if (top === 'db') {
      if (SQLITE_BINARY.test(name)) {
        report(
          file,
          'db-dump-text',
          'the DB ladder is a text dump (db/<release>.sql), never a binary database'
        )
      }
      continue
    }
    if (RESERVED_ROOT_FOLDERS.has(top)) continue
    if (top === 'claude' && driver === 'agent-sdk') continue

    const observer = driver === OBSERVER_SEGMENT
    if (segments.length !== 4 || !(observer ? OBSERVER_FIXTURE : DRIVER_FIXTURE).test(name)) {
      report(
        file,
        'layout',
        'a provider fixture sits at <provider>/<driver>/<providerVersion>/<case>.{jsonl,json}'
      )
      continue
    }
    const folder = segments.slice(0, 3).join('/')
    if (!fixtureSets.has(folder)) fixtureSets.set(folder, [])
    fixtureSets.get(folder).push(name)
  }

  for (const [folder, names] of fixtureSets) {
    violations.push(
      ...checkFixtureSet(root, folder, names, folder.split('/')[1] === OBSERVER_SEGMENT)
    )
  }

  return violations.sort((a, b) =>
    a.file === b.file ? a.rule.localeCompare(b.rule) : a.file < b.file ? -1 : 1
  )
}

function main(argv) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = argv[0] ? path.resolve(argv[0]) : path.resolve(here, '..', '..', 'fixtures')
  const label = argv[0] ?? 'fixtures'
  const violations = checkFixturesLayout(root)
  for (const { file, rule, message } of violations) {
    process.stderr.write(`${file}: ${rule} — ${message}\n`)
  }
  if (violations.length > 0) {
    process.stderr.write(`fixtures layout: ${violations.length} violation(s) in ${label}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`fixtures layout: ok (${label})\n`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
