import { describe, expect, it } from 'vitest'
import { compactUnits, oreCapsuleClasses, oreCapsuleName } from './oreCapsule'

describe('compactUnits', () => {
  it('writes a count below ten thousand in full, with comma thousands', () => {
    expect(compactUnits(0)).toBe('0')
    expect(compactUnits(4)).toBe('4')
    expect(compactUnits(548)).toBe('548')
    expect(compactUnits(9999)).toBe('9,999')
  })

  it('compacts from ten thousand up, as the design table spells each', () => {
    expect(compactUnits(10_000)).toBe('10K')
    expect(compactUnits(12_480)).toBe('12.5K')
    expect(compactUnits(280_612)).toBe('281K')
    expect(compactUnits(1_234_567)).toBe('1.2M')
    expect(compactUnits(12_000_000)).toBe('12M')
  })

  it('moves up a unit rather than write a thousand of the one below', () => {
    expect(compactUnits(999_999)).toBe('1M')
  })
})

describe('oreCapsuleName', () => {
  it('names one material and its full count, so the compact number is never the only reading', () => {
    expect(oreCapsuleName('coal', 280_612)).toBe('Coal: 280,612')
    expect(oreCapsuleName('uranium', 0)).toBe('Uranium: 0')
  })
})

describe('oreCapsuleClasses', () => {
  it('is the capsule, then its size, then the dimmed zero look', () => {
    expect(oreCapsuleClasses(4)).toEqual(['dm-ore'])
    expect(oreCapsuleClasses(12, 'lg')).toEqual(['dm-ore', 'dm-ore--lg'])
    expect(oreCapsuleClasses(0)).toEqual(['dm-ore', 'dm-ore--zero'])
  })
})
