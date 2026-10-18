// The delegation endpoint's ports (05 §3.8, 16 §4.8, §5; ADR-013 items 1, 3). Type-only (R2).
//
// - `DelegationEndpoint` is the driving port the MCP adapter calls (16 §5.4): `delegate` answers a
//   ticket at once or refuses for the gate and the limits; `result` waits up to `wait.maxMs` for
//   the ticket to settle, else answers `pending`. It lives here, not in `application/`, because
//   `DelegationServer.listen` names it and a port imports only ports and domain (R2).
// - `DelegationServer` is the driven port the MCP adapter (`McpDelegationServer`) implements: it
//   listens on the MCP endpoint (ADR-013 item 3), never on loopback TCP.
// - `ParentDeliverer` is the bridge to conversation (the turn-input handoff, ISSUE-205).
// - `SubtaskRouter` and `WorkerLauncher` (16 §4.8) are in `subtaskRouting.ts` (ISSUE-204).
//
// Package gaps, filled here (resolved in dev, recorded in the hand-off):
// - `LoopbackEndpoint` is named by 16 §4.8 and defined nowhere. The endpoint it describes is a
//   named pipe or a Unix socket (ADR-013 item 3), so it carries that path and no port.
// - `SubtaskResultView` is named by 16 §4.8 and defined nowhere. It is the 16 §5.4 tool-result
//   shape. `done.outcome` follows the shape 16 §5.4 cites at `0bfd108` (`TurnOutcome`: the
//   worker's turn-end kind and, when the provider returned one, its text). `pending` carries the
//   ticket; the `routing` 16 §5.4 lists is not on the 06 `Delegation` aggregate, so it is not
//   carried until the package says where it is kept.
// - The relay connection: the frozen `DelegationServer` has no way to receive an authenticated
//   connection from the transport. `DelegationRelayListener` is that seam: the transport
//   (`host/transport/mcpEndpoint`) binds the endpoint, authenticates the `McpHello`, binds the
//   token to the connection and hands it over; the server reads and writes one MCP JSON-RPC
//   message per frame (ADR-013 item 3) and never sees the credential.
import type { TurnEndKind } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, LaunchId, Result } from '../../../kernel/domain/values'
import type { SubtaskTextRefusal } from '../domain/subtaskText'
import type { DelegationToolFailure } from '../domain/toolFailure'
import type { DelegationToken } from './delegationStores'

/** The blocking wait of `delegate_subtask` and `subtask_result` (16 §2.6, §5.5; ADR-013 item 1). */
export const DELEGATION_WAIT_MS = 50_000

/** The finished subtask handed back on `done` (16 §5.4; never stored, never logged). */
export interface SubtaskOutcome {
  readonly kind: TurnEndKind
  readonly text?: string
  readonly truncated?: boolean
}

/**
 * A failed tool result's `failure` (16 §5.4): the 16 §5.4 kinds, plus two this adapter needs and
 * the 16 §5.4 table does not list (package gap, resolved in dev): a refused input is named by its
 * 06 `SubtaskText` refusal (`task-empty`, `task-too-long`, `context-too-long`), and a call the Host
 * could not complete (its launch revoked mid-call, a store failure) is `unavailable`. The detail
 * always ends with the fallback sentence and never carries an error message.
 */
export type SubtaskToolFailure =
  | DelegationToolFailure
  | { readonly kind: SubtaskTextRefusal | 'unavailable'; readonly detail: string }

/** The one tool-result shape of both tools (16 §5.4). */
export type SubtaskResultView =
  | { readonly status: 'done'; readonly outcome: SubtaskOutcome }
  | { readonly status: 'pending'; readonly ticket: string }
  | { readonly status: 'failed'; readonly failure: SubtaskToolFailure }

/** Where the MCP endpoint listens: a pipe name or a socket path, never a TCP port (ADR-013 item 3). */
export interface LoopbackEndpoint {
  readonly path: string
}

// As 16 §4.8 writes them (copy of 05 §3.8; names, members and comments; layout by prettier)
export interface DelegationEndpoint {
  // called by the MCP transport adapter (ADR-013 item 3)
  // delegate refuses synchronously only for the gate and the limits; Jev, provider and worker failures settle later
  // and are read through result (06 DelegationFailure: jev-unreachable, jev-could-not-choose, no-provider, …)
  delegate(
    token: DelegationToken,
    subtask: { task: string; context?: string }
  ): Promise<Result<{ ticket: string }, 'gate-closed' | 'concurrency-limit' | 'depth-exceeded'>>
  result(
    token: DelegationToken,
    ticket: string,
    wait: { maxMs: number }
  ): Promise<SubtaskResultView> // waits up to maxMs for done/failed, else 'pending' (DELEGATION_WAIT_MS, 16 §5.5)
}
export interface DelegationServer {
  listen(handler: DelegationEndpoint): Promise<{ endpoint: LoopbackEndpoint }>
  close(): Promise<void>
}
export interface ParentDeliverer {
  deliver(parent: DwarfId, text: string): Promise<Result<'delivered', 'cannot-receive' | 'failed'>>
} // bridge → conversation.deliverInvisibly (turn-input route only); result → Delegation.handoff

/**
 * One authenticated relay connection (16 §5.2 items 4–5). `token` is the Host-side handle bound at
 * authentication: the launch's token row without its hash, never the credential value.
 */
export interface DelegationRelayConnection {
  readonly token: DelegationToken
  /** Writes one MCP JSON-RPC message as one frame. */
  send(message: unknown): void
  /** Each frame's one MCP JSON-RPC message, in arrival order. */
  onMessage(listener: (message: unknown) => void): void
  /** Called once when the connection closed, from either side. */
  onClose(listener: () => void): void
  /** Ends the connection without a frame. */
  close(): void
}

/** The MCP endpoint as the server sees it: authenticated connections, one per relay. */
export interface DelegationRelayListener {
  listen(
    accept: (connection: DelegationRelayConnection) => void
  ): Promise<{ endpoint: LoopbackEndpoint; close(): Promise<void> }>
}

/** The launch facts the gate re-reads on every call (16 §4.8; 09 `launches`, D-17). */
export interface DelegationLaunchFacts {
  /** `launched_with_let_jev_choose` and `delegated` of the launch, or `null` when it is unknown. */
  gateOf(launchId: LaunchId): { launchedWithLetJevChoose: boolean; delegated: boolean } | null
}

/**
 * Package gap (16 §5.4: "`phase:'delivered'` once the response was flushed to the connection
 * without error"; the frozen `DelegationEndpoint.result` cannot report it): the MCP adapter tells
 * the handoff, for each `done` answer it wrote, whether its response frame left on an open
 * connection. The answer is the very object `result` returned, so the adapter needs no ticket.
 */
export interface DelegationHandoffReport {
  responseFlushed(answer: SubtaskResultView, flushed: boolean): void
}
