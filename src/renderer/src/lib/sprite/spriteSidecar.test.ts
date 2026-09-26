import { describe, expect, it } from 'vitest'
import {
  FALLBACK_FRAME_MS,
  readSidecar,
  sheetFromSidecar,
  uniformSheet,
  type SpriteSidecar
} from './spriteSidecar'

/*
 * A sidecar in the shape Aseprite's scripted export writes (the design's art bible, Export): one
 * entry per frame with its cell and `duration`, and the sheet's own tag under `meta.frameTags`.
 * Built here rather than read off disk; `dwarfSheets.test.ts` holds the committed sidecars against
 * their PNGs.
 */
function exported(durations: number[], tag = 'working'): unknown {
  return {
    frames: durations.map((duration, i) => ({
      filename: `${tag} ${i}`,
      frame: { x: i * 36, y: 0, w: 36, h: 38 },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: 36, h: 38 },
      sourceSize: { w: 36, h: 38 },
      duration
    })),
    meta: {
      image: `dwarf-${tag}-v3-Sheet.png`,
      size: { w: durations.length * 36, h: 38 },
      frameTags: [{ name: tag, from: 0, to: durations.length - 1, direction: 'forward' }]
    }
  }
}

describe('readSidecar', () => {
  it('reads every frame’s own duration, in strip order', () => {
    const sidecar = readSidecar(exported([120, 100, 150]))
    expect(sidecar.durations).toEqual([120, 100, 150])
  })

  it('reads the cell every frame is cut in', () => {
    expect(readSidecar(exported([120, 100])).cell).toEqual({ width: 36, height: 38 })
  })

  it('reads the tags the export carries', () => {
    expect(readSidecar(exported([120, 100, 150], 'start-working')).tags).toEqual([
      { name: 'start-working', from: 0, to: 2, direction: 'forward' }
    ])
  })

  it('reads a hash-shaped export in the order its frames were written', () => {
    // Aseprite writes either an array or an object keyed by frame name; both carry the strip in
    // insertion order, which is the order the cells sit in.
    const array = exported([70, 180, 110]) as { frames: { filename: string }[]; meta: unknown }
    const hash = {
      frames: Object.fromEntries(array.frames.map((frame) => [frame.filename, frame])),
      meta: array.meta
    }
    expect(readSidecar(hash).durations).toEqual([70, 180, 110])
  })

  it('treats a sidecar with no tags as having none', () => {
    const bare = exported([100, 100]) as { meta: Record<string, unknown> }
    delete bare.meta.frameTags
    expect(readSidecar(bare).tags).toEqual([])
  })

  it('refuses a sidecar that is not an export, naming what is wrong', () => {
    expect(() => readSidecar(null)).toThrow(/sidecar/)
    expect(() => readSidecar({ meta: {} })).toThrow(/frames/)
    expect(() => readSidecar({ frames: [], meta: {} })).toThrow(/no frames/)
  })

  it('refuses a frame whose duration is not a positive number of milliseconds', () => {
    // A zero or missing duration would hold a frame for no time at all, or for NaN: the clock
    // would spin on it. The export always writes a whole positive number.
    for (const bad of [0, -20, Number.NaN, '120', undefined]) {
      const sidecar = exported([120, 100]) as { frames: { duration: unknown }[] }
      sidecar.frames[1]!.duration = bad
      expect(() => readSidecar(sidecar), String(bad)).toThrow(/duration/)
    }
  })
})

describe('sheetFromSidecar', () => {
  const sidecar: SpriteSidecar = readSidecar(exported([120, 120, 200, 90]))

  it('takes its frame count and per-frame durations from the sidecar', () => {
    const sheet = sheetFromSidecar('/swing.png', sidecar)
    expect(sheet.src).toBe('/swing.png')
    expect(sheet.frames).toBe(4)
    expect(sheet.durations).toEqual([120, 120, 200, 90])
  })

  it('keeps --frame-ms as the sheet’s fallback, never as its timing', () => {
    // `frameMs` stays on every sheet so a caller that knows nothing of durations still reads a
    // number, but a sheet with a sidecar is timed by its durations alone.
    expect(sheetFromSidecar('/swing.png', sidecar).frameMs).toBe(FALLBACK_FRAME_MS)
  })

  it('cuts the strip to a named tag when asked for one', () => {
    const tagged = readSidecar({
      ...(exported([100, 110, 120, 130, 140]) as object),
      meta: {
        frameTags: [
          { name: 'wind-up', from: 0, to: 1, direction: 'forward' },
          { name: 'swing', from: 2, to: 4, direction: 'forward' }
        ]
      }
    })
    const swing = sheetFromSidecar('/swing.png', tagged, { tag: 'swing' })
    expect(swing.frames).toBe(3)
    expect(swing.durations).toEqual([120, 130, 140])
  })

  it('refuses a tag the sidecar does not carry, rather than playing the whole strip', () => {
    expect(() => sheetFromSidecar('/swing.png', sidecar, { tag: 'missing' })).toThrow(/missing/)
  })

  it('passes impact and glow frames through untouched', () => {
    const sheet = sheetFromSidecar('/swing.png', sidecar, { impactFrames: [2], glowFrames: [1, 2] })
    expect(sheet.impactFrames).toEqual([2])
    expect(sheet.glowFrames).toEqual([1, 2])
  })
})

describe('uniformSheet', () => {
  it('times a sheet with no sidecar at --frame-ms, 100ms a frame', () => {
    // motion.md, Sprite frame timing: `--frame-ms` is only the fallback for a sheet that has no
    // Aseprite JSON sidecar.
    expect(FALLBACK_FRAME_MS).toBe(100)
    const sheet = uniformSheet('/plain.png', 6)
    expect(sheet).toEqual({ src: '/plain.png', frames: 6, frameMs: 100 })
    expect(sheet.durations).toBeUndefined()
  })
})
