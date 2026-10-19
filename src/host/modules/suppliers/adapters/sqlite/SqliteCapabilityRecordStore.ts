// `SqliteCapabilityRecordStore` (16 §4.4; 05 §3.4): measured provider behaviour with the provider
// version and the date (NFR-OBS-04) in `capability_records` (09 §4.3), in bound SQL only. The one
// writer of that table. Held to `runCapabilityRecordStoreContract`, like the in-memory double.
//
// - `record` upserts on `(provider_id, provider_version)` (the table's UNIQUE key; 16 §4.4), then
//   prunes the provider to its newest 10 versions by `measured_at` (09 §7.1), both in one
//   transaction: it joins the caller's when one is open, and opens its own otherwise (16 §2.2).
//   A re-probe of the same version keeps the row's id and replaces its measurement.
// - `latest` reads the provider's newest row through the `capability_records_latest` index; on an
//   equal date the later inserted row is the newer one.
// - Reset metrics never touches these rows (09 §7.2): this adapter has no reset step.
import { z } from 'zod'
import type { Instant, ProviderId } from '../../../../kernel/domain/values'
import type { DiagnosticsLog } from '../../../../kernel/ports/diagnosticsLog'
import type { IdGenerator } from '../../../../kernel/ports/idGenerator'
import type { SqliteDatabase } from '../../../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../../../kernel/ports/transactionRunner'
import type { ProviderCapabilities } from '../../domain/capabilities'
import type { CapabilityRecordStore } from '../../ports/capabilityRecordStore'

/** 09 §7.1: the newest versions kept per provider. */
const CAPABILITY_RECORDS_KEPT = 10

export interface SqliteCapabilityRecordStoreDeps {
  /** The Host's one writer (09 §8.1). */
  db: SqliteDatabase
  /** The `SqliteTransactionRunner` of the same connection. */
  tx: TransactionRunner
  /** The surrogate `id` of a new row (09 §2). */
  ids: IdGenerator
  log: DiagnosticsLog
}

/**
 * The read-back check of a stored `ProviderCapabilities` (ADR-009 D2, the owner of the type; this
 * schema is checked against it at compile time). A field missing, unknown or of the wrong kind
 * makes the row unreadable, so a stale or damaged measurement never reaches a caller (INV-44).
 */
const capabilitiesSchema = z
  .object({
    launch: z.boolean(),
    observe: z.boolean(),
    sendTurn: z.boolean(),
    interrupt: z.boolean(),
    permission: z.enum(['interactive', 'policy-only', 'none']),
    question: z.enum(['form', 'options', 'none']),
    answeredElsewhere: z.boolean(),
    staleAnswerSafe: z.boolean(),
    resume: z.enum(['load', 'resume', 'cli-flag', 'none']),
    adopt: z.boolean(),
    turnEnd: z.enum(['reliable', 'none']),
    reactionEvidence: z.enum(['turn-id', 'transcript-match', 'none']),
    subagents: z.enum(['events', 'transcript', 'none']),
    usage: z
      .object({
        fidelity: z.union([z.literal(0), z.literal(1), z.literal(2)]),
        rateLimits: z.boolean()
      })
      .strict(),
    mcpInjection: z.enum(['in-process', 'protocol', 'ticket-file', 'none']),
    console: z.enum(['focus-terminal', 'attach', 'log']),
    earlyFailure: z.enum(['handshake', 'exit-only']),
    installDetection: z.enum(['user-binary', 'none']),
    observedPermission: z.enum(['detected', 'none']),
    observedQuestion: z.enum(['detected', 'none'])
  })
  .strict() satisfies z.ZodType<ProviderCapabilities>

const UPSERT = `INSERT INTO capability_records
    (id, provider_id, provider_version, capabilities_json, measured_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (provider_id, provider_version) DO UPDATE SET
    capabilities_json = excluded.capabilities_json,
    measured_at = excluded.measured_at`

const NEWEST_FIRST = 'ORDER BY measured_at DESC, rowid DESC'

const PRUNE = `DELETE FROM capability_records
  WHERE provider_id = ?
    AND id NOT IN (SELECT id FROM capability_records WHERE provider_id = ? ${NEWEST_FIRST} LIMIT ?)`

const LATEST = `SELECT provider_version, capabilities_json, measured_at FROM capability_records
  WHERE provider_id = ? ${NEWEST_FIRST} LIMIT 1`

export class SqliteCapabilityRecordStore implements CapabilityRecordStore {
  constructor(private readonly deps: SqliteCapabilityRecordStoreDeps) {}

  record(id: ProviderId, version: string, caps: ProviderCapabilities, at: Instant): void {
    const { db, tx, ids } = this.deps
    tx.inTransaction(() => {
      db.run(UPSERT, [ids.uuidv7(), id, version, JSON.stringify(caps), at])
      db.run(PRUNE, [id, id, CAPABILITY_RECORDS_KEPT])
    })
  }

  latest(id: ProviderId): { version: string; caps: ProviderCapabilities; at: Instant } | null {
    const row = this.deps.db.all(LATEST, [id])[0]
    if (row === undefined) return null
    const version = String(row['provider_version'])
    const caps = parseCapabilities(String(row['capabilities_json']))
    if (caps === null) {
      this.deps.log.record({
        level: 'warn',
        event: 'capability-record.unreadable',
        subsystem: 'suppliers',
        provider: id,
        providerVersion: version
      })
      return null
    }
    return { version, caps, at: Number(row['measured_at']) }
  }
}

/** A stored `capabilities_json` read back; `null` when it is not JSON or not a `ProviderCapabilities`. */
function parseCapabilities(json: string): ProviderCapabilities | null {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  const parsed = capabilitiesSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
