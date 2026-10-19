// layer: L1
// The preserved-invariant index (ADR-029 Verification; 17 §1.7 "Invariants index"): every test
// that pins a code-embodied invariant ADR-029 preserves is named here by file and exact title, and
// this test fails when a file is missing or one of those statements is gone. The census
// (`node skills/test-safety/assets/test-census.mjs --base <ref>`) catches a statement lost from
// these files; this index catches one renamed or moved away. A test that moves to a new home is
// re-pointed here, never dropped (ISSUE-245).
//
// Pinned so far (ISSUE-072): the ended-agent rule (#28/#64/#157/#391, INV-36), the #45 pid-recycle
// guard and coal only via the backfill (INV-95). The legacy tests stay referenced while the legacy
// code they cover exists (cut 5 deletes it); the Host's tests are their successors. ISSUE-337 and ISSUE-245
// deleted src/main/providers and src/main/sessionLaunch, so their legacy entries are re-pointed at the successors
// already pinned here (reconcile.test.ts, the ended-agent ledger contract, observationLoop.ended.test.ts). ISSUE-341
// deleted src/main/domain, so the legacy coal-only-via-backfill entry (ledger.test.ts) is re-pointed at its successors
// already pinned here (credit.test.ts, ledgerTriggers.test.ts).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPOSITORY = join(import.meta.dirname, '..', '..')

interface Pinned {
  /** The invariant, as ADR-029 §B names it. */
  invariant: string
  /** Repository-relative, posix separators. */
  file: string
  /** Exact `it` / `test` titles. */
  titles: readonly string[]
}

const CLAUDE_RECONCILE = 'src/host/modules/observation/adapters/claude/reconcile.test.ts'

const PRESERVED_INVARIANT_TESTS: readonly Pinned[] = [
  {
    invariant: 'an ended agent is never re-adopted (#28/#64/#157/#391)',
    file: CLAUDE_RECONCILE,
    titles: [
      '[INV-36, FM-092] a late write of an ended subagent produces no SessionObserved and no dwarf',
      '[S3.22] a late write of a session ended by Remove mine does not rediscover the removed mine',
      '[ADR-029] a nested subagent buried under same-tick attachments is found by the sidecar sweep',
      '[C-16, INV-36] a resumed transcript never announces the session it replays'
    ]
  },
  {
    invariant: 'an ended agent is never re-adopted (#28/#64/#157/#391)',
    file: 'src/host/modules/observation/testing/endedAgentLedger.contract.ts',
    titles: ['[INV-36] recording an identity twice answers duplicate and has answers true']
  },
  {
    invariant: 'an ended agent is never re-adopted (#28/#64/#157/#391)',
    file: 'src/host/modules/observation/application/observationLoop.ended.test.ts',
    titles: [
      '[INV-36] a dwarf whose identity was ended while it arrived is closed on its next record, never kept'
    ]
  },
  {
    invariant: 'the #45 pid-recycle guard keeps its own polarity on the shared tolerance',
    file: CLAUDE_RECONCILE,
    titles: [
      '[ADR-029] a pid reused by another process within the tolerance is not taken for the recorded session'
    ]
  },
  {
    invariant: 'coal only via the backfill (INV-95)',
    file: 'src/host/modules/ledger/domain/credit.test.ts',
    titles: ['[INV-95] a live observation never credits coal']
  },
  {
    invariant: 'coal only via the backfill (INV-95)',
    file: 'src/host/modules/ledger/adapters/ledgerTriggers.test.ts',
    titles: ['[INV-95] a coal material with kind live is rejected by the CHECK']
  }
]

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether `source` holds an `it` / `test` statement with exactly this title. */
function holdsStatement(source: string, title: string): boolean {
  const quoted = `(['"\`])${escapeRegExp(title)}\\1`
  return new RegExp(`\\b(?:it|test)(?:\\.\\w+)*\\(\\s*${quoted}`).test(source)
}

/** Every pinned file or statement that is not where the index says. */
function missingInvariantTests(
  pinned: readonly Pinned[],
  read: (file: string) => string | null
): string[] {
  const missing: string[] = []
  for (const { file, titles } of pinned) {
    const source = read(file)
    if (source === null) {
      missing.push(`${file}: file missing`)
      continue
    }
    for (const title of titles) {
      if (!holdsStatement(source, title)) missing.push(`${file}: ${title}`)
    }
  }
  return missing
}

function readRepositoryFile(file: string): string | null {
  const path = join(REPOSITORY, ...file.split('/'))
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

describe('preserved-invariant index (ADR-029)', () => {
  it('[ADR-029] the ended-agent, #45 and coal-only-via-backfill tests exist and keep their statements', () => {
    expect(PRESERVED_INVARIANT_TESTS.length).toBeGreaterThan(0)
    expect(missingInvariantTests(PRESERVED_INVARIANT_TESTS, readRepositoryFile)).toEqual([])

    // The index itself reports a missing file and a statement renamed away.
    const sample: Pinned = { invariant: 'sample', file: 'a.test.ts', titles: ['keeps it'] }
    expect(missingInvariantTests([sample], () => null)).toEqual(['a.test.ts: file missing'])
    expect(missingInvariantTests([sample], () => "it('keeps it, renamed', () => {})")).toEqual([
      'a.test.ts: keeps it'
    ])
    expect(missingInvariantTests([sample], () => "  it(\n    'keeps it',\n () => {})")).toEqual([])
  })
})
