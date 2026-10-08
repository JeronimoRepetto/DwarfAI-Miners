import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import { ANSWER_HANDOVER_TIMEOUT_MS, isTerminal, type Ask, type AskState } from './ask'
import {
  MACHINE_6,
  applyTransition,
  channelResult,
  closeForDwarf,
  frontAsk,
  openAsk,
  reconcileAfterRestart,
  resolveExternally,
  submit,
  type AskOpening,
  type AskTransitionId
} from './askMachine'

// Machine 6 (07 §6) over plain values: time is passed in, nothing reads a clock (05 §2.2, R1).
const T0 = 1_790_000_000_000
const YEAR = 365 * 24 * 3_600 * 1_000

const opening = (overrides: Partial<AskOpening> = {}): AskOpening => ({
  id: 'ask-1',
  dwarfId: 'dwarf-1',
  kind: 'permission',
  channel: 'driver',
  providerRequestId: 'request-1',
  payload: { toolName: 'Bash', requestText: 'pnpm test' },
  options: { hasAllowOnce: true },
  reannounce: true,
  ...overrides
})

/** An open card ask (S6.01). */
function opened(overrides: Partial<AskOpening> = {}, at = T0): Ask {
  const result = openAsk(opening(overrides), at)
  if (result.kind !== 'opened') throw new Error('the opening is a card ask')
  return result.ask
}

/** An ask whose submit won the critical section (S6.06). */
function answering(ask: Ask = opened()): Ask {
  const result = submit([ask], ask.id)
  if (result.kind !== 'won') throw new Error('the first submit on an open front ask wins')
  return result.ask
}

/** One ask in each terminal state, reached through the machine's own transitions. */
function terminals(): Ask[] {
  const autoDenied: Ask = { ...opened(), state: 'auto-denied', closedAt: T0 } // S6.03 is born terminal (ISSUE-132)
  return [
    channelResult(answering(), { kind: 'accepted' }, T0 + 1).ask,
    resolveExternally(opened(), 'elsewhere', T0 + 1).ask,
    resolveExternally(opened(), 'cancelled', T0 + 1).ask,
    first(closeForDwarf([opened()], 'dwarf-1', T0 + 1)).ask,
    autoDenied
  ]
}

/** The first element of a list a test built itself. */
function first<T>(items: readonly T[]): T {
  const [item] = items
  if (item === undefined) throw new Error('the list is not empty')
  return item
}

/** mulberry32: a small deterministic PRNG; every property case is reproducible from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

describe('ask machine (07 machine 6)', () => {
  it('[US-ASK-006.AC09, S6.07, INV-72] a submit on an ask that is answering or closed returns not-open and changes nothing', () => {
    const stale = [answering(), ...terminals()]
    expect(stale.map((ask) => ask.state)).toEqual([
      'answering',
      'answered-in-app',
      'answered-elsewhere',
      'cancelled',
      'closed-by-death',
      'auto-denied'
    ])
    for (const ask of stale) {
      const asks = [ask]
      const before = structuredClone(asks)
      expect(submit(asks, ask.id)).toEqual({ kind: 'not-open', transition: 'S6.07' })
      expect(asks).toEqual(before)
    }
    // An id the broker does not hold is just as stale: nothing to show.
    expect(submit([opened()], 'ask-unknown')).toEqual({ kind: 'not-open', transition: null })
  })

  it('[S6.06, INV-72] property: of any number of submits on an open ask exactly one wins the critical section', () => {
    // Concurrent submits reach the Host's single event loop one after another (ADR-010 item 4).
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = prng(seed)
      const submits = 1 + Math.floor(random() * 25)
      let asks: Ask[] = [opened()]
      let wins = 0
      for (let n = 0; n < submits; n += 1) {
        const result = submit(asks, 'ask-1')
        if (result.kind === 'won') {
          wins += 1
          asks = [result.ask]
        }
      }
      expect(wins, `seed ${seed}`).toBe(1)
      expect(first(asks).state).toBe('answering')
    }

    // TC-126-01: any interleaving of submits, channel results and external resolutions. A submit
    // wins only on an open ask; every other submit is not-open and changes nothing; a second win
    // needs a refusal that reopened the card (S6.09) in between.
    const outcomes = [
      { kind: 'accepted' },
      { kind: 'refused', reason: 'channel-rejected' },
      { kind: 'refused', reason: 'invalid-answer' },
      { kind: 'refused', reason: 'channel-unavailable' },
      { kind: 'refused', reason: 'ask-closed' }
    ] as const
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = prng(seed)
      let ask = opened()
      let held: 'elsewhere' | null = null
      let wins = 0
      let reopens = 0
      for (let step = 0; step < 40; step += 1) {
        const now = T0 + step
        const roll = random()
        if (roll < 0.6) {
          const before = ask
          const result = submit([ask], ask.id)
          if (result.kind === 'won') {
            expect(before.state, `seed ${seed}`).toBe('open')
            wins += 1
            ask = result.ask
          } else {
            expect(before.state, `seed ${seed}`).not.toBe('open')
            expect(ask).toBe(before)
          }
        } else if (roll < 0.85 && ask.state === 'answering') {
          const settled = channelResult(
            ask,
            first(outcomes.slice(Math.floor(random() * outcomes.length))),
            now,
            held
          )
          if (settled.transition === 'S6.09') reopens += 1
          ask = settled.ask
          held = null
        } else if (roll >= 0.97) {
          const resolution = resolveExternally(ask, random() < 0.5 ? 'elsewhere' : 'cancelled', now)
          ask = resolution.ask
          held = held ?? resolution.held
        }
        expect(wins, `seed ${seed}`).toBeLessThanOrEqual(1 + reopens)
      }
    }
  })

  it('[S6.08] an accepted result closes the ask answered-in-app', () => {
    const settled = channelResult(answering(), { kind: 'accepted' }, T0 + 5)
    expect(settled.outcome).toEqual({ kind: 'accepted' })
    expect(settled.transition).toBe('S6.08')
    expect(settled.ask.state).toBe('answered-in-app')
    expect(settled.ask.closedAt).toBe(T0 + 5)
  })

  it('[S6.09, INV-78] a channel-rejected, invalid-answer or channel-unavailable result returns the ask to open', () => {
    for (const reason of ['channel-rejected', 'invalid-answer', 'channel-unavailable'] as const) {
      const settled = channelResult(answering(), { kind: 'refused', reason }, T0 + 5)
      expect(settled.outcome).toEqual({ kind: 'refused', reason })
      expect(settled.transition).toBe('S6.09')
      expect(settled.ask.state).toBe('open')
      expect(settled.ask.closedAt).toBeUndefined()
      // The card comes back: the next submit on the same ask wins again.
      expect(submit([settled.ask], settled.ask.id).kind).toBe('won')
    }
  })

  it('[S6.10, S6.15, S6.22] an ask closed while answering yields refused ask-closed and stays in its closing state', () => {
    const askClosed = { kind: 'refused', reason: 'ask-closed' } as const

    // S6.10: the driver no longer holds the request.
    const gone = channelResult(answering(), askClosed, T0 + 5)
    expect(gone).toMatchObject({ outcome: askClosed, transition: 'S6.10' })
    expect(gone.ask).toMatchObject({ state: 'answered-elsewhere', closedAt: T0 + 5 })

    // S6.21 → S6.10: resolved elsewhere while the hand-over is in flight is held until the result;
    // a refusal then closes it answered-elsewhere, while an accepted result is what resolved it.
    const inFlight = answering()
    const held = resolveExternally(inFlight, 'elsewhere', T0 + 3)
    expect(held).toMatchObject({ transition: 'S6.21', held: 'elsewhere' })
    expect(held.ask).toBe(inFlight)
    const refusedHeld = channelResult(
      held.ask,
      { kind: 'refused', reason: 'channel-rejected' },
      T0 + 5,
      'elsewhere'
    )
    expect(refusedHeld).toMatchObject({ outcome: askClosed, transition: 'S6.10' })
    expect(refusedHeld.ask.state).toBe('answered-elsewhere')
    const acceptedHeld = channelResult(held.ask, { kind: 'accepted' }, T0 + 5, 'elsewhere')
    expect(acceptedHeld).toMatchObject({ outcome: { kind: 'accepted' }, transition: 'S6.08' })

    // S6.15: the session ended mid-answer; S6.22: the turn was cancelled mid-answer.
    const died = first(closeForDwarf([answering()], 'dwarf-1', T0 + 3))
    expect(died.transition).toBe('S6.15')
    const cancelled = resolveExternally(answering(), 'cancelled', T0 + 3)
    expect(cancelled.transition).toBe('S6.22')
    for (const closing of [died.ask, cancelled.ask]) {
      for (const late of [
        { kind: 'accepted' },
        { kind: 'refused', reason: 'channel-rejected' }
      ] as const) {
        const settled = channelResult(closing, late, T0 + 9)
        expect(settled.outcome).toEqual(askClosed)
        expect(settled.transition).toBeNull()
        expect(settled.ask).toBe(closing) // no card comes back
      }
    }
    expect(died.ask).toMatchObject({ state: 'closed-by-death', closedAt: T0 + 3 })
    expect(cancelled.ask).toMatchObject({ state: 'cancelled', closedAt: T0 + 3 })
  })

  it("[S6.16, INV-70] a dwarf's second ask waits and becomes the front when the first closes", () => {
    const front = opened({ id: 'ask-a', providerRequestId: 'request-a' }, T0)
    const second = opened(
      {
        id: 'ask-b',
        providerRequestId: 'request-b',
        kind: 'question',
        payload: { steps: [] },
        options: null
      },
      T0 + 1
    )
    const other = opened(
      { id: 'ask-c', dwarfId: 'dwarf-2', providerRequestId: 'request-c' },
      T0 + 2
    )
    let asks: Ask[] = [front, second, other]

    expect([...frontAsk(asks)].map(([dwarfId, ask]) => [dwarfId, ask.id])).toEqual([
      ['dwarf-1', 'ask-a'],
      ['dwarf-2', 'ask-c']
    ])
    // The queued ask shows no card, so a submit on it wins nothing.
    expect(submit(asks, 'ask-b')).toEqual({ kind: 'not-open', transition: null })

    // While the front is answering it stays the dwarf's one ask; the second still waits.
    const won = submit(asks, 'ask-a')
    expect(won.kind).toBe('won')
    asks = asks.map((ask) => (won.kind === 'won' && ask.id === won.ask.id ? won.ask : ask))
    expect(frontAsk(asks).get('dwarf-1')?.id).toBe('ask-a')
    expect(submit(asks, 'ask-b').kind).toBe('not-open')

    // The first closes: the second becomes the front and its submit can win.
    const closed = channelResult(first(asks), { kind: 'accepted' }, T0 + 9).ask
    asks = [closed, second, other]
    expect(frontAsk(asks).get('dwarf-1')?.id).toBe('ask-b')
    expect(submit(asks, 'ask-b').kind).toBe('won')
  })

  it('[INV-74] no transition depends on elapsed time; only the answer hand-over has a 30 s bound', () => {
    expect(ANSWER_HANDOVER_TIMEOUT_MS).toBe(30_000)
    // An ask a provider waits on for ten years is still the open front ask, and still answerable.
    const ask = opened()
    expect(frontAsk([ask]).get('dwarf-1')).toBe(ask)
    expect(submit([ask], ask.id).kind).toBe('won')
    // Every transition lands on the same state however much time passed; `now` only stamps closedAt.
    for (const now of [T0, T0 + 1, T0 + 10 * YEAR]) {
      expect(resolveExternally(ask, 'elsewhere', now).ask).toMatchObject({
        state: 'answered-elsewhere',
        closedAt: now
      })
      expect(resolveExternally(ask, 'cancelled', now).ask.state).toBe('cancelled')
      expect(first(closeForDwarf([ask], 'dwarf-1', now)).ask.state).toBe('closed-by-death')
      expect(
        channelResult(answering(ask), { kind: 'refused', reason: 'channel-unavailable' }, now).ask
          .state
      ).toBe('open')
    }
  })

  it('[S6.07, INV-76] every submit on a channel none ask returns not-open', () => {
    const observed = opened({ channel: 'none' })
    expect(observed.state).toBe('open')
    const asks = [observed]
    const before = structuredClone(asks)
    for (let n = 0; n < 5; n += 1) {
      expect(submit(asks, observed.id)).toEqual({ kind: 'not-open', transition: 'S6.07' })
    }
    expect(asks).toEqual(before)
  })

  it('[S6.05, S6.17, S6.20] every machine 6 transition reaches its target: Other thing… is an ordinary message that never answers or closes the ask, a re-adopted server-kind ask still pending on the server stays open on the same askId, and an answering ask after a restart returns to open while still pending, else settles; a transition 07 does not list is rejected', () => {
    const inState = (state: AskState): Ask =>
      state === 'answering'
        ? answering()
        : state === 'open'
          ? opened()
          : { ...opened(), state, closedAt: T0 }

    // The walk: every listed (from → to) pair of 07 §6 lands on its target.
    for (const [id, row] of Object.entries(MACHINE_6) as [
      AskTransitionId,
      (typeof MACHINE_6)[AskTransitionId]
    ][]) {
      if (row.from === 'birth') {
        expect(() => applyTransition(opened(), id, 'open', T0)).toThrow(HostInvariantError)
        continue
      }
      for (const from of row.from) {
        const targets = row.to === 'same' ? [from] : row.to
        for (const to of targets) {
          const next = applyTransition(inState(from), id, to, T0 + 7)
          expect(next.state, `${id} ${from} → ${to}`).toBe(to)
          expect(next.closedAt, `${id} ${from} → ${to}`).toBe(
            isTerminal(to) ? (isTerminal(from) ? T0 : T0 + 7) : undefined
          )
        }
      }
    }
    // Births: a card ask (S6.01), an observed no-channel ask (S6.02), a re-raised need (S6.19).
    expect(openAsk(opening(), T0)).toMatchObject({ kind: 'opened', transition: 'S6.01' })
    expect(openAsk(opening({ channel: 'none' }), T0)).toMatchObject({
      kind: 'opened',
      transition: 'S6.02'
    })
    expect(openAsk(opening({ reannounce: false }), T0)).toMatchObject({
      kind: 'opened',
      transition: 'S6.19',
      ask: { reannounce: false }
    })

    // S6.05: "Other thing…" is an ordinary message; the ask stays exactly as it was.
    const ask = opened()
    expect(applyTransition(ask, 'S6.05', 'open')).toEqual(ask)
    expect(() => applyTransition(ask, 'S6.05', 'answered-in-app', T0)).toThrow(HostInvariantError)
    expect(() => applyTransition(ask, 'S6.05', 'answering')).toThrow(HostInvariantError)

    // S6.17: a re-adopted server-kind session, request still pending → same askId, still open.
    const readopted = reconcileAfterRestart(
      ask,
      { sessionSurvived: true, stillPending: true, deliveryEvidence: false },
      T0 + 9
    )
    expect(readopted.transition).toBe('S6.17')
    expect(readopted.ask).toEqual(ask)
    // S6.18: the session did not survive the Host crash.
    expect(
      reconcileAfterRestart(
        answering(),
        { sessionSurvived: false, stillPending: true, deliveryEvidence: false },
        T0 + 9
      )
    ).toMatchObject({
      transition: 'S6.18',
      ask: { state: 'closed-by-death' }
    })

    // S6.20: an answering ask after a restart.
    const restart = (stillPending: boolean, deliveryEvidence: boolean) =>
      reconcileAfterRestart(
        answering(),
        { sessionSurvived: true, stillPending, deliveryEvidence },
        T0 + 9
      )
    expect(restart(true, false)).toMatchObject({
      transition: 'S6.20',
      ask: { state: 'open', id: 'ask-1' }
    })
    expect(restart(false, true)).toMatchObject({
      transition: 'S6.20',
      ask: { state: 'answered-in-app', closedAt: T0 + 9 }
    })
    expect(restart(false, false)).toMatchObject({
      transition: 'S6.20',
      ask: { state: 'answered-elsewhere', closedAt: T0 + 9 }
    })

    // Unlisted transitions are rejected: a closed ask never reopens, an open ask has no result.
    expect(() => applyTransition(inState('answered-in-app'), 'S6.09', 'open')).toThrow(
      HostInvariantError
    )
    expect(() => applyTransition(ask, 'S6.08', 'answered-in-app', T0)).toThrow(HostInvariantError)
    expect(() => applyTransition(answering(), 'S6.20', 'cancelled', T0)).toThrow(HostInvariantError)
    expect(() => channelResult(ask, { kind: 'accepted' }, T0)).toThrow(HostInvariantError)
  })
})
