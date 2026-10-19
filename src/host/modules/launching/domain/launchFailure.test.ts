import { describe, expect, it } from 'vitest'
import {
  buildLaunchFailure,
  CAUSE_5_REASON_SENTENCE_PLACEHOLDER,
  NO_LAUNCHABLE_PROVIDER_SENTENCE,
  TOOL_OUTPUT_TAIL_MAX_CHARS
} from './launchFailure'

describe('buildLaunchFailure (ADR-020 items 1, 2, 6)', () => {
  it('[INV-55] the tool output tail is kept for exited-at-once and could-not-start only, trimmed to its last 400 characters', () => {
    const output = 'x'.repeat(100) + 'y'.repeat(TOOL_OUTPUT_TAIL_MAX_CHARS)

    for (const cause of ['exited-at-once', 'could-not-start'] as const) {
      const failure = buildLaunchFailure({ cause, supplierLabel: 'Codex', toolOutputTail: output })
      expect(failure.toolOutputTail).toBe('y'.repeat(400))
    }
    for (const cause of ['not-installed', 'jev-unreachable', 'jev-could-not-choose'] as const) {
      const failure = buildLaunchFailure({
        cause,
        supplierLabel: 'Codex',
        jevReason: 'timeout',
        toolOutputTail: output
      })
      expect(failure).not.toHaveProperty('toolOutputTail')
    }
  })

  it('[INV-52, S5.14, S5.15] each cause carries its actions, a Jev reason only for the Jev causes, and a reason sentence only for jev-could-not-choose', () => {
    expect(
      buildLaunchFailure({ cause: 'not-installed', supplierLabel: 'Codex', jevReason: 'timeout' })
    ).toEqual({ cause: 'not-installed', supplierLabel: 'Codex', actions: ['retry'] })
    expect(
      buildLaunchFailure({ cause: 'jev-unreachable', supplierLabel: 'Codex', jevReason: 'timeout' })
    ).toEqual({
      cause: 'jev-unreachable',
      supplierLabel: 'Codex',
      jevReason: 'timeout',
      actions: ['retry', 'pick-manually']
    })
    expect(
      buildLaunchFailure({
        cause: 'jev-could-not-choose',
        supplierLabel: 'Codex',
        jevReason: 'no-key'
      })
    ).toEqual({
      cause: 'jev-could-not-choose',
      supplierLabel: 'Codex',
      jevReason: 'no-key',
      // ⟦COPY NEEDED: S-020-2 cause-5 reason sentence⟧ — design owns the sentence per reason
      reasonSentence: CAUSE_5_REASON_SENTENCE_PLACEHOLDER,
      actions: ['pick-manually']
    })
    expect(
      buildLaunchFailure({
        cause: 'jev-could-not-choose',
        supplierLabel: 'The supplier',
        jevReason: 'no-launchable-provider'
      })
    ).toEqual({
      cause: 'jev-could-not-choose',
      supplierLabel: 'The supplier',
      jevReason: 'no-launchable-provider',
      reasonSentence: NO_LAUNCHABLE_PROVIDER_SENTENCE,
      actions: []
    })
  })
})
