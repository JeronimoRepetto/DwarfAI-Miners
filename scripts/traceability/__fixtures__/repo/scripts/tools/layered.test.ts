/**
 * A script test whose layer comes from the comment below.
 */
// layer: L7
import { describe, expect, it } from 'vitest'

describe('layered', () => {
  it('[R1] reads its layer from the comment at the top', () => {
    expect(true).toBe(true)
  })
})
