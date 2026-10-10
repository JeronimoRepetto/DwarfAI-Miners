// layer: L1
// L1 (17 §1.1): ADR-011 item 5's emission table over every combination of origin, capability and
// `hasAllowOnce` (TC-132-01). The capability fixtures are data: no provider id enters the logic.
import { describe, expect, it } from 'vitest'
import {
  resolveEmission,
  type Emission,
  type EmissionInput,
  type EmissionSession
} from './emission'

const PERMISSIONS = ['interactive', 'policy-only', 'none'] as const
const QUESTIONS = ['form', 'options', 'none'] as const
const DETECTION = ['detected', 'none'] as const

/** A session with every answer path open; each test narrows one field. */
const session = (overrides: Partial<EmissionSession> = {}): EmissionSession => ({
  origin: 'launched',
  permission: 'interactive',
  question: 'form',
  observedPermission: 'detected',
  observedQuestion: 'detected',
  ...overrides
})

const permission = (hasAllowOnce = true, channel: EmissionInput['channel'] = 'driver') =>
  ({ kind: 'permission', channel, options: { hasAllowOnce } }) as const
const question = (channel: EmissionInput['channel'] = 'driver') =>
  ({ kind: 'question', channel }) as const

const DENY: Emission = { kind: 'auto-denied', answer: 'deny', degradedFrom: 'ask' }
const DECLINE: Emission = { kind: 'auto-denied', answer: 'decline', degradedFrom: 'ask' }

/** Every session the table covers. */
function everySession(): EmissionSession[] {
  const all: EmissionSession[] = []
  for (const origin of ['launched', 'observed'] as const)
    for (const p of PERMISSIONS)
      for (const q of QUESTIONS)
        for (const op of DETECTION)
          for (const oq of DETECTION)
            all.push({
              origin,
              permission: p,
              question: q,
              observedPermission: op,
              observedQuestion: oq
            })
  return all
}

/** Every request the table covers. */
function everyInput(): EmissionInput[] {
  const all: EmissionInput[] = []
  for (const channel of ['driver', 'hook-keystroke', 'hook-decision', 'http', 'none'] as const) {
    all.push(question(channel))
    for (const hasAllowOnce of [true, false]) all.push(permission(hasAllowOnce, channel))
  }
  return all
}

describe('resolveEmission (ADR-011 item 5)', () => {
  it('[US-ASK-006.AC10, S6.03, FM-072] a launched session with policy-only or none permission gets auto-denied for a question or a permission', () => {
    for (const p of ['policy-only', 'none'] as const) {
      expect(resolveEmission(permission(), session({ permission: p }))).toEqual(DENY)
      expect(resolveEmission(question(), session({ permission: p }))).toEqual(DECLINE)
    }
    // A launched session with no question channel declines the question that still arrives.
    expect(resolveEmission(question(), session({ question: 'none' }))).toEqual(DECLINE)
    // The interactive session keeps its card.
    expect(resolveEmission(permission(), session())).toEqual({ kind: 'card' })
    expect(resolveEmission(question(), session())).toEqual({ kind: 'card' })
  })

  it('[US-ASK-003.AC09, INV-73, FM-071] a permission without allow_once is auto-denied when launched and channel-none when observed', () => {
    expect(resolveEmission(permission(false), session())).toEqual(DENY)
    expect(
      resolveEmission(permission(false, 'hook-keystroke'), session({ origin: 'observed' }))
    ).toEqual({ kind: 'channel-none' })
  })

  it('[US-ASK-006.AC11, S6.02, INV-76] an observed ask of a provider without a channel, detected by a trusted signal, is channel-none', () => {
    const observed = session({ origin: 'observed', permission: 'none', question: 'none' })
    expect(resolveEmission(permission(true, 'none'), observed)).toEqual({ kind: 'channel-none' })
    expect(resolveEmission(question('none'), observed)).toEqual({ kind: 'channel-none' })
    // Reported on a channel kind while the session has no channel: still no card.
    expect(resolveEmission(permission(true, 'driver'), observed)).toEqual({ kind: 'channel-none' })
    expect(resolveEmission(question('driver'), observed)).toEqual({ kind: 'channel-none' })
    // An observed session with an answer channel (the keystroke channel, ADR-012) keeps its card.
    expect(
      resolveEmission(permission(true, 'hook-keystroke'), session({ origin: 'observed' }))
    ).toEqual({ kind: 'card' })
  })

  it('[US-ASK-006.AC12, S1.17, FM-073] an observed ask whose kind the provider cannot detect is not an ask', () => {
    const blind = { origin: 'observed', permission: 'none', question: 'none' } as const
    expect(
      resolveEmission(permission(true, 'none'), session({ ...blind, observedPermission: 'none' }))
    ).toEqual({ kind: 'not-an-ask' })
    expect(
      resolveEmission(question('none'), session({ ...blind, observedQuestion: 'none' }))
    ).toEqual({ kind: 'not-an-ask' })
    // Detection is per kind (15 §2.5, observed Codex): the other kind still opens.
    expect(
      resolveEmission(question('none'), session({ ...blind, observedPermission: 'none' }))
    ).toEqual({ kind: 'channel-none' })
    expect(
      resolveEmission(permission(true, 'none'), session({ ...blind, observedQuestion: 'none' }))
    ).toEqual({ kind: 'channel-none' })
  })

  it('[ADR-011] nothing is ever weakened to Allow', () => {
    for (const s of everySession()) {
      for (const input of everyInput()) {
        const emission = resolveEmission(input, s)
        // TC-132-01: the table's four results, and a degradation is only ever a refusal.
        expect(['card', 'auto-denied', 'channel-none', 'not-an-ask']).toContain(emission.kind)
        if (emission.kind === 'auto-denied') {
          expect(emission.answer).toBe(input.kind === 'permission' ? 'deny' : 'decline')
          expect(emission.degradedFrom).toBe('ask')
        }
        // A card is offered only where the app can honour it with a one-time Allow (INV-73).
        if (emission.kind === 'card') {
          expect(input.channel).not.toBe('none')
          expect(s.permission).toBe('interactive')
          if (input.kind === 'permission') expect(input.options.hasAllowOnce).toBe(true)
          else expect(s.question).not.toBe('none')
        }
        // A launched session never waits on the person without a card; an observed one is never
        // auto-denied (the app does not answer what it only observes).
        if (s.origin === 'launched') expect(['card', 'auto-denied']).toContain(emission.kind)
        else expect(emission.kind).not.toBe('auto-denied')
      }
    }
  })
})
