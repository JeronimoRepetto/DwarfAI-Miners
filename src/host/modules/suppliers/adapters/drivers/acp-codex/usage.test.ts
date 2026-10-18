// L1 tests of the Codex acp usage normalisation (ADR-006 item 4), over the counts codex-acp 1.13.1
// reported in the recordings of fixtures/codex/acp/0.153.4/ (c-06: totalTokens 39756 = 809 + 38912
// + 35, so outputTokens already include the 28 thoughtTokens).
import { describe, expect, it } from 'vitest'
import { codexAcpUsage } from './usage'

describe('codexAcpUsage', () => {
  it('[ADR-006] output excludes the reasoning codex-acp counts inside outputTokens, as the app-server driver does', () => {
    expect(
      codexAcpUsage({
        totalTokens: 39756,
        inputTokens: 809,
        cachedReadTokens: 38912,
        outputTokens: 35,
        thoughtTokens: 28
      })
    ).toEqual({ inputNet: 809, output: 7, cacheRead: 38912, cacheWrite: 0, reasoning: 28 })
  })

  it('[ADR-006] a report without thoughtTokens keeps its output, and reasoning above output never goes negative', () => {
    expect(codexAcpUsage({ totalTokens: 10, inputTokens: 5, outputTokens: 5 })).toEqual({
      inputNet: 5,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0
    })
    expect(
      codexAcpUsage({ totalTokens: 9, inputTokens: 5, outputTokens: 4, thoughtTokens: 6 })
    ).toMatchObject({ output: 0, reasoning: 6 })
  })
})
