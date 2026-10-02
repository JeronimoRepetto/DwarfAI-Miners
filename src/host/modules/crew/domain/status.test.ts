import { describe, expect, it } from 'vitest'
import { ASLEEP_AFTER_MS, classifyDwarfStatus, type StatusFacts } from './status'
import * as updates from './statusFacts'
import {
  arrivalFacts,
  askClosed,
  askOpened,
  departed,
  firesFinishedCue,
  nextWakeAt,
  otherActivity,
  turnEnded,
  turnStarted,
  type AskOpening
} from './statusFacts'

// The diagram-conformance table of machine 1 (07 §1): every S1 id appears in exactly one title.
const T0 = 1_790_000_000_000
const SEC = 1_000

const question = (askedAt: number): AskOpening => ({ kind: 'question', askedAt, state: 'open' })
const reliableEnd = (at: number) =>
  ({ at, reliability: 'reliable', cancelledFromApp: false }) as const
const inferredEnd = (at: number) =>
  ({ at, reliability: 'inferred', cancelledFromApp: false }) as const

/** A dwarf that went idle at T0 by arriving with no message; asleep from T0 + 60 s. */
const idleSinceT0 = (): StatusFacts => arrivalFacts(T0, 'idle')

describe('machine 1, dwarf status (07 §1; ADR-032 item 2)', () => {
  it('[US-OBS-002.AC02, S1.02] a dwarf that arrives with no message and no turn is idle', () => {
    expect(ASLEEP_AFTER_MS).toBe(60_000)
    const facts = arrivalFacts(T0, 'idle')
    expect(classifyDwarfStatus(facts, T0)).toBe('idle')
    expect(classifyDwarfStatus(facts, T0 + 1)).toBe('idle')
  })

  it('[US-OBS-002.AC03, US-OBS-004.AC02, S1.05, NFR-TIM-04] 60 000 ms after arriving idle it is asleep and 59 999 ms after it is still idle', () => {
    const facts = idleSinceT0()
    expect(nextWakeAt(facts)).toBe(T0 + 60_000)
    expect(classifyDwarfStatus(facts, T0 + 59_999)).toBe('idle')
    expect(classifyDwarfStatus(facts, T0 + 60_000)).toBe('asleep')
    expect(classifyDwarfStatus(facts, T0 + 3_600_000)).toBe('asleep')
  })

  it('[US-OBS-002.AC04, US-OBS-004.AC03, S1.08] a turn start before the 60 s makes it working and cancels the wake-up', () => {
    const started = turnStarted(idleSinceT0(), T0 + 30 * SEC)
    expect(classifyDwarfStatus(started, T0 + 30 * SEC)).toBe('working')
    expect(nextWakeAt(started)).toBeNull()
    expect(classifyDwarfStatus(started, T0 + 60_000)).toBe('working')
    expect(classifyDwarfStatus(started, T0 + 3_600_000)).toBe('working')
  })

  it('[US-OBS-004.AC01, US-MINE-001.AC05, S1.03] a finished turn makes it idle at once and asleep exactly 60 s later', () => {
    const end = reliableEnd(T0 + 5 * SEC)
    const ended = turnEnded(arrivalFacts(T0, 'working'), end)
    expect(classifyDwarfStatus(ended, end.at)).toBe('idle')
    expect(nextWakeAt(ended)).toBe(end.at + 60_000)
    expect(classifyDwarfStatus(ended, end.at + 59_999)).toBe('idle')
    expect(classifyDwarfStatus(ended, end.at + 60_000)).toBe('asleep')
    // The level-2 cue fires only for a reliable end the app did not cancel (S1.03 actions).
    expect(firesFinishedCue(end)).toBe(true)
    expect(firesFinishedCue({ ...end, cancelledFromApp: true })).toBe(false)
  })

  it('[US-OBS-004.AC04, US-MINE-003.AC01, S1.10, S1.12, INV-24] an open ask makes any status asking at once', () => {
    const askAt = T0 + 90 * SEC
    const working = arrivalFacts(T0, 'working')
    const asleep = idleSinceT0()
    expect(classifyDwarfStatus(asleep, askAt)).toBe('asleep')
    for (const facts of [working, asleep]) {
      const asking = askOpened(facts, { kind: 'permission', askedAt: askAt, state: 'open' })
      expect(classifyDwarfStatus(asking, askAt)).toBe('asking')
      expect(asking.openAsk).toEqual({ kind: 'permission', askedAt: askAt })
      expect(nextWakeAt(asking)).toBeNull()
      expect(classifyDwarfStatus(asking, askAt + 3_600_000)).toBe('asking')
    }
  })

  it('[US-OBS-004.AC05, US-MINE-003.AC02, S1.13] an answered ask with the turn active returns to working, never straight to idle or asleep', () => {
    const asking = askOpened(arrivalFacts(T0, 'working'), question(T0 + SEC))
    const answeredAt = T0 + 5 * 60 * SEC
    const answered = askClosed(asking)
    expect(answered.openAsk).toBeUndefined()
    expect(classifyDwarfStatus(answered, answeredAt)).toBe('working')
    expect(nextWakeAt(answered)).toBeNull()
  })

  it('[US-OBS-004.AC08, INV-25] falling asleep and waking follow activity only; no command sets a status', () => {
    // The only fact updates are activity, turn, ask and departure facts: none takes a status.
    expect(Object.keys(updates).sort()).toEqual([
      'arrivalFacts',
      'askClosed',
      'askOpened',
      'departed',
      'firesFinishedCue',
      'nextWakeAt',
      'otherActivity',
      'turnEnded',
      'turnStarted'
    ])
    // Asleep is reached by time alone, and left only by activity.
    const facts = idleSinceT0()
    const later = T0 + 2 * ASLEEP_AFTER_MS
    expect(classifyDwarfStatus(facts, later)).toBe('asleep')
    expect(classifyDwarfStatus(otherActivity(facts, later), later)).toBe('idle')
    expect(classifyDwarfStatus(turnStarted(facts, later), later)).toBe('working')
    // No stored status anywhere in the facts: it is always derived.
    expect(Object.keys(turnStarted(facts, later))).not.toContain('status')
  })

  it('[US-OBS-004.AC14, S1.04] an inferred turn end moves working to idle and asleep 60 s later, and publishes no departure', () => {
    const end = inferredEnd(T0 + 40 * SEC)
    const ended = turnEnded(arrivalFacts(T0, 'working'), end)
    expect(classifyDwarfStatus(ended, end.at)).toBe('idle')
    expect(classifyDwarfStatus(ended, end.at + 59_999)).toBe('idle')
    expect(classifyDwarfStatus(ended, end.at + 60_000)).toBe('asleep')
    expect(ended.turn).toEqual({ state: 'ended', endedAt: end.at, reliability: 'inferred' })
    // No departure (INV-26) and no finished cue (ADR-032 item 5).
    expect(ended.processState).toBe('running')
    expect(firesFinishedCue(end)).toBe(false)
  })

  it('[US-OBS-006.AC04, S1.01] a dwarf arriving with a turn in progress, as on rediscovery, starts working, not idle', () => {
    const facts = arrivalFacts(T0, 'working')
    expect(facts.turn).toEqual({ state: 'active' })
    expect(classifyDwarfStatus(facts, T0)).toBe('working')
    expect(nextWakeAt(facts)).toBeNull()
  })

  it('[S1.16, INV-24] an auto-denied ask never makes the dwarf asking', () => {
    for (const facts of [arrivalFacts(T0, 'working'), idleSinceT0()]) {
      const before = classifyDwarfStatus(facts, T0 + SEC)
      const after = askOpened(facts, { kind: 'permission', askedAt: T0, state: 'auto-denied' })
      expect(after).toEqual(facts)
      expect(classifyDwarfStatus(after, T0 + SEC)).toBe(before)
    }
  })

  it('[S1.18] after a restart the status recomputed from the persisted facts equals the status before it', () => {
    const states: StatusFacts[] = [
      arrivalFacts(T0, 'working'),
      idleSinceT0(),
      turnEnded(arrivalFacts(T0, 'working'), reliableEnd(T0 + 10 * SEC)),
      askOpened(idleSinceT0(), question(T0 + 20 * SEC))
    ]
    for (const facts of states) {
      for (const now of [T0 + 30 * SEC, T0 + 70 * SEC, T0 + 600 * SEC]) {
        const persisted = JSON.parse(JSON.stringify(facts)) as StatusFacts
        expect(classifyDwarfStatus(persisted, now)).toBe(classifyDwarfStatus(facts, now))
        expect(nextWakeAt(persisted)).toBe(nextWakeAt(facts))
      }
    }
  })

  it('[S1.06] activity that is not a turn start keeps an idle dwarf idle and moves its wake-up', () => {
    const touched = otherActivity(idleSinceT0(), T0 + 50 * SEC)
    expect(classifyDwarfStatus(touched, T0 + 50 * SEC)).toBe('idle')
    expect(nextWakeAt(touched)).toBe(T0 + 110 * SEC)
    expect(classifyDwarfStatus(touched, T0 + 60 * SEC)).toBe('idle')
    expect(classifyDwarfStatus(touched, T0 + 110 * SEC - 1)).toBe('idle')
    expect(classifyDwarfStatus(touched, T0 + 110 * SEC)).toBe('asleep')
  })

  it('[S1.07] activity that is not a turn start wakes an asleep dwarf to idle, not working', () => {
    const at = T0 + 120 * SEC
    const touched = otherActivity(idleSinceT0(), at)
    expect(classifyDwarfStatus(touched, at)).toBe('idle')
    expect(nextWakeAt(touched)).toBe(at + 60_000)
  })

  it('[S1.09] a turn start wakes an asleep dwarf straight to working', () => {
    const at = T0 + 120 * SEC
    const started = turnStarted(idleSinceT0(), at)
    expect(classifyDwarfStatus(started, at)).toBe('working')
    expect(started.lastActivityAt).toBe(at)
  })

  it('[S1.11] an ask opened while idle makes it asking and cancels the wake-up', () => {
    const asking = askOpened(idleSinceT0(), question(T0 + 10 * SEC))
    expect(classifyDwarfStatus(asking, T0 + 10 * SEC)).toBe('asking')
    expect(nextWakeAt(asking)).toBeNull()
  })

  it('[S1.14] an ask closed with no active turn returns to idle, waking at the last activity plus 60 s', () => {
    const idle = otherActivity(idleSinceT0(), T0 + 5 * SEC)
    const closed = askClosed(askOpened(idle, question(T0 + 10 * SEC)))
    expect(classifyDwarfStatus(closed, T0 + 30 * SEC)).toBe('idle')
    expect(nextWakeAt(closed)).toBe(T0 + 65 * SEC)
  })

  it('[S1.15] closing the front ask while another ask of the dwarf is open keeps it asking with the next one', () => {
    const asking = askOpened(arrivalFacts(T0, 'working'), question(T0 + SEC))
    // A second ask while one is open does not replace the front one.
    const both = askOpened(asking, { kind: 'permission', askedAt: T0 + 2 * SEC, state: 'open' })
    expect(both.openAsk).toEqual({ kind: 'question', askedAt: T0 + SEC })
    const next = askClosed(both, { kind: 'permission', askedAt: T0 + 2 * SEC })
    expect(next.openAsk).toEqual({ kind: 'permission', askedAt: T0 + 2 * SEC })
    expect(classifyDwarfStatus(next, T0 + 3 * SEC)).toBe('asking')
  })

  it('[S1.17] an ask the provider leaves no evidence of keeps the dwarf working until its turn end is inferred', () => {
    // No fact update exists for an undetectable ask: the facts stay those of an active turn.
    const working = arrivalFacts(T0, 'working')
    expect(classifyDwarfStatus(working, T0 + 25 * SEC)).toBe('working')
    const inferred = turnEnded(working, inferredEnd(T0 + 30 * SEC))
    expect(classifyDwarfStatus(inferred, T0 + 30 * SEC)).toBe('idle')
    expect(classifyDwarfStatus(inferred, T0 + 90 * SEC)).toBe('asleep')
  })

  it('[S1.19] a turn active at a Host crash counts as an inferred end at the crash instant, with no cue', () => {
    const crashAt = T0 + 10 * SEC
    const lost = inferredEnd(crashAt)
    const recovered = turnEnded(arrivalFacts(T0, 'working'), lost)
    expect(classifyDwarfStatus(recovered, crashAt + 20 * SEC)).toBe('idle')
    expect(classifyDwarfStatus(recovered, crashAt + 60 * SEC)).toBe('asleep')
    expect(firesFinishedCue(lost)).toBe(false)
  })

  it('[S1.20] a departure ends the machine and leaves no wake-up', () => {
    const gone = departed(idleSinceT0())
    expect(gone.processState).toBe('closed')
    expect(nextWakeAt(gone)).toBeNull()
  })
})
