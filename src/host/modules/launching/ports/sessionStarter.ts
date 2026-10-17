// Driven port of launching (05 §3.5, 16 §4.5 `SessionStarter`), as owner amendment N (AMENDMENT-14,
// OQ-85, A14-02, 2026-10-15) gives it its third argument: the bridge in `host/wiring`
// (wiring/bridges/sessionStarter.ts) starts the session through the suppliers driver's `launch`
// (ADR-009 D3) and classifies its outcome into ADR-020's causes. Type-only (R2).
//
// - Launching records, the bridge does not (16 §4.5 "Tx: — (caller records)"): the `launches` row is
//   committed before `start`, and the `processes` row is written in `req.onSpawned`, right after the
//   OS spawn and before the handshake wait (16 §2.2; 07 S4.01).
// - `ok` once the driver's readiness handshake completed and the 3-second early window survived
//   (ADR-020 D4; 07 S5.21); otherwise exactly one `LaunchFailure` whose cause is one of the three a
//   launch's own process can end with (`not-installed`, `could-not-start`, `exited-at-once`; the two
//   Jev causes settle in `routing`, before any start). Its `toolOutputTail`, causes 2–3 only, is at
//   most 400 characters and lives in Host memory only (ADR-020 item 6; INV-55).
// - `gate.launchedWithLetJevChoose` is the launch row's `launched_with_let_jev_choose` (09 D-17): the
//   delegation gate the bridge hands to `DelegationLifecycle.issueFor` (ADR-013 item 4; PO #50).
//   That call is EPIC-12's (later: ISSUE-201…ISSUE-203); until it lands the bridge starts every
//   session with `delegation: null`.
import type { LaunchFailure } from '../../../kernel/domain/sharedContracts'
import type { ProviderId } from '../../../kernel/domain/values'
import type { DriverLaunchRequest, DriverSession } from '../../suppliers'

/**
 * 05 `Result<DriverSession, LaunchFailure>`, spelled out: the kernel `Result` types its error as a
 * string literal (16 §2.1), and this port's error is the ADR-020 `LaunchFailure` object.
 */
export type StartResult = { ok: true; value: DriverSession } | { ok: false; error: LaunchFailure }

// Amended: 05 §3.5 / 16 §4.5 SessionStarter.start third argument (owner amendment N, AMENDMENT-14 A14-02, 2026-10-15)
export interface SessionStarter {
  start(
    providerId: ProviderId,
    req: DriverLaunchRequest,
    gate: { launchedWithLetJevChoose: boolean }
  ): Promise<StartResult>
} // bridge → delegation.issueFor (fills req.delegation), then suppliers ProviderDriver.launch (ADR-009) + ADR-020 classification; revokeLaunch when start fails
