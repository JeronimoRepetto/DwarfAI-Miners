// L1 (17 §1.1): the effort-ceiling fallback onto the configured default (ADR-028 items 2-3).
// TC-193-01, TC-193-02.
import { describe, expect, it } from 'vitest'
import { defaultFallback, type EffortCeilingFallback } from './defaultFallback'

const CEILING: EffortCeilingFallback = { kind: 'fallback', reason: 'effort-ceiling' }

describe('defaultFallback', () => {
  it('[US-LAUNCH-003.AC13, INV-86, ADR-028] an effort-ceiling decision with a configured default yields the default provider, model and effort, uncapped, with fallback effort-ceiling', () => {
    // 'max' is the top of every ladder: any ceiling at all would lower it.
    expect(
      defaultFallback(CEILING, { provider: 'codex', model: 'gpt-5-codex', effort: 'max' })
    ).toStrictEqual({
      providerId: 'codex',
      model: 'gpt-5-codex',
      effort: 'max',
      confidence: {},
      truncated: false,
      parts: { providerId: 'safe-default', model: 'safe-default', effort: 'safe-default' },
      fallback: 'effort-ceiling'
    })
  })

  it('[ADR-028] a configured default provider with no model or effort yields only the provider', () => {
    expect(defaultFallback(CEILING, { provider: 'claude' })).toStrictEqual({
      providerId: 'claude',
      confidence: {},
      truncated: false,
      parts: { providerId: 'safe-default' },
      fallback: 'effort-ceiling'
    })
  })

  it('[ADR-028] with Default provider None the ceiling yields no-default', () => {
    expect(defaultFallback(CEILING, {})).toBe('no-default')
    // 09 §4.8: a model or effort only with a provider; a stray one never makes a default.
    expect(defaultFallback(CEILING, { model: 'sonnet', effort: 'low' })).toBe('no-default')
  })
})
