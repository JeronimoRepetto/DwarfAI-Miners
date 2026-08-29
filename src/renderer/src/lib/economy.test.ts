import { describe, expect, it } from 'vitest'
import { formatTokens, MAX_PILE_STEP, oreCount, orePileStep, TOKENS_PER_ORE } from './economy'

describe('formatTokens', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1K'],
    [1234, '1.2K'],
    [2_500_000, '2.5M'],
    [1_000_000_000, '1B']
  ])('formats %d as %s', (input, expected) => {
    expect(formatTokens(input)).toBe(expected)
  })

  it('clamps negative input to 0', () => {
    expect(formatTokens(-50)).toBe('0')
  })
})

describe('oreCount', () => {
  it('divides tokens by TOKENS_PER_ORE, rounded down', () => {
    expect(oreCount(0)).toBe(0)
    expect(oreCount(TOKENS_PER_ORE - 1)).toBe(0)
    expect(oreCount(TOKENS_PER_ORE)).toBe(1)
    expect(oreCount(TOKENS_PER_ORE * 3 + 500)).toBe(3)
  })

  it('never goes negative', () => {
    expect(oreCount(-1000)).toBe(0)
  })
})

describe('orePileStep', () => {
  it('grows in discrete steps as ore increases', () => {
    expect(orePileStep(0)).toBe(0)
    expect(orePileStep(1)).toBe(1)
    expect(orePileStep(4)).toBe(1)
    expect(orePileStep(5)).toBe(2)
    expect(orePileStep(19)).toBe(2)
    expect(orePileStep(20)).toBe(3)
    expect(orePileStep(49)).toBe(3)
    expect(orePileStep(50)).toBe(4)
    expect(orePileStep(149)).toBe(4)
    expect(orePileStep(150)).toBe(MAX_PILE_STEP)
  })

  it('never exceeds MAX_PILE_STEP however large the pile gets', () => {
    expect(orePileStep(10_000_000)).toBe(MAX_PILE_STEP)
  })
})
