import { describe, expect, it } from 'vitest'
import type { ProviderId } from '../../../../kernel/domain/values'
import { RecordingDiagnosticsLog } from '../../../../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../../../../kernel/fakes/SequenceIdGenerator'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import { NodeSqliteDatabase } from '../../../../platform/sqlite/NodeSqliteDatabase'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { FaultySqlite, SimulatedCrash } from '../../../../platform/sqlite/testing/FaultySqlite'
import { copyTemplateDb, openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import { FAIL_CLOSED_CAPABILITIES, type ProviderCapabilities } from '../../domain/capabilities'
import { runCapabilityRecordStoreContract } from '../../testing/capabilityRecordStore.contract'
import { SqliteCapabilityRecordStore } from './SqliteCapabilityRecordStore'

// L3 (17 §1.3): the same contract as the in-memory double, over a copy of the run's template
// database (schema v1, migration 1 applied), so every row meets the real `capability_records`
// CHECKs and its UNIQUE (provider_id, provider_version) key (09 §4.3).

function storeOver(
  db: SqliteDatabase,
  log = new RecordingDiagnosticsLog(),
  ids = new SequenceIdGenerator()
) {
  return new SqliteCapabilityRecordStore({
    db,
    tx: new SqliteTransactionRunner(db),
    ids,
    log
  })
}

function rows(db: SqliteDatabase, id: ProviderId) {
  return db.all(
    'SELECT id, provider_version, measured_at FROM capability_records WHERE provider_id = ? ORDER BY provider_version',
    [id]
  )
}

const caps = (fidelity: 0 | 1 | 2): ProviderCapabilities => ({
  ...FAIL_CLOSED_CAPABILITIES,
  launch: true,
  usage: { fidelity, rateLimits: false }
})

describe('SqliteCapabilityRecordStore', () => {
  runCapabilityRecordStoreContract('SqliteCapabilityRecordStore', () => {
    const { db } = openTemplateCopy()
    return {
      store: storeOver(db),
      heldVersions: (id) => rows(db, id).map((row) => String(row['provider_version']))
    }
  })

  it('[NFR-OBS-04] recording the same provider version again replaces its row, never a second one', () => {
    const { db } = openTemplateCopy()
    const store = storeOver(db)
    store.record('alpha', '4.0.0', caps(0), 100)
    const [first] = rows(db, 'alpha')

    store.record('alpha', '4.0.0', caps(2), 200)

    // One row for the version, its surrogate id kept, its measurement replaced (16 §4.4).
    expect(rows(db, 'alpha')).toEqual([
      { id: first?.['id'], provider_version: '4.0.0', measured_at: 200 }
    ])
    expect(store.latest('alpha')?.caps.usage.fidelity).toBe(2)
  })

  it('[INV-44] a row whose capabilities_json no longer parses is treated as absent and logged', () => {
    const { db } = openTemplateCopy()
    const log = new RecordingDiagnosticsLog()
    const store = storeOver(db, log)
    store.record('alpha', '5.0.0', caps(1), 100)
    store.record('bravo', '6.0.0', caps(1), 100)
    // The newest row of each provider no longer holds a `ProviderCapabilities`: JSON of another
    // shape (a field of the wrong kind, a field missing) and, past the json_valid CHECK, no JSON.
    db.run(
      `INSERT INTO capability_records (id, provider_id, provider_version, capabilities_json, measured_at)
       VALUES ('00000000-0000-7000-8000-0000000000a1', 'alpha', '5.1.0', '{"launch":"yes"}', 200)`
    )
    db.exec('PRAGMA ignore_check_constraints = ON')
    db.run(
      `INSERT INTO capability_records (id, provider_id, provider_version, capabilities_json, measured_at)
       VALUES ('00000000-0000-7000-8000-0000000000b1', 'bravo', '6.1.0', '{not json', 200)`
    )
    db.exec('PRAGMA ignore_check_constraints = OFF')

    // No record: the caller applies the fail-closed values (INV-44), it never sees a half record.
    expect(store.latest('alpha')).toBeNull()
    expect(store.latest('bravo')).toBeNull()
    expect(log.byEvent('capability-record.unreadable')).toEqual([
      {
        level: 'warn',
        event: 'capability-record.unreadable',
        subsystem: 'suppliers',
        provider: 'alpha',
        providerVersion: '5.1.0'
      },
      {
        level: 'warn',
        event: 'capability-record.unreadable',
        subsystem: 'suppliers',
        provider: 'bravo',
        providerVersion: '6.1.0'
      }
    ])
  })

  it('[NFR-OBS-04] [CH-11] a crash right after recording an eleventh version still leaves ten rows', () => {
    const path = copyTemplateDb()
    const log = new RecordingDiagnosticsLog()
    const ids = new SequenceIdGenerator()
    const first = NodeSqliteDatabase.open(path)
    try {
      const store = storeOver(first, log, ids)
      for (let minor = 0; minor < 10; minor += 1) {
        store.record('alpha', `8.${minor}.0`, caps(1), 1_000 + minor)
      }
    } finally {
      first.close()
    }

    // The Host dies right after the first commit of the eleventh version's record (CH-11): a prune
    // not committed with that record is never done.
    const faulty = FaultySqlite.open(path)
    try {
      faulty.crashAfterCommit(1)
      expect(() => storeOver(faulty, log, ids).record('alpha', '8.10.0', caps(2), 2_000)).toThrow(
        SimulatedCrash
      )
    } finally {
      faulty.close()
    }

    const reopened = NodeSqliteDatabase.open(path)
    try {
      expect(rows(reopened, 'alpha')).toHaveLength(10)
      expect(storeOver(reopened).latest('alpha')?.version).toBe('8.10.0')
    } finally {
      reopened.close()
    }
  })

  it('[ADR-009] records survive closing and reopening the database', () => {
    const path = copyTemplateDb()
    const first = NodeSqliteDatabase.open(path)
    try {
      storeOver(first).record('alpha', '7.0.0', caps(2), 300)
    } finally {
      first.close()
    }

    const reopened = NodeSqliteDatabase.open(path)
    try {
      expect(storeOver(reopened).latest('alpha')).toEqual({
        version: '7.0.0',
        caps: caps(2),
        at: 300
      })
    } finally {
      reopened.close()
    }
  })
})
