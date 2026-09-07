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
    expect(
      claudeModelCatalog([
        { value: 'claude-sonnet-5', displayName: 'Sonnet', supportsEffort: true },
        { value: 'claude-haiku-4-5', displayName: 'Haiku', supportsEffort: false }
      ])
    ).toEqual({
      provider: 'claude',
      models: [
        { value: 'claude-sonnet-5', label: 'Sonnet' },
        { value: 'claude-haiku-4-5', label: 'Haiku' }
      ],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      source: 'provider'
    })
  })

  it('drops the label when the display name is empty', () => {
    expect(
      claudeModelCatalog([{ value: 'claude-sonnet-5', displayName: '', supportsEffort: true }])
    ).toEqual({
      provider: 'claude',
      models: [{ value: 'claude-sonnet-5' }],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      source: 'provider'
    })
  })

  it('drops the label when it only repeats the value, rather than showing it twice', () => {
    expect(
      claudeModelCatalog([{ value: 'sonnet', displayName: 'sonnet', supportsEffort: true }])
    ).toEqual({
      provider: 'claude',
      models: [{ value: 'sonnet' }],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      source: 'provider'
    })
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
