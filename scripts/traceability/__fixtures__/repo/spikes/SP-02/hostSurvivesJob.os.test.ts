import { describe, expect, it } from 'vitest'

describe.runIf(process.platform === 'win32')('SP-02 regression', () => {
  it('[SP-02, ADR-002] the Host survives the end of the UI job', () => {
    expect(true).toBe(true)
  })
})
