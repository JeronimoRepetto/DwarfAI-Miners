import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { DwarfRole } from '../../types'
import {
  DWARF_CREW,
  DWARF_SHEETS,
  SPRITE_SHEETS,
  WORKER2_GRIND_MS,
  WORKER2_SHIFT_SWINGS,
  type SpriteSheetKey
} from './dwarfSheets'
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

  /*
   * AMENDED by #635, and the old claim is gone because the design replaced it: this asserted every
   * sheet played at a uniform 100ms, read off the v2 preview GIFs. The design adopted per-action
   * frame timing (decision log, Frame timing and Sprite frame clock): every sheet now plays each
   * frame's own duration from its Aseprite sidecar, and 100ms (`--frame-ms`) is only the fallback
   * for a sheet with no sidecar. `frameMs` stays on every sheet as exactly that fallback.
   */
  it('plays every sheet by its own sidecar, with --frame-ms only as the fallback (#635)', () => {
    for (const { where, sheet } of everySheet()) {
      expect(sheet.frameMs, where).toBe(100)
      expect(sheet.durations?.length, where).toBe(sheet.frames)
      for (const hold of sheet.durations ?? []) expect(hold, where).toBeGreaterThan(0)
    }
  })

  it('carries the approved cycle of every sheet (art bible, Timing, per action)', () => {
    // The sum of each sheet's durations: the design's per-sheet rows, as the export wrote them.
    const cycle = (sheet: SpriteSheet | undefined): number =>
      (sheet?.durations ?? []).reduce((sum, hold) => sum + hold, 0)
    expect(cycle(DWARF_SHEETS.worker.working)).toBe(1460)
    expect(cycle(DWARF_SHEETS.worker.idle)).toBe(1120)
    expect(cycle(DWARF_SHEETS.worker['start-working'])).toBe(370)
    expect(cycle(DWARF_SHEETS.worker['end-working'])).toBe(680)
    expect(cycle(DWARF_SHEETS.worker2.working)).toBe(1160)
    expect(cycle(DWARF_SHEETS.worker2.idle)).toBe(1120)
    expect(cycle(DWARF_SHEETS.worker2['start-working'])).toBe(1830)
    expect(cycle(DWARF_SHEETS.worker2['end-working'])).toBe(1750)
    expect(cycle(DWARF_SHEETS.foreman.idle)).toBe(5230)
    expect(cycle(DWARF_SHEETS.foreman.sleeping)).toBe(2560)
    expect(cycle(DWARF_SHEETS.foreman['start-sleep'])).toBe(1040)
    expect(cycle(DWARF_SHEETS.foreman['end-sleep'])).toBe(1280)
  })

  it('holds the pick swing’s impact frame 200ms, the longest of the swing (#635)', () => {
    // The reason per-frame timing exists at all: "the impact frame is held 200ms and the swing
    // hurried" (art bible, Working (pick)).
    const holds = DWARF_SHEETS.worker.working?.durations ?? []
    expect(holds[5]).toBe(200)
    expect(Math.max(...holds)).toBe(200)
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
    /*
     * AMENDED by #635. This pinned index 4, the maintainer's 1-indexed frame 5 read off the v2
     * preview GIF. The design now names the impact frame of the v3 swing as the one it holds
     * 200ms (art bible, Working (pick): "the impact frame is held 200ms"; sound.md, "crew cue
     * `strike` on the impact frame"), and that hold is index 5. Still ONE frame and nowhere else:
     * the pre-migration `isPickImpact` warning against "a permanent glow ... rather than impacts"
     * (see presentation.ts before #87's sheet migration) still holds.
     */
    it('declares the strike on the frame the swing holds 200ms, index 5 (#635)', () => {
      const swing = DWARF_SHEETS.worker.working!
      expect(swing.impactFrames).toEqual([5])
      expect(swing.durations?.[5]).toBe(200)
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
  /*
   * AMENDED by #635, on the design lead ruling 2026-09-26 (SPRITE-QUESTIONS.md, question 2): one grind per shift, starting when the shift starts; the worker2's shift is as many swings as fit inside the
   * 8.53 s grind, and the rest of the shift is silence. It pinned eight, the v2 count worked at
   * 100ms a frame. Under the v3 sidecars that is five (the arithmetic is pinned below), and the
   * count is one named constant because the PO judges it by ear (#330).
   */
  it('swings the worker twice a shift and the worker2 as often as fits inside its grind', () => {
    expect(DWARF_CREW.worker.swings).toBe(2)
    expect(DWARF_CREW.worker2.swings).toBe(WORKER2_SHIFT_SWINGS)
    expect(WORKER2_SHIFT_SWINGS).toBe(5)
  })

  it('declares no count for the foreman, who has no swing to repeat', () => {
    expect(DWARF_CREW.foreman.swings).toBeUndefined()
  })

  it('sounds the worker on the frames its own sheet already calls impacts', () => {
    // A pointer at the sheet rather than a second copy of frame 4: the strike
    // and its sparks are one event, so the two must not be able to drift.
    // AMENDED for the maintainer's first live listen of #339 (issue #330):
    // the recording is hot against the room tone, so it now opens at a tenth
    // of itself (2026-09-09) — the same shape WALK_GAIN already gave the
    // footsteps.
    expect(DWARF_CREW.worker.sound?.strike).toEqual({ on: 'impactFrames', gain: 0.1 })
    expect(DWARF_CREW.worker.sound?.shift).toBeUndefined()
  })

  /*
   * AMENDED by #635, on the design lead ruling 2026-09-26 (SPRITE-QUESTIONS.md, question 2): one grind per shift, starting when the shift starts. It pinned the cue at frame 14 of the 16-frame pick-up, 200ms
   * (300ms under v3) before the first swing. The shift starts on the pick-up's first frame, so
   * that is where the grind opens now.
   */
  it("starts the worker2's grind as its shift starts, on the pick-up's first frame", () => {
    expect(DWARF_CREW.worker2.sound?.shift).toEqual({ sheet: 'start-working', frame: 0 })
    // The worker2 has no strike to name and never will (#211, confirmed by the design lead on
    // 2026-09-26, SPRITE-QUESTIONS.md question 4): its "Impact" labels are motion phase names.
    expect(DWARF_CREW.worker2.sound?.strike).toBeUndefined()
  })

  /*
   * AMENDED by #635, on the design lead ruling 2026-09-26 (SPRITE-QUESTIONS.md, question 2): one grind per shift, starting when the shift starts. It pinned the grind ending 1.05s before the last of eight
   * swings did, the v2 count outlasting the recording under v3 timing. Now the arithmetic is the
   * ruling's: the grind opens with the shift, the pick-up (1830ms) and every swing (1160ms each)
   * fall inside the 8530ms recording, and the time left until the next shift is silence.
   *
   *     8530 - 1830 = 6700ms for swings; 6700 / 1160 = 5.78, so five swings (a sixth ends at 8790)
   *     the swings end at 1830 + 5 x 1160 = 7630ms; the grind ends 900ms into the 1750ms set-down
   *     the shift lasts 1830 + 5800 + 1750 = 9380ms, so 850ms of silence before the next grind
   */
  it('fits the pick-up and every swing inside one grind, silent until the next shift (#635)', () => {
    const sum = (holds: readonly number[] | undefined): number =>
      (holds ?? []).reduce((total, hold) => total + hold, 0)
    const pickUp = sum(DWARF_SHEETS.worker2['start-working']!.durations)
    const swing = sum(DWARF_SHEETS.worker2.working!.durations)
    const setDown = sum(DWARF_SHEETS.worker2['end-working']!.durations)
    const swings = DWARF_CREW.worker2.swings!
    expect(WORKER2_GRIND_MS).toBe(8530)
    expect(pickUp + swings * swing).toBe(7630)
    expect(pickUp + swings * swing).toBeLessThanOrEqual(WORKER2_GRIND_MS)
    // One more swing would outlast the recording: five is as many as fit.
    expect(pickUp + (swings + 1) * swing).toBeGreaterThan(WORKER2_GRIND_MS)
    // The shift outlasts its grind, so a shift's grind has ended before the next one opens.
    expect(pickUp + swings * swing + setDown).toBe(9380)
    expect(pickUp + swings * swing + setDown - WORKER2_GRIND_MS).toBe(850)
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

/*
 * The sheets by the design's own key (#635): what the sprite atom plays, `DM.SHEETS` in the
 * design's prototype (assets.md, Sprite sheets). The ranks' keys point at the ranks' own sheets,
 * never at a copy, and the base dwarf's idle is the one sheet no rank plays.
 */
describe('SPRITE_SHEETS (#635)', () => {
  it('names every sheet the sprite atom plays, by the design’s key', () => {
    expect(Object.keys(SPRITE_SHEETS).sort()).toEqual(
      [
        'base/idle',
        'foreman/end-sleep',
        'foreman/idle',
        'foreman/sleeping',
        'foreman/start-sleep',
        'worker/end-working',
        'worker/idle',
        'worker/start-working',
        'worker/working',
        'worker2/end-working',
        'worker2/idle',
        'worker2/start-working',
        'worker2/working'
      ].sort()
    )
  })

  it('points each rank’s key at that rank’s own sheet', () => {
    for (const role of ROLES) {
      for (const [name, sheet] of Object.entries(DWARF_SHEETS[role])) {
        expect(SPRITE_SHEETS[`${role}/${name}` as SpriteSheetKey]?.sheet, `${role}/${name}`).toBe(
          sheet
        )
      }
    }
  })

  it('plays the start and end transitions once, and every other sheet as a loop', () => {
    const once = Object.entries(SPRITE_SHEETS)
      .filter(([, entry]) => entry.once)
      .map(([key]) => key)
      .sort()
    expect(once).toEqual(
      [
        'foreman/end-sleep',
        'foreman/start-sleep',
        'worker/end-working',
        'worker/start-working',
        'worker2/end-working',
        'worker2/start-working'
      ].sort()
    )
  })

  it('carries the base dwarf’s seven-frame idle, 1120ms a cycle, drawn in the same cell', () => {
    const base = SPRITE_SHEETS['base/idle'].sheet
    expect(base.frames).toBe(7)
    expect(base.durations).toEqual([100, 100, 180, 180, 260, 140, 160])
    const { width, height } = pngSize(base.src)
    expect(height).toBe(SPRITE_FRAME_SIZE.height)
    expect(width / SPRITE_FRAME_SIZE.width).toBe(base.frames)
  })
})
