import { describe, expect, it } from 'vitest'
import { jevCardEyebrow, jevCardTip, jevPickText } from './jevCardCopy'
import type { JevDecision } from './launchState'

/*
 * The Add panel's Jev card (#635, MESSAGE-QUESTIONS 15; decision log, Jev card from the decision):
 * the eyebrow, one paragraph built only from what the decision carries, and a tooltip holding the
 * rest in the app's own sentences, one per line.
 */

// The design's worked example (screens/launch.md): frontier at 88%, Claude at 91%, the model at 74%.
const DECISION: JevDecision = {
  kind: 'decision',
  provider: 'claude',
  model: 'opus',
  effort: 'high',
  confidence: 0.74,
  truncated: false,
  tier: 'frontier',
  parts: {
    provider: { value: 'claude', confidence: 0.91, applied: 'answered' },
    tier: { value: 'frontier', confidence: 0.88, applied: 'answered' },
    trivial: { value: false, probability: 0.05 },
    largeContext: { value: false, probability: 0.05 },
    model: { value: 'opus', applied: 'answered', probability: 0.74 }
  }
}

describe('jevCardEyebrow', () => {
  it('says Jev suggests, or that the pick was accepted automatically with auto-accept on', () => {
    expect(jevCardEyebrow(false)).toBe('JEV SUGGESTS')
    expect(jevCardEyebrow(true)).toBe('JEV · ACCEPTED AUTOMATICALLY')
  })
})

describe('jevPickText', () => {
  it('names the supplier, the model and the effort, joined by a middle dot', () => {
    expect(jevPickText({ supplier: 'Claude', model: 'opus', effort: 'high' })).toBe(
      'Claude · opus · high'
    )
  })

  it('leaves out a part the decision lacks, never a placeholder for it', () => {
    expect(jevPickText({ supplier: 'Claude', model: null, effort: 'high' })).toBe('Claude · high')
    expect(jevPickText({ supplier: 'Claude', model: 'opus' })).toBe('Claude · opus')
    expect(jevPickText({ supplier: 'Claude', model: null })).toBe('Claude')
  })
})

describe('jevCardTip', () => {
  it('says which parts Jev answered, then its least certain answer, as the design words them', () => {
    expect(jevCardTip(DECISION, 'Claude')).toEqual([
      'Jev chose the frontier tier (88% sure) and Claude (91% sure). Jev picked the model (74% fit).',
      "Jev's least certain answer was 74%."
    ])
  })

  it('names a part that fell to a safe value, and gives no least certain answer with none answered', () => {
    const lines = jevCardTip(
      {
        ...DECISION,
        confidence: undefined,
        parts: {
          ...DECISION.parts,
          provider: { value: 'claude', confidence: 0.19, applied: 'safe-default' },
          tier: { value: 'frontier', confidence: 0.3, applied: 'safe-default' },
          model: { value: 'opus', applied: 'only-candidate' }
        }
      },
      'Claude'
    )

    expect(lines).toEqual([
      'Jev was unsure about the tier (30%) and the provider (19%); the safe values frontier and Claude were used. Only one model fits that tier, so no second question was asked.'
    ])
  })

  it('adds each flag that applies, one per line, in the design’s order', () => {
    const lines = jevCardTip(
      {
        ...DECISION,
        truncated: true,
        parts: {
          ...DECISION.parts,
          trivial: { value: true, probability: 0.9 },
          largeContext: { value: true, probability: 0.9 }
        }
      },
      'Claude'
    )

    expect(lines.slice(2)).toEqual([
      'Treated as a trivial prompt.',
      'Large-context model preferred.',
      'The prompt sent to Jev was trimmed to fit its request budget.'
    ])
  })

  it('carries only the flags the decision sets', () => {
    const lines = jevCardTip({ ...DECISION, truncated: true }, 'Claude')

    expect(lines.slice(2)).toEqual([
      'The prompt sent to Jev was trimmed to fit its request budget.'
    ])
  })

  it('never carries the app’s closing note, which the pickers now say themselves', () => {
    expect(jevCardTip(DECISION, 'Claude').join(' ')).not.toContain('pickers below')
  })

  it('says how the model was picked when Jev could not pick it', () => {
    const [parts] = jevCardTip(
      {
        ...DECISION,
        parts: { ...DECISION.parts, model: { applied: 'safe-default', reason: 'timeout' } }
      },
      'Claude'
    )

    expect(parts).toContain(
      'Jev could not pick the model (Jev took too long); the closest local choice was used.'
    )
  })
})
