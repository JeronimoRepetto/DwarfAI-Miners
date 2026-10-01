import { statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../kernel/domain/errors'
import type { CleanShutdownReason } from '../../kernel/domain/bootIdentity'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import { HostEpochLog, readResetEpoch } from './hostEpochLog'
import { SqliteTransactionRunner } from './SqliteTransactionRunner'
import { openTemplateCopy } from './testing/templateDb'

// L3 (17 §1.3): the `app_meta` epoch writer of 09 §8.4 over a copy of the run's template database
// (schema v1, migration 1's seed row), so every write meets the real §4.1 CHECKs.

const T0 = 1_790_000_000_000
const EPOCH_A = '01900000-0000-7000-8000-00000000000a'
const EPOCH_B = '01900000-0000-7000-8000-00000000000b'
const BOOT = {
  bootId: '6f1c2d0e-1b2a-4c3d-9e8f-0a1b2c3d4e5f',
  bootTimeMs: T0 - 3_600_000,
  logonSessionId: '0x3e7a1'
}

function epochColumns(db: SqliteDatabase): Record<string, unknown> {
  const [row] = db.all(
    `SELECT current_host_epoch, host_epoch_started_at, host_boot_id, host_boot_time_ms,
            host_logon_session_id, clean_shutdown_epoch, clean_shutdown_at, clean_shutdown_reason
     FROM app_meta WHERE id = 1`
  )
  return { ...row }
}

function setUp() {
  const { db, path } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const log = new HostEpochLog({ db, transactions })
  return { db, path, transactions, log }
}

describe('HostEpochLog (09 §8.4)', () => {
  it("[ADR-015] beginEpoch writes the epoch, its start instant and the boot identity, and clears the marker, in the caller's transaction", () => {
    const { db, transactions, log } = setUp()
    transactions.inTransaction(() =>
      log.beginEpoch(transactions, { epoch: EPOCH_A, startedAt: T0, bootIdentity: BOOT })
    )
    log.markClean('upgrade', T0 + 5_000)

    transactions.inTransaction(() =>
      log.beginEpoch(transactions, {
        epoch: EPOCH_B,
        startedAt: T0 + 60_000,
        bootIdentity: { ...BOOT, logonSessionId: '0x51c20' }
      })
    )

    expect(epochColumns(db)).toEqual({
      current_host_epoch: EPOCH_B,
      host_epoch_started_at: T0 + 60_000,
      host_boot_id: BOOT.bootId,
      host_boot_time_ms: BOOT.bootTimeMs,
      host_logon_session_id: '0x51c20',
      clean_shutdown_epoch: null,
      clean_shutdown_at: null,
      clean_shutdown_reason: null
    })
    // It joins the caller's transaction: when the caller's work fails, the epoch rolls back with it.
    expect(() =>
      transactions.inTransaction(() => {
        log.beginEpoch(transactions, { epoch: EPOCH_A, startedAt: T0 + 90_000, bootIdentity: BOOT })
        throw new Error('classification failed')
      })
    ).toThrow('classification failed')
    expect(epochColumns(db)['current_host_epoch']).toBe(EPOCH_B)
    // Outside a transaction it refuses: the epoch is only ever written inside one (09 §8.4 step 3).
    expect(() =>
      log.beginEpoch(transactions, { epoch: EPOCH_A, startedAt: T0, bootIdentity: BOOT })
    ).toThrow(HostInvariantError)
    expect(epochColumns(db)['current_host_epoch']).toBe(EPOCH_B)
  })

  it('[ADR-015] unreadable boot identity fields are stored as NULL', () => {
    const { db, transactions, log } = setUp()

    transactions.inTransaction(() =>
      log.beginEpoch(transactions, {
        epoch: EPOCH_A,
        startedAt: T0,
        bootIdentity: { bootId: 'unknown', bootTimeMs: 'unknown', logonSessionId: 'unknown' }
      })
    )

    expect(epochColumns(db)).toMatchObject({
      current_host_epoch: EPOCH_A,
      host_boot_id: null,
      host_boot_time_ms: null,
      host_logon_session_id: null
    })
    // Read back, a NULL is no reading again: 'unknown', never equal to anything (ADR-015 item 4).
    expect(log.readPrevious()).toEqual({
      epoch: EPOCH_A,
      startedAt: T0,
      bootIdentity: { bootId: 'unknown', bootTimeMs: 'unknown', logonSessionId: 'unknown' },
      marker: null
    })
  })

  it('[ADR-002] markClean writes epoch, time and reason, and the CHECK refuses the retired reason idle', () => {
    const { db, transactions, log } = setUp()
    transactions.inTransaction(() =>
      log.beginEpoch(transactions, { epoch: EPOCH_A, startedAt: T0, bootIdentity: BOOT })
    )

    log.markClean('stop-all', T0 + 5_000)

    expect(epochColumns(db)).toMatchObject({
      current_host_epoch: EPOCH_A,
      host_boot_id: BOOT.bootId,
      clean_shutdown_epoch: EPOCH_A,
      clean_shutdown_at: T0 + 5_000,
      clean_shutdown_reason: 'stop-all'
    })
    expect(() => log.markClean('idle' as CleanShutdownReason, T0 + 6_000)).toThrow(
      expect.objectContaining({ code: 'SQLITE_CONSTRAINT' })
    )
    expect(epochColumns(db)).toMatchObject({
      clean_shutdown_at: T0 + 5_000,
      clean_shutdown_reason: 'stop-all'
    })
  })

  it('[ADR-015] readPrevious answers null before any epoch, then the epoch with its boot identity and the marker of that epoch only', () => {
    const { db, transactions, log } = setUp()
    expect(log.readPrevious()).toBeNull()

    transactions.inTransaction(() =>
      log.beginEpoch(transactions, { epoch: EPOCH_A, startedAt: T0, bootIdentity: BOOT })
    )
    expect(log.readPrevious()).toEqual({
      epoch: EPOCH_A,
      startedAt: T0,
      bootIdentity: BOOT,
      marker: null
    })

    log.markClean('os-session-end', T0 + 5_000)
    expect(log.readPrevious()?.marker).toEqual({ reason: 'os-session-end', at: T0 + 5_000 })

    // A marker of another epoch is no marker of this one (09 §8.4 step 1).
    db.run('UPDATE app_meta SET clean_shutdown_epoch = ? WHERE id = 1', [EPOCH_B])
    expect(log.readPrevious()?.marker).toBeNull()
  })

  it('[ADR-002] markClean before any epoch writes nothing: there is no epoch to mark', () => {
    const { db, log } = setUp()

    log.markClean('stop-all', T0)

    expect(epochColumns(db)).toMatchObject({
      current_host_epoch: null,
      clean_shutdown_epoch: null,
      clean_shutdown_reason: null
    })
  })

  it('[ADR-002] flush truncates the write-ahead log (wal_checkpoint TRUNCATE, 09 §8.1)', () => {
    const { path, transactions, log } = setUp()
    transactions.inTransaction(() =>
      log.beginEpoch(transactions, { epoch: EPOCH_A, startedAt: T0, bootIdentity: BOOT })
    )
    log.markClean('stop-all', T0 + 5_000)
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0)

    log.flush()

    expect(statSync(`${path}-wal`).size).toBe(0)
  })

  it('[ADR-023] readResetEpoch reads app_meta.reset_epoch', () => {
    const { db } = setUp()
    expect(readResetEpoch(db)).toBe(0)

    db.run('UPDATE app_meta SET reset_epoch = 3 WHERE id = 1')

    expect(readResetEpoch(db)).toBe(3)
  })
})
