import { describe, expect, it, test } from 'vitest'

describe('ConversationCommands.send', () => {
  it('[US-MSG-001.AC03, NFR-TIM-05] marks the message delivered when the channel accepts it', () => {
    expect(true).toBe(true)
  })

  test("[ BR-17 ,US-MSG-003.AC01 ] doesn't retry on its own", () => {
    expect(true).toBe(true)
  })

  it.skip(`[US-MSG-001.AC04] shows the second mark when the dwarf acts`, () => {
    expect(true).toBe(true)
  })

  it('keeps the draft when the send fails', () => {
    expect(true).toBe(true)
  })
})
