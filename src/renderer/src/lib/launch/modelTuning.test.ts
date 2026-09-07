import { describe, expect, it } from 'vitest'
import type { AgentModelCatalog } from '../../types'
import { OTHER_CHOICE } from './launchState'
import {
  MODEL_HISTORY_SOURCE,
  NO_MODEL_LIST,
  effortPicker,
  modelPicker,
  permissionsVisible
} from './modelTuning'

const CLAUDE_LIVE: AgentModelCatalog = {
  provider: 'claude',
  models: [
    { value: 'claude-sonnet-5', label: 'Sonnet' },
    { value: 'claude-haiku-4-5', label: 'Haiku' }
  ],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  source: 'provider'
}

const CODEX_HISTORY: AgentModelCatalog = {
  provider: 'codex',
  models: [{ value: 'gpt-5.6-sol' }],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  source: 'history'
}

const CODEX_EMPTY_HISTORY: AgentModelCatalog = {
  provider: 'codex',
  models: [],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  source: 'history'
}

const ANTIGRAVITY_NONE: AgentModelCatalog = {
  provider: 'antigravity',
  models: [],
  efforts: [],
  source: 'none'
}

describe('modelPicker (#239)', () => {
  it('is hidden before any provider chip is chosen', () => {
    expect(modelPicker([CLAUDE_LIVE], null)).toEqual({
      visible: false,
      models: [],
      disabled: true,
      note: null
    })
  })

  it('is hidden for Other, which has no provider identity to answer for', () => {
    expect(modelPicker([CLAUDE_LIVE], OTHER_CHOICE)).toEqual({
      visible: false,
      models: [],
      disabled: true,
      note: null
    })
  })

  it('offers the live list for a provider that answered live, with no note', () => {
    expect(modelPicker([CLAUDE_LIVE], 'claude')).toEqual({
      visible: true,
      models: CLAUDE_LIVE.models,
      disabled: false,
      note: null
    })
  })

  it('offers the history list with the source named, so the picker never passes it off as the CLI’s own word', () => {
    expect(modelPicker([CODEX_HISTORY], 'codex')).toEqual({
      visible: true,
      models: CODEX_HISTORY.models,
      disabled: false,
      note: MODEL_HISTORY_SOURCE
    })
  })

  it('shows the select disabled with the reason for a provider main could not ask at all', () => {
    expect(modelPicker([ANTIGRAVITY_NONE], 'antigravity')).toEqual({
      visible: true,
      models: [],
      disabled: true,
      note: NO_MODEL_LIST
    })
  })

  it('disables an empty history list too, though the row still shows it is history', () => {
    expect(modelPicker([CODEX_EMPTY_HISTORY], 'codex')).toEqual({
      visible: true,
      models: [],
      disabled: true,
      note: MODEL_HISTORY_SOURCE
    })
  })

  it('reads none, not a crash, when main’s answer never named the chosen provider at all', () => {
    expect(modelPicker([], 'claude')).toEqual({
      visible: true,
      models: [],
      disabled: true,
      note: NO_MODEL_LIST
    })
  })
})

describe('effortPicker (#239)', () => {
  it('is hidden before a provider is chosen, and for Other', () => {
    expect(effortPicker([CLAUDE_LIVE], null)).toEqual({ visible: false, efforts: [] })
    expect(effortPicker([CLAUDE_LIVE], OTHER_CHOICE)).toEqual({ visible: false, efforts: [] })
  })

  it('offers the chosen provider’s own effort levels', () => {
    expect(effortPicker([CLAUDE_LIVE], 'claude')).toEqual({
      visible: true,
      efforts: CLAUDE_LIVE.efforts
    })
  })

  it('stays hidden for a provider with none, rather than drawing an empty select', () => {
    expect(effortPicker([ANTIGRAVITY_NONE], 'antigravity')).toEqual({ visible: false, efforts: [] })
  })
})

describe('permissionsVisible (#239)', () => {
  it('shows for held Claude only', () => {
    expect(permissionsVisible('claude')).toBe(true)
  })

  it('hides for a provider with no held engine', () => {
    expect(permissionsVisible('codex')).toBe(false)
    expect(permissionsVisible('antigravity')).toBe(false)
  })

  it('hides for Other and for no choice at all', () => {
    expect(permissionsVisible(OTHER_CHOICE)).toBe(false)
    expect(permissionsVisible(null)).toBe(false)
  })
})
