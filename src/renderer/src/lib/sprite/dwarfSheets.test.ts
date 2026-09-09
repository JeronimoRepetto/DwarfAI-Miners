import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { DwarfRole } from '../../types'
import { DWARF_CREW, DWARF_SHEETS } from './dwarfSheets'
import { SPRITE_FRAME_SIZE, type SpriteSheet } from './spriteSheet'

// Amended by #157: 'worker2' joined DwarfRole, and a hand-written list is
// exactly the kind that stops covering a rank without anything going red.
const ROLES: readonly DwarfRole[] = ['worker', 'foreman', 'worker2']

/**
 * The repository root. A png import resolves to a root-relative path in the
 * test environment ("/src/renderer/src/assets/..."), so joining the two reaches
 * the committed file itself.
 */
const REPO_ROOT = new URL('../../../../../', import.meta.url)

/**
 * The pixel size in a PNG's IHDR chunk, which is the first thing after the
 * 8-byte signature and always at the same two offsets.
 */
function pngSize(src: string): { width: number; height: number } {
  const path = fileURLToPath(new URL(`.${src}`, REPO_ROOT))
  const bytes = readFileSync(path)
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** Every sheet in the inventory, with a name to fail under. */
function everySheet(): { where: string; sheet: SpriteSheet }[] {
  return ROLES.flatMap((role) =>
    Object.entries(DWARF_SHEETS[role]).map(([name, sheet]) => ({
      where: `${role}/${name}`,
      sheet: sheet as SpriteSheet
    }))
  )
}

/*
 * These read the committed PNGs off the disk, which is the one thing the rest
 * of the suite is careful never to do. It earns the exception: a frame count is
 * a claim ABOUT the bytes, and nothing else in the app can notice when the two
 * disagree. A sheet declared one frame short shears every frame of the
 * animation sideways and still renders — no error, no broken image, just a
 * dwarf sliced in half — which is exactly the failure a build-time explicit
 * import cannot catch (see art.ts).
 */
describe('DWARF_SHEETS against the committed art', () => {
  it('declares the frame count the strip actually holds', () => {
    for (const { where, sheet } of everySheet()) {
      const { width } = pngSize(sheet.src)
      expect(width / SPRITE_FRAME_SIZE.width, where).toBe(sheet.frames)
    }
  })

  it('is drawn in the frame box every other measurement is derived from', () => {
    for (const { where, sheet } of everySheet()) {
      const { width, height } = pngSize(sheet.src)
      expect(height, where).toBe(SPRITE_FRAME_SIZE.height)
      expect(width % SPRITE_FRAME_SIZE.width, where).toBe(0)
    }
  })

  it('corrects the design source, which states a smaller box than was drawn', () => {
    /*
     * foundations.md says the dwarf sprite is 34x36. Every sheet the maintainer
     * actually drew is 38 tall and a whole number of 36s wide. The art is the
     * answer; the document is the stale copy.
     *
     * AMENDED by #211, which caught this test resting on a coincidence. It used
     * to assert `width % 34 !== 0` for every sheet on the claim that "34 divides
     * none of them" — true of the eleven sheets that existed when it was
     * written, and false the moment the worker2's end-working strip landed: 612
     * is 34 x 18 exactly, as well as the 36 x 17 it actually is. The strip is
     * fine and its 17 frames are confirmed by its own preview GIF; the
     * ARGUMENT was the weak part, since nothing stops a multiple of 36 also
     * being a multiple of 34.
     *
     * So the claim is now tested as the CONJUNCTION the design source actually
     * states — a 34x36 box — rather than as two independent halves. No sheet is
     * consistent with that box, and the height is what rules it out every time,
     * which is the half that was load-bearing all along.
     */
    for (const { where, sheet } of everySheet()) {
      const { width, height } = pngSize(sheet.src)
      expect(height, where).not.toBe(36)
      expect({ where, fitsDesignBox: height === 36 && width % 34 === 0 }).toEqual({
        where,
        fitsDesignBox: false
      })
    }
  })
})

describe('DWARF_SHEETS', () => {
  /*
   * The fallback rule, expressed as a type and pinned here: `idle` is the one
   * sheet every role is required to have, and anything a role has not been
   * drawn resolves to it. That is what lets the inventory stay honest about
   * missing art instead of substituting another role's.
   */
  it('gives every rank an idle loop, which is what everything else falls back to', () => {
    for (const role of ROLES) {
      expect(DWARF_SHEETS[role].idle.frames, role).toBeGreaterThan(1)
    }
  })

  it('gives each rank its own drawing rather than sharing one', () => {
    // The foreman walked like a miner because WALK_ANIMATION was a single
    // shared constant (#74). A per-role record is what dissolves that, so the
    // ranks having distinct art is the property worth holding.
    expect(DWARF_SHEETS.foreman.idle.src).not.toBe(DWARF_SHEETS.worker.idle.src)
    // #157's art update superseded the interim "worker2 reuses the worker's
    // sheets": it idles in its OWN skin from day one, and this is what stops a
    // future edit quietly pointing it back at the worker's strip.
    expect(DWARF_SHEETS.worker2.idle.src).not.toBe(DWARF_SHEETS.worker.idle.src)
    expect(DWARF_SHEETS.worker2.idle.src).not.toBe(DWARF_SHEETS.foreman.idle.src)
  })

  describe('the worker2 (#157)', () => {
    /*
     * AMENDED by #211, which is the arrival the version below predicted in so
     * many words: "when the working strip arrives THIS is the expectation that
     * changes, and the sequence picks it up as data with no branch moving." It
     * asserted `Object.keys(DWARF_SHEETS.worker2)` was `['idle']` alone and
     * nothing else drawn yet. The working triad has now been drawn, so the
     * inventory is the four sheets below; the six-frame idle assertion is kept
     * verbatim, and no branch did have to move.
     */
    it('has its own six-frame idle, and now its own working triad too (#211)', () => {
      expect(Object.keys(DWARF_SHEETS.worker2)).toEqual([
        'idle',
        'start-working',
        'working',
        'end-working'
      ])
      expect(DWARF_SHEETS.worker2.idle.frames).toBe(6)
    })

    /*
     * AMENDED by #211 for the same reason, and narrowed rather than dropped.
     * The version below ran over ['working', 'start-working', 'end-working',
     * 'sleeping']; the first three are now drawn, so asserting them undefined
     * would be asserting the art had not arrived. `sleeping` is what is still
     * undrawn for this rank, and the fallback rule it proves — a worker2 uses
     * its OWN idle, never the worker's or the foreman's art — is unchanged and
     * is still the whole point of the test.
     */
    it('falls back to its own idle for every state it has no sheet for', () => {
      // The engine's rule, spent here on the rank that needs it most. Borrowing
      // across ranks is how the foreman ended up walking like a miner (#74).
      for (const name of ['sleeping', 'start-sleep', 'end-sleep'] as const) {
        expect(DWARF_SHEETS.worker2[name], name).toBeUndefined()
      }
    })
  })

  it('plays every sheet at the tempo its own preview GIF was exported at', () => {
    // 100ms a frame, read out of the Graphic Control Extension of every GIF
    // beside the sheets — uniform across all of them, transitions included.
    // The cadence is the artist's, not a number chosen here.
    for (const { where, sheet } of everySheet()) {
      expect(sheet.frameMs, where).toBe(100)
    }
  })

  describe('the foreman falling asleep', () => {
    it('has a start, a loop and an end, which is what makes it a transition', () => {
      expect(DWARF_SHEETS.foreman['start-sleep']?.frames).toBe(8)
      expect(DWARF_SHEETS.foreman.sleeping?.frames).toBe(12)
      expect(DWARF_SHEETS.foreman['end-sleep']?.frames).toBe(11)
    })

    it('adds up to the sleep preview, which was exported as one animation', () => {
      // The GIF beside the three sheets holds 31 frames: 8 + 12 + 11. That the
      // parts sum to the whole is the evidence they are one movement and were
      // meant to be played in that order.
      const parts = ['start-sleep', 'sleeping', 'end-sleep'] as const
      const total = parts.reduce((sum, name) => sum + (DWARF_SHEETS.foreman[name]?.frames ?? 0), 0)
      expect(total).toBe(31)
    })
  })

  describe('the worker starting to work', () => {
    it('has a start, a loop and an end, which is what makes it a transition', () => {
      expect(DWARF_SHEETS.worker['start-working']?.frames).toBe(3)
      // 13 since the loop was redrawn with a longer recovery (2026-09-05); the
      // header test above is what holds this to the bytes on disk.
      expect(DWARF_SHEETS.worker.working?.frames).toBe(13)
      expect(DWARF_SHEETS.worker['end-working']?.frames).toBe(6)
    })

    // No "adds up to the preview" pin here, unlike the foreman's sleep above:
    // dwarf-worker-working-v2.gif's Graphic Control Extension blocks measure
    // 60 frames at a uniform 100ms, not 3 + 13 + 6 = 22 — the preview loops
    // the swing several times to show it repeating rather than encoding the
    // three parts once each, so frame count is not evidence of ordering here.
  })

  describe('the worker2 starting to work (#211)', () => {
    it('has a start, a loop and an end, which is what makes it a transition', () => {
      // Read off the three PNGs' IHDR widths against the 36px cell: 576/36,
      // 360/36 and 612/36, all exact. The counts are longer than the worker's
      // 3/11/6 throughout and that is the art, not a mistake — this rank was
      // drawn with a slower pick-up and a much longer set-down.
      expect(DWARF_SHEETS.worker2['start-working']?.frames).toBe(16)
      expect(DWARF_SHEETS.worker2.working?.frames).toBe(10)
      expect(DWARF_SHEETS.worker2['end-working']?.frames).toBe(17)
    })

    it('adds up to the working preview, which encodes start, four swings and end', () => {
      /*
       * The evidence that these three are one movement and are meant to be
       * played in this order — the shape the foreman's sleep pin uses, and
       * available here in a way it was NOT for the worker.
       * dwarf-worker2-working-v2.gif's Graphic Control Extension blocks measure
       * 73 frames, and 73 is exactly 16 + (10 x 4) + 17: the preview
       * concatenates the pick-up, four turns of the swing, and the set-down.
       * The worker's own preview has no such decomposition (60 frames against
       * 3/11/6), which is why that pin is absent above and present here.
       */
      const start = DWARF_SHEETS.worker2['start-working']?.frames ?? 0
      const loop = DWARF_SHEETS.worker2.working?.frames ?? 0
      const end = DWARF_SHEETS.worker2['end-working']?.frames ?? 0
      expect(start + loop * 4 + end).toBe(73)
    })

    it('is drawn in the same cell as its own idle, so it cannot change size mid-swing', () => {
      /*
       * The scale question #211 raised, answered at the asset. The issue read
       * the worker2's idle as 180x190 against 38-tall working strips and
       * expected a size jump; 180x190 is the PREVIEW GIF's logical screen (one
       * 36x38 cell at 5x), and the worker's own preview is 180x190 too. The
       * committed idle SHEET is 216x38 — six cells of exactly the same 36x38
       * box the new strips use.
       *
       * Sheet pixels never reach the drawn size anyway (see the DwarfSprite
       * pin), so this holds the stronger property: the same cell means the same
       * pixel density as well as the same box, which is what makes the swap
       * invisible rather than merely the right size.
       */
      const idle = pngSize(DWARF_SHEETS.worker2.idle.src)
      for (const name of ['start-working', 'working', 'end-working'] as const) {
        const sheet = DWARF_SHEETS.worker2[name]
        expect(sheet, name).toBeDefined()
        const { width, height } = pngSize(sheet!.src)
        expect(height, name).toBe(idle.height)
        expect(width / (sheet!.frames || 1), name).toBe(
          idle.width / DWARF_SHEETS.worker2.idle.frames
        )
      }
    })

    it('names no impact or glow frame on any strip, because it carries no pick', () => {
      /*
       * A SETTLED DECISION, pinned so it is not re-opened as an oversight —
       * maintainer ruling on #211. The worker's loop declares impactFrames [4]
       * and glowFrames [4, 5] because its swing lands a pick strike that bites
       * the rock; the worker2 carries no pick and its animation has no strike,
       * so there is no frame for either field to name and no frame map coming.
       * Nothing is owed here. What would break this test is somebody picking a
       * frame by eye, which is exactly what it is here to stop.
       */
      for (const name of ['idle', 'start-working', 'working', 'end-working'] as const) {
        expect(DWARF_SHEETS.worker2[name]?.impactFrames, name).toBeUndefined()
        expect(DWARF_SHEETS.worker2[name]?.glowFrames, name).toBeUndefined()
      }
    })
  })

  /*
   * What has NOT been drawn, stated out loud so that nobody has to infer it
   * from an absence. #74 delivers waiting and walking art later; when it
   * lands this expectation is the one that changes, and the sequence picks
   * the new sheets up as data.
   */
  it('has working art for a worker now, but still no waiting or walking art (#74)', () => {
    expect(Object.keys(DWARF_SHEETS.worker)).toEqual([
      'idle',
      'start-working',
      'working',
      'end-working'
    ])
  })

  /*
   * The strike is now picked (#74), so the blanket "no sheet claims one" this
   * replaces is no longer true of `worker/working` — it stayed true of every
   * OTHER sheet, which the tests below still pin.
   */
  describe('the worker striking the rock', () => {
    it("declares the strike at the artist's frame 5, converted to index 4", () => {
      // The maintainer's own frame map is 1-indexed off the preview GIF; every
      // index in this codebase is 0-indexed, so frame 5 (the swing landing,
      // first spark centered on the pick's tip) becomes index 4. Sparks fire
      // off exactly this one frame and nowhere else — the pre-migration
      // `isPickImpact` this restores marked only the down-stroke a hit,
      // warning that more would read as "a permanent glow ... rather than
      // impacts" (see presentation.ts before #87's sheet migration).
      expect(DWARF_SHEETS.worker.working?.impactFrames).toEqual([4])
    })

    it("glows only the artist's two brightest frames, 5-6 (index 4-5), never the dispersal", () => {
      // Frames 7-9 (index 6-8) disperse and fade in the art alone (maintainer's
      // design call) — a separate declaration from impactFrames above,
      // because retriggering the debris burst across all five spark frames
      // is exactly the "permanent glow" the old single-hit comment warned
      // against, not a light on the strike.
      expect(DWARF_SHEETS.worker.working?.glowFrames).toEqual([4, 5])
    })
  })

  it('leaves the foreman untouched — he has no swing to glow or spark', () => {
    for (const name of Object.keys(DWARF_SHEETS.foreman) as (keyof typeof DWARF_SHEETS.foreman)[]) {
      const sheet = DWARF_SHEETS.foreman[name]
      expect(sheet?.impactFrames, name).toBeUndefined()
      expect(sheet?.glowFrames, name).toBeUndefined()
    }
  })

  it('claims no impact or glow frame on any other worker sheet either', () => {
    // An idle, start-working or end-working sheet that claimed one would
    // throw debris (or glow) off a dwarf standing still, mid pick-up, or
    // setting the pick back down.
    for (const { where, sheet } of everySheet()) {
      if (where === 'worker/working') continue
      expect(sheet.impactFrames, where).toBeUndefined()
      expect(sheet.glowFrames, where).toBeUndefined()
    }
  })
})

/*
 * The rank's shift and its own sounds (#325's count, #330's cues), which are
 * declarations about the art rather than about the bytes — so unlike the frame
 * counts above, nothing on disk can be read to confirm them. What CAN be held
 * is their arithmetic against the counts, and that is most of this block: the
 * grind recording is 8.53 s long and the numbers have to add up to it.
 */
describe('DWARF_CREW (#330)', () => {
  it('swings the worker twice a shift and the worker2 eight times', () => {
    // Not a taste: the worker2's grind is one 8.53 s recording of the whole
    // movement, and it is asked to start 200 ms before the first swing and to
    // die out three frames into the set-down. Eight swings is the only count
    // that fits between the two.
    expect(DWARF_CREW.worker.swings).toBe(2)
    expect(DWARF_CREW.worker2.swings).toBe(8)
  })

  it('declares no count for the foreman, who has no swing to repeat', () => {
    expect(DWARF_CREW.foreman.swings).toBeUndefined()
  })

  it('sounds the worker on the frames its own sheet already calls impacts', () => {
    // A pointer at the sheet rather than a second copy of frame 4: the strike
    // and its sparks are one event, so the two must not be able to drift.
    expect(DWARF_CREW.worker.sound?.strike).toEqual({ on: 'impactFrames' })
    expect(DWARF_CREW.worker.sound?.shift).toBeUndefined()
  })

  it("starts the worker2's grind 200ms before its first swing, at frame 14 of 16", () => {
    expect(DWARF_CREW.worker2.sound?.shift).toEqual({ sheet: 'start-working', frame: 14 })
    // The worker2 has no strike to name and never will (#211): it carries no
    // pick, which is why its whole shift is one sound instead of a hit.
    expect(DWARF_CREW.worker2.sound?.strike).toBeUndefined()
    const pickUp = DWARF_SHEETS.worker2['start-working']!
    expect((pickUp.frames - 14) * pickUp.frameMs).toBe(200)
  })

  it('lands the end of the grind three frames into the set-down', () => {
    // The whole arithmetic, read off the sheets rather than restated. The cue
    // leaves 0.2s of pick-up, then eight 1.0s swings — and `hands-sfx.mp3` is
    // 8.53s, so its tail runs 0.33s past the last swing: three frames into
    // end-working, which is where the arms stop in the art.
    const GRIND_MS = 8530
    const cue = DWARF_CREW.worker2.sound!.shift!
    const pickUp = DWARF_SHEETS.worker2['start-working']!
    const swing = DWARF_SHEETS.worker2.working!
    const setDown = DWARF_SHEETS.worker2['end-working']!
    const lead = (pickUp.frames - cue.frame) * pickUp.frameMs
    const swinging = DWARF_CREW.worker2.swings! * swing.frames * swing.frameMs
    expect(lead + swinging).toBe(8200)
    expect(Math.floor((GRIND_MS - lead - swinging) / setDown.frameMs)).toBe(3)
  })

  it('names the strip the grind is timed against, and it is one the rank has', () => {
    // A cue pointing at a strip this rank was never drawn would never fire,
    // silently — the same failure `everySheet` above exists to stop for frames.
    const cue = DWARF_CREW.worker2.sound!.shift!
    expect(DWARF_SHEETS.worker2[cue.sheet]).toBeDefined()
    expect(cue.frame).toBeLessThan(DWARF_SHEETS.worker2[cue.sheet]!.frames)
  })

  it('gives every rank the same footsteps, the foreman included', () => {
    // The one cue that is not a frame: it is the walk, and every rank walks.
    // Quiet on purpose — footsteps are texture under the mine, not an event.
    for (const role of ROLES) expect(DWARF_CREW[role].sound?.walk, role).toEqual({ gain: 0.05 })
  })

  it('leaves the foreman silent at work, having neither a strike nor a shift', () => {
    expect(DWARF_CREW.foreman.sound?.strike).toBeUndefined()
    expect(DWARF_CREW.foreman.sound?.shift).toBeUndefined()
  })
})
