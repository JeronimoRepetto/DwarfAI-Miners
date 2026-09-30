import { describe, expect, it } from 'vitest'
import { badgeClasses, badgeText, pillClasses } from './badge'

describe('badgeText', () => {
  it('is the count itself, up to 99', () => {
    expect(badgeText(1)).toBe('1')
    expect(badgeText(12)).toBe('12')
    expect(badgeText(99)).toBe('99')
  })

  it('overflows past 99, since a corner has room for two digits', () => {
    expect(badgeText(100)).toBe('99+')
    expect(badgeText(140)).toBe('99+')
  })
})

describe('badgeClasses', () => {
  it('is the badge, then its tone; attention is the brass default and adds no class', () => {
    expect(badgeClasses()).toEqual(['dm-badge'])
    expect(badgeClasses('attn')).toEqual(['dm-badge'])
    expect(badgeClasses('info')).toEqual(['dm-badge', 'dm-badge--info'])
    expect(badgeClasses('danger')).toEqual(['dm-badge', 'dm-badge--danger'])
  })
})

describe('pillClasses', () => {
  it('is the pill, then its tone', () => {
    expect(pillClasses()).toEqual(['dm-pill'])
    for (const tone of ['needs', 'ok', 'warn', 'danger', 'info'] as const) {
      expect(pillClasses(tone)).toEqual(['dm-pill', 'dm-pill--' + tone])
    }
  })
})
