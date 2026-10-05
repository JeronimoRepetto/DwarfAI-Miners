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

  it('[SP-02, SP-04, SP-05] every committed spike record passes the record check', () => {
    const dir = path.join(repoRoot, 'spike-results')
    const records = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.md')) : []
    for (const name of records) {
      const problems = checkSpikeRecord(readFileSync(path.join(dir, name), 'utf8'), name)
      expect(problems, `spike-results/${name}`).toEqual([])
    }
  })
})
