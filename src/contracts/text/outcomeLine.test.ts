// layer: L1
// L1 (17 §1.1): the turn outcome line's words (US-MSG-011 "States and copy"; NFR-TIM-15), rendered
// from the Host's structured line (06 §9.2) with the copy dictionary. `now` is passed in: the idle
// time moves with the renderer's clock, never a Host timer.
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { OutcomeLine } from '../wire'
import {
  idleText,
  outcomeSquareTone,
  renderOutcomeLine,
  type RenderableOutcomeLine,
  type RenderablePart
} from './outcomeLine'

const NOW = 1_790_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const line = (
  kind: RenderableOutcomeLine['kind'],
  parts: RenderablePart[] = [],
  reliability: RenderableOutcomeLine['reliability'] = 'reliable'
): RenderableOutcomeLine => ({ kind, parts, reliability })

describe('renderOutcomeLine', () => {
  it('[INV-67] renders the wire OutcomeLine as it crosses seam B', () => {
    expectTypeOf<OutcomeLine>().toMatchTypeOf<RenderableOutcomeLine>()
    expectTypeOf<RenderablePart>().toEqualTypeOf<OutcomeLine['parts'][number]>()
  })

  it('[US-MSG-011.AC14] one step reads "Working · 1 step so far"', () => {
    expect(renderOutcomeLine(line('working', [{ kind: 'steps-so-far', n: 1 }]), NOW)).toBe(
      'Working · 1 step so far'
    )
    expect(renderOutcomeLine(line('working', [{ kind: 'steps-so-far', n: 2 }]), NOW)).toBe(
      'Working · 2 steps so far'
    )
  })

  it('[US-MSG-011.AC13] no step reads "Working"', () => {
    expect(renderOutcomeLine(line('working'), NOW)).toBe('Working')
  })

  it('[US-MSG-011.AC02] asking reads "Waiting on you · 2 questions" or "Waiting on you · permission"', () => {
    expect(
      renderOutcomeLine(line('waiting-on-you', [{ kind: 'waiting-questions', n: 2 }]), NOW)
    ).toBe('Waiting on you · 2 questions')
    expect(renderOutcomeLine(line('waiting-on-you', [{ kind: 'waiting-permission' }]), NOW)).toBe(
      'Waiting on you · permission'
    )
  })

  it('[US-MSG-011.AC03, US-MSG-011.AC04] after the answer reads "Working · answers received", then "Working · reading your message"', () => {
    expect(renderOutcomeLine(line('working', [{ kind: 'answers-received' }]), NOW)).toBe(
      'Working · answers received'
    )
    expect(renderOutcomeLine(line('working', [{ kind: 'reading-your-message' }]), NOW)).toBe(
      'Working · reading your message'
    )
  })

  it('[US-MSG-011.AC11] "Turn finished · 5 steps"', () => {
    expect(renderOutcomeLine(line('concluded', [{ kind: 'steps', n: 5 }]), NOW)).toBe(
      'Turn finished · 5 steps'
    )
    // Asleep: the finished word stays and the idle time is appended (US-MSG-011 interaction 6).
    expect(
      renderOutcomeLine(
        line('concluded', [
          { kind: 'steps', n: 5 },
          { kind: 'idle-since', at: NOW - 41 * MIN }
        ]),
        NOW
      )
    ).toBe('Turn finished · 5 steps · idle for 41m')
    // Within the first minute the dwarf is still idle, not asleep (PO #7): no idle part yet.
    expect(
      renderOutcomeLine(
        line('concluded', [
          { kind: 'steps', n: 5 },
          { kind: 'idle-since', at: NOW - 59_999 }
        ]),
        NOW
      )
    ).toBe('Turn finished · 5 steps')
  })

  it('[US-MSG-011.AC10] "Turn stopped at a limit · idle for 41m"', () => {
    expect(
      renderOutcomeLine(line('capped', [{ kind: 'idle-since', at: NOW - 41 * MIN }]), NOW)
    ).toBe('Turn stopped at a limit · idle for 41m')
  })

  it('[US-MSG-011.AC05] a bad ending reads "Turn stopped at a limit", "Turn failed" or "Turn interrupted"', () => {
    expect(renderOutcomeLine(line('capped'), NOW)).toBe('Turn stopped at a limit')
    expect(renderOutcomeLine(line('errored', [{ kind: 'steps', n: 1 }]), NOW)).toBe(
      'Turn failed · 1 step'
    )
    expect(renderOutcomeLine(line('interrupted'), NOW)).toBe('Turn interrupted')
  })

  it('[ADR-021, INV-67] a line with no reliable end never reads "Turn finished": its word is the open design item', () => {
    const text = renderOutcomeLine(line('working', [{ kind: 'steps', n: 3 }], 'inferred'), NOW)
    expect(text).toMatch(/^⟦COPY NEEDED: [^⟦⟧]+⟧ · 3 steps$/)
    expect(text).not.toContain('Turn finished')
  })

  it('[US-MSG-011.AC07, NFR-TIM-15] idle time reads minutes, then hours, then days, each rounded down, never a unit above days', () => {
    const table: [number, string][] = [
      [59_000, '0m'],
      [60_000, '1m'],
      [59 * MIN + 59_000, '59m'],
      [HOUR, '1h'],
      [23 * HOUR + 59 * MIN, '23h'],
      [DAY, '1d'],
      [7 * DAY, '7d'],
      [400 * DAY, '400d']
    ]
    for (const [ms, text] of table) expect(idleText(ms), `${ms} ms`).toBe(text)
  })

  it('[US-MSG-011.AC01, US-MSG-011.AC02, US-MSG-011.AC07] the square is green for working and idle, brass for asking and steel for asleep', () => {
    expect(outcomeSquareTone('working')).toBe('green')
    expect(outcomeSquareTone('idle')).toBe('green')
    expect(outcomeSquareTone('asking')).toBe('brass')
    expect(outcomeSquareTone('asleep')).toBe('steel')
  })

  it('[US-MSG-011.AC12] property: no rendered line contains the word done', () => {
    const kinds: RenderableOutcomeLine['kind'][] = [
      'working',
      'concluded',
      'capped',
      'errored',
      'interrupted',
      'waiting-on-you'
    ]
    const parts: RenderablePart[][] = [
      [],
      [{ kind: 'steps', n: 1 }],
      [{ kind: 'steps-so-far', n: 7 }],
      [{ kind: 'waiting-questions', n: 1 }],
      [{ kind: 'waiting-questions', n: 3 }],
      [{ kind: 'waiting-permission' }],
      [{ kind: 'answers-received' }],
      [{ kind: 'reading-your-message' }],
      [
        { kind: 'steps', n: 12 },
        { kind: 'idle-since', at: NOW - 3 * DAY }
      ]
    ]
    let cases = 0
    for (const kind of kinds)
      for (const p of parts)
        for (const reliability of ['reliable', 'inferred'] as const)
          for (const elapsed of [0, MIN, 5 * HOUR, 30 * DAY]) {
            const text = renderOutcomeLine(line(kind, p, reliability), NOW + elapsed)
            expect(text).not.toBe('')
            expect(text.toLowerCase()).not.toMatch(/\bdone\b/)
            cases += 1
          }
    expect(cases).toBe(6 * 9 * 2 * 4)
  })
})
