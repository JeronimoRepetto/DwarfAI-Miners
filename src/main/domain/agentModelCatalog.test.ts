import { describe, expect, it } from 'vitest'
import {
  antigravityModelCatalog,
  claudeModelCatalog,
  codexModelCatalog,
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

describe('antigravityModelCatalog (#239)', () => {
  it('answers none with no effort levels, until #237 gives it a launch path', () => {
    expect(antigravityModelCatalog()).toEqual({
      provider: 'antigravity',
      models: [],
      efforts: [],
      source: 'none'
    })
  })
})
