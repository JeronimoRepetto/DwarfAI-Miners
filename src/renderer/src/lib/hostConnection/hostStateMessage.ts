// What the Panel says about the Host connection (ADR-002 D8 items 4–5, D9; 07 §12B; 14 §3.8 `HostConnectionView`):
// the one Host-state message, its variant and its one action, and whether the Panel is read-only. Pure: the view in,
// the message out; `useHostConnection` holds the view and `HostStateMessage.vue` draws the message.
//
// The words are design's (ADR-002 O-4, O-5; 13 FM-007 "O-15 crash-loop variant"): each is a key of the copy dictionary,
// whose value is a marked `⟦COPY NEEDED⟧` placeholder until design gives it (25-AGENTS §8.1), never shipped text.
import { t, type PlainCopyKey, type HostConnectionView } from '@dwarfai/contracts'

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
   * its turn (`polite`). A message with an action is the dialog, one without an action is one toast
   * (`hostStateToast`; owner's ruling 2026-10-02, over ADR-002 D9's "no toast"); never an OS notification.
   */
  live: 'off' | 'polite' | 'assertive'
}

type ShownVariant = Exclude<HostStateVariant, 'none'>

const TEXT: Readonly<Record<ShownVariant, PlainCopyKey>> = {
  reconnecting: 'hostState.reconnecting.text',
  'crash-loop': 'hostState.crashLoop.text',
  unresponsive: 'hostState.unresponsive.text',
  incompatible: 'hostState.incompatible.text',
  'spawn-failed': 'hostState.spawnFailed.text',
  'elevated-refused': 'hostState.elevatedRefused.text',
  'in-job': 'hostState.inJob.text'
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

const ACTION_LABEL: Readonly<Record<Exclude<HostStateAction, 'none'>, PlainCopyKey>> = {
  retry: 'hostState.action.retry',
  'stop-everything': 'hostState.action.stopEverything'
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
    text: t(TEXT[variant]),
    actionLabel: action === 'none' ? null : t(ACTION_LABEL[action]),
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

/**
 * The toast a Host-state notice without an action raises (owner's ruling 2026-10-02): its text, once, when `next`
 * enters a state `previous` was not in; null otherwise. A state is its variant and its politeness, so a connected
 * in-job (polite) and an unavailable in-job (assertive) are two states. A notice with an action is the dialog
 * (HostStateMessage.vue) and never toasts; nothing is no toast either.
 */
export function hostStateToast(previous: HostStateMessage, next: HostStateMessage): string | null {
  if (next.variant === 'none' || next.action !== 'none' || next.text === null) return null
  const same = previous.variant === next.variant && previous.live === next.live
  return same ? null : next.text
}
