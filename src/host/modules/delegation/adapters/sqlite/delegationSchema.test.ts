import { describe, expect, it } from 'vitest'
import type { SqliteDatabase, SqliteParam } from '../../../../kernel/ports/sqliteDatabase'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import { seedDelegationRows } from '../../testing/seedDelegationRows'

// L5 (17 §1.5; 09 §4.6, §6.5): the CHECKs of `delegations` and `delegation_tokens` that the two
// delegation stores rely on, probed on a copy of the run's template database (every migration
// applied, 0002 included): for each CHECK one row that stores and one that is rejected. Lead decision (ISSUE-198):
// the probes live in the delegation module rather than in `platform/sqlite/schema.contract.test.ts`,
// which another issue holds; they restate no DDL.
type Row = Record<string, SqliteParam>

const PARENT = '00000000-0000-7000-8000-0000000d3d01'
const WORKER = '00000000-0000-7000-8000-0000000d3d02'
const LAUNCHES = Array.from(
  { length: 12 },
  (_, n) => `00000000-0000-7000-8000-0000000d3a${n.toString(16).padStart(2, '0')}`
)
const HASH = 'a'.repeat(64)
const DELIVERED: Row = {
  handoff_via: 'tool-result',
  handoff_phase: 'delivered',
  handoff_phase_at: 4
}

let serial = 0

function insert(db: SqliteDatabase, table: string, row: Row): void {
  const columns = Object.keys(row)
  db.run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((column) => row[column] ?? null)
  )
}

function delegation(change: Row): Row {
  serial += 1
  const n = serial.toString(16).padStart(4, '0')
  return {
    id: `00000000-0000-7000-8000-0000000d${n}`,
    parent_dwarf_id: PARENT,
    ticket: `probe-ticket-${n}`,
    state: 'attempted',
    created_at: 1,
    ...change
  }
}

/** One stored and one rejected row per CHECK of 09 §4.6. */
const DELEGATION_CHECKS: readonly (readonly [string, Row, Row])[] = [
  ['id is 36 characters', {}, { id: 'short-id' }],
  ['task_text at most 4 000', { task_text: 'x'.repeat(4000) }, { task_text: 'x'.repeat(4001) }],
  [
    'context_text at most 16 000',
    { context_text: 'x'.repeat(16000) },
    { context_text: 'x'.repeat(16001) }
  ],
  ['state is known', { state: 'running' }, { state: 'queued' }],
  [
    'failure is known',
    { state: 'failed', failure: 'parent-gone', settled_at: 5 },
    { state: 'failed', failure: 'oops', settled_at: 5 }
  ],
  [
    'handoff_via is known',
    { state: 'running', ...DELIVERED },
    { state: 'running', ...DELIVERED, handoff_via: 'email' }
  ],
  [
    'handoff_phase is known',
    { state: 'running', ...DELIVERED, handoff_phase: 'sending' },
    { state: 'running', ...DELIVERED, handoff_phase: 'lost' }
  ],
  [
    'failure exactly when failed',
    { state: 'failed', failure: 'no-provider', settled_at: 5 },
    { state: 'failed', settled_at: 5 }
  ],
  [
    'settled_at exactly when settled',
    { state: 'succeeded', settled_at: 5, ...DELIVERED },
    { state: 'running', settled_at: 5 }
  ],
  [
    'the three handoff fields together',
    { state: 'running', ...DELIVERED },
    { state: 'running', handoff_via: 'tool-result' }
  ],
  [
    'succeeded only with handoff_phase delivered (INV-68)',
    { state: 'succeeded', settled_at: 5, ...DELIVERED },
    { state: 'succeeded', settled_at: 5, ...DELIVERED, handoff_phase: 'sending' }
  ],
  [
    'no task or context once settled',
    { state: 'running', task_text: 'Review the diff', context_text: 'PR 12' },
    { state: 'failed', failure: 'worker-lost', settled_at: 5, task_text: 'Review the diff' }
  ],
  ['the worker is never the parent', { worker_dwarf_id: WORKER }, { worker_dwarf_id: PARENT }]
]

const TOKEN_CHECKS: readonly (readonly [string, Row, Row])[] = [
  ['mechanism is known', { mechanism: 'in-process' }, { mechanism: 'env' }],
  [
    'credential_hash is 64 characters',
    { mechanism: 'ticket-file', credential_hash: HASH },
    { mechanism: 'ticket-file', credential_hash: 'abc' }
  ],
  // AMENDED for owner amendment N (AMENDMENT-14, OQ-85), 2026-10-15 (migration 0002, A14-05): every relay
  // entry (`ticket-file`, `protocol`) stores its credential hash; `in-process` never has one.
  [
    'credential_hash exactly for ticket-file and protocol',
    { mechanism: 'protocol', credential_hash: HASH },
    { mechanism: 'protocol' }
  ],
  [
    'no credential_hash on in-process',
    { mechanism: 'in-process' },
    { mechanism: 'in-process', credential_hash: HASH }
  ]
]

describe('09 §4.6 delegation CHECKs', () => {
  it('[ADR-013] the delegations and delegation_tokens CHECKs of 09 hold against the migrated schema', () => {
    const { db } = openTemplateCopy()
    seedDelegationRows(db, { dwarfs: [PARENT, WORKER], launches: LAUNCHES })

    for (const [check, stored, rejected] of DELEGATION_CHECKS) {
      expect(() => insert(db, 'delegations', delegation(stored)), check).not.toThrow()
      expect(() => insert(db, 'delegations', delegation(rejected)), check).toThrow(
        /CHECK constraint failed/
      )
    }

    const launches = [...LAUNCHES]
    const token = (change: Row): Row => ({
      launch_id: launches.shift() ?? null,
      parent_dwarf_id: PARENT,
      issued_at: 1,
      ...change
    })
    for (const [check, stored, rejected] of TOKEN_CHECKS) {
      expect(() => insert(db, 'delegation_tokens', token(stored)), check).not.toThrow()
      expect(() => insert(db, 'delegation_tokens', token(rejected)), check).toThrow(
        /CHECK constraint failed/
      )
    }
    // A14-06: the row is written before the launch's dwarf exists; its parent is bound later.
    expect(() =>
      insert(db, 'delegation_tokens', token({ mechanism: 'in-process', parent_dwarf_id: null }))
    ).not.toThrow()
  })
})
