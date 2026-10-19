import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { checkFixturesLayout } from './fixtures-layout.mjs'

/**
 * L7 check of the repository-root `fixtures/` tree (17 §1.4, §1.5, §1.9, §2.2).
 *
 * Each case builds a small tree in its own `mkdtemp` directory and runs the checker on it. The
 * real filesystem is used on purpose: the checker's whole subject is a directory tree on disk.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const checkerPath = path.join(here, 'fixtures-layout.mjs')

/** The fixed top-level folders, as their tracked placeholders. */
const FIXED_FOLDERS = {
  'db/.gitkeep': '',
  'ipc/capabilities/.gitkeep': '',
  'bin/.gitkeep': ''
}

const LF_TURN = '{"type":"turn.started"}\n{"type":"turn.completed"}\n'
const LF_TURN_WITH_EXTRA =
  '{"type":"turn.started","unknown":1}\n{"type":"turn.completed","unknown":2}\n'

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

/** Writes `files` (posix path → content) under a fresh temp directory and returns it. */
function makeTree(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'fixtures-layout-'))
  tempRoots.push(root)
  for (const [relativePath, content] of Object.entries(files)) {
    const full = path.join(root, ...relativePath.split('/'))
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

function meta(overrides = {}) {
  return JSON.stringify({
    providerVersion: '2.1.14',
    capturedAt: '2026-09-30T00:00:00.000Z',
    capturedBy: 'maintainer',
    os: 'linux',
    scrubbed: true,
    capabilities: {},
    ...overrides
  })
}

/** A complete JSONL protocol fixture set: meta, case, its -with-extra and its CRLF variant. */
function protocolSet(dir, metaOverrides = {}) {
  return {
    [`${dir}/meta.json`]: meta(metaOverrides),
    [`${dir}/turn.jsonl`]: LF_TURN,
    [`${dir}/turn-with-extra.jsonl`]: LF_TURN_WITH_EXTRA,
    [`${dir}/turn-crlf.jsonl`]: LF_TURN.replaceAll('\n', '\r\n')
  }
}

/** The violations as `file rule` lines, so a failure names what was missed or added. */
function reported(root) {
  return checkFixturesLayout(root).map(({ file, rule }) => `${file} ${rule}`)
}

describe('fixtures layout (17 §1.4)', () => {
  it('[ADR-009] a protocol fixture without meta.json, without scrubbed: true or without its -with-extra variant is reported', () => {
    const dir = 'claude/stream-json/2.1.x'

    const withoutMeta = protocolSet(dir)
    delete withoutMeta[`${dir}/meta.json`]
    expect(reported(makeTree({ ...FIXED_FOLDERS, ...withoutMeta }))).toEqual([
      `${dir}/meta.json meta-json`
    ])

    expect(
      reported(makeTree({ ...FIXED_FOLDERS, ...protocolSet(dir, { scrubbed: false }) }))
    ).toEqual([`${dir}/meta.json scrubbed`])

    const withoutExtra = protocolSet(dir)
    delete withoutExtra[`${dir}/turn-with-extra.jsonl`]
    expect(reported(makeTree({ ...FIXED_FOLDERS, ...withoutExtra }))).toEqual([
      `${dir}/turn.jsonl with-extra-variant`
    ])

    expect(reported(makeTree({ ...FIXED_FOLDERS, ...protocolSet(dir) }))).toEqual([])
  })

  it('[ADR-009] a JSONL fixture without its CRLF variant is reported', () => {
    const dir = 'codex/app-server/0.40.x'
    const withoutCrlf = protocolSet(dir)
    delete withoutCrlf[`${dir}/turn-crlf.jsonl`]

    expect(reported(makeTree({ ...FIXED_FOLDERS, ...withoutCrlf }))).toEqual([
      `${dir}/turn.jsonl crlf-variant`
    ])

    // A CRLF file whose lines differ from the case is not its CRLF variant.
    const wrongTwin = protocolSet(dir)
    wrongTwin[`${dir}/turn-crlf.jsonl`] = '{"type":"other"}\r\n'
    expect(reported(makeTree({ ...FIXED_FOLDERS, ...wrongTwin }))).toContain(
      `${dir}/turn.jsonl crlf-variant`
    )
  })

  it('[R11] a fixtures/claude/agent-sdk directory is reported', () => {
    const root = makeTree({
      ...FIXED_FOLDERS,
      ...protocolSet('claude/stream-json/2.1.x'),
      ...protocolSet('claude/agent-sdk/0.1.x')
    })

    expect(reported(root)).toEqual(['claude/agent-sdk no-agent-sdk'])
  })

  it('[ADR-008] a meta.json whose capturedBy is not a role (maintainer, ci-synthetic) is reported', () => {
    const dir = 'opencode/server/1.0.x'

    for (const role of ['maintainer', 'ci-synthetic']) {
      const root = makeTree({ ...FIXED_FOLDERS, ...protocolSet(dir, { capturedBy: role }) })
      expect(reported(root), role).toEqual([])
    }

    for (const notARole of ['Jane Doe', 'jane@example.com', '', undefined]) {
      const root = makeTree({ ...FIXED_FOLDERS, ...protocolSet(dir, { capturedBy: notARole }) })
      expect(reported(root), String(notARole)).toEqual([`${dir}/meta.json captured-by-role`])
    }
  })

  it('[ADR-005] a .db file under fixtures/db is reported; .sql dumps are accepted', () => {
    expect(
      reported(makeTree({ ...FIXED_FOLDERS, 'db/cut-0.sql': 'CREATE TABLE t (x);\n' }))
    ).toEqual([])

    expect(
      reported(makeTree({ ...FIXED_FOLDERS, 'db/cut-0.db': 'SQLite format 3\u0000' }))
    ).toEqual(['db/cut-0.db db-dump-text'])
  })

  it('[ADR-008] a *.raw.* capture anywhere under fixtures/ is reported', () => {
    const dir = 'claude/stream-json/2.1.x'
    const root = makeTree({
      ...FIXED_FOLDERS,
      ...protocolSet(dir),
      [`${dir}/turn.raw.jsonl`]: LF_TURN,
      'db/cut-0.raw.sql': ''
    })

    expect(reported(root)).toEqual([
      `${dir}/turn.raw.jsonl raw-capture`,
      'db/cut-0.raw.sql raw-capture'
    ])
  })

  it('[ADR-005, ADR-009] a tree without its fixed db/, ipc/capabilities/ or bin/ folder is reported', () => {
    expect(reported(makeTree({ 'README.md': '' }))).toEqual([
      'bin fixed-folder',
      'db fixed-folder',
      'ipc/capabilities fixed-folder'
    ])
  })

  it('[ADR-009] a file outside fixtures/<provider>/<driver>/<providerVersion>/<case>.{jsonl,json} is reported', () => {
    const root = makeTree({
      ...FIXED_FOLDERS,
      ...protocolSet('claude/observer/2.1.x'),
      'notes.txt': '',
      'claude/stray.jsonl': LF_TURN,
      'claude/observer/2.1.x/nested/deep.jsonl': LF_TURN,
      'claude/stream-json/2.1.x/meta.json': meta(),
      'claude/stream-json/2.1.x/help.txt': ''
    })

    expect(reported(root)).toEqual([
      'claude/observer/2.1.x/nested/deep.jsonl layout',
      'claude/stray.jsonl layout',
      'claude/stream-json/2.1.x/help.txt layout',
      'notes.txt layout'
    ])
  })

  it('[ADR-009] the command exits non-zero and names the file and the rule of each violation', () => {
    const root = makeTree({ ...FIXED_FOLDERS, 'db/cut-0.db': '' })

    const run = spawnSync(process.execPath, [checkerPath, root], { encoding: 'utf8' })

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('db/cut-0.db')
    expect(run.stderr).toContain('db-dump-text')
  })

  it('[ADR-009] the real fixtures/ tree passes the checker', () => {
    expect(checkFixturesLayout(path.join(repoRoot, 'fixtures'))).toEqual([])

    const run = spawnSync(process.execPath, [checkerPath, path.join(repoRoot, 'fixtures')], {
      encoding: 'utf8'
    })
    expect(run.status, run.stderr).toBe(0)
  })
})
