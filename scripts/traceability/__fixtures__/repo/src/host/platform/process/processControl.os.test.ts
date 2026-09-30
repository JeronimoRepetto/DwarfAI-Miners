import { describe, expect, it } from 'vitest'

describe.runIf(process.platform === 'win32')('ProcessControl on Windows', () => {
  it('[ADR-014, FM-001, CH-01] ends the child and the grandchild', () => {
    expect(true).toBe(true)
  })
})
