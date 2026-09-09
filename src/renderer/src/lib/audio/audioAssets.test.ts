import { describe, expect, it } from 'vitest'
import { UI_SFX_KINDS } from './volume'
import { AMBIENCE_SRC, DWARF_VOICE_SRC, MUSIC_TRACK_SRC, UI_SFX_SRC } from './audioAssets'

/**
 * The inventory itself, which nothing else checks (#323).
 *
 * Every import in `audioAssets.ts` is written out by hand rather than globbed,
 * so a renamed file fails the build — but a file added to the directory and
 * never imported, or imported twice under two names, fails nothing at all. The
 * playlist would simply be shorter than the directory, which is precisely the
 * failure nobody notices. These count and de-duplicate what is declared.
 */
describe('MUSIC_TRACK_SRC', () => {
  it('carries all eight tracks, each exactly once', () => {
    // Six on #174, two more from the same session on #323.
    expect(MUSIC_TRACK_SRC).toHaveLength(8)
    expect(new Set(MUSIC_TRACK_SRC).size).toBe(8)
  })

  it('resolves every track to something bundled', () => {
    for (const src of MUSIC_TRACK_SRC) expect(src).toBeTruthy()
  })
})

describe('UI_SFX_SRC', () => {
  it('names every interface sound the engine can ask for, and no more', () => {
    expect(Object.keys(UI_SFX_SRC).sort()).toEqual([...UI_SFX_KINDS].sort())
  })

  it('gives the click and the panel two different recordings', () => {
    expect(UI_SFX_SRC.click).not.toBe(UI_SFX_SRC.panel)
  })
})

describe('the other two inventories', () => {
  it('keeps a bed for each state and a voice for each rank, all distinct', () => {
    // Guarded here for the same reason as the tracks: `satisfies` proves each
    // key is present, never that two of them are not the same file.
    expect(new Set(Object.values(AMBIENCE_SRC)).size).toBe(2)
    expect(new Set(Object.values(DWARF_VOICE_SRC)).size).toBe(3)
  })
})
