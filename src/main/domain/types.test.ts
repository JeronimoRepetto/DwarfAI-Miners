import { describe, expect, it } from 'vitest'
import {
  defaultDwarf,
  defaultFeedMessage,
  defaultMine,
  defaultProviderSnapshot,
  type Dwarf,
  type Mine,
  type ProviderSnapshot
} from './types'

describe('defaultDwarf', () => {
  it('returns the documented defaults', () => {
    const dwarf: Dwarf = defaultDwarf()
    expect(dwarf).toEqual({
      id: '',
      provider: 'claude',
      role: 'worker',
      name: 'Dwarf',
      status: 'waiting',
      sessionId: ''
    })
  })

  it('returns a fresh object on every call', () => {
    expect(defaultDwarf()).not.toBe(defaultDwarf())
  })
})

describe('defaultMine', () => {
  it('returns the documented defaults', () => {
    const mine: Mine = defaultMine()
    expect(mine).toEqual({
      id: '',
      path: '',
      name: 'Mine',
      tier: 'bronze',
      dwarfs: [],
      updatedAt: 0
    })
  })

  it('returns a fresh dwarfs array on every call', () => {
    expect(defaultMine().dwarfs).not.toBe(defaultMine().dwarfs)
  })
})

describe('defaultProviderSnapshot', () => {
  it('returns the documented defaults', () => {
    const snapshot: ProviderSnapshot = defaultProviderSnapshot()
    expect(snapshot).toEqual({
      provider: 'claude',
      sessionId: '',
      cwd: '',
      status: 'idle',
      dwarfs: [],
      updatedAt: 0
    })
  })
})

describe('defaultFeedMessage', () => {
  it('returns the documented defaults', () => {
    expect(defaultFeedMessage()).toEqual({ role: 'assistant', text: '', timestamp: '' })
  })
})
