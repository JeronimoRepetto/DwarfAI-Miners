import { describe, expect, it } from 'vitest'
import { portraitAttributes, portraitClasses, portraitMark, portraitStatusText } from './portrait'

describe('portraitMark', () => {
  it('marks asking, asleep and done on the frame, and nothing for working or idle', () => {
    expect(portraitMark('asking')).toBe('?')
    expect(portraitMark('asleep')).toBe('z')
    expect(portraitMark('done')).toBe('✓')
    expect(portraitMark('working')).toBe('')
    expect(portraitMark('idle')).toBe('')
  })
})

describe('portraitStatusText', () => {
  it('says each status as the name reads it; asking is "needs you"', () => {
    expect(portraitStatusText('asking')).toBe('needs you')
    expect(portraitStatusText('asleep')).toBe('asleep')
    expect(portraitStatusText('working')).toBe('working')
    expect(portraitStatusText('done')).toBe('done')
    expect(portraitStatusText('idle')).toBe('idle')
  })
})

describe('portraitClasses', () => {
  it('is the portrait and its recipe, then its size, then the forced state', () => {
    expect(portraitClasses({})).toEqual(['dm-portrait', 'm-mat'])
    expect(portraitClasses({ size: 'sm' })).toEqual(['dm-portrait', 'm-mat', 'dm-portrait--sm'])
    expect(portraitClasses({ size: 'lg', state: 'hover' })).toEqual([
      'dm-portrait',
      'm-mat',
      'dm-portrait--lg',
      'is-hover'
    ])
  })
})

describe('portraitAttributes', () => {
  it('is an unnamed figure when static, carrying only its status', () => {
    expect(portraitAttributes({ interactive: false, status: 'idle', name: 'a' })).toEqual({
      'data-status': 'idle'
    })
  })

  it('is a button named after the dwarf and its state when interactive, selection pressed', () => {
    expect(portraitAttributes({ interactive: true, status: 'asking', name: 'b' })).toEqual({
      type: 'button',
      'data-status': 'asking',
      'aria-pressed': 'false',
      'aria-label': 'b, needs you'
    })
    expect(
      portraitAttributes({ interactive: true, status: 'idle', name: 'a', selected: true })[
        'aria-pressed'
      ]
    ).toBe('true')
  })
})
