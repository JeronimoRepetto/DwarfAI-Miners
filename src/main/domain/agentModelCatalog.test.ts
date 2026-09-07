import { describe, expect, it } from 'vitest'
import {
  antigravityModelCatalog,
  claudeModelCatalog,
  codexModelCatalog,
  unavailableAntigravityModelCatalog,
  unavailableClaudeModelCatalog
} from './agentModelCatalog'

describe('claudeModelCatalog (#239)', () => {
  it('carries a live answer as source: provider, with the effort levels the boundary checks', () => {
    // AMENDED for #96 (was: neither model carried an `effortLevels` field, and
    // the expectation named none). A per-model list now rides each option —
    // see ModelOption.effortLevels for why the provider-wide `efforts` could
    // not answer the question a mid-run effort control has to ask. No
    // assertion was weakened: `efforts`, the labels and the source are
    // asserted exactly as before, and the `supportsEffort: false` row still
    // proves a model that takes no effort gets nothing.
    expect(
      claudeModelCatalog([
        {
          value: 'claude-sonnet-5',
          displayName: 'Sonnet',
          supportsEffort: true,
          effortLevels: ['low', 'medium', 'high']
        },
        { value: 'claude-haiku-4-5', displayName: 'Haiku', supportsEffort: false }
      ])
    ).toEqual({
      provider: 'claude',
      models: [
        { value: 'claude-sonnet-5', label: 'Sonnet', effortLevels: ['low', 'medium', 'high'] },
        { value: 'claude-haiku-4-5', label: 'Haiku' }
      ],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      source: 'provider'
    })
  })

  it('drops the label when the display name is empty', () => {
    // AMENDED for #96 (was: `supportsEffort: true` with no expectation of an
    // effortLevels field). Flipped to `false` rather than restating the new
    // field: this case is about the LABEL rule and nothing else, and effort
    // has its own three cases below.
    expect(
      claudeModelCatalog([{ value: 'claude-sonnet-5', displayName: '', supportsEffort: false }])
    ).toEqual({
      provider: 'claude',
      models: [{ value: 'claude-sonnet-5' }],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      source: 'provider'
    })
  })

  it('drops the label when it only repeats the value, rather than showing it twice', () => {
    // AMENDED for #96, same as the case above and for the same reason.
    expect(
      claudeModelCatalog([{ value: 'sonnet', displayName: 'sonnet', supportsEffort: false }])
    ).toEqual({
      provider: 'claude',
      models: [{ value: 'sonnet' }],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      source: 'provider'
    })
  })

  /*
   * Issue #96. `applyFlagSettings({ effortLevel })` on a model without
   * `supportsEffort` resolves cleanly and silently does nothing — measured
   * live, and the whole reason the per-model list exists. So the gate is
   * exactly `supportsEffort`, and a model that fails it must carry NO list at
   * all: an empty one would read as "a model with an effort control and no
   * levels in it", which is a control that cannot be used rather than one
   * that should not be drawn.
   */
  it('offers no effort levels at all for a model that takes none', () => {
    const catalog = claudeModelCatalog([
      { value: 'claude-haiku-4-5', displayName: 'Haiku', supportsEffort: false }
    ])
    expect(catalog.models[0]).toEqual({ value: 'claude-haiku-4-5', label: 'Haiku' })
    expect('effortLevels' in catalog.models[0]!).toBe(false)
  })

  it("names only the levels the provider itself listed, never the provider's whole set", () => {
    // A model that accepts three of the five must not be offered the other
    // two: the SDK answers per model, and widening that answer here would be
    // this app inventing a level the model never claimed.
    const catalog = claudeModelCatalog([
      {
        value: 'claude-sonnet-5',
        displayName: 'Sonnet',
        supportsEffort: true,
        effortLevels: ['low', 'high']
      }
    ])
    expect(catalog.models[0]?.effortLevels).toEqual(['low', 'high'])
  })

  it("falls back to the provider's own boundary list when a model says it takes an effort but names none", () => {
    // Not an invention: `efforts` is the same closed list every launch of this
    // provider is already checked against, so nothing here can offer a level
    // the boundary would refuse. The alternative — no control on a model that
    // said outright that it takes one — would hide a working setting.
    const catalog = claudeModelCatalog([
      { value: 'claude-opus-5', displayName: 'Opus', supportsEffort: true }
    ])
    expect(catalog.models[0]?.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(catalog.models[0]?.effortLevels).toEqual(catalog.efforts)
  })

  it('treats an empty level list as no list, rather than as an effort control with nothing in it', () => {
    const catalog = claudeModelCatalog([
      { value: 'claude-opus-5', displayName: 'Opus', supportsEffort: true, effortLevels: [] }
    ])
    expect(catalog.models[0]?.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('answers an empty catalogue for an installed CLI that named no models', () => {
    expect(claudeModelCatalog([])).toEqual({
      provider: 'claude',
      models: [],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      source: 'provider'
    })
  })
})

describe('unavailableClaudeModelCatalog (#239)', () => {
  it('answers source: none, never history, for a provider that normally answers live', () => {
    expect(unavailableClaudeModelCatalog()).toEqual({
      provider: 'claude',
      models: [],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      source: 'none'
    })
  })
})

describe('codexModelCatalog (#239)', () => {
  it('carries every distinct model the registry recorded, in the order given', () => {
    expect(
      codexModelCatalog([
        { model: 'gpt-5.6-sol' },
        { model: 'gpt-5.6-mini' },
        { model: 'gpt-5.6-sol' }
      ])
    ).toEqual({
      provider: 'codex',
      models: [{ value: 'gpt-5.6-sol' }, { value: 'gpt-5.6-mini' }],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      source: 'history'
    })
  })

  it('never re-sorts: the newest-first ordering is the caller’s to have already made', () => {
    // readCodexThreads already orders by activity DESC; this only dedupes.
    expect(codexModelCatalog([{ model: 'b' }, { model: 'a' }])).toEqual({
      provider: 'codex',
      models: [{ value: 'b' }, { value: 'a' }],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      source: 'history'
    })
  })

  it('skips a thread with no model or an empty one, never a placeholder entry', () => {
    expect(
      codexModelCatalog([{ model: undefined }, { model: '' }, { model: 'gpt-5.6-sol' }])
    ).toEqual({
      provider: 'codex',
      models: [{ value: 'gpt-5.6-sol' }],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      source: 'history'
    })
  })

  it('answers source: history even with nothing to show, because the derivation never changes', () => {
    expect(codexModelCatalog([])).toEqual({
      provider: 'codex',
      models: [],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      source: 'history'
    })
  })
})

/*
 * AMENDED for #282 (was: a single test, 'answers none with no effort levels,
 * until #237 gives it a launch path', calling `antigravityModelCatalog()`
 * with no argument and asserting `source: 'none'` with `efforts: []` — #237
 * gave Antigravity a launch path but no live list yet, so the catalogue
 * stayed a hard-coded none. #282 asks `agy models` live; this now mirrors
 * claudeModelCatalog's own shape and its two describe blocks below.
 */
describe('antigravityModelCatalog (#282)', () => {
  it('carries a live answer as source: provider, with the effort levels the boundary checks', () => {
    expect(
      antigravityModelCatalog([
        { value: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)' },
        { value: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' }
      ])
    ).toEqual({
      provider: 'antigravity',
      models: [
        { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
        { value: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
      ],
      efforts: ['low', 'medium', 'high'],
      source: 'provider'
    })
  })

  it('drops the label when the display name is empty', () => {
    expect(antigravityModelCatalog([{ value: 'agy-model', displayName: '' }])).toEqual({
      provider: 'antigravity',
      models: [{ value: 'agy-model' }],
      efforts: ['low', 'medium', 'high'],
      source: 'provider'
    })
  })

  it('drops the label when it only repeats the value, rather than showing it twice', () => {
    expect(antigravityModelCatalog([{ value: 'agy-model', displayName: 'agy-model' }])).toEqual({
      provider: 'antigravity',
      models: [{ value: 'agy-model' }],
      efforts: ['low', 'medium', 'high'],
      source: 'provider'
    })
  })

  it('answers an empty catalogue for an installed CLI that named no models', () => {
    expect(antigravityModelCatalog([])).toEqual({
      provider: 'antigravity',
      models: [],
      efforts: ['low', 'medium', 'high'],
      source: 'provider'
    })
  })
})

describe('unavailableAntigravityModelCatalog (#282)', () => {
  it('answers source: none, never provider, for a CLI that could not be asked', () => {
    expect(unavailableAntigravityModelCatalog()).toEqual({
      provider: 'antigravity',
      models: [],
      efforts: ['low', 'medium', 'high'],
      source: 'none'
    })
  })
})
