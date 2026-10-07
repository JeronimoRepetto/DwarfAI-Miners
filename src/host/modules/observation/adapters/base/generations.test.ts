// L1 (17 §1.1): the session identity of a record of a Codex or OpenCode session that can be resumed
// under its own id (owner amendment I; owner decision B, 2026-10-05, as 07 S4.41): derived from the
// provider's store (its record times) and the ended-agents ledger alone, so a Host restart derives
// the same identity, and an ended identity never receives a record again (INV-36).
import { describe, expect, it } from 'vitest'
import { RESUME_GAP_MS, RecordTimeline, generationAt, resumedSessionIdOf } from './generations'

const T0 = 1_790_900_000_000
const MIN = 60_000

describe('generationAt', () => {
  const m1 = T0 + 30 * MIN
  const m2 = T0 + 120 * MIN
  const markers = [m1, m2]
  const endedSet =
    (...ids: string[]) =>
    (id: string) =>
      ids.includes(id)

  it('[S4.41, INV-36] a session that never ended keeps its own id across every quiet gap: an idle live session is not resumed', () => {
    expect(generationAt('thread', markers, T0, endedSet())).toBe('thread')
    expect(generationAt('thread', markers, m2 + MIN, endedSet())).toBe('thread')
  })

  it('[S4.41, FM-145, INV-36] the records after the first gap that follows an ended identity belong to a new generation, and the ended one never gets a record again', () => {
    const ended = endedSet('thread')

    expect(generationAt('thread', markers, m1 - 1, ended)).toBe('thread')
    expect(generationAt('thread', markers, m1, ended)).toBe(resumedSessionIdOf('thread', m1))
    // An idle gap inside the live resumed session does not resume it again.
    expect(generationAt('thread', markers, m2 + MIN, ended)).toBe(resumedSessionIdOf('thread', m1))

    const both = endedSet('thread', resumedSessionIdOf('thread', m1))
    expect(generationAt('thread', markers, m2 + MIN, both)).toBe(resumedSessionIdOf('thread', m2))
  })

  it('[ADR-015, S4.41] the generation identity is `<id>~resumed-<epoch seconds>`, the shape Antigravity uses', () => {
    expect(resumedSessionIdOf('ses_1', Date.parse('2026-10-07T10:00:00.900Z'))).toBe(
      'ses_1~resumed-1791367200'
    )
  })
})

describe('RecordTimeline', () => {
  it('[S4.41] a marker is a record that follows the previous one by at least the quiet gate, whatever order the records arrive in', () => {
    const timeline = new RecordTimeline()
    for (const at of [T0, T0 + MIN, T0 + MIN + RESUME_GAP_MS - 1, T0 + 40 * MIN, T0 + MIN]) {
      timeline.add(at)
    }
    timeline.add(T0 + 20 * MIN)

    expect(timeline.markers()).toEqual([T0 + 20 * MIN, T0 + 40 * MIN])
    expect(timeline.newest()).toBe(T0 + 40 * MIN)
    expect(new RecordTimeline().newest()).toBe(null)
  })
})
