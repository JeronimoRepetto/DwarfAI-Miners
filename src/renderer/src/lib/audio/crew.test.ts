import { describe, expect, it } from 'vitest'
import { CREW_CAPS, CREW_RELEASE_MS, crewVariantIndex } from './crew'

describe('the crew clip limits (#330)', () => {
  it('lets three crew clips sound at once and no more', () => {
    // A missing strike in a busy mine is inaudible; nine of them at once is a
    // rattle. Three is the maintainer's number.
    // AMENDED for ISSUE-255 (was: the single CREW_POLYPHONY of three): the caps are one count
    // per crew cue (sound.md, Mapping onto the engine), and three is the strikes' own.
    expect(CREW_CAPS.strike).toBe(3)
  })

  it('releases a sustained clip over 300ms, which is a fade and not a cut', () => {
    expect(CREW_RELEASE_MS).toBe(300)
  })
})

describe('crewVariantIndex (#330)', () => {
  it('gives the same dwarf the same variant every time it is asked', () => {
    // The point of the whole function: a dwarf that walked in on one pair of
    // boots must leave in the same pair, and the answer has to survive the
    // walk that happens minutes later with nothing remembered in between.
    for (const id of ['d1', 'agent-7', 'sess-abcdef0123', '']) {
      expect(crewVariantIndex(id, 2), id).toBe(crewVariantIndex(id, 2))
    }
  })

  it('answers inside the range it was given', () => {
    for (let n = 1; n <= 5; n++) {
      for (const id of ['a', 'b', 'c', 'dwarf-42', 'x'.repeat(64)]) {
        const index = crewVariantIndex(id, n)
        expect(index, `${id}/${n}`).toBeGreaterThanOrEqual(0)
        expect(index, `${id}/${n}`).toBeLessThan(n)
      }
    }
  })

  it('answers 0 for a cue with one recording, or none at all', () => {
    // Every cue is picked the same way, so a cue with a single variant has to
    // give the same answer for every dwarf rather than a special case above.
    expect(crewVariantIndex('anything', 1)).toBe(0)
    expect(crewVariantIndex('anything', 0)).toBe(0)
    expect(crewVariantIndex('anything', -1)).toBe(0)
  })

  it('actually reaches both footstep variants across a crew', () => {
    // A hash that always answered 0 would be stable and useless. Nine ids is
    // a full mine, and both recordings have to be worn by somebody in it.
    const ids = Array.from({ length: 9 }, (_, index) => `dwarf-${index}`)
    const picked = new Set(ids.map((id) => crewVariantIndex(id, 2)))
    expect(picked).toEqual(new Set([0, 1]))
  })

  it('does not simply follow the id in order, which would pair up the crew', () => {
    // Session ids arrive in bursts of near-identical strings, so "the last
    // character modulo two" would give a whole mine one pair of boots and its
    // neighbour the other. Two ids one character apart must be free to differ.
    const runs = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((id) => crewVariantIndex(id, 2))
    expect(new Set(runs).size).toBe(2)
  })
})

// APPENDED for ISSUE-255 (sound.md, Mapping onto the engine; PO ruling 2026-09-26): the single cap of
// three crew clips is one count per crew cue now.
describe('the crew caps per cue (ISSUE-255)', () => {
  it('[NFR-SND-01] caps each crew cue on its own: 3 pick strikes, 2 worker2 grinds and 2 walks', () => {
    expect(CREW_CAPS).toEqual({ strike: 3, shift: 2, walk: 2 })
  })
})
