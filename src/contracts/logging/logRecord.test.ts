import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import { CATALOG_PROVIDER_IDS } from '../catalog'
import {
  LOG_CAP_BYTES,
  LOG_RECORD_FIELDS,
  LOG_SEGMENT_BYTES,
  PRUNE_EVERY_BYTES,
  logRecordSchema,
  type LogRecord
} from './logRecord'

describe('LogRecord (ADR-026 items 1–3)', () => {
  it("[ADR-026] the strict schema declares exactly ADR-026 item 3's fields and infers LogRecord", () => {
    expectTypeOf<z.infer<typeof logRecordSchema>>().toEqualTypeOf<LogRecord>()
    expect(LOG_RECORD_FIELDS).toEqual([
      'ts',
      'level',
      'proc',
      'pid',
      'appVersion',
      'event',
      'subsystem',
      'outcome',
      'causeClass',
      'provider',
      'providerVersion',
      'dwarfId',
      'mineId',
      'launchId',
      'errCode',
      'msg',
      'count',
      'requestId',
      'hostEpoch',
      'askId',
      'messageId',
      'delegationId',
      'resetId',
      'connId',
      'role',
      'method',
      'seq',
      'bytes',
      'durationMs',
      'stack'
    ])
    const valid = {
      ts: '2026-10-02T09:14:03.120Z',
      level: 'info',
      proc: 'ui',
      pid: 1,
      appVersion: '0.20.0',
      event: 'host.start',
      subsystem: 'host'
    }
    expect(logRecordSchema.safeParse(valid).success).toBe(true)
    expect(logRecordSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false)
  })

  it('[ADR-026] each id field takes the shape its owner declares: UUIDv7 where declared, any string for hostEpoch and connId', () => {
    const valid = {
      ts: '2026-10-02T09:14:03.120Z',
      level: 'info',
      proc: 'host',
      pid: 1,
      appVersion: '0.20.0',
      event: 'channel.attach',
      subsystem: 'transport'
    }
    const uuidV7 = '0192f0c1-7a2e-7c3d-9f00-5b1a2c3d4e5f'
    // HostEpoch is `string` (06 §0.1) and HelloOk.clientId is `string` (ADR-003 item 5).
    for (const field of ['hostEpoch', 'connId']) {
      expect(logRecordSchema.safeParse({ ...valid, [field]: 'boot-7' }).success, field).toBe(true)
    }
    // Owners declaring UUIDv7: 06 §0.1 (MineId, DwarfId, AskId, MessageId, LaunchId, DelegationId,
    // ResetId) and ADR-026 item 3 (requestId).
    for (const field of [
      'dwarfId',
      'mineId',
      'launchId',
      'requestId',
      'askId',
      'messageId',
      'delegationId',
      'resetId'
    ]) {
      expect(logRecordSchema.safeParse({ ...valid, [field]: uuidV7 }).success, field).toBe(true)
      expect(logRecordSchema.safeParse({ ...valid, [field]: 'boot-7' }).success, field).toBe(false)
    }
  })

  it('[ADR-026] event is a stable dotted id and provider a lower-case catalog id; any other value is refused', () => {
    const valid = {
      ts: '2026-10-02T09:14:03.120Z',
      level: 'warn',
      proc: 'host',
      pid: 1,
      appVersion: '0.20.0',
      event: 'launch.failed',
      subsystem: 'launching'
    }
    const accepts = (extra: Record<string, unknown>): boolean =>
      logRecordSchema.safeParse({ ...valid, ...extra }).success
    const token = 'a1b2c3d4'.repeat(8)

    // Event ids of the 19 §9 catalog, including one-segment and hyphenated ones.
    for (const event of [
      'host.start',
      'host.boot.unclean',
      'host.job-status',
      'versioned-copy',
      'uncaught'
    ]) {
      expect(accepts({ event }), event).toBe(true)
    }
    for (const event of [
      'Thorin Canarybeard',
      'launch failed',
      'Launch.Failed',
      '',
      '.x',
      'x.',
      'a..b',
      token
    ]) {
      expect(accepts({ event }), event).toBe(false)
    }

    for (const provider of [...CATALOG_PROVIDER_IDS, 'claude-code']) {
      expect(accepts({ provider }), provider).toBe(true)
    }
    for (const provider of ['Claude', 'open code', 'codex.cli', '', token]) {
      expect(accepts({ provider }), provider).toBe(false)
    }
  })

  it('[ADR-026] the segment, cap and prune constants are 5 000 000, 100 000 000 and 262 144 bytes', () => {
    expect(LOG_SEGMENT_BYTES).toBe(5_000_000)
    expect(LOG_CAP_BYTES).toBe(100_000_000)
    expect(PRUNE_EVERY_BYTES).toBe(262_144)
  })
})
