import { describe, expect, it } from 'vitest'
import {
  NATIVE_SUBAGENT_FALLBACK_SENTENCE,
  producesParentLine,
  toolFailure,
  type ToolFailureSource
} from './toolFailure'

// 16 §5.4 "Domain failure → tool failure kind", as written: the 06 failure (or a refusal that
// creates no delegation), its tool `failure.kind` (null: no tool result exists), and whether the
// parent's chat gets the PO #45 line.
const TABLE_16_5_4: ReadonlyArray<{
  source: ToolFailureSource
  kind: string | null
  parentLine: boolean
}> = [
  { source: 'gate-closed', kind: 'disabled', parentLine: true },
  { source: 'jev-unreachable', kind: 'jev-unreachable', parentLine: true },
  { source: 'jev-could-not-choose', kind: 'jev-unsure', parentLine: true },
  { source: 'no-provider', kind: 'provider-not-launchable', parentLine: true },
  { source: 'worker-failed', kind: 'launch-failed', parentLine: true },
  { source: 'worker-lost', kind: 'launch-failed', parentLine: true },
  { source: 'handoff-failed', kind: null, parentLine: true },
  { source: 'parent-gone', kind: null, parentLine: false },
  { source: 'concurrency-limit', kind: 'concurrency-limit', parentLine: false },
  { source: 'depth-exceeded', kind: 'depth-exceeded', parentLine: false },
  { source: 'unknown-ticket', kind: 'unknown-ticket', parentLine: false }
]

describe('toolFailure', () => {
  it('[ADR-013] every failure maps to its tool kind and every detail ends with the fallback sentence; parent-gone and the limits produce no parent line', () => {
    expect(NATIVE_SUBAGENT_FALLBACK_SENTENCE).toBe(
      'Use your own native subagent mechanism for this subtask instead.'
    )
    for (const row of TABLE_16_5_4) {
      const withoutReason = toolFailure(row.source)
      const withReason = toolFailure(row.source, 'The reason from the caller.')
      expect(withoutReason?.kind ?? null, row.source).toBe(row.kind)
      expect(withReason?.kind ?? null, row.source).toBe(row.kind)
      if (withoutReason !== null && withReason !== null) {
        expect(withoutReason.detail, row.source).toBe(NATIVE_SUBAGENT_FALLBACK_SENTENCE)
        expect(withReason.detail, row.source).toBe(
          `The reason from the caller. ${NATIVE_SUBAGENT_FALLBACK_SENTENCE}`
        )
      }
      expect(producesParentLine(row.source), row.source).toBe(row.parentLine)
    }
    // A reason with space around it is trimmed, so one space precedes the sentence.
    expect(toolFailure('gate-closed', '  Off.  ')?.detail).toBe(
      `Off. ${NATIVE_SUBAGENT_FALLBACK_SENTENCE}`
    )
  })
})
