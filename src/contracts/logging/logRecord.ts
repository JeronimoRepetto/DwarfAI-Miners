import { z } from 'zod'
import { redactSecrets } from './redactSecrets'

// verbatim: ADR-026 item 3
// prettier-ignore
export interface LogRecord {
  ts: string                         // ISO-8601 UTC
  level: 'error' | 'warn' | 'info' | 'debug'
  proc: 'host' | 'ui' | 'shim'
  pid: number
  appVersion: string
  event: string                      // stable dotted id, e.g. 'launch.failed', 'driver.drift', 'host.start'
  subsystem: string                  // module name (ADR-004)
  outcome?: 'ok' | 'failed' | 'skipped' | 'degraded'
  causeClass?: string                // e.g. LaunchFailureCause, DeliveryFailure.kind, JevFallbackReason
  provider?: string                  // catalog id
  providerVersion?: string           // NFR-OBS-04
  dwarfId?: string; mineId?: string; launchId?: string   // opaque ids only
  errCode?: string                   // errno / JSON-RPC code
  msg?: string                       // fixed developer sentence, redacted (rule 5)
  count?: number                     // rate-limited repeats folded in (rule 6)
  // correlation and transport (CR-13-04 / CR-19-01); opaque ids and numbers only, never content
  requestId?: string                 // UUIDv7 minted by the renderer composable per intent (14 §1.6)
  hostEpoch?: string                 // Host epoch (hello.ok.epoch); with launchId it identifies the DWARFAI_SPAWN tag
  askId?: string; messageId?: string; delegationId?: string; resetId?: string
  connId?: string                    // hello.ok.clientId of the connection
  role?: 'ui' | 'notifier' | 'viewer' | 'mcp'
  method?: string                    // seam-B method or frame name, or seam-A member name; never params, data or result
  seq?: number                       // frame seq
  bytes?: number                     // frame or payload size
  durationMs?: number
  stack?: string                     // uncaught errors of DwarfAI code only: ≤ 10 frames, ≤ 2 000 chars (rule 5)
}
// end verbatim

export type LogLevel = LogRecord['level']
export type LogProc = LogRecord['proc']

/** A segment is closed at this size and a new one opened (ADR-026 item 1). */
export const LOG_SEGMENT_BYTES = 5_000_000
/** The whole `logs/` folder never exceeds this, decimal bytes (ADR-026 item 2, OQ-24). */
export const LOG_CAP_BYTES = 100_000_000
/** A writer runs the prune plan before opening a segment and after every 256 KiB written (ADR-026 item 2). */
export const PRUNE_EVERY_BYTES = 262_144

/**
 * An id field accepts only the shape its owning document declares (ADR-026 Verification: "ids ... of
 * their declared shape"). Where the owner declares UUIDv7 the field is `uuidV7` and the citation sits
 * on the field; where the owner declares a plain `string` (`hostEpoch`, `connId`) the field stays
 * `z.string()`. Content in those free-string fields is kept out by the writers (17 §1.7 canary).
 */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const uuidV7 = z.string().regex(UUID_V7)
/**
 * A token is never an id (ADR-026 item 4: "any token" is never logged): a value that `redactSecrets`
 * would change is refused even when it fits a lower-case id shape (a 64-hex token does).
 */
const notToken = (v: string): boolean => redactSecrets(v) === v
/**
 * ADR-026 item 3: `event` is a "stable dotted id"; 19 §9: "Event ids are stable dotted names". The
 * pattern admits every id of the 19 §9 catalog, including one-segment (`uncaught`) and hyphenated
 * (`host.job-status`) ones.
 */
const DOTTED_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/
/**
 * ADR-026 item 3: `provider` is a "catalog id". Catalog ids (`contracts/catalog` CATALOG_PROVIDER_IDS)
 * are lower-case ids; the catalog is open (ADR-009 D2), so the shape is checked, not the membership.
 */
const CATALOG_ID = /^[a-z][a-z0-9-]*$/
/** Numbers only, and finite: JSON has no NaN or Infinity. */
const num = z.number().finite()

/** The runtime twin of `LogRecord`: unknown keys, wrong types and off-shape ids are refused. */
export const logRecordSchema = z
  .object({
    ts: z.string().datetime(), // ADR-026 item 3: "ISO-8601 UTC" ('Z' designator only)
    level: z.enum(['error', 'warn', 'info', 'debug']),
    proc: z.enum(['host', 'ui', 'shim']),
    pid: num,
    appVersion: z.string(),
    event: z.string().regex(DOTTED_ID).refine(notToken), // ADR-026 item 3 "stable dotted id"
    subsystem: z.string(),
    outcome: z.enum(['ok', 'failed', 'skipped', 'degraded']).optional(),
    causeClass: z.string().optional(),
    provider: z.string().regex(CATALOG_ID).refine(notToken).optional(), // ADR-026 item 3 "catalog id"
    providerVersion: z.string().optional(),
    dwarfId: uuidV7.optional(), // ADR-015 item 7 ("UUIDv7 surrogate"); 06 §0.1 DwarfId
    mineId: uuidV7.optional(), // 06 §0.1 MineId "branded string, UUIDv7"
    launchId: uuidV7.optional(), // 06 §0.1 LaunchId "branded string, UUIDv7"
    errCode: z.string().optional(),
    msg: z.string().optional(),
    count: num.optional(),
    requestId: uuidV7.optional(), // ADR-026 item 3 "UUIDv7 minted by the renderer composable"; 14 §1.6
    hostEpoch: z.string().optional(), // 06 §0.1 HostEpoch "string"; ADR-003 HelloOk.epoch: string (free string; writers)
    askId: uuidV7.optional(), // 06 §0.1 AskId "branded string, UUIDv7"
    messageId: uuidV7.optional(), // 06 §0.1 MessageId "branded string, UUIDv7"
    delegationId: uuidV7.optional(), // 06 §0.1 DelegationId "branded string, UUIDv7"
    resetId: uuidV7.optional(), // 06 §0.1 ResetId "branded string, UUIDv7"
    connId: z.string().optional(), // ADR-003 item 5 HelloOk.clientId: string (free string; writers)
    role: z.enum(['ui', 'notifier', 'viewer', 'mcp']).optional(),
    method: z.string().optional(),
    seq: num.optional(),
    bytes: num.optional(),
    durationMs: num.optional(),
    stack: z.string().optional()
  })
  .strict()

/** The allowlist, in `LogRecord` declaration order (also the key order of a written line). */
export const LOG_RECORD_FIELDS = Object.keys(logRecordSchema.shape) as readonly (keyof LogRecord)[]
