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

/*
 * The second receipt (#191). A DETACHED launch leaves no held conversation, so
 * for a long time nothing on the board could be matched to one and the panel
 * never handed over. Its evidence is the session's own transcript, whose first
 * human turn is the prompt that was sent — but that match runs in MAIN, where
 * both strings are raw and neither has to survive a trip through the wire's
 * redaction. What reaches here is main's verdict: the receipt it opened for
 * this launch, stamped on the dwarf it proved.
 */
const RECEIPT = 'receipt:1'

function launched(id: string, launchId?: string): Dwarf {
  return defaultDwarf({
    id,
    name: id,
    sessionId: id,
    ...(launchId === undefined ? {} : { launchId })
  })
}

describe('recognising the dwarf a detached launch became', () => {
  it('finds the dwarf main stamped with this launch’s own receipt', () => {
    const found = launchedDwarfIn(mine([launched('a'), launched('b', RECEIPT)]), PROMPT, RECEIPT)

    expect(found?.id).toBe('b')
  })

  it('ignores a dwarf carrying another launch’s receipt', () => {
    expect(launchedDwarfIn(mine([launched('a', 'receipt:2')]), PROMPT, RECEIPT)).toBeUndefined()
  })

  /*
   * The words are not the receipt here, and that is the whole distinction. A
   * detached session's conversation is not something this app can read on the
   * wire at all, so a dwarf whose words happen to match proves nothing — only
   * main's own verdict does.
   */
  it('never adopts on words alone once a receipt is what it is waiting for', () => {
    expect(launchedDwarfIn(mine([held('a', PROMPT)]), PROMPT, RECEIPT)).toBeUndefined()
  })

  /*
   * A session that finished before the poll first drew it is exactly the case
   * this half of #191 exists to serve: the reply is already written, and the
   * panel opens on the ended state with it visible.
   */
  it('adopts a dwarf whose session has already ended', () => {
    const ended = { ...launched('a', RECEIPT), status: 'leaving' as const }

    expect(launchedDwarfIn(mine([ended]), PROMPT, RECEIPT)?.id).toBe('a')
  })

  /*
   * Two dwarfs cannot honestly carry one receipt — main claims exactly one
   * session per launch — but if a board ever showed both, the answer must not
   * depend on the order the poll listed them in. Same tie, same rule.
   */
  it('breaks a tie on id, exactly as the held receipt does', () => {
    const forwards = launchedDwarfIn(
      mine([launched('b', RECEIPT), launched('a', RECEIPT)]),
      PROMPT,
      RECEIPT
    )
    const backwards = launchedDwarfIn(
      mine([launched('a', RECEIPT), launched('b', RECEIPT)]),
      PROMPT,
      RECEIPT
    )

    expect(forwards?.id).toBe('a')
    expect(backwards?.id).toBe('a')
  })

  it('recognises nobody in a mine that is not there', () => {
    expect(launchedDwarfIn(undefined, PROMPT, RECEIPT)).toBeUndefined()
  })
})
