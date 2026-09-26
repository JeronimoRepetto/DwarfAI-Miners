import { describe, expect, it } from 'vitest'
import { DWARF_CREW } from '../sprite/dwarfSheets'
import { UI_SFX_KINDS } from './volume'
import {
  AMBIENCE_SRC,
  CREW_SFX_SRC,
  DWARF_VOICE_SRC,
  MUSIC_TRACK_SRC,
  UI_SFX_SRC
} from './audioAssets'

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
  /*
   * AMENDED for #330: it asserted two beds. The `working` bed is retired — the
   * crew makes the mine's noise itself now — so there is one room tone. The
   * retired file stayed on disk unimported until #637 deleted it; the claim is
   * unchanged in kind: every declared bed resolves to a file of its own.
   */
  it('keeps a bed for each state and a voice for each rank, all distinct', () => {
    // Guarded here for the same reason as the tracks: `satisfies` proves each
    // key is present, never that two of them are not the same file.
    expect(new Set(Object.values(AMBIENCE_SRC)).size).toBe(1)
    expect(new Set(Object.values(DWARF_VOICE_SRC)).size).toBe(3)
  })
})

describe('CREW_SFX_SRC (#330)', () => {
  it('has a recording for every cue a rank declares, and for no other', () => {
    /*
     * The cross-check that matters, and neither side can make it alone: a cue
     * declared with no recording behind it fires into silence that nobody
     * notices, and a recording for a cue no rank declares is a file that never
     * plays. `dwarfSheets.ts` says when a rank sounds; this says what with.
     */
    for (const role of ['worker', 'worker2', 'foreman'] as const) {
      const declared = DWARF_CREW[role].sound ?? {}
      const named = CREW_SFX_SRC[role]
      expect(Object.keys(named).sort(), role).toEqual(Object.keys(declared).sort())
      for (const [cue, variants] of Object.entries(named)) {
        expect((variants ?? []).length, `${role}/${cue}`).toBeGreaterThan(0)
        for (const src of variants ?? []) expect(src, `${role}/${cue}`).toBeTruthy()
      }
    }
  })

  it('gives the worker a pick and the worker2 its hands, and they are not the same sound', () => {
    expect(CREW_SFX_SRC.worker.strike).toHaveLength(1)
    expect(CREW_SFX_SRC.worker2.shift).toHaveLength(1)
    expect(CREW_SFX_SRC.worker.strike![0]).not.toBe(CREW_SFX_SRC.worker2.shift![0])
  })

  /*
   * AMENDED for #637. This was `offers two footstep recordings, shared by every
   * rank that walks` and expected a PAIR: two long walk recordings, one worn per
   * dwarf. Both carried a third-party copyright tag and are gone; the walk is one
   * seamless loop now, played for as long as the dwarf walks (see the looping
   * cases in engine.test.ts). The claim that survives is the sharing: one walk,
   * the same for the whole crew.
   */
  it('offers one footstep loop, shared by every rank that walks', () => {
    expect(CREW_SFX_SRC.worker.walk).toHaveLength(1)
    for (const role of ['worker2', 'foreman'] as const) {
      expect(CREW_SFX_SRC[role].walk, role).toEqual(CREW_SFX_SRC.worker.walk)
    }
  })

  /*
   * AMENDED for #637: it counted four files, the two walks among them. With the
   * walk a single loop there are three — one per cue — and the claim is
   * unchanged: no recording answers two different cues.
   */
  it('shares no recording between two different cues', () => {
    // Three files for three cues across three ranks; hearing a pick where the
    // footsteps should be is the failure an explicit import cannot catch.
    const all = Object.values(CREW_SFX_SRC).flatMap((byCue) =>
      Object.values(byCue).flatMap((variants) => [...(variants ?? [])])
    )
    expect(new Set(all).size).toBe(3)
  })
})
