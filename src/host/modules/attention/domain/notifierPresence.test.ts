// layer: L1
// L1 (17 §1.1): machine 12C (07 §12C), the tray / notifier presence the Host keeps so that a UI
// process draws notifications while the Host runs (ADR-018 item 5; 16 §4.11 `NotifierLauncher`:
// 2 s, at most 3 starts per 5 minutes, for the Host's whole life). Pure: every instant is passed in.
import { describe, expect, it } from 'vitest'
import type { Instant } from '../../../kernel/domain/values'
import {
  initialNotifierPresence,
  nextNotifierPresence,
  RESPAWN_ATTEMPT_LIMIT,
  RESPAWN_WINDOW_MS,
  TRAY_RESPAWN_DELAY_MS,
  type NotifierPresence,
  type NotifierPresenceEffect,
  type NotifierPresenceEvent
} from './notifierPresence'

const T0: Instant = 1_790_000_000_000

/** Folds `events` from the initial state; returns the last state and every effect in order. */
function run(
  events: readonly NotifierPresenceEvent[],
  from: NotifierPresence = initialNotifierPresence()
): { presence: NotifierPresence; effects: NotifierPresenceEffect[] } {
  let presence = from
  const effects: NotifierPresenceEffect[] = []
  for (const event of events) {
    const next = nextNotifierPresence(presence, event)
    presence = next.presence
    effects.push(...next.effects)
  }
  return { presence, effects }
}

const detached: NotifierPresenceEvent = { type: 'last-client-detached' }
const due = (at: Instant): NotifierPresenceEvent => ({ type: 'respawn-due', at })
const failed = (at: Instant): NotifierPresenceEvent => ({ type: 'start-failed', at })
const attached = (role: 'ui' | 'notifier'): NotifierPresenceEvent => ({
  type: 'client-attached',
  role
})

/** A detach at `at`, the 2 s wait, and a start whose notifier attaches. */
function respawnThatAttaches(at: Instant): NotifierPresenceEvent[] {
  return [detached, due(at + TRAY_RESPAWN_DELAY_MS), attached('notifier')]
}

describe('tray / notifier presence (machine 12C)', () => {
  it('[ADR-018] after the last client detaches the app is started once 2 s later', () => {
    expect(TRAY_RESPAWN_DELAY_MS).toBe(2_000)
    const waiting = run([detached])
    expect(waiting.presence.state).toBe('waiting')
    expect(waiting.effects).toStrictEqual([
      { effect: 'schedule-start', delayMs: TRAY_RESPAWN_DELAY_MS }
    ])

    const spawning = run([due(T0 + TRAY_RESPAWN_DELAY_MS)], waiting.presence)
    expect(spawning.presence.state).toBe('spawning')
    expect(spawning.effects).toStrictEqual([{ effect: 'start' }])

    // S12.C03: the started app attaches as notifier; pending notifications are drawn.
    const back = run([attached('notifier')], spawning.presence)
    expect(back.presence.state).toBe('attached')
    expect(back.effects).toStrictEqual([{ effect: 'draw-pending' }])
  })

  it('[ADR-018, FM-042] a third failed start within 5 minutes gives up and no further start is scheduled', () => {
    expect(RESPAWN_ATTEMPT_LIMIT).toBe(3)
    expect(RESPAWN_WINDOW_MS).toBe(5 * 60_000)
    const first = T0 + TRAY_RESPAWN_DELAY_MS
    const second = first + 1_000 + TRAY_RESPAWN_DELAY_MS
    const third = second + 1_000 + TRAY_RESPAWN_DELAY_MS
    const { presence, effects } = run([
      detached,
      due(first),
      failed(first + 1_000),
      due(second),
      failed(second + 1_000),
      due(third),
      failed(third + 1_000)
    ])

    expect(presence.state).toBe('gave-up')
    expect(effects.filter((e) => e.effect === 'start')).toHaveLength(3)
    expect(effects.at(-1)).toStrictEqual({ effect: 'give-up', attempts: 3 })
    expect(effects.filter((e) => e.effect === 'give-up')).toHaveLength(1)
    // S12.C04: each of the first two failures waits 2 s again; the third schedules nothing.
    expect(effects.filter((e) => e.effect === 'schedule-start')).toHaveLength(3)

    // Gave up: a late timer or another detach starts nothing (no retry until a UI attaches).
    const after = run([due(third + 60_000), detached, failed(third + 61_000)], presence)
    expect(after.presence.state).toBe('gave-up')
    expect(after.effects).toStrictEqual([])
  })

  it('[ADR-018] a ui or notifier attaching clears the attempt counter, also after giving up', () => {
    const gaveUp = run([
      detached,
      due(T0),
      failed(T0 + 1),
      due(T0 + 2),
      failed(T0 + 3),
      due(T0 + 4),
      failed(T0 + 5)
    ]).presence
    expect(gaveUp.state).toBe('gave-up')

    for (const role of ['ui', 'notifier'] as const) {
      // S12.C08: a normal app launch attaches; the counter is cleared.
      const relaunched = run([attached(role)], gaveUp).presence
      expect(relaunched).toStrictEqual({ state: 'attached', attempts: [] })
      // So three fresh starts are allowed again, all inside the same 5 minutes.
      const again = run(
        [detached, due(T0 + 10), failed(T0 + 11), due(T0 + 12), failed(T0 + 13), due(T0 + 14)],
        relaunched
      )
      expect(again.presence.state).toBe('spawning')
      expect(again.effects.filter((e) => e.effect === 'start')).toHaveLength(3)
    }

    // While waiting (before the 2 s pass), a UI attaching cancels the pending start.
    const cancelled = run([detached, attached('ui')])
    expect(cancelled.presence.state).toBe('attached')
    expect(cancelled.effects.at(-1)).toStrictEqual({ effect: 'cancel-start' })
  })

  it('[ADR-018] a fourth detach 5 minutes after the first attempt is allowed a new start', () => {
    // Three respawns that each attach and then die again: the respawned notifier attaching keeps
    // the counter (S12.C03), so a tray process that keeps dying is held to 3 per 5 minutes.
    const firstAttempt = T0 + TRAY_RESPAWN_DELAY_MS
    const three = run([
      ...respawnThatAttaches(T0),
      ...respawnThatAttaches(T0 + 10_000),
      ...respawnThatAttaches(T0 + 20_000)
    ])
    expect(three.presence.attempts).toHaveLength(3)

    // A fourth detach inside the 5 minutes gives up.
    const early = run([detached, due(T0 + 60_000)], three.presence)
    expect(early.presence.state).toBe('gave-up')
    expect(early.effects.at(-1)).toStrictEqual({ effect: 'give-up', attempts: 3 })

    // A fourth detach 5 minutes after the first attempt: the first attempt left the window.
    const late = run([detached, due(firstAttempt + RESPAWN_WINDOW_MS)], three.presence)
    expect(late.presence.state).toBe('spawning')
    expect(late.effects.at(-1)).toStrictEqual({ effect: 'start' })
  })
})
