// The OpenCode `http-server` driver's design row and the spike outcomes it is built on (15 §3 row
// O1, §4.6; ADR-009 D4). Pure data.
import type { ProviderCapabilities } from '../../../domain/capabilities'

/**
 * How a Host-launched `opencode serve` is protected (ADR-009 D4): (a) an owner-only endpoint, (b) a
 * per-launch password delivered by an allowed means. S-031-3 (spike S-031-3, OpenCode
 * 1.18.32) verified neither: the password goes only through argv or env, both forbidden by ADR-017
 * item 3, and `serve` listens on TCP only. `null` is that outcome: the driver never starts a
 * server, so no loopback listener without a password can exist (FM-084), and option (c), the
 * `acp` entry, launches OpenCode instead.
 */
export const SERVER_PROTECTION: 'owner-only-endpoint' | 'password' | null = null

/**
 * SP-14 (spike SP-14, passed at 1.18.32): `POST /session/{id}/abort?directory=<cwd>`
 * ends one session's turn and leaves the shared server running. Without it a close would fall to
 * the tree kill of the Host's own server (15 §4.6 End / kill).
 */
export const SESSION_ABORT_RECORDED = true

/**
 * 15 §3 row O1, every UNVERIFIED value at its in-force one (INV-44): `launch` stays closed until
 * S-031-3 records a protection (above); `interrupt` is the SP-14 abort; `question` U→none;
 * `answeredElsewhere` U→no (SP-09); `resume` U→none; `turnEnd` none until S-021-2. `adopt` is the
 * server-kind re-attach of a Host-launched server; with no server ever launched there is nothing to
 * re-attach, so the probe reports it closed too.
 */
export const O1_ROW: ProviderCapabilities = {
  launch: false,
  observe: true,
  sendTurn: true,
  interrupt: SESSION_ABORT_RECORDED,
  permission: 'interactive',
  question: 'none',
  answeredElsewhere: false,
  staleAnswerSafe: true,
  resume: 'none',
  adopt: false,
  turnEnd: 'none',
  reactionEvidence: 'transcript-match',
  subagents: 'transcript',
  usage: { fidelity: 1, rateLimits: false },
  mcpInjection: 'ticket-file',
  console: 'log',
  earlyFailure: 'handshake',
  installDetection: 'user-binary',
  observedPermission: 'none',
  observedQuestion: 'none'
}
