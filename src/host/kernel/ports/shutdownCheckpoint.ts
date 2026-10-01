// Kernel driven port (ADR-002 D7; 07 S12.10, S12.16, S12.17; lead decision 2026-09-30 in
// ISSUE-028): the checkpoint every clean exit runs before it sends `host.closing`. `flush()`
// makes the database durable; `markClean(reason)` records the clean-shutdown marker with its
// reason, so the next boot's reconcile tells an upgrade drain (resume) from an OS session end
// or Stop everything and quit (ADR-015 item 4; OQ-55).
//
// The marker lives in `app_meta` (09 §8.4), written by `platform/sqlite/hostEpochLog.ts`, which
// host/main.ts binds once the boot opened the database (ISSUE-039). The reasons are the kernel
// domain's (`domain/bootIdentity.ts`), where the next boot reads them back.
import type { CleanShutdownReason } from '../domain/bootIdentity'

export type { CleanShutdownReason } from '../domain/bootIdentity'

export interface ShutdownCheckpoint {
  flush(): void
  markClean(reason: CleanShutdownReason): void
}
