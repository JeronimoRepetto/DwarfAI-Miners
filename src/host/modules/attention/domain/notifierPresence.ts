// Machine 12C (07 §12C): the tray / notifier presence the Host keeps so that, while it runs, a UI
// process draws notifications (ADR-018 item 5; ADR-002 D7; 16 §4.11 `NotifierLauncher`, OQ-40 A).
// Pure: no clock, no timer, no I/O; every instant is passed in and every side effect is returned
// for the supervisor (application/notifierSupervisor.ts) to carry out.
//
// - S12.C01 the last `ui`/`notifier` client detaches → `waiting`, start the 2 s wait.
// - S12.C02 the wait ends with fewer than 3 starts in the last 5 minutes → `spawning`, start the
//   app `--background`; the start is counted at that instant.
// - S12.C03 a `notifier` attaches while `spawning` → `attached`, pending notifications drawn. The
//   counter is KEPT: the respawned tray process attaching is not a normal launch, so a tray
//   process that keeps dying is still held to 3 starts per 5 minutes.
// - S12.C04 the start failed → `waiting` and the wait again; S12.C05 a third start within 5 minutes
//   (counted at the wait's end, or at the third failure) → `gave-up`, one warning, no retry.
// - S12.C08 any other `ui` or `notifier` attach (a normal app launch) → `attached` and the counter
//   is cleared, also after giving up; a pending wait is cancelled.
// - The window slides: a start older than 5 minutes no longer counts (the budget is per 5 minutes
//   for the Host's whole life, never per Host life). There is no Quit state (S12.C06/C07 withdrawn)
//   and nothing here ever ends the Host (OQ-63).
import type { Instant } from '../../../kernel/domain/values'

/** 16 §4.11: the wait after the last UI client detached before the app is started. */
export const TRAY_RESPAWN_DELAY_MS = 2_000
/** 16 §4.11: the sliding window the start budget is counted over. */
export const RESPAWN_WINDOW_MS = 5 * 60_000
/** 16 §4.11: the starts allowed inside one window. */
export const RESPAWN_ATTEMPT_LIMIT = 3

/** 07 §0.2 `NotifierLauncherState`: no Quit state (ADR-018 item 5). */
export type NotifierLauncherState = 'attached' | 'waiting' | 'spawning' | 'gave-up'

export interface NotifierPresence {
  readonly state: NotifierLauncherState
  /** The instants of the starts still inside the window, oldest first. */
  readonly attempts: readonly Instant[]
}

export type NotifierPresenceEvent =
  | { type: 'client-attached'; role: 'ui' | 'notifier' }
  | { type: 'last-client-detached' }
  /** The 2 s wait ended. */
  | { type: 'respawn-due'; at: Instant }
  /** The started app exited, or could not start, before it attached. */
  | { type: 'start-failed'; at: Instant }
  /** The launcher itself answered `'gave-up'` (16 §4.11). */
  | { type: 'launcher-gave-up' }

export type NotifierPresenceEffect =
  | { effect: 'schedule-start'; delayMs: number }
  | { effect: 'cancel-start' }
  | { effect: 'start' }
  | { effect: 'give-up'; attempts: number }
  | { effect: 'draw-pending' }

export interface NotifierPresenceStep {
  presence: NotifierPresence
  effects: NotifierPresenceEffect[]
}

/** The Host starts with its UI attached ([*] → `attached`). */
export function initialNotifierPresence(): NotifierPresence {
  return { state: 'attached', attempts: [] }
}

export function nextNotifierPresence(
  presence: NotifierPresence,
  event: NotifierPresenceEvent
): NotifierPresenceStep {
  switch (event.type) {
    case 'client-attached':
      return attach(presence, event.role)
    case 'last-client-detached':
      return presence.state === 'attached' ? wait(presence.attempts) : same(presence)
    case 'respawn-due':
      return presence.state === 'waiting' ? startOrGiveUp(presence, event.at) : same(presence)
    case 'start-failed':
      return presence.state === 'spawning' ? afterFailure(presence, event.at) : same(presence)
    case 'launcher-gave-up':
      return presence.state === 'spawning' ? giveUp(presence.attempts) : same(presence)
  }
}

function attach(presence: NotifierPresence, role: 'ui' | 'notifier'): NotifierPresenceStep {
  const effects: NotifierPresenceEffect[] = []
  if (presence.state === 'waiting') effects.push({ effect: 'cancel-start' })
  if (role === 'notifier') effects.push({ effect: 'draw-pending' })
  // S12.C03 keeps the counter for the respawned notifier; every other attach is a normal launch.
  const respawned = presence.state === 'spawning' && role === 'notifier'
  return {
    presence: { state: 'attached', attempts: respawned ? presence.attempts : [] },
    effects
  }
}

function wait(attempts: readonly Instant[]): NotifierPresenceStep {
  return {
    presence: { state: 'waiting', attempts },
    effects: [{ effect: 'schedule-start', delayMs: TRAY_RESPAWN_DELAY_MS }]
  }
}

function startOrGiveUp(presence: NotifierPresence, at: Instant): NotifierPresenceStep {
  const recent = inWindow(presence.attempts, at)
  if (recent.length >= RESPAWN_ATTEMPT_LIMIT) return giveUp(recent)
  return {
    presence: { state: 'spawning', attempts: [...recent, at] },
    effects: [{ effect: 'start' }]
  }
}

function afterFailure(presence: NotifierPresence, at: Instant): NotifierPresenceStep {
  const recent = inWindow(presence.attempts, at)
  return recent.length >= RESPAWN_ATTEMPT_LIMIT ? giveUp(recent) : wait(recent)
}

function giveUp(attempts: readonly Instant[]): NotifierPresenceStep {
  return {
    presence: { state: 'gave-up', attempts },
    effects: [{ effect: 'give-up', attempts: attempts.length }]
  }
}

function same(presence: NotifierPresence): NotifierPresenceStep {
  return { presence, effects: [] }
}

/** The starts made less than RESPAWN_WINDOW_MS before `at`. */
function inWindow(attempts: readonly Instant[], at: Instant): Instant[] {
  return attempts.filter((started) => at - started < RESPAWN_WINDOW_MS)
}
