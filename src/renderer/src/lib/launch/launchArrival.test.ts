import { describe, expect, it } from 'vitest'
import { defaultDwarf, defaultMine } from '../../testing/factories'
import type { Dwarf, Mine } from '../../types'
import { launchedDwarfIn } from './launchArrival'

const PROMPT = 'dig the east gallery'

function dwarf(id: string, conversation?: Dwarf['conversation']): Dwarf {
  return defaultDwarf({
    id,
    name: id,
    sessionId: id,
    ...(conversation === undefined ? {} : { conversation })
  })
}

function held(id: string, first: string, role: 'user' | 'assistant' = 'user'): Dwarf {
  return dwarf(id, [{ role, text: first, timestamp: '2026-01-01T00:00:00Z' }])
}

function mine(dwarfs: Dwarf[]): Mine {
  return defaultMine({ id: 'mine-1', name: 'mine-1', path: '/work/mine-1', dwarfs })
}

describe('recognising the dwarf a launch just started', () => {
  /*
   * The launch verdict carries no dwarf id, and inventing one is the second
   * observation path #86 refuses. What it does leave behind is evidence: the
   * held registry seeds the new session's conversation with the exact prompt
   * that was sent, so the first message of a held exchange IS the receipt.
   */
  it('finds the dwarf whose held exchange opens with the prompt that was sent', () => {
    const found = launchedDwarfIn(mine([held('a', 'something else'), held('b', PROMPT)]), PROMPT)

    expect(found?.id).toBe('b')
  })

  it('recognises nobody in a mine that is not there', () => {
    expect(launchedDwarfIn(undefined, PROMPT)).toBeUndefined()
  })

  /*
   * Only a session this panel HOLDS carries a conversation at all, so an
   * observed session cannot be mistaken for a launch — which is the whole
   * reason this identifies by the held exchange rather than by "a dwarf that
   * was not here a moment ago".
   */
  it('never mistakes an observed session for the one it started', () => {
    expect(launchedDwarfIn(mine([dwarf('a')]), PROMPT)).toBeUndefined()
  })

  it('ignores a held session that opened with somebody else’s prompt', () => {
    expect(launchedDwarfIn(mine([held('a', 'shore the north wall')]), PROMPT)).toBeUndefined()
  })

  it('ignores a held session whose first word was the agent’s', () => {
    expect(launchedDwarfIn(mine([held('a', PROMPT, 'assistant')]), PROMPT)).toBeUndefined()
  })

  it('recognises nobody for a prompt of nothing, whatever is on the board', () => {
    expect(launchedDwarfIn(mine([held('a', '')]), '')).toBeUndefined()
  })

  /*
   * Two sessions started with identical prompts are indistinguishable by their
   * own evidence, so the tie breaks on id rather than on whatever order the
   * poll happened to list them in: the panel must not change its mind about
   * which dwarf it opened on between two snapshots.
   */
  it('breaks a tie on id rather than on the order the poll listed them', () => {
    const forwards = launchedDwarfIn(mine([held('b', PROMPT), held('a', PROMPT)]), PROMPT)
    const backwards = launchedDwarfIn(mine([held('a', PROMPT), held('b', PROMPT)]), PROMPT)

    expect(forwards?.id).toBe('a')
    expect(backwards?.id).toBe('a')
  })
})
