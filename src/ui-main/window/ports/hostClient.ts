// HostClient: driven port of the window module, main half (05 §3.14; frozen copy 16 §4.14, contract 16 §4.14.1).
// UI main talks to the DwarfAI Host only through it; its adapter is `src/ui-main/host-client/HostClient.ts`, its
// double the in-process `FakeHost` (16 §4.14 table). Type-only (`16` §4.14; R2).
//
// The types the port names that no other document defines are fixed here, each from the sentence that names it:
// - `HostConnection`: ADR-002 D9's state type, copied verbatim in ./hostConnection.ts (16 §4.14.1 "Name").
// - `HostAvailability`: "available | unavailable{spawn-failed | crash-loop | incompatible | generation-restart |
//   elevated-refused | in-job | unresponsive}" (the `ensureHost` comment of 05 §3.14).
// - `Presence`: what the UI reports, "Presence {onScreenMineIds, anyWindowVisible, seq}" (05 §3.14), which is 14 §3.4
//   `PresenceParams` (the Host adds `anyUiAttached` itself, ADR-018). It moves to `contracts` with B-M07 (later:
//   ISSUE-111).
// - `HostEvent`: what `subscribe` hands its handler (ADR-003 item 7; 14 §4.2, §4.3 rule 1): a snapshot only once
//   every page arrived, as one `SnapshotPage` holding every chunk of every page and no `next`, then each `evt` frame
//   whose `seq` is greater than the last one applied, in order. A `resync-required` frame is not handed on: it makes
//   the client snapshot again, and the next `snapshot` event replaces the state (no walk-out from a difference).
import type {
  EvtFrame,
  HostMethod,
  HostParams,
  HostResult,
  MineId,
  SnapshotPage,
  SnapshotParams
} from '@dwarfai/contracts'

import type { HostConnection } from './hostConnection'

export type { HostConnection }

/** Why the Host is unavailable (ADR-002 D9). */
export type HostUnavailableReason = Extract<HostConnection, { state: 'unavailable' }>['reason']

/** What `ensureHost` settles with (ADR-002 D4, D9). */
export type HostAvailability = 'available' | { unavailable: HostUnavailableReason }

/** The UI's presence report (14 §3.4 `PresenceParams`; ADR-024 D7). */
export interface Presence {
  onScreenMineIds: MineId[]
  anyWindowVisible: boolean
  seq: number
}

/** What a `subscribe` handler receives (ADR-003 item 7; 14 §4.2, §4.3). */
export type HostEvent =
  /** A complete snapshot at `snapshot.seq`: every chunk of every page, no `next`. */
  | { kind: 'snapshot'; snapshot: SnapshotPage }
  /** One frame newer than the last snapshot or frame applied. */
  | { kind: 'frame'; frame: EvtFrame }

// verbatim: 05 §3.14 (the `HostClient` interface and the comment under it, byte-for-byte; `prettier-ignore` keeps
// its alignment)
// prettier-ignore
export interface HostClient {                                   // host-client; its state is ADR-002 D9's `HostConnection` type
  ensureHost(): Promise<HostAvailability>                       // ADR-002 D9: available | unavailable{spawn-failed | crash-loop | incompatible | generation-restart | elevated-refused | in-job | unresponsive}; respawn policy per D9 (3 crashes in 5 min → crash-loop); unresponsive = endpoint bound, no frame for 60 s (ADR-003 item 9; AMENDMENT-2, AR-13-02)
  state(): HostConnection                                       // ADR-002 D9 state (connecting | connected | reconnecting | unavailable)
  onStateChange(h: (s: HostConnection) => void): () => void
  capabilities(): readonly string[]                             // HelloOk.capabilities of the current connection (ADR-003 item 5): method, frame: and section: names (14 §1.3)
  call<M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]>   // feature-gated: a method absent from capabilities() is refused locally with NOT_SUPPORTED, never sent (ADR-027 D4, 14 §1.3)
  snapshot(p: SnapshotParams): Promise<SnapshotPage>            // paged session.snapshot (14 §4); only advertised sections are requested
  subscribe(handler: (e: HostEvent) => void): () => void       // ADR-003 item 7: subscribe first → snapshot → apply seq > snapshot.seq; resync-required → re-snapshot
  reportPresence(p: Presence): void                            // ADR-018/ADR-024 Presence {onScreenMineIds, anyWindowVisible, seq}
  withUiConnection<T>(work: (c: Pick<HostClient, 'call' | 'snapshot'>) => Promise<T>): Promise<T>   // the window's ui connection, or a short-lived one closed after work (Stop everything and quit, OQ-47)
}
// HostClient holds the `notifier` connection for the process's life and a `ui` connection while a window is open
// (ADR-003 item 12). For Stop everything and quit with no window open, withUiConnection opens a short-lived `ui`
// connection, reads the owned-session count, and on confirm calls host.shutdown {mode:'stop-all'}; on cancel it
// closes it (OQ-47).
// end verbatim: 05 §3.14
