import { describe, expect, it } from 'vitest'
import type { IntegrationState } from '../../../kernel/domain/values'
import { FAIL_CLOSED_CAPABILITIES, type ProviderCapabilities } from './capabilities'
import { combineLowest, merge, negotiatedFor } from './mergeCapabilities'

// The ADR-009 D2 merge table, restated here as test data (lowest first), so the code is checked
// against the table rather than against itself.
const BOOLEANS = [
  'launch',
  'observe',
  'sendTurn',
  'interrupt',
  'answeredElsewhere',
  'staleAnswerSafe',
  'adopt'
] as const
const ORDERED = {
  permission: ['none', 'policy-only', 'interactive'],
  question: ['none', 'options', 'form'],
  turnEnd: ['none', 'reliable'],
  reactionEvidence: ['none', 'transcript-match', 'turn-id'],
  subagents: ['none', 'transcript', 'events'],
  observedPermission: ['none', 'detected'],
  observedQuestion: ['none', 'detected']
} as const
const UNORDERED = {
  resume: { values: ['load', 'resume', 'cli-flag', 'none'], failClosed: 'none' },
  mcpInjection: { values: ['in-process', 'protocol', 'ticket-file', 'none'], failClosed: 'none' },
  console: { values: ['focus-terminal', 'attach', 'log'], failClosed: 'log' },
  earlyFailure: { values: ['handshake', 'exit-only'], failClosed: 'exit-only' },
  installDetection: { values: ['user-binary', 'none'], failClosed: 'user-binary' }
} as const
const FIDELITY = [0, 1, 2] as const

/** Every field at its highest value (unordered enums at their first listed value). */
const HIGHEST: ProviderCapabilities = {
  launch: true,
  observe: true,
  sendTurn: true,
  interrupt: true,
  permission: 'interactive',
  question: 'form',
  answeredElsewhere: true,
  staleAnswerSafe: true,
  resume: 'load',
  adopt: true,
  turnEnd: 'reliable',
  reactionEvidence: 'turn-id',
  subagents: 'events',
  usage: { fidelity: 2, rateLimits: true },
  mcpInjection: 'in-process',
  console: 'focus-terminal',
  earlyFailure: 'handshake',
  installDetection: 'none',
  observedPermission: 'detected',
  observedQuestion: 'detected'
}

type Caps = ProviderCapabilities
const withField = (base: Caps, field: string, value: unknown): Caps =>
  Object.assign(structuredClone(base), { [field]: value })

describe('ADR-009 D2 merge', () => {
  it('[C-25] every boolean field is ceiling AND negotiated', () => {
    for (const field of BOOLEANS) {
      for (const c of [true, false]) {
        for (const n of [true, false]) {
          const effective = merge(withField(HIGHEST, field, c), withField(HIGHEST, field, n))
          expect(effective[field], `${field}: ${c} AND ${n}`).toBe(c && n)
        }
      }
    }
    for (const c of [true, false]) {
      for (const n of [true, false]) {
        const effective = merge(
          { ...HIGHEST, usage: { fidelity: 2, rateLimits: c } },
          { ...HIGHEST, usage: { fidelity: 2, rateLimits: n } }
        )
        expect(effective.usage.rateLimits, `usage.rateLimits: ${c} AND ${n}`).toBe(c && n)
      }
    }
  })

  it('[C-25] every ordered enum takes the lower value, including observedPermission and usage.fidelity', () => {
    for (const [field, order] of Object.entries(ORDERED)) {
      for (const [ci, c] of order.entries()) {
        for (const [ni, n] of order.entries()) {
          const effective = merge(withField(HIGHEST, field, c), withField(HIGHEST, field, n))
          expect(effective[field as keyof Caps], `${field}: lower of ${c}, ${n}`).toBe(
            order[Math.min(ci, ni)]
          )
        }
      }
    }
    for (const c of FIDELITY) {
      for (const n of FIDELITY) {
        const effective = merge(
          { ...HIGHEST, usage: { fidelity: c, rateLimits: true } },
          { ...HIGHEST, usage: { fidelity: n, rateLimits: true } }
        )
        expect(effective.usage.fidelity, `usage.fidelity: lower of ${c}, ${n}`).toBe(Math.min(c, n))
      }
    }
  })

  it('[C-25] an unordered enum takes the negotiated value if the ceiling allows it, else its fail-closed value', () => {
    for (const [field, { values, failClosed }] of Object.entries(UNORDERED)) {
      for (const c of values) {
        for (const n of values) {
          const effective = merge(withField(HIGHEST, field, c), withField(HIGHEST, field, n))
          expect(effective[field as keyof Caps], `${field}: ceiling ${c}, negotiated ${n}`).toBe(
            n === c ? n : failClosed
          )
        }
      }
    }
  })

  it('[C-25] an omitted negotiated field yields the lowest or fail-closed value', () => {
    expect(merge(HIGHEST, {})).toEqual(FAIL_CLOSED_CAPABILITIES)
    for (const field of Object.keys(HIGHEST) as (keyof Caps)[]) {
      const negotiated: Partial<Caps> = structuredClone(HIGHEST)
      delete negotiated[field]
      const effective = merge(HIGHEST, negotiated)
      expect(effective[field], `${field} omitted`).toEqual(FAIL_CLOSED_CAPABILITIES[field])
      for (const other of Object.keys(HIGHEST) as (keyof Caps)[]) {
        if (other !== field) expect(effective[other], `${other} kept`).toEqual(HIGHEST[other])
      }
    }
  })

  it('[C-25] a probe value higher than the protocol value never raises the effective value', () => {
    // C-25b: protocol lower than the probe, the probe lower than the protocol, and unordered
    // values that differ. The effective value is never above the lower source.
    const protocol: Partial<Caps> = {
      ...HIGHEST,
      launch: false,
      permission: 'policy-only',
      question: 'none',
      usage: { fidelity: 1, rateLimits: true },
      resume: 'resume'
    }
    const probe: Partial<Caps> = {
      ...HIGHEST,
      sendTurn: false,
      subagents: 'transcript',
      usage: { fidelity: 2, rateLimits: false },
      resume: 'load'
    }
    for (const sources of [
      [protocol, probe],
      [probe, protocol]
    ]) {
      const effective = merge(HIGHEST, combineLowest(...sources))
      expect(effective.launch).toBe(false)
      expect(effective.sendTurn).toBe(false)
      expect(effective.permission).toBe('policy-only')
      expect(effective.question).toBe('none')
      expect(effective.subagents).toBe('transcript')
      expect(effective.usage).toEqual({ fidelity: 1, rateLimits: false })
      expect(effective.resume).toBe('none') // the sources disagree: fail closed
      expect(effective.observedQuestion).toBe('detected') // both report it high: kept
    }
    // Nor does a probe above the ceiling raise the effective value above the ceiling.
    const lowCeiling: Caps = {
      ...HIGHEST,
      launch: false,
      permission: 'policy-only',
      resume: 'none'
    }
    const raised = merge(lowCeiling, combineLowest(probe, { ...probe, launch: true }))
    expect(raised.launch).toBe(false)
    expect(raised.permission).toBe('policy-only')
    expect(raised.resume).toBe('none')
    // A source that omits a field does not lower it: only the sources that report a field count.
    expect(combineLowest({ permission: 'interactive' }, { question: 'form' })).toEqual({
      permission: 'interactive',
      question: 'form'
    })
    expect(combineLowest()).toEqual({})
  })

  it('[C-27] a gated provider whose integration is off or on-unverified has permission and question none', () => {
    const cases: [IntegrationState | null, Caps['permission'], Caps['question']][] = [
      ['off', 'none', 'none'],
      ['on-unverified', 'none', 'none'],
      ['on-verified', 'interactive', 'form'],
      [null, 'interactive', 'form'] // not gated
    ]
    for (const [gate, permission, question] of cases) {
      const effective = merge(HIGHEST, negotiatedFor([HIGHEST], gate))
      expect(effective.permission, `gate ${String(gate)}`).toBe(permission)
      expect(effective.question, `gate ${String(gate)}`).toBe(question)
      expect(effective.launch).toBe(true) // the gate lowers only the answer channel
    }
  })
})
