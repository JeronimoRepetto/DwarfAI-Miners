import { describe, expect, it } from 'vitest'

throw new Error('this fixture must never be executed')

describe('never executed', () => {
  it('[US-OBS-001.AC01] is still read', () => {
    expect(true).toBe(true)
  })
})
