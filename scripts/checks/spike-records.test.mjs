import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * L7 check of the spike records (testing strategy `17` §4; NFR-OBS-04).
 *
 * A spike closes only when `spike-results/<ID>.md` exists with the front matter
 * `{ id, date, os[], versions{}, verdict: passed | failed | partial, exitCriterion }` and the decision taken.
 * This file holds the checker and runs it over every record present, so a later spike record that breaks the
 * form fails `pnpm test`. AMENDED for the cut-0 conformance audit: a P-4 stub (`21` §2) is
 * `{ id, date, verdict: pending, owner, gate, exitCriterion }` with no Decision, until its spike issue records it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const VERDICTS = ['passed', 'failed', 'partial']
const SPIKE_ID = /^(SP-\d{2}|S-\d{3}-\d)$/

/** Removes one pair of matching surrounding quotes. */
function unquote(value) {
  const match = /^(["'])(.*)\1$/.exec(value)
  return match ? match[2] : value
}

/**
 * Parses the YAML subset the records use: `key: scalar`, `key: [a, b]`, and `key:` followed by an indented
 * block of `  sub: scalar` (a map) or `  - item` (a list). Returns null when there is no front matter.
 */
function parseFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)
  if (!match) return null
  const data = {}
  let open = null
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const nested = /^\s+(?:-\s+(.*)|([\w.@/-]+):\s*(.*))$/.exec(line)
    if (nested && open) {
      if (nested[1] !== undefined) {
        if (!Array.isArray(data[open])) data[open] = []
        data[open].push(unquote(nested[1].trim()))
      } else {
        if (data[open] === null) data[open] = {}
        if (typeof data[open] === 'object' && !Array.isArray(data[open])) {
          data[open][nested[2]] = unquote(nested[3].trim())
        }
      }
      continue
    }
    const top = /^([\w]+):\s*(.*)$/.exec(line)
    if (!top) continue
    const [, key, raw] = top
    const value = raw.trim()
    open = null
    if (value === '') {
      data[key] = null
      open = key
    } else if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim()
      data[key] = inner === '' ? [] : inner.split(',').map((item) => unquote(item.trim()))
    } else {
      data[key] = unquote(value)
    }
  }
  return { data, body: text.slice(match[0].length) }
}

/** Whether `value` is a real calendar date written as YYYY-MM-DD. */
function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
}

/** The text of the `## Decision` section, or null when the record has none. */
function decisionText(body) {
  const match = /^## Decision[^\S\r\n]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body)
  return match ? match[1].trim() : null
}

/**
 * The verdict of a P-4 stub (`21` §2 P-4): the spike has an owner and a record file but has not run. It never counts
 * as a record that closes the spike (`17` §4 "Gate").
 */
const PENDING = 'pending'

/** A stub names its owner, what it gates and its exit criterion, and claims no result: no `## Decision`. */
function checkPendingStub(data, body) {
  const problems = []
  for (const key of ['owner', 'gate', 'exitCriterion']) {
    if (typeof data[key] !== 'string' || data[key].trim() === '') {
      problems.push(`${key} is missing or empty in a pending stub`)
    }
  }
  if (/^## Decision\b/m.test(body)) {
    problems.push('a pending stub claims no result, so it has no ## Decision section')
  }
  return problems
}

/** Checks one record; returns the list of problems (empty when the record is valid). */
function checkSpikeRecord(text, fileName) {
  const parsed = parseFrontMatter(text)
  if (!parsed) return ['no front matter (--- … ---) at the top of the record']
  const { data, body } = parsed
  const problems = []
  const expectedId = path.basename(fileName, '.md')
  if (typeof data.id !== 'string' || !SPIKE_ID.test(data.id)) {
    problems.push('id is missing or is not a spike id (SP-nn or S-nnn-n)')
  } else if (data.id !== expectedId) {
    problems.push(`id ${data.id} does not match the file name ${fileName}`)
  }
  if (!isIsoDate(data.date)) problems.push('date is missing or is not a YYYY-MM-DD date')
  if (data.verdict === PENDING) return [...problems, ...checkPendingStub(data, body)]
  const osValid =
    Array.isArray(data.os) &&
    data.os.length > 0 &&
    data.os.every((os) => typeof os === 'string' && os !== '')
  if (!osValid) problems.push('os is missing or is not a non-empty list')
  const versions = data.versions
  const versionsValid =
    versions !== null &&
    typeof versions === 'object' &&
    !Array.isArray(versions) &&
    Object.keys(versions).length > 0 &&
    Object.values(versions).every((version) => typeof version === 'string' && version !== '')
  if (!versionsValid) problems.push('versions is missing or is not a non-empty map')
  if (!VERDICTS.includes(data.verdict)) {
    problems.push(`verdict is missing or is not one of ${VERDICTS.join(', ')}`)
  }
  if (typeof data.exitCriterion !== 'string' || data.exitCriterion.trim() === '') {
    problems.push('exitCriterion is missing or empty')
  }
  const decision = decisionText(body)
  if (!decision) {
    const why = data.verdict === 'failed' ? ' (a failed record names the fallback it adopts)' : ''
    problems.push(`the ## Decision section is missing or empty${why}`)
  }
  return problems
}

/**
 * ADR-012 item 1 (ISSUE-320): an SP-11 record whose Decision says "the hook route is adopted" must show criteria
 * (a), (b) and (c) passed for one route, read from its `## Results` table. Returns the problems found.
 */
function hookRouteAdoptionProblems(text) {
  const parsed = parseFrontMatter(text)
  const decision = parsed ? decisionText(parsed.body) : null
  if (!decision || !/\bthe hook route is adopted\b/i.test(decision)) return []
  const results = /^## Results[^\S\r\n]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(parsed.body)
  if (!results) return ['the hook route is adopted but the record has no ## Results table']
  const cells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim())
  const rows = new Map()
  for (const line of results[1].split(/\r?\n/)) {
    const match = /^\|\s*\(([a-d])\)/.exec(line)
    if (match) rows.set(match[1], cells(line))
  }
  const criteria = ['a', 'b', 'c']
  const routes = Math.max(0, ...criteria.map((criterion) => (rows.get(criterion)?.length ?? 1) - 1))
  const passedOnOneRoute = Array.from({ length: routes }, (_, index) => index + 1).some((column) =>
    criteria.every((criterion) => /^passed\b/.test(rows.get(criterion)?.[column] ?? ''))
  )
  if (passedOnOneRoute) return []
  return criteria
    .filter(
      (criterion) =>
        !Array.from({ length: routes }, (_, index) => index + 1).some((column) =>
          /^passed\b/.test(rows.get(criterion)?.[column] ?? '')
        )
    )
    .map((criterion) => `the hook route is adopted but criterion (${criterion}) is not passed`)
    .concat(['the hook route is adopted but no single route passes all three adoption criteria'])
}

/**
 * The `## Results` table of a record body: its header cells and its rows (each a list of trimmed cells), or null
 * when the record has no Results table.
 */
function resultsTable(body) {
  const results = /^## Results[^\S\r\n]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body)
  if (!results) return null
  const cells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim())
  const lines = results[1].split(/\r?\n/).filter((line) => line.trim().startsWith('|'))
  if (lines.length < 2) return null
  const [header, , ...rows] = lines
  return { headers: cells(header), rows: rows.map(cells) }
}

/** The index of the first header matching `pattern`, or -1. */
const column = (table, pattern) => table.headers.findIndex((header) => pattern.test(header))

/**
 * ADR-013 item 8 (ISSUE-325, TC-325-02): an SP-12 record whose Decision sets `` `<driver>`: `mcpInjection:
 * 'protocol'` `` must show, in its `## Results` row for that driver, the entry and the credential absent ("no") from
 * every recorded descendant argv and env. Returns the problems found.
 */
function mcpProtocolProblems(text) {
  const parsed = parseFrontMatter(text)
  const decision = parsed ? decisionText(parsed.body) : null
  if (!decision) return []
  const drivers = [...decision.matchAll(/`([\w-]+)`:\s*`mcpInjection:\s*'protocol'`/g)].map(
    (match) => match[1]
  )
  if (drivers.length === 0) return []
  const table = resultsTable(parsed.body)
  if (!table)
    return drivers.map(
      (driver) => `${driver} is set to protocol but the record has no ## Results table`
    )
  const argv = column(table, /\bargv\b/i)
  const env = column(table, /\benv\b/i)
  const problems = []
  for (const driver of drivers) {
    const row = table.rows.find((cells) => cells[0].includes(`\`${driver}\``))
    if (!row) {
      problems.push(`${driver} is set to protocol but has no recorded row`)
      continue
    }
    if (argv < 0 || !/^no\b/i.test(row[argv] ?? '')) {
      problems.push(
        `${driver} is set to protocol but its recorded argv is not free of the entry and the credential`
      )
    }
    if (env < 0 || !/^no\b/i.test(row[env] ?? '')) {
      problems.push(
        `${driver} is set to protocol but its recorded env is not free of the entry and the credential`
      )
    }
  }
  return problems
}

/** The four SP-07 fixture kinds (`17` §4) and the header each is read from. */
const CATALOG_FIXTURE_KINDS = [
  ['launch', /^launch/i],
  ['permission', /^permission/i],
  ['questions', /^question/i],
  ['resume', /^resume/i]
]

/**
 * OQ-22 (ISSUE-326, TC-326-01): an SP-07 record whose Decision says "<provider> is admitted to the catalog" must
 * list, in that provider's `## Results` row, a shown result with a `fixtures/…` path for launch, permission,
 * questions and resume. Returns the problems found.
 */
function catalogAdmissionProblems(text) {
  const parsed = parseFrontMatter(text)
  const decision = parsed ? decisionText(parsed.body) : null
  if (!decision) return []
  const admitted = [
    ...decision.matchAll(/([A-Za-z][\w-]*)[^\n]*? is admitted to the catalog\b/g)
  ].map((match) => match[1])
  if (admitted.length === 0) return []
  const table = resultsTable(parsed.body)
  const problems = []
  for (const provider of admitted) {
    const row = table?.rows.find((cells) => cells[0].startsWith(provider))
    if (!row) {
      problems.push(`${provider} is admitted to the catalog but has no recorded row`)
      continue
    }
    for (const [kind, header] of CATALOG_FIXTURE_KINDS) {
      const cell = row[column(table, header)] ?? ''
      if (!/^shown\b/i.test(cell) || !/`fixtures\/[^`]+`/.test(cell)) {
        problems.push(`${provider} is admitted to the catalog but lists no ${kind} fixture`)
      }
    }
  }
  return problems
}

/** The two OpenCode server kinds of S-011-1 (spike register; ADR-011 item 7). */
const SERVER_KINDS = ['Host-launched', 'person-run']

/**
 * ADR-011 items 2, 7 (ISSUE-327, TC-327-01, TC-327-02): an S-011-1 record states, per OpenCode version and for both
 * server kinds, the plugin load, the loaded signal and the deny result in its `## Results` table, and its Decision
 * states what `on-verified` means: "written and read back" unless a loaded signal was identified. Returns the
 * problems found.
 */
function onVerifiedProblems(text) {
  const parsed = parseFrontMatter(text)
  if (!parsed) return ['no front matter']
  const table = resultsTable(parsed.body)
  if (!table) return ['the record has no ## Results table']
  const load = column(table, /plugin load/i)
  const signal = column(table, /loaded signal/i)
  const deny = column(table, /^deny/i)
  const problems = []
  const seen = new Map()
  for (const cells of table.rows) {
    const [version, kind] = cells[0].split(',').map((part) => part.trim())
    if (!seen.has(version)) seen.set(version, new Set())
    seen.get(version).add(kind?.toLowerCase())
    for (const [name, index] of [
      ['plugin load', load],
      ['loaded signal', signal],
      ['deny result', deny]
    ]) {
      if (index < 0 || (cells[index] ?? '') === '') problems.push(`${cells[0]} states no ${name}`)
    }
  }
  for (const [version, kinds] of seen) {
    for (const kind of SERVER_KINDS) {
      if (!kinds.has(kind.toLowerCase())) problems.push(`${version} has no ${kind} server kind`)
    }
  }
  const meaning = /`on-verified` means "([^"]+)"/.exec(decisionText(parsed.body) ?? '')
  if (!meaning) {
    problems.push('the Decision does not state what on-verified means')
  } else {
    const signalFound =
      signal >= 0 && table.rows.some((cells) => !/^\W*none\b/i.test(cells[signal] ?? ''))
    if (!signalFound && meaning[1] !== 'written and read back') {
      problems.push(
        'no loaded signal was identified, so on-verified must mean written and read back'
      )
    }
  }
  return problems
}

const VALID = `---
id: SP-02
date: 2026-09-30
os: [windows-11]
versions:
  node: 24.11.1
verdict: passed
exitCriterion: A Host started from the UI survives closing the UI's job
---

# SP-02

## Decision

The breakaway launcher is kept.
`

/** The valid record with the front matter line starting with `key:` removed. */
function without(key) {
  const lines = VALID.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${key}:`))
  let end = start + 1
  while (end < lines.length && lines[end].startsWith('  ')) end += 1
  lines.splice(start, end - start)
  return lines.join('\n')
}

describe('spike records (17 §4)', () => {
  it('[SP-02] a spike record without id, date, os, versions, verdict or exitCriterion fails', () => {
    expect(checkSpikeRecord(VALID, 'SP-02.md'), 'the complete record').toEqual([])
    for (const key of ['id', 'date', 'os', 'versions', 'verdict', 'exitCriterion']) {
      const problems = checkSpikeRecord(without(key), 'SP-02.md')
      expect(problems.join('\n'), `a record without ${key}`).toMatch(new RegExp(`\\b${key}\\b`))
    }
    expect(checkSpikeRecord('# SP-02\n\nno front matter\n', 'SP-02.md').length).toBeGreaterThan(0)
    const emptyOs = VALID.replace('os: [windows-11]', 'os: []')
    expect(checkSpikeRecord(emptyOs, 'SP-02.md').join('\n'), 'an empty os list').toMatch(/\bos\b/)
    const emptyVersions = VALID.replace('versions:\n  node: 24.11.1\n', 'versions:\n')
    expect(checkSpikeRecord(emptyVersions, 'SP-02.md').join('\n'), 'no versions').toMatch(
      /\bversions\b/
    )
    const badDate = VALID.replace('date: 2026-09-30', 'date: 30/09/2026')
    expect(checkSpikeRecord(badDate, 'SP-02.md').join('\n'), 'a non-ISO date').toMatch(/\bdate\b/)
    expect(checkSpikeRecord(VALID, 'SP-04.md').join('\n'), 'id differs from the file').toMatch(
      /\bid\b/
    )
  })

  it('[SP-02] a record whose verdict is not passed, failed or partial fails, and a failed record must name its decision', () => {
    for (const verdict of ['passed', 'failed', 'partial']) {
      const record = VALID.replace('verdict: passed', `verdict: ${verdict}`)
      expect(checkSpikeRecord(record, 'SP-02.md'), `verdict ${verdict}`).toEqual([])
    }
    for (const verdict of ['pass', 'ok', 'open', '']) {
      const record = VALID.replace('verdict: passed', `verdict: ${verdict}`)
      expect(checkSpikeRecord(record, 'SP-02.md').join('\n'), `verdict "${verdict}"`).toMatch(
        /\bverdict\b/
      )
    }
    const failed = VALID.replace('verdict: passed', 'verdict: failed')
    const noDecision = failed.replace(/## Decision[\s\S]*$/, '')
    expect(checkSpikeRecord(noDecision, 'SP-02.md').join('\n'), 'failed, no decision').toMatch(
      /\bDecision\b/
    )
    const emptyDecision = failed.replace('The breakaway launcher is kept.\n', '')
    expect(checkSpikeRecord(emptyDecision, 'SP-02.md').join('\n'), 'empty decision').toMatch(
      /\bDecision\b/
    )
  })

  it('[S-019-1, SP-03, S-015-2] the cut-0 exit records exist, pass the record check and state what their gated issues follow', () => {
    const dir = path.join(repoRoot, 'spike-results')
    const read = (id) => {
      const file = path.join(dir, `${id}.md`)
      expect(existsSync(file), `spike-results/${id}.md exists`).toBe(true)
      const text = readFileSync(file, 'utf8')
      expect(checkSpikeRecord(text, `${id}.md`), `spike-results/${id}.md`).toEqual([])
      expect(existsSync(path.join(dir, id)), `spike-results/${id}/ holds the raw outputs`).toBe(
        true
      )
      return { text, decision: decisionText(parseFrontMatter(text).body) }
    }
    // TC-315-02: the window factory and parity-cut-0.md read one sentence (later: ISSUE-046, ISSUE-056).
    expect(read('S-019-1').decision, 'S-019-1 says whether the renderer runs sandboxed').toMatch(
      /\bthe renderer (runs|does not run) sandboxed\b/
    )
    // TC-315-03: the copy rule per recorded layout, or the alternative copy source (later: ISSUE-031).
    expect(read('SP-03').decision, 'SP-03 states the copy rule per layout').toMatch(
      /^\| Layout +\|.*\bCopy rule\b/m
    )
    // TC-315-04: the per-OS identity source table proposed for ADR-015 item 4.
    const bootIdentity = read('S-015-2').text
    const proposal =
      /^## Proposed table for ADR-015 item 4\s*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(
        bootIdentity
      )
    expect(proposal, 'S-015-2 has the proposed table section').not.toBeNull()
    for (const os of ['Windows', 'macOS', 'Linux']) {
      expect(proposal?.[1], `the proposed table has a ${os} row`).toMatch(
        new RegExp(`^\\| ${os}\\b`, 'm')
      )
    }
  })

  // ADDED for the cut-0 conformance audit: 21 §2 P-4 asks a `spike-results/<ID>.md` stub with an owner for each
  // long-lead spike of wave 1. A stub is `verdict: pending`: it names its owner, what it gates and its exit criterion,
  // and claims no result, so it has no os, versions or Decision of its own.
  it('[ADR-001] a P-4 pending stub (SP-08, S-008-1, SP-16, SP-07) names its owner, its gate and its exit criterion and claims no result', () => {
    const stub = `---
id: SP-08
date: 2026-10-02
verdict: pending
owner: provider devs
gate: ISSUE-321 (step 3a entry)
exitCriterion: Flag presence and routing recorded per version
---

# SP-08

Not run yet.
`
    expect(checkSpikeRecord(stub, 'SP-08.md'), 'the complete stub').toEqual([])
    for (const key of ['owner', 'gate', 'exitCriterion']) {
      const lines = stub.split('\n').filter((line) => !line.startsWith(`${key}:`))
      expect(
        checkSpikeRecord(lines.join('\n'), 'SP-08.md').join('\n'),
        `a stub without ${key}`
      ).toMatch(new RegExp(`\\b${key}\\b`))
    }
    const decided = `${stub}\n## Decision\n\nKept.\n`
    expect(checkSpikeRecord(decided, 'SP-08.md').join('\n'), 'a stub with a decision').toMatch(
      /\bDecision\b/
    )

    const dir = path.join(repoRoot, 'spike-results')
    for (const id of ['SP-08', 'S-008-1', 'SP-16', 'SP-07']) {
      const file = path.join(dir, `${id}.md`)
      expect(existsSync(file), `spike-results/${id}.md exists`).toBe(true)
      expect(
        checkSpikeRecord(readFileSync(file, 'utf8'), `${id}.md`),
        `spike-results/${id}.md`
      ).toEqual([])
    }
  })

  // ADDED for ISSUE-318 (TC-318-01, TC-318-02): the cut-1 entry records. While a spike has not passed on an OS, its
  // record names the fallback the gated issues follow there (21 §9 "Cut 1 entry"; 24-issues README §6).
  it('[S-030-1, S-018-1, S-027-4] the cut-1 entry records exist, pass the record check and name the fallback their gated issues follow', () => {
    const dir = path.join(repoRoot, 'spike-results')
    const decisionOf = (id) => {
      const file = path.join(dir, `${id}.md`)
      expect(existsSync(file), `spike-results/${id}.md exists`).toBe(true)
      const text = readFileSync(file, 'utf8')
      expect(checkSpikeRecord(text, `${id}.md`), `spike-results/${id}.md`).toEqual([])
      expect(existsSync(path.join(dir, id)), `spike-results/${id}/ holds the raw outputs`).toBe(
        true
      )
      return decisionText(parseFrontMatter(text).body) ?? ''
    }
    const caseFolding = decisionOf('S-030-1')
    expect(caseFolding, 'S-030-1 names its fallback').toMatch(
      /no\s+case\s+folding\s+on\s+unknown\s+volumes/
    )
    expect(caseFolding, 'S-030-1 names its gated issues').toMatch(/ISSUE-062[\s\S]*ISSUE-064/)
    const tray = decisionOf('S-018-1')
    expect(tray, 'S-018-1 names its fallback').toMatch(/window-only[\s\S]*R-16/)
    expect(tray, 'S-018-1 names its gated issues').toMatch(/ISSUE-112[\s\S]*ISSUE-113/)
    const login = decisionOf('S-027-4')
    expect(login, 'S-027-4 names its fallback').toMatch(/candidate\s+autostart[\s\S]*until\s+v1/)
    expect(login, 'S-027-4 names the gate ISSUE-060 reads').toMatch(
      /ISSUE-060[\s\S]*LOGIN_ENTRY_PASSED/
    )
  })

  // ADDED for ISSUE-319 (TC-319-01): the cut-1 non-blocking records. Each may stay partial or failed, but it keeps the
  // documented default and names the gated issue that follows it (21 §9 "Cut 1, non-blocking"; 24-issues README §6).
  // Only the records with measured output have a raw-output folder yet; the others gain theirs with the first
  // recording on the maintainer's machine (17 §5.5).
  it('[SP-06, S-014-1, S-021-1, S-021-2, S-032-1, S-018-2] the cut-1 measurement records exist, pass the record check and keep the default their gated issues follow', () => {
    const dir = path.join(repoRoot, 'spike-results')
    const decisionOf = (id, { rawOutputs }) => {
      const file = path.join(dir, `${id}.md`)
      expect(existsSync(file), `spike-results/${id}.md exists`).toBe(true)
      const text = readFileSync(file, 'utf8')
      expect(checkSpikeRecord(text, `${id}.md`), `spike-results/${id}.md`).toEqual([])
      if (rawOutputs) {
        expect(existsSync(path.join(dir, id)), `spike-results/${id}/ holds the raw outputs`).toBe(
          true
        )
      }
      return decisionText(parseFrontMatter(text).body) ?? ''
    }
    const usage = decisionOf('SP-06', { rawOutputs: false })
    expect(usage, 'SP-06 keeps its default').toMatch(
      /one\s+authoritative\s+usage\s+path\s+per\s+session/
    )
    expect(usage, 'SP-06 names its gated issue').toMatch(/ISSUE-076/)
    const pidSource = decisionOf('S-014-1', { rawOutputs: true })
    expect(pidSource, 'S-014-1 keeps its default').toMatch(/failed: 'no-identity'[\s\S]*kept/)
    expect(pidSource, 'S-014-1 names its gated issue').toMatch(/ISSUE-079/)
    for (const id of ['S-021-1', 'S-021-2']) {
      const turnEnd = decisionOf(id, { rawOutputs: false })
      expect(turnEnd, `${id} keeps its default`).toMatch(/`turnEnd`\s+stays\s+`none`/)
      expect(turnEnd, `${id} names its gated issue`).toMatch(/ISSUE-100/)
    }
    const inferred = decisionOf('S-032-1', { rawOutputs: false })
    expect(inferred, 'S-032-1 keeps its default rule').toMatch(
      /INFERRED_TURN_END_MS`, default 30 s/
    )
    expect(inferred, 'S-032-1 keeps the observed-ask values').toMatch(
      /observedPermission[\s\S]*observedQuestion|initial `15` §2\.5 values stay/
    )
    expect(inferred, 'S-032-1 names its gated issue').toMatch(/ISSUE-070/)
    const raise = decisionOf('S-018-2', { rawOutputs: true })
    expect(raise, 'S-018-2 keeps its default').toMatch(/FM-049/)
    expect(raise, 'S-018-2 names its gated issue').toMatch(/ISSUE-114/)
  })

  // ADDED for ISSUE-320 (TC-320-01): ADR-012 item 1 adopts the hook route only if (a), (b) and (c) all hold.
  it('[SP-11, ADR-012] an SP-11 record that marks the hook route adopted has criteria a, b and c passed', () => {
    const record = (b, c, decision) => `---
id: SP-11
date: 2026-10-14
os: [macos-26.6.2-25G83-arm64]
versions:
  claude-code: 2.1.299
verdict: passed
exitCriterion: ADR-012 item 1
---

# SP-11

## Results

| Criterion | \`PermissionRequest\` | \`PreToolUse\` |
| --------- | ------------------- | ------------ |
| (a)       | passed (A1, A2)     | passed (T1)  |
| (b)       | ${b} (B1, B2)       | failed (T2)  |
| (c)       | ${c} (C1, C2, C3)   | not measured |
| (d)       | informational       | informational |

## Decision

${decision}
`
    const adopted = 'The hook route is adopted through `PermissionRequest`.'
    const kept = 'The hook route is not adopted yet; the keystroke exception stays.'
    expect(
      hookRouteAdoptionProblems(record('passed', 'passed', adopted)),
      'a, b, c passed'
    ).toEqual([])
    expect(
      hookRouteAdoptionProblems(record('failed', 'passed', adopted)).join('\n'),
      'adopted with (b) failed'
    ).toMatch(/\(b\)/)
    expect(
      hookRouteAdoptionProblems(record('passed', 'failed', adopted)).join('\n'),
      'adopted with (c) failed'
    ).toMatch(/\(c\)/)
    expect(hookRouteAdoptionProblems(record('failed', 'failed', kept)), 'not adopted').toEqual([])

    const file = path.join(repoRoot, 'spike-results', 'SP-11.md')
    const text = readFileSync(file, 'utf8')
    expect(checkSpikeRecord(text, 'SP-11.md'), 'spike-results/SP-11.md').toEqual([])
    expect(hookRouteAdoptionProblems(text), 'spike-results/SP-11.md follows the rule').toEqual([])
    expect(
      existsSync(path.join(repoRoot, 'spike-results', 'SP-11')),
      'spike-results/SP-11/ holds the raw outputs'
    ).toBe(true)
  })

  // ADDED for ISSUE-325 (TC-325-02): ADR-013 item 8, no delegation entry or credential in a recorded argv or env.
  it("[SP-12, ADR-013] an SP-12 record that sets mcpInjection protocol for a driver shows that driver's recorded argv and env free of the entry and the credential", () => {
    const record = (argv, env, decision) => `---
id: SP-12
date: 2026-10-17
os: [windows-11]
versions:
  codex-cli: 0.153.4
verdict: passed
exitCriterion: Per driver, argv/env of the child shown free of the entry and credential
---

# SP-12

## Results

| Driver                     | Entry or credential in any descendant argv | Entry or credential in any descendant env |
| -------------------------- | ------------------------------------------ | ----------------------------------------- |
| Codex \`app-server-rpc\` 0.153.4 | ${argv}                                | ${env}                                    |

## Decision

${decision}
`
    const adopted = "- \`app-server-rpc\`: \`mcpInjection: 'protocol'\` (ISSUE-152)."
    const kept = '- `mcpInjection` stays `ticket-file` for Codex.'
    const clean = 'no (14 descendants)'
    const tokenArgv = 'yes: `--mcp-config {"token":"<delegation-token>"}`'
    const tokenEnv = 'yes: `DWARFAI_MCP_TOKEN` in the relay env'

    expect(mcpProtocolProblems(record(clean, clean, adopted)), 'argv and env clean').toEqual([])
    expect(
      mcpProtocolProblems(record(tokenArgv, clean, adopted)).join('\n'),
      'protocol with a token-bearing argv'
    ).toMatch(/app-server-rpc[\s\S]*argv/)
    expect(
      mcpProtocolProblems(record(clean, tokenEnv, adopted)).join('\n'),
      'protocol with the entry in the env'
    ).toMatch(/app-server-rpc[\s\S]*env/)
    expect(
      mcpProtocolProblems(record(clean, clean, adopted.replace('app-server-rpc', 'acp'))).join(
        '\n'
      ),
      'protocol for a driver with no recorded row'
    ).toMatch(/acp/)
    expect(mcpProtocolProblems(record(tokenArgv, tokenEnv, kept)), 'not adopted').toEqual([])

    const file = path.join(repoRoot, 'spike-results', 'SP-12.md')
    const text = readFileSync(file, 'utf8')
    expect(checkSpikeRecord(text, 'SP-12.md'), 'spike-results/SP-12.md').toEqual([])
    expect(mcpProtocolProblems(text), 'spike-results/SP-12.md follows the rule').toEqual([])
    expect(
      existsSync(path.join(repoRoot, 'spike-results', 'SP-12')),
      'spike-results/SP-12/ holds the raw outputs'
    ).toBe(true)
  })

  // ADDED for ISSUE-326 (TC-326-01): OQ-22, a provider joins the catalog only with all four kinds of fixture.
  it('[SP-07] an SP-07 record that admits a provider to the catalog lists fixtures for launch, permission, questions and resume', () => {
    const row = (
      provider,
      resume,
      permission = 'shown: `fixtures/kiro/acp/1.0.0/sp07-permission`'
    ) =>
      `| ${provider} | shown: \`fixtures/kiro/acp/1.0.0/sp07-launch\` | ${permission} | shown: \`fixtures/kiro/acp/1.0.0/sp07-question\` | ${resume} |`
    const record = (rows, decision) => `---
id: SP-07
date: 2026-10-17
os: [windows-11]
versions:
  kiro-cli: 1.0.0
verdict: passed
exitCriterion: Fixtures recorded and the driver conformance suite passes for each
---

# SP-07

## Results

| Provider and version | Launch | Permission | Questions | Resume |
| -------------------- | ------ | ---------- | --------- | ------ |
${rows.join('\n')}

## Decision

${decision}
`
    const resumed = 'shown: `fixtures/kiro/acp/1.0.0/sp07-resume`'
    const admitted = '- Kiro 1.0.0 is admitted to the catalog.'
    const kept = '- Neither enters the catalog, and ISSUE-158 closes as not needed.'

    expect(
      catalogAdmissionProblems(record([row('Kiro 1.0.0', resumed)], admitted)),
      'all four fixtures'
    ).toEqual([])
    expect(
      catalogAdmissionProblems(record([row('Kiro 1.0.0', 'not observed')], admitted)).join('\n'),
      'admitted without a resume fixture'
    ).toMatch(/Kiro[\s\S]*resume/i)
    expect(
      catalogAdmissionProblems(
        record([row('Kiro 1.0.0', resumed, 'not observed: 403')], admitted)
      ).join('\n'),
      'admitted without a permission fixture'
    ).toMatch(/Kiro[\s\S]*permission/i)
    expect(
      catalogAdmissionProblems(record([], admitted)).join('\n'),
      'admitted with no recorded row'
    ).toMatch(/Kiro/)
    expect(
      catalogAdmissionProblems(record([row('Kiro 1.0.0', 'not observed')], kept)),
      'not admitted'
    ).toEqual([])

    const file = path.join(repoRoot, 'spike-results', 'SP-07.md')
    const text = readFileSync(file, 'utf8')
    expect(checkSpikeRecord(text, 'SP-07.md'), 'spike-results/SP-07.md').toEqual([])
    expect(catalogAdmissionProblems(text), 'spike-results/SP-07.md follows the rule').toEqual([])
    expect(decisionText(parseFrontMatter(text).body), 'SP-07 names its gated issue').toMatch(
      /ISSUE-158 closes as not needed/
    )
  })

  // ADDED for ISSUE-327 (TC-327-01, TC-327-02): ADR-011 items 2, 7, the on-verified meaning per server kind.
  it('[S-011-1, ADR-011] an S-011-1 record states the meaning of on-verified per server kind and version', () => {
    const hostRow = '| 1.18.32, Host-launched | loaded at the first request | none | honoured |'
    const personRow = '| 1.18.32, person-run | not loaded without a restart | none | not run |'
    const record = (rows, decision) => `---
id: S-011-1
date: 2026-10-17
os: [windows-11]
versions:
  opencode: 1.18.32
verdict: partial
exitCriterion: Load behavior recorded per OpenCode version for both server kinds
---

# S-011-1

## Results

| Version / server kind | Plugin load | Loaded signal | Deny |
| --------------------- | ----------- | ------------- | ---- |
${rows.join('\n')}

## Decision

${decision}
`
    const meaning = '- **`on-verified` means "written and read back"** for ISSUE-228 and ISSUE-229.'

    expect(onVerifiedProblems(record([hostRow, personRow], meaning)), 'both kinds').toEqual([])
    expect(
      onVerifiedProblems(record([personRow], meaning)).join('\n'),
      'a record without the Host-launched kind'
    ).toMatch(/1\.18\.32[\s\S]*Host-launched/)
    expect(
      onVerifiedProblems(record([hostRow], meaning)).join('\n'),
      'a record without the person-run kind'
    ).toMatch(/1\.18\.32[\s\S]*person-run/)
    expect(
      onVerifiedProblems(record([hostRow, personRow], '- Nothing decided.')).join('\n'),
      'no stated meaning'
    ).toMatch(/on-verified/)
    expect(
      onVerifiedProblems(
        record([hostRow, personRow], '- **`on-verified` means "loaded"** from the signal.')
      ).join('\n'),
      'a meaning other than written and read back with no loaded signal'
    ).toMatch(/written and read back/)

    const file = path.join(repoRoot, 'spike-results', 'S-011-1.md')
    const text = readFileSync(file, 'utf8')
    expect(checkSpikeRecord(text, 'S-011-1.md'), 'spike-results/S-011-1.md').toEqual([])
    expect(onVerifiedProblems(text), 'spike-results/S-011-1.md follows the rule').toEqual([])
    expect(
      existsSync(path.join(repoRoot, 'spike-results', 'S-011-1')),
      'spike-results/S-011-1/ holds the raw outputs'
    ).toBe(true)
  })

  // ADDED for ISSUE-328 (TC-328-01, TC-328-03): the packaging spike records written from the hosted-runner lane
  // (.github/workflows/spikes-package.yml). Each names the build issue it gates; while it is not passed on every OS it
  // says the gap is listed as an R-16 known limit by the v1 checklist (later: ISSUE-281).
  it('[S-019-2, S-019-3, S-027-1, S-027-3, SP-03, S-027-4, S-018-2] the packaging spike records exist, name their gated issue and, while open, the R-16 known limit', () => {
    const dir = path.join(repoRoot, 'spike-results')
    const read = (id) => {
      const file = path.join(dir, `${id}.md`)
      expect(existsSync(file), `spike-results/${id}.md exists`).toBe(true)
      const text = readFileSync(file, 'utf8')
      expect(checkSpikeRecord(text, `${id}.md`), `spike-results/${id}.md`).toEqual([])
      expect(existsSync(path.join(dir, id)), `spike-results/${id}/ holds the raw outputs`).toBe(
        true
      )
      const { data, body } = parseFrontMatter(text)
      return { data, body, decision: decisionText(body) ?? '' }
    }
    const gates = {
      'S-019-2': /ISSUE-269/,
      'S-019-3': /ISSUE-046[\s\S]*ISSUE-274|ISSUE-274[\s\S]*ISSUE-046/,
      'S-027-1': /ISSUE-275/,
      'S-027-3': /ISSUE-276/
    }
    for (const [id, gate] of Object.entries(gates)) {
      const { data, body, decision } = read(id)
      expect(decision, `${id} names its gated issue`).toMatch(gate)
      for (const os of ['Windows', 'macOS', 'Linux']) {
        expect(body, `${id} has a row for ${os}, run or not`).toMatch(
          new RegExp(`^\\| ${os}\\b`, 'm')
        )
      }
      if (data.verdict !== 'passed') {
        expect(decision, `${id} is open, so it names the R-16 known limit`).toMatch(
          /R-16[\s\S]*ISSUE-281/
        )
      }
    }
    for (const id of ['SP-03', 'S-027-4', 'S-018-2']) {
      expect(read(id).body, `${id} has its packaged re-check section`).toMatch(
        /^## Packaged (half|re-check) \(ISSUE-328\)/m
      )
    }
  })

  // ADDED for ISSUE-328 (TC-328-02): the release artifacts' bundled packages are recorded against S-008-1, and the
  // Agent SDK the legacy path still ships is recorded as failed, not passed, until ISSUE-184 removes it.
  it('[S-008-1] the record lists what the release artifacts ship and records the shipped Agent SDK as failed', () => {
    const text = readFileSync(path.join(repoRoot, 'spike-results', 'S-008-1.md'), 'utf8')
    const section =
      /^## Release artifacts \(ISSUE-328\)\s*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)
    expect(section, 'S-008-1 has the release-artifact section').not.toBeNull()
    const sdkRow = section?.[1]
      .split(/\r?\n/)
      .find((line) => line.startsWith('| `@anthropic-ai/claude-agent-sdk` '))
    expect(sdkRow, 'the shipped Agent SDK has a row').toBeDefined()
    expect(sdkRow).toMatch(/\bfailed\b/)
    expect(sdkRow).toMatch(/ISSUE-184/)
    expect(
      existsSync(path.join(repoRoot, 'spike-results', 'S-008-1', 'release-artifacts')),
      'the bundled-package tables per OS are kept'
    ).toBe(true)
  })

  it('[SP-02, SP-04, SP-05] every committed spike record passes the record check', () => {
    const dir = path.join(repoRoot, 'spike-results')
    const records = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.md')) : []
    for (const name of records) {
      const problems = checkSpikeRecord(readFileSync(path.join(dir, name), 'utf8'), name)
      expect(problems, `spike-results/${name}`).toEqual([])
    }
  })
})
