import { describe, expect, it } from 'vitest'
import { defaultProject } from '../../testing/factories'
import type { Mine, MineTier, ProjectSummary } from '../../types'
import { createBrowseRefresh } from './browseRefresh'

/*
 * AMENDED for AMENDMENT-26 (owner-approved 2026-10-23; was: the board's `Mine.weightBytes` against the row's
 * `weightBytes`, a pair no Host wire carries). The board's reading is its `score` (`MineWire.score`) with the tier it
 * measured; the list row carries the tier only (`mines.list`, 14 B-M19). So the list is behind where the board
 * measured a tier the row does not show, and each reading is asked for once. Same cases, same answers.
 */
const mine = (id: string, kb?: number, tier: MineTier = 'bronze'): Mine => ({
  id,
  path: id,
  name: id,
  tier,
  dwarfs: [],
  tokensObserved: 0,
  updatedAt: 0,
  ...(kb === undefined ? {} : { score: { kb, nextTierKb: 350 } })
})

const row = (id: string, knownTier?: MineTier): ProjectSummary =>
  defaultProject({ id, path: id, name: id, ...(knownTier === undefined ? {} : { knownTier }) })

describe('createBrowseRefresh', () => {
  it('asks again when a walk the list is still waiting on has answered on the board', () => {
    expect(createBrowseRefresh().due([mine('a', 2)], [row('a')])).toBe(true)
  })

  it('asks again when the board measured a different tier than the list shows', () => {
    // A re-measure that moved the tier, or a folder that emptied: both are a new reading.
    expect(createBrowseRefresh().due([mine('a', 400, 'copper')], [row('a', 'bronze')])).toBe(true)
    expect(createBrowseRefresh().due([mine('a', 0, 'bronze')], [row('a', 'silver')])).toBe(true)
  })

  it('asks nothing while the list and the board agree', () => {
    expect(
      createBrowseRefresh().due([mine('a', 2), mine('b')], [row('a', 'bronze'), row('b')])
    ).toBe(false)
  })

  it('asks nothing for a board mine the list has no row for, which it draws off the board', () => {
    expect(createBrowseRefresh().due([mine('a', 2)], [])).toBe(false)
  })

  it('asks nothing where the board has no reading the list lacks', () => {
    expect(createBrowseRefresh().due([mine('a')], [row('a', 'bronze')])).toBe(false)
  })

  it('asks once per reading, so a list that never catches up is not re-read on every poll', () => {
    const refresh = createBrowseRefresh()
    expect(refresh.due([mine('a', 2)], [row('a')])).toBe(true)
    expect(refresh.due([mine('a', 2)], [row('a')])).toBe(false)
    expect(refresh.due([mine('a', 4)], [row('a')])).toBe(true)
  })

  it('answers a burst of readings with one re-read', () => {
    const refresh = createBrowseRefresh()
    expect(refresh.due([mine('a', 1), mine('b', 2)], [row('a'), row('b')])).toBe(true)
    expect(refresh.due([mine('a', 1), mine('b', 2)], [row('a'), row('b')])).toBe(false)
  })
})
