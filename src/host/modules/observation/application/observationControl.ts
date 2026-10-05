// The observation module's driving port (05 §3.3; 16 §4.3), member for member. ISSUE-070 builds
// `start`, `stop` and `nudge` (the loop); `catchUp` lands with offline activity (later:
// ISSUE-078) and `recordEnded` with the `EndedAgentLedger` (later: ISSUE-072), so the module
// exposes `ObservationControlSoFar` until then.
import type { Instant, ProviderId, ProviderIdentity } from '../../../kernel/domain/values'

export interface ObservationControl {
  start(): void // poll/watch loop (poller.ts), coalescing nudges (#196)
  nudge(hint: { providerId: ProviderId; path?: string; sessionId?: string }): void // hook ingress SessionStart etc.
  catchUp(): Promise<void> // Host start: offline activity since last cursors
  stop(): void
  recordEnded(identity: ProviderIdentity, at: Instant): void // called by the SessionTerminator bridge after an end (ADR-014 item 7): anti-ghost, never re-surfaced
}

/** The members built so far. */
export type ObservationControlSoFar = Pick<ObservationControl, 'start' | 'stop' | 'nudge'>
