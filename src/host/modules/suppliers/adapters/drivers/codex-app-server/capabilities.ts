// The Codex `app-server-rpc` driver's capability row (15 §3 row X1) and its probe reading (15 §2.3
// row Codex, ADR-009 D4). Every UNVERIFIED `U→x` value of row X1 is held at its in-force `x`
// (INV-44). The spike records this driver follows (ISSUE-325, Codex 0.153.4 on Windows; macOS and
// Linux not run, not claimed):
// - SP-12 partial → `mcpInjection` stays `ticket-file` (the path-only Jev entry in argv);
// - S-015-1 failed (the app-server daemon is Unix-only) → `adopt` stays `false`, and recovery is
//   `thread/resume` (ADR-015 item 5: `adopt` stays false whatever S-015-1 finds).
import type { ProviderCapabilities } from '../../../domain/capabilities'

/** The verdicts of the committed records this row follows (`spike-results/`). */
export interface SpikeRecords {
  /** `spike-results/SP-12.md`: a per-session MCP entry through the protocol. */
  readonly sp12: 'passed' | 'partial' | 'failed'
  /** `spike-results/S-015-1.md`: adopt through the app-server daemon. */
  readonly s0151: 'passed' | 'failed'
}

/** ISSUE-325's records. Only a committed record may change a value here. */
export const SPIKE_RECORDS: SpikeRecords = Object.freeze({ sp12: 'partial', s0151: 'failed' })

/** 15 §3 row X1, every `U→x` at its in-force `x`; the probe opens `launch`. */
export const APP_SERVER_ROW: Readonly<ProviderCapabilities> = Object.freeze({
  launch: false, // the probe opens it when `codex --help` lists the app-server subcommand
  observe: true,
  sendTurn: true, // turn/start
  interrupt: true, // turn/interrupt
  permission: 'interactive', // approvals as server requests
  question: 'form', // item/tool/requestUserInput (EXPERIMENTAL)
  answeredElsewhere: true, // serverRequest/resolved
  staleAnswerSafe: true,
  resume: 'resume', // thread/resume
  adopt: false, // U→no: S-015-1 failed; ADR-015 item 5
  turnEnd: 'reliable', // turn/completed
  reactionEvidence: 'turn-id',
  subagents: 'events', // ThreadSourceKind.subAgent*
  usage: Object.freeze({ fidelity: 2, rateLimits: true }), // account/rateLimits/* (HR U1)
  mcpInjection: 'ticket-file', // → protocol only after SP-12 passes (it is partial)
  console: 'log', // attach only after S-031-1
  earlyFailure: 'handshake',
  installDetection: 'user-binary',
  observedPermission: 'none', // n/a for a driver row
  observedQuestion: 'none'
}) as Readonly<ProviderCapabilities>

/** `app-server` listed as a subcommand of its own (a Commands line, not prose). */
const APP_SERVER_COMMAND = /^ {2}app-server(?=\s|$)/m

/**
 * The probed capabilities (15 §2.3): `launch` is true only when the help lists the app-server
 * subcommand; a help that could not be read (`null`: no answer within PROBE_TIMEOUT_MS, a failed
 * run) gives the fail-closed `launch: false`, so the profile falls to `codex-acp` (ADR-009 D4).
 * The spike-gated fields (`mcpInjection`, `adopt`) keep the row's values whatever the help says:
 * SP-12 is partial and S-015-1 failed (`SPIKE_RECORDS`), and neither a protocol entry nor a daemon
 * adopt is built (hidden until built, 21 §1 item 8).
 */
export function capabilitiesFromHelp(help: string | null): ProviderCapabilities {
  return {
    ...APP_SERVER_ROW,
    usage: { ...APP_SERVER_ROW.usage },
    launch: help !== null && APP_SERVER_COMMAND.test(help)
  }
}
