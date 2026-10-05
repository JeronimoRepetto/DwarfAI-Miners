// layer: L1
// L1 (17 §1.1): the turn outcome line (06 §9.2 `OutcomeLine`, INV-67; US-MSG-011), derived by one pure
// rule from the dwarf's status, its open activity run, the steps since the person's last message, its
// last turn end, its front ask and its answers-record phase. Tables and an exhaustive property over
// every input combination; every instant is passed in (no clock read).
//
// TC-102-01 (at most three parts, none of them closingWords or detail; an inferred end never yields
// end wording or an idle part).
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { TurnEndKind } from '../../../kernel/domain/sharedContracts'
import type { DwarfId } from '../../../kernel/domain/values'
import type { DwarfStatus } from '../../crew'
import {
  deriveOutcomeLine,
  type FrontAsk,
  type OutcomeInput,
  type OutcomeLine,
  type OutcomeStatus,
  type TurnOutcomeKind
} from './outcomeLine'

const DWARF = '00000000-0000-7000-8000-0000000000d1' as DwarfId
const T0 = 1_790_000_000_000
const END_KINDS: readonly TurnEndKind[] = ['concluded', 'capped', 'errored', 'interrupted']
const STATUSES: readonly OutcomeStatus[] = ['working', 'asking', 'idle', 'asleep']

function input(overrides: Partial<OutcomeInput> = {}): OutcomeInput {
  return {
    dwarfId: DWARF,
    status: 'working',
    openRun: null,
    stepsSinceLastPersonMessage: 0,
    lastTurnEnd: null,
    frontAsk: null,
    answers: null,
    observedWithoutEndTime: false,
    at: T0,
    ...overrides
  }
}

const reliableEnd = (kind: TurnEndKind, at = T0 - 5_000, detail?: string) => ({
  kind,
  reliability: 'reliable' as const,
  at,
  ...(detail === undefined ? {} : { detail })
})

describe('deriveOutcomeLine', () => {
  it('[US-MSG-011.AC12, ADR-032] the status it reads is crew’s four-value status and the kinds are exactly the six of 06 §9.2', () => {
    expectTypeOf<OutcomeStatus>().toEqualTypeOf<DwarfStatus>()
    expectTypeOf<TurnOutcomeKind>().toEqualTypeOf<
      'working' | 'concluded' | 'capped' | 'errored' | 'interrupted' | 'waiting-on-you'
    >()
  })

  it('[US-MSG-011.AC13] a working dwarf whose open run has no steps yet has kind working and no parts', () => {
    for (const openRun of [null, { stepCount: 0 }]) {
      const line = deriveOutcomeLine(input({ openRun }))
      expect(line).toEqual({
        dwarfId: DWARF,
        kind: 'working',
        stepCount: 0,
        parts: [],
        reliability: 'reliable',
        at: T0
      })
    }
  })

  it("[US-MSG-011.AC01, US-MSG-011.AC14] a working dwarf's line carries its open run's steps so far, from one step on", () => {
    for (const n of [1, 2, 37]) {
      const line = deriveOutcomeLine(input({ openRun: { stepCount: n } }))
      expect(line.kind).toBe('working')
      expect(line.stepCount).toBe(n)
      expect(line.parts).toEqual([{ kind: 'steps-so-far', n }])
    }
    // Steps of earlier runs since the person's last message are not "so far": only the open run counts.
    const line = deriveOutcomeLine(
      input({ openRun: { stepCount: 2 }, stepsSinceLastPersonMessage: 9 })
    )
    expect(line.parts).toEqual([{ kind: 'steps-so-far', n: 2 }])
  })

  it("[US-MSG-011.AC02] an asking dwarf's line is waiting-on-you with the question count or permission", () => {
    const questions = deriveOutcomeLine(
      input({
        status: 'asking',
        openRun: { stepCount: 4 },
        frontAsk: { kind: 'question', questionCount: 2 }
      })
    )
    expect(questions).toEqual({
      dwarfId: DWARF,
      kind: 'waiting-on-you',
      stepCount: 4,
      parts: [{ kind: 'waiting-questions', n: 2 }],
      reliability: 'reliable',
      at: T0
    })
    const permission = deriveOutcomeLine(
      input({ status: 'asking', frontAsk: { kind: 'permission' } })
    )
    expect(permission.kind).toBe('waiting-on-you')
    expect(permission.parts).toEqual([{ kind: 'waiting-permission' }])
    // An asking dwarf stays waiting-on-you whatever its last turn end said.
    const afterEnd = deriveOutcomeLine(
      input({
        status: 'asking',
        frontAsk: { kind: 'permission' },
        lastTurnEnd: reliableEnd('concluded'),
        stepsSinceLastPersonMessage: 5
      })
    )
    expect(afterEnd.kind).toBe('waiting-on-you')
    expect(afterEnd.parts).toEqual([{ kind: 'waiting-permission' }])
  })

  it('[US-MSG-011.AC03, US-MSG-011.AC04] after the answer is submitted the line reads answers received, and after the answers message is handed over it reads reading your message', () => {
    const submitted = deriveOutcomeLine(input({ openRun: { stepCount: 3 }, answers: 'submitted' }))
    expect(submitted.kind).toBe('working')
    expect(submitted.parts).toEqual([{ kind: 'answers-received' }])
    expect(submitted.stepCount).toBe(3)

    const handedOver = deriveOutcomeLine(
      input({ openRun: { stepCount: 3 }, answers: 'handed-over' })
    )
    expect(handedOver.kind).toBe('working')
    expect(handedOver.parts).toEqual([{ kind: 'reading-your-message' }])
  })

  it("[US-MSG-011.AC11] a reliable concluded end carries the total steps of every run since the person's last message", () => {
    const end = reliableEnd('concluded', T0 - 41 * 60_000)
    const line = deriveOutcomeLine(
      input({
        status: 'idle',
        openRun: null,
        stepsSinceLastPersonMessage: 5,
        lastTurnEnd: end,
        closingWords: 'All tests pass now.'
      })
    )
    expect(line).toEqual({
      dwarfId: DWARF,
      kind: 'concluded',
      stepCount: 5,
      parts: [
        { kind: 'steps', n: 5 },
        { kind: 'idle-since', at: end.at }
      ],
      closingWords: 'All tests pass now.',
      reliability: 'reliable',
      at: end.at
    })
  })

  it('[US-MSG-011.AC05, US-MSG-011.AC10] a reliable capped, errored or interrupted end has its own kind and leaves out the step count when none is known', () => {
    for (const kind of ['capped', 'errored', 'interrupted'] as const) {
      const end = reliableEnd(kind, T0 - 41 * 60_000, 'max_turns')
      const none = deriveOutcomeLine(
        input({ status: 'asleep', lastTurnEnd: end, closingWords: 'I stopped here.' })
      )
      expect(none).toEqual({
        dwarfId: DWARF,
        kind,
        stepCount: 0,
        parts: [{ kind: 'idle-since', at: end.at }],
        detail: 'max_turns',
        reliability: 'reliable',
        at: end.at
      })
      const some = deriveOutcomeLine(
        input({ status: 'asleep', lastTurnEnd: end, stepsSinceLastPersonMessage: 2 })
      )
      expect(some.kind).toBe(kind)
      expect(some.parts).toEqual([
        { kind: 'steps', n: 2 },
        { kind: 'idle-since', at: end.at }
      ])
    }
  })

  it('[US-MSG-011.AC06, INV-67] property: no line ever has more than three parts or a part made of closingWords or detail', () => {
    const closingWords = 'CLOSING-WORDS-MARK read src/secret.ts and edited it'
    const detail = 'DETAIL-MARK provider word'
    let cases = 0
    for (const line of everyLine({ closingWords, detail })) {
      cases += 1
      expect(line.parts.length).toBeLessThanOrEqual(3)
      const serialized = JSON.stringify(line.parts)
      expect(serialized).not.toContain('CLOSING-WORDS-MARK')
      expect(serialized).not.toContain('DETAIL-MARK')
      // closingWords and detail live only in their tooltip fields; closingWords at most 200 chars.
      expect((line.closingWords ?? '').length).toBeLessThanOrEqual(200)
    }
    expect(cases).toBeGreaterThan(1_000)
    // A long closing text is trimmed to 200 characters for the tooltip (06 §9.2).
    const long = deriveOutcomeLine(
      input({
        status: 'idle',
        lastTurnEnd: reliableEnd('concluded'),
        closingWords: 'x'.repeat(260)
      })
    )
    expect(long.closingWords).toBe('x'.repeat(200))
  })

  it('[ADR-021, INV-67] property: an inferred end never yields a concluded, capped, errored or interrupted kind nor an idle-since part', () => {
    let cases = 0
    for (const line of everyLine({ reliabilities: ['inferred'] })) {
      cases += 1
      expect(END_KINDS).not.toContain(line.kind)
      expect(line.parts.map((p) => p.kind)).not.toContain('idle-since')
      expect(line.detail).toBeUndefined()
      expect(line.closingWords).toBeUndefined()
    }
    expect(cases).toBeGreaterThan(100)
    // An idle dwarf after an inferred end keeps its observed step count and says it has no reliable end.
    const inferred = deriveOutcomeLine(
      input({
        status: 'asleep',
        stepsSinceLastPersonMessage: 3,
        lastTurnEnd: { kind: 'concluded', reliability: 'inferred', at: T0 - 90_000 }
      })
    )
    expect(inferred).toEqual({
      dwarfId: DWARF,
      kind: 'working',
      stepCount: 3,
      parts: [{ kind: 'steps', n: 3 }],
      reliability: 'inferred',
      at: T0 - 90_000
    })
  })

  it('[US-MSG-011.AC09] an observed session with no end time has no idle-since part when the dwarf falls asleep', () => {
    for (const kind of END_KINDS) {
      const line = deriveOutcomeLine(
        input({
          status: 'asleep',
          lastTurnEnd: reliableEnd(kind),
          stepsSinceLastPersonMessage: 5,
          observedWithoutEndTime: true
        })
      )
      expect(line.kind).toBe(kind)
      expect(line.parts).toEqual([{ kind: 'steps', n: 5 }])
    }
  })
})

/** Every combination of the rule's inputs, derived. */
function* everyLine(
  options: {
    closingWords?: string
    detail?: string
    reliabilities?: readonly ('reliable' | 'inferred')[]
  } = {}
): Generator<OutcomeLine> {
  const reliabilities = options.reliabilities ?? ['reliable', 'inferred']
  const ends: OutcomeInput['lastTurnEnd'][] = [
    ...(options.reliabilities === undefined ? [null] : []),
    ...END_KINDS.flatMap((kind) =>
      reliabilities.flatMap((reliability) => [
        { kind, reliability, at: T0 - 1_000 },
        { kind, reliability, at: T0 - 1_000, detail: options.detail ?? 'provider word' }
      ])
    )
  ]
  const asks: (FrontAsk | null)[] = [
    null,
    { kind: 'permission' },
    { kind: 'question', questionCount: 1 },
    { kind: 'question', questionCount: 4 }
  ]
  for (const status of STATUSES)
    for (const openRun of [null, { stepCount: 0 }, { stepCount: 1 }, { stepCount: 6 }])
      for (const steps of [0, 1, 5])
        for (const lastTurnEnd of ends)
          for (const frontAsk of asks)
            for (const answers of [null, 'submitted', 'handed-over'] as const)
              for (const observedWithoutEndTime of [false, true])
                for (const closingWords of [undefined, options.closingWords ?? 'All set.']) {
                  yield deriveOutcomeLine(
                    input({
                      status,
                      openRun,
                      stepsSinceLastPersonMessage: steps,
                      lastTurnEnd,
                      frontAsk,
                      answers,
                      observedWithoutEndTime,
                      ...(closingWords === undefined ? {} : { closingWords })
                    })
                  )
                }
}
