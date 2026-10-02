// The central driven seam: ADR-009 D3 (`ProviderDriver`, `SessionRef`, `DriverSession`,
// `DriverEvent`), copied field for field — ADR-009 is the owner and wins on any difference — and
// the supporting types 15 §1.2 owns. Owner types of other documents are imported, never restated
// (15 §1.2: ADR-010, ADR-020, ADR-021, ADR-006, ADR-011, 06 §0). Type-only (R2).
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type {
  AnswerOutcome,
  LaunchFailureCause,
  PermissionPayload,
  QuestionAnswers,
  QuestionPayload,
  SourceKey,
  TurnEnded,
  UsageObservation
} from '../../../kernel/domain/sharedContracts'
import type {
  FolderPath,
  Instant,
  LaunchId,
  MessageId,
  ProviderId
} from '../../../kernel/domain/values'
import type { ProviderCapabilities } from '../domain/capabilities'
import type { DriverTransport, PermissionModeSpec, ProviderProfile } from '../domain/profile'

/**
 * `ProviderDriver.observer?()` returns the observation module's `ObservationAdapter` (05 §3.3).
 * The edge is observation → suppliers (05 §1.3), so suppliers cannot import that type without a
 * cycle (R5): here it is opaque, and the observation module narrows it to its own port.
 */
export type ObservationAdapter = unknown

// ---------- ADR-009 D3 ----------

export interface ProviderDriver {
  readonly profile: ProviderProfile
  readonly transport: DriverTransport
  detect(): Promise<DetectResult> // AQ-22 (D5)
  probe(install: InstalledProvider): Promise<ProviderCapabilities> // runtime capability check (AQ-30)
  launch(req: DriverLaunchRequest): Promise<DriverSession> // resolves only after the handshake
  resume?(ref: SessionRef): Promise<DriverSession> // ADR-015
  adopt?(ref: SessionRef): Promise<DriverSession | null> // server-kind re-attach (ADR-002 D8)
  observer?(): ObservationAdapter // passive observation (transplanted parsers)
}

export interface SessionRef {
  providerId: ProviderId
  providerSessionId: string
  providerAgentId?: string // subagent sharing its parent's session (ADR-015 item 7)
  previousProviderSessionId?: string // set by a Host-driven resume that minted a new id (ADR-015 item 7)
  pid?: number
  processStartTimeMs?: number
  serverUrl?: string
}

export interface DriverSession {
  readonly ref: SessionRef
  readonly capabilities: ProviderCapabilities // effective
  events(): AsyncIterable<DriverEvent>
  sendTurn(input: TurnInput): Promise<SendReceipt> // SendReceipt carries echo correlation (ADR-007)
  interrupt(): Promise<void>
  answerPermission(req: {
    providerRequestId: string
    decision: 'allow' | 'deny'
  }): Promise<AnswerOutcome>
  answerQuestion(
    req:
      | { providerRequestId: string; answers: QuestionAnswers }
      | { providerRequestId: string; decline: true } // explicit decline (ADR-011 item 3 cancel, Codex isSecret)
  ): Promise<AnswerOutcome>
  close(mode: 'detach' | 'end-thread'): Promise<CloseOutcome> // protocol close; process kill is ADR-014's
}

// AnswerOutcome is defined once in ADR-010 item 5 (AQ-09); the driver returns that type unchanged.

export type DriverEvent =
  | { t: 'message'; record: MessageInput } // ADR-007
  | { t: 'activity'; step: ActivityStep }
  | { t: 'ask.opened'; ask: AskInput } // ADR-010
  | { t: 'ask.resolved'; providerRequestId: string; by: 'elsewhere' | 'cancelled' }
  | { t: 'usage'; observation: UsageObservationInput } // ADR-006
  | { t: 'status'; value: 'working' | 'idle' }
  // AMENDED (owner-approved 2026-10-02, ADR-009 D3: driver turn.ended payload omits dwarfId);
  // was: `end: TurnEnded`. A driver cannot know the dwarf (ADR-015 item 7): suppliers stamps it.
  | { t: 'turn.ended'; end: DriverTurnEnded } // TurnEnded as defined by ADR-021 D1 (kind, reliability, turnKey, …)
  | { t: 'subagent'; childRef: SessionRef; parentRef: SessionRef }
  | { t: 'error'; cause: DriverErrorCause }
  | { t: 'exited'; code: number | null }

/**
 * The driver side of ADR-021's `TurnEnded` (AMENDED, owner-approved 2026-10-02, ADR-009 D3): the
 * payload without `dwarfId`, as `UsageObservationInput` omits it (15 §1.2). Suppliers fills it
 * with the dwarf bound to the session before the event leaves the module.
 */
export type DriverTurnEnded = Omit<TurnEnded, 'dwarfId'>

// ---------- 15 §1.2: detection and probe (ADR-009 D5, AQ-22, AQ-30) ----------

export interface InstalledProvider {
  providerId: ProviderId
  binaryPath: string // realpath of the USER's CLI (one resolver, ADR-009 D5); never an SDK/adapter-bundled binary
  version: string | null // from the CLI's own `--version`; null if it did not answer within PROBE_TIMEOUT_MS
  resolvedVia: 'path' | 'package-manager-dir' | 'login-shell-path'
  statMtimeMs: number // cache revalidation key (ADR-009 D5)
}

export type DetectResult =
  | { kind: 'installed'; install: InstalledProvider }
  | { kind: 'not-installed' }
  | { kind: 'quarantined'; path: string } // resolved but never spawned to probe it (HR R2); treated as not installed

// ---------- 15 §1.2: launch ----------

export interface DelegationInjection {
  // ADR-013 item 3; present only when the launch is gated in (ADR-013 item 4)
  mechanism: 'in-process' | 'protocol' | 'ticket-file' // = effective capabilities.mcpInjection (never 'none' here)
  relay?: { program: string; args: readonly string[] } // protocol / ticket-file: the `dwarfai-mcp` relay (versioned copy)
  credentialFilePath?: string // protocol / ticket-file: <hostDataDir>/run/mcp/<launchId>.cred — a PATH, never the value
  inProcessServer?: unknown // in-process: the SDK `type:'sdk'` server object built by module `delegation` (no v1 driver uses it, OQ-52)
}

export interface DriverLaunchRequest {
  launchId: LaunchId
  install: InstalledProvider // the only executable the driver may spawn (ADR-008 item 1)
  cwd: FolderPath
  prompt: string // first turn; stdin or protocol message, NEVER argv (HR §4 "prompt in argv")
  model?: string
  effort?: string // validated against ProviderProfile.models / ModelEntry.efforts
  permissionMode: PermissionModeSpec | null // from offeredModes() (ADR-011 item 1); null only for 'stdio-raw'
  delegation: DelegationInjection | null
  spawnTag: string // value of DWARFAI_SPAWN=v1:<installId>:<launchId>:<hostEpoch> (ADR-015 item 2)
  onSpawned(identity: ProcessIdentity): Promise<void> // called once, right after the OS spawn of the root process and
  // before the handshake wait; launching writes the `processes` row in it
  // (the `launches` intent row was written before `launch()`; R5A-24).
  // ProcessIdentity: ADR-014 item 1. A driver that cannot obtain the
  // identity (§4.1 fallback) calls it as soon as it can; never skipped silently
  customArgv?: readonly string[] // 'stdio-raw' only: parseHostedCommand() output (no shell)
}

export interface DriverLaunchError {
  // launch() rejects only with this (ADR-009 D3, R-04)
  cause: Extract<LaunchFailureCause, 'not-installed' | 'could-not-start' | 'exited-at-once'>
  detail?: string // diagnostic only (ADR-020 D3)
  toolOutputTail?: string // ≤ 400 chars, causes 2–3 only, memory only (ADR-020 D1, D6)
}

export interface DriverResumeError {
  // resume() / adopt() reject with this; maps 1:1 to ADR-015 UnrecoveredReason
  reason: 'stale-ref' | 'resume-error'
  detail?: string
}

// ---------- 15 §1.2: turns ----------

export interface TurnInput {
  messageId: MessageId // ADR-022: stable, reused by Retry
  kind: 'message' | 'handoff' // 'handoff' = ADR-013 item 6 result pushed as turn input (carries the marker)
  text: string // stdin / protocol, never argv
  attachments: readonly { path: string; name: string; bytes: number }[] // Host-revalidated paths (11 F4 step 1)
}

export interface SendReceipt {
  confidence: 'confirmed' | 'unconfirmed' // ADR-022 Delivery.confidence (unconfirmed = written, no protocol ack in 30 s; #439)
  heldUntilTurnEnd: boolean // queued behind a running turn (ADR-022; today #457)
  correlation: string // echo correlation for ADR-007 item 3 (`pending_echo`): see §4 per driver
  providerTurnId?: string // present when reactionEvidence is 'turn-id' (ADR-022 item 3)
}

export interface DriverSendError {
  kind: 'channel-error' | 'session-closed'
  reason: string
} // → ADR-022 DeliveryFailure

// ---------- 15 §1.2: close ----------

export type CloseOutcome =
  { kind: 'closed' } | { kind: 'failed'; reason: 'protocol-error' | 'unsupported' | 'timeout' } // ADR-014 falls through to the tree kill

// ---------- 15 §1.2: event payloads (ADR-009 D3 DriverEvent) ----------

export type MessageInput = ConversationEntry // ADR-009 D3 name = 06/08 name (request R-03)

export interface ConversationEntry {
  sourceKey: SourceKey // derivation per driver/adapter, §4 and §5; identical across paths (§1.5)
  role: 'person' | 'dwarf' | 'system-line' // provider-originated only; 'answers-record' rows are DwarfAI-originated (ADR-007)
  text: string // normalized; UTF-8 ≤ 64 KiB (06 MessageText)
  providerTime: Instant | null
  activity?: readonly ActivityStep[] // tool steps folded into this entry (US-MSG-004)
  echoOf?: string // SendReceipt.correlation this entry echoes → merged, no second bubble (INV-60)
  handoffEcho?: boolean // echo of an ADR-013 item 6 pushed handoff: dropped at ingest, key recorded
  providerAgentId?: string // subagent that wrote it when it shares the parent's session (ADR-015 item 7)
}

export interface ActivityStep {
  sourceKey: SourceKey
  turnKey: string | null // same key space as TurnEnded.turnKey
  kind: 'tool' | 'thinking' | 'plan' | 'other'
  toolName?: string
  summary: string // one line through domain/redactSecrets.ts; NEVER tool output (ADR-007 item 4)
  state: 'started' | 'finished' | 'failed'
  at: Instant | null
}

export type AskInput =
  // second argument of AskBroker.open(dwarfId, input) (ADR-010 item 5); the
  // caller (suppliers, observation, hook/plugin ingress) resolves SessionRef → dwarfId
  | {
      kind: 'permission'
      providerRequestId: string // unique per session; composite ids are joined with ':' (Kimi, §4.9)
      channel: 'driver' | 'hook-keystroke' | 'hook-decision' | 'http' | 'none' // = AskRecord['channel'] (ADR-010)
      payload: PermissionPayload // 06 §0.2 { toolName, requestText }
      options: { hasAllowOnce: boolean; hasRejectOnce: boolean } // hasAllowOnce false → OQ-42 path (§2.7)
      turnKey?: string
    }
  | {
      kind: 'question'
      providerRequestId: string
      channel: 'driver' | 'hook-keystroke' | 'hook-decision' | 'http' | 'none'
      payload: QuestionPayload // 06 §0.2 { steps: QuestionStep[] }
      secret: boolean // Codex `isSecret` (HR A6): never rendered, declined with { decline: true } (§2.7)
      turnKey?: string
    }

export type UsageObservationInput = Omit<UsageObservation, 'dwarfId' | 'observedAt'> // ADR-006 item 4; suppliers fills both

export type DriverErrorCause =
  | { kind: 'protocol-drift'; detail: string } // unknown/malformed shape; skipped, session continues (HO-33 drift)
  | { kind: 'provider-error'; detail: string; retryable: boolean } // API error the provider reported (US-RES-004)
  | { kind: 'rate-limited'; resetAt?: Instant } // SDK rate_limit_event, transcript rate_limit marker (HR U2, U4)
  | { kind: 'auth-required' } // the CLI itself reports "not logged in" (ADR-008 item 2)
  | { kind: 'transport-lost'; detail: string } // EOF / socket reset before an exit was observed
// `detail` is sanitized: no secrets, no tool output, no message text (ADR-026).
