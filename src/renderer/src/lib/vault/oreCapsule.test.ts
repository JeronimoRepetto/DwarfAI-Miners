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

  /*
   * The design lead's compact-count ruling (ATOMS-QUESTIONS-2, question 4), band by band: full
   * under 10,000; one decimal to 99.9K; whole to 999K; one decimal to 9.9M; whole from 10M; a
   * trailing ".0" dropped; a figure that rounds into the next band is written in that band.
   */
  it.each([
    [9_999, '9,999'],
    [10_000, '10K'],
    [10_040, '10K'],
    [99_940, '99.9K'],
    [99_960, '100K'],
    [100_000, '100K'],
    [280_600, '281K'],
    [999_499, '999K'],
    [999_950, '1M'],
    [1_000_000, '1M'],
    [1_040_000, '1M'],
    [1_240_000, '1.2M'],
    [9_940_000, '9.9M'],
    [9_960_000, '10M'],
    [10_000_000, '10M'],
    [12_345_678, '12M'],
    [123_456_789, '123M']
  ])('follows the compact count rule at its boundaries: %i reads %s', (units, text) => {
    expect(compactUnits(units)).toBe(text)
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
