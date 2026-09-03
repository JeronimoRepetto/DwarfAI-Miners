import { fileURLToPath } from 'node:url'
import { Jimp, intToRGBA } from 'jimp'
import { describe, expect, it } from 'vitest'
import type { DwarfRole } from '../../types'
import { DWARF_SHEETS } from './dwarfSheets'
import { SPRITE_FRAME_SIZE } from './spriteSheet'

/**
 * WHICH WAY THE COMMITTED DWARF ART IS PAINTED (#156).
 *
 * Every station's facing was authored by the maintainer on a five-panel arrow
 * sheet, transcribed into `docs/mine-interior-facing.json`, generated into
 * `interiorMap.ts` and read faithfully by the scene — and every dwarf in the
 * mine still came out facing the wrong way. The transcription was never the
 * problem. The problem was one sentence, carried unchecked since #131 flagged
 * it as unconfirmed, in the generator and in `presentation.ts`:
 *
 *     The art is painted facing right.
 *
 * It is painted facing LEFT. So a station authored `left` was mirrored into
 * facing right, a station authored `right` was left unmirrored and faced left,
 * and the whole map rendered in a mirror.
 *
 * This is that assumption pinned to the art itself rather than to prose. The
 * dwarfs wear helmet lamps, and a lamp shines where its wearer is looking: each
 * waking sheet paints the beam as a wedge of semi-transparent warm light. If the
 * beam's centre of mass sits LEFT of the dwarf's own, the art faces left. It is
 * measured off the committed PNGs, so art redrawn the other way round fails
 * here — which is where the mirror should have been caught.
 */

// Amended by #157: 'worker2' joined DwarfRole. Its idle sheet arrived with the
// same correction already applied, and this is what proves that rather than
// trusting it — a rank left off this list is a rank whose art nobody measured.
const ROLES: readonly DwarfRole[] = ['worker', 'foreman', 'worker2']

/**
 * The repository root. A png import resolves to a root-relative path in the test
 * environment, so joining the two reaches the committed file — the same idiom
 * `dwarfSheets.test.ts` uses to check the strips against their PNGs.
 */
const REPO_ROOT = new URL('../../../../../', import.meta.url)

interface Centroids {
  /** Where the lamp's light is, or null on a sheet whose lamp is out. */
  beam: number | null
  /** Where the dwarf is. */
  body: number
}

/**
 * The lamp beam is warm, bright and SEMI-TRANSPARENT, which is what separates it
 * from the solid amber of the helmet badge and from the sparks. Solid pixels are
 * the dwarf himself; fully clear ones are nothing.
 */
async function firstFrameCentroids(src: string): Promise<Centroids> {
  const image = await Jimp.read(fileURLToPath(new URL(`.${src}`, REPO_ROOT)))
  let beamX = 0
  let beamCount = 0
  let bodyX = 0
  let bodyCount = 0
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < SPRITE_FRAME_SIZE.width; x++) {
      const { r, g, b, a } = intToRGBA(image.getPixelColor(x, y))
      if (a === 0) continue
      if (a < 200) {
        if (r > 200 && g > 150 && b < 130) {
          beamX += x
          beamCount += 1
        }
        continue
      }
      bodyX += x
      bodyCount += 1
    }
  }
  return { beam: beamCount === 0 ? null : beamX / beamCount, body: bodyX / bodyCount }
}

function everySheet(): { where: string; src: string }[] {
  return ROLES.flatMap((role) =>
    Object.entries(DWARF_SHEETS[role]).map(([name, sheet]) => ({
      where: `${role}/${name}`,
      src: sheet.src
    }))
  )
}

describe('the committed dwarf sheets', () => {
  it('paints a helmet beam, which is the only reason the facing can be read at all', async () => {
    // Without this the measurement below would pass on any art whatsoever,
    // because every sheet would be skipped as "lamp out".
    const lit: string[] = []
    for (const { where, src } of everySheet()) {
      if ((await firstFrameCentroids(src)).beam !== null) lit.push(where)
    }
    expect(lit.length).toBeGreaterThan(0)
  })

  it('paints every lit dwarf facing LEFT, which is what the scene mirrors from', async () => {
    for (const { where, src } of everySheet()) {
      const { beam, body } = await firstFrameCentroids(src)
      // A sheet with the lamp out — the foreman asleep — says nothing about
      // which way its dwarf faces, and is not asked to.
      if (beam === null) continue
      expect({ where, facesLeft: beam < body }).toEqual({ where, facesLeft: true })
    }
  })
})
