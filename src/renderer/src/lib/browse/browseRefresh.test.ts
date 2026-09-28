import { describe, expect, it } from 'vitest'
import { defaultProject } from '../../testing/factories'
import type { Mine, ProjectSummary } from '../../types'
import { createBrowseRefresh } from './browseRefresh'

const mine = (id: string, weightBytes?: number): Mine => ({
  id,
  path: id,
  name: id,
  tier: 'bronze',
  dwarfs: [],
  tokensObserved: 0,
  updatedAt: 0,
  ...(weightBytes === undefined ? {} : { weightBytes })
})

const row = (id: string, weightBytes?: number): ProjectSummary =>
  defaultProject({ id, path: id, name: id, ...(weightBytes === undefined ? {} : { weightBytes }) })

describe('createBrowseRefresh', () => {
  it('asks again when a walk the list is still waiting on has answered on the board', () => {
    expect(createBrowseRefresh().due([mine('a', 2048)], [row('a')])).toBe(true)
  })

  it('asks again when the board measured a different weight than the list shows', () => {
    // A re-measure that moved the score, or a folder that emptied: both are a new reading.
    expect(createBrowseRefresh().due([mine('a', 0)], [row('a', 4096)])).toBe(true)
  })

  it('asks nothing while the list and the board agree', () => {
    expect(
      createBrowseRefresh().due([mine('a', 2048), mine('b')], [row('a', 2048), row('b')])
    ).toBe(false)
  })

  it('asks nothing for a board mine the list has no row for, which it draws off the board', () => {
    expect(createBrowseRefresh().due([mine('a', 2048)], [])).toBe(false)
  })

  it('asks nothing where the board has no reading the list lacks', () => {
    expect(createBrowseRefresh().due([mine('a')], [row('a', 2048)])).toBe(false)
  })

  it('asks once per reading, so a list that never catches up is not re-read on every poll', () => {
    const refresh = createBrowseRefresh()
    expect(refresh.due([mine('a', 2048)], [row('a')])).toBe(true)
    expect(refresh.due([mine('a', 2048)], [row('a')])).toBe(false)
    expect(refresh.due([mine('a', 4096)], [row('a')])).toBe(true)
  })

  it('answers a burst of readings with one re-read', () => {
    const refresh = createBrowseRefresh()
    expect(refresh.due([mine('a', 1), mine('b', 2)], [row('a'), row('b')])).toBe(true)
    expect(refresh.due([mine('a', 1), mine('b', 2)], [row('a'), row('b')])).toBe(false)
  })
})
