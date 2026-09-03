import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { DwarfRole } from '../../types'
import { DWARF_SHEETS } from './dwarfSheets'
import { SPRITE_FRAME_SIZE, type SpriteSheet } from './spriteSheet'

const ROLES: readonly DwarfRole[] = ['worker', 'foreman']

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
    // foundations.md says the dwarf sprite is 34x36. Every sheet the maintainer
    // actually drew is 38 tall and a whole number of 36s wide, and 34 divides
    // none of them. The art is the answer; the document is the stale copy.
    for (const { where, sheet } of everySheet()) {
      const { width, height } = pngSize(sheet.src)
      expect(height, where).not.toBe(36)
      expect(width % 34, where).not.toBe(0)
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
    // two ranks having distinct art is the property worth holding.
    expect(DWARF_SHEETS.foreman.idle.src).not.toBe(DWARF_SHEETS.worker.idle.src)
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

  /*
   * What has NOT been drawn, stated out loud so that nobody has to infer it
   * from an absence. #74 delivers working, waiting and walking art later; when
   * it lands these expectations are the ones that change, and the sequence
   * picks the new sheets up as data.
   */
  it('has no working, waiting or walking art for a worker yet', () => {
    expect(Object.keys(DWARF_SHEETS.worker)).toEqual(['idle'])
  })

  it('claims no impact frame anywhere, because no swing has been drawn', () => {
    // Sparks fire off a declared impact and nowhere else. An idle sheet that
    // claimed one would throw debris off a dwarf standing still.
    for (const { where, sheet } of everySheet()) {
      expect(sheet.impactFrames, where).toBeUndefined()
    }
  })
})
