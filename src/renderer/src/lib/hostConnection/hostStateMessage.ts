// What the Panel says about the Host connection (ADR-002 D8 items 4–5, D9; 07 §12B; 14 §3.8 `HostConnectionView`):
// the one Host-state message, its variant and its one action, and whether the Panel is read-only. Pure: the view in,
// the message out; `useHostConnection` holds the view and `HostStateMessage.vue` draws the message.
//
// The words are design's (ADR-002 O-4, O-5; 13 FM-007 "O-15 crash-loop variant"), so every string here is a marked
// `⟦COPY NEEDED⟧` placeholder until design gives it (25-AGENTS §8.1), never shipped text.
import type { HostConnectionView } from '@dwarfai/contracts'

export type HostStateVariant =
  | 'none'
  | 'reconnecting'
  | 'crash-loop'
  | 'unresponsive'
  | 'incompatible'
  | 'spawn-failed'
  | 'elevated-refused'
  | 'in-job'

/** The message's one action: A-N05 `retryHostConnection`, or Stop everything and quit (ADR-002 D8 item 5). */
export type HostStateAction = 'retry' | 'stop-everything' | 'none'

export interface HostStateMessage {
  variant: HostStateVariant
  action: HostStateAction
  /** The message's text; null when there is no message. */
  text: string | null
  /** The action's label; null when the message has no action. */
  actionLabel: string | null
  /**
   * How a screen reader hears it: a Host that is down interrupts (`assertive`), a reconnect or a degraded Host waits
   * its turn (`polite`). Never a toast and never an OS notification (ADR-002 D9).
   */
  live: 'off' | 'polite' | 'assertive'
}

type ShownVariant = Exclude<HostStateVariant, 'none'>

const TEXT: Readonly<Record<ShownVariant, string>> = {
  reconnecting: '⟦COPY NEEDED: O-5 reconnecting message⟧',
  'crash-loop': '⟦COPY NEEDED: O-15 crash-loop variant⟧',
  unresponsive: '⟦COPY NEEDED: O-5 Host-unresponsive message⟧',
  incompatible: '⟦COPY NEEDED: O-5 incompatible Host message⟧',
  'spawn-failed': '⟦COPY NEEDED: O-5 Host did not start message⟧',
  'elevated-refused': '⟦COPY NEEDED: O-4 elevated-refused message⟧',
  'in-job': '⟦COPY NEEDED: O-4 in-job message⟧'
}

const ACTION: Readonly<Record<ShownVariant, HostStateAction>> = {
  reconnecting: 'none',
  'crash-loop': 'retry',
  unresponsive: 'retry',
  // D8 item 5: an older UI never asks a newer Host to upgrade; it offers only Stop everything and quit.
  incompatible: 'stop-everything',
  'spawn-failed': 'retry',
  // The way out is starting the app normally (13 FM-011, FM-012); a retry would be refused the same way.
  'elevated-refused': 'none',
  'in-job': 'none'
}

const ACTION_LABEL: Readonly<Record<Exclude<HostStateAction, 'none'>, string>> = {
  retry: '⟦COPY NEEDED: O-5 Host-state Retry action⟧',
  'stop-everything': '⟦COPY NEEDED: O-3 Stop everything and quit action⟧'
}

const NONE: HostStateMessage = {
  variant: 'none',
  action: 'none',
  text: null,
  actionLabel: null,
  live: 'off'
}

function shown(variant: ShownVariant, live: 'polite' | 'assertive'): HostStateMessage {
  const action = ACTION[variant]
  return {
    variant,
    action,
    text: TEXT[variant],
    actionLabel: action === 'none' ? null : ACTION_LABEL[action],
    live
  }
}

/** The message for `view`; null is a Host connection not served yet (its rows unrouted), which says nothing. */
export function hostStateMessage(view: HostConnectionView | null): HostStateMessage {
  if (view === null) return NONE
  switch (view.state) {
    case 'connecting':
      return NONE
    case 'reconnecting':
      return shown('reconnecting', 'polite')
    case 'connected':
      // A Host inside a job runs normally but its sessions end with the job (ADR-002 D6; 13 FM-012).
      return view.jobStatus === 'in-job' ? shown('in-job', 'polite') : NONE
    case 'unavailable':
      // `generation-restart` is dormant in v1 (AMENDMENT-11): no state maps to its notice, and nothing here offers
      // `confirmHostRestart` or an upgrade.
      if (view.reason === undefined || view.reason === 'generation-restart') return NONE
      return shown(view.reason, 'assertive')
  }
}

/**
 * The message after `view`, given the one on screen: an `unavailable` message stays through the `connecting` its retry
 * started (S12.B07) and leaves only when the Host connects or another message replaces it.
 */
export function heldHostStateMessage(
  previous: HostStateMessage,
  view: HostConnectionView | null
): HostStateMessage {
  if (view?.state === 'connecting' && previous.live === 'assertive') return previous
  return hostStateMessage(view)
}

/**
 * Whether the Panel holds its last snapshot read-only (ADR-002 D9; 13 FM-146): every state but `connected`. A Host
 * connection not served yet (null) is today's panel, which stays usable (hidden until built, 21 §1 item 8).
 */
export function hostReadOnly(view: HostConnectionView | null): boolean {
  return view !== null && view.state !== 'connected'
}
