/**
 * The Aseprite JSON sidecar beside every exported sheet, and the sheet it describes (#635).
 *
 * The design's art bible (Export) cuts every strip the app plays from its Aseprite tag with a
 * sidecar carrying each frame's own duration and that one tag. Sprites play those durations
 * (motion.md, Sprite frame timing; decision log, Sprite frame clock), because a uniform tempo is
 * what made the pick swing read as mechanical: the impact frame is held 200ms and the swing
 * hurried. `--frame-ms` is only the fallback for a sheet that has no sidecar.
 *
 * Pure: it reads a parsed object and knows no file, no DOM and no clock. A malformed sidecar is
 * refused loudly rather than played at some guessed tempo, since a sidecar is a claim about the
 * art that nothing at runtime could otherwise notice being wrong.
 */
import type { SpriteSheet } from './spriteSheet'

/**
 * `--frame-ms`, the fallback frame for a sheet with no sidecar (motion.md, Motion tokens). The
 * design token of the same name in `design-tokens.css` carries the same 100ms for CSS.
 */
export const FALLBACK_FRAME_MS = 100

/** One tag of the source file, as the export writes it: an inclusive range of frames. */
export interface SidecarTag {
  readonly name: string
  readonly from: number
  readonly to: number
  readonly direction: string
}

/** What a sidecar says about its sheet, and nothing it says about the exporter. */
export interface SpriteSidecar {
  /** Each frame's hold in milliseconds, in the order the cells sit in the strip. */
  readonly durations: readonly number[]
  /** The cell every frame is cut in, read off the first frame. */
  readonly cell: { readonly width: number; readonly height: number }
  readonly tags: readonly SidecarTag[]
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null
}

function fail(problem: string): never {
  throw new Error(`sprite sidecar: ${problem}`)
}

function tagOf(value: unknown, index: number): SidecarTag {
  if (!isObject(value)) fail(`tag ${index} is not an object`)
  const { name, from, to, direction } = value
  if (typeof name !== 'string' || !Number.isInteger(from) || !Number.isInteger(to)) {
    fail(`tag ${index} has no name or frame range`)
  }
  return {
    name,
    from: from as number,
    to: to as number,
    direction: typeof direction === 'string' ? direction : 'forward'
  }
}

/**
 * Reads a parsed sidecar. Aseprite writes `frames` either as an array or as an object keyed by
 * frame name; both hold the strip in the order it was written, which is the cells' order.
 */
export function readSidecar(json: unknown): SpriteSidecar {
  if (!isObject(json)) fail('not an object')
  const raw = json.frames
  if (!isObject(raw)) fail('frames is missing')
  const frames = Array.isArray(raw) ? (raw as unknown[]) : Object.values(raw)
  if (frames.length === 0) fail('no frames')

  const durations = frames.map((frame, index) => {
    const duration = isObject(frame) ? frame.duration : undefined
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
      fail(`frame ${index} has no positive duration`)
    }
    return duration
  })

  const first = frames[0] as Json
  const box = isObject(first.frame) ? first.frame : {}
  const cell = {
    width: typeof box.w === 'number' ? box.w : 0,
    height: typeof box.h === 'number' ? box.h : 0
  }

  const meta = isObject(json.meta) ? json.meta : {}
  const tags = Array.isArray(meta.frameTags) ? meta.frameTags.map(tagOf) : []
  return { durations, cell, tags }
}

/** What a sheet declares beyond its timing: the frames that throw sparks or glow (issue #74). */
export interface SheetExtras {
  /** Cut the strip to this tag of the sidecar; absent plays every frame. */
  readonly tag?: string
  readonly impactFrames?: readonly number[]
  readonly glowFrames?: readonly number[]
}

/**
 * The sheet a sidecar times: its frame count and each frame's own hold. `frameMs` carries the
 * fallback only so every sheet has one number; a sheet with durations is never timed by it.
 */
export function sheetFromSidecar(
  src: string,
  sidecar: SpriteSidecar,
  extras: SheetExtras = {}
): SpriteSheet {
  let durations = sidecar.durations
  if (extras.tag !== undefined) {
    const tag = sidecar.tags.find((candidate) => candidate.name === extras.tag)
    if (tag === undefined) fail(`no tag named ${extras.tag}`)
    durations = durations.slice(tag.from, tag.to + 1)
  }
  return {
    src,
    frames: durations.length,
    frameMs: FALLBACK_FRAME_MS,
    durations,
    ...(extras.impactFrames === undefined ? {} : { impactFrames: extras.impactFrames }),
    ...(extras.glowFrames === undefined ? {} : { glowFrames: extras.glowFrames })
  }
}

/** A sheet with no sidecar: every frame held for `--frame-ms`. */
export function uniformSheet(src: string, frames: number): SpriteSheet {
  return { src, frames, frameMs: FALLBACK_FRAME_MS }
}
