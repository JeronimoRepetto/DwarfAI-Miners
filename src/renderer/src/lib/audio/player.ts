/**
 * The thin adapter between the engine's decisions and something that makes a
 * noise (#174, #173).
 *
 * ## Why `HTMLAudioElement` and not Web Audio
 *
 * The issues allow either and ask for the choice to be stated. This is
 * `HTMLAudioElement` with its `volume` ramped on a timer, and the reason is
 * the shape of the bug #156 already cost this project once: a renderer feature
 * that works perfectly under `pnpm dev` and reaches the user broken, because
 * the dev server serves assets from an http origin and the packaged app loads
 * them from `file://`.
 *
 * Both Web Audio routes cross exactly that line.
 *
 *   - `decodeAudioData` needs the bytes, which means `fetch`/XHR. A `file://`
 *     document cannot fetch a sibling `file://` URL in Chromium, so every
 *     track would decode in development and fail in the installer.
 *   - `createMediaElementSource` avoids the fetch, but routing a media element
 *     through the graph applies Chromium's cross-origin check, and a `file://`
 *     resource's origin is not something this project has verified across
 *     Windows, macOS and Linux. The failure mode there is silence with no
 *     error — the worst possible one, because it is indistinguishable from a
 *     volume set to zero.
 *
 * A media ELEMENT, meanwhile, loads a `file://` sibling exactly as the `<img>`
 * tags of the mine paintings already do in the shipped app, which is evidence
 * rather than a hope.
 *
 * What that costs is ramp resolution. `volume` is a property stepped from JS,
 * so a 1 s fade is `1000 / RAMP_STEP_MS` steps rather than a sample-accurate
 * line — but the media pipeline applies the property smoothly per rendering
 * quantum, so what a listener hears is a fade rather than a staircase, and at
 * these lengths (1 s and 2 s over sustained material) the difference is not
 * audible. What the issues actually need to be exact is the SCHEDULING — the
 * fade-out starting one second before the end, the seam two seconds before it
 * — and that is read off the track's own `currentTime`/`duration` by
 * `musicTimeline` and `shouldCrossfadeLoopSeam`, so it stays right whatever
 * rate the ramp steps at.
 */

/** How often a ramp rewrites `volume` — roughly one frame at 60Hz. */
export const RAMP_STEP_MS = 16

/**
 * Where a linear ramp has got to, as a pure fraction of the way from `from` to
 * `to`. Clamped at both ends so a late step cannot overshoot.
 */
export function rampValueAt(from: number, to: number, elapsedMs: number, ms: number): number {
  if (ms <= 0 || elapsedMs >= ms) return to
  if (elapsedMs <= 0) return from
  return from + (to - from) * (elapsedMs / ms)
}

/**
 * One sound, open and addressable. Deliberately narrow: everything the engine
 * knows how to ask for, and nothing that would let it reach the element.
 */
export interface AudioClip {
  play: () => void
  pause: () => void
  /** Stop, rewind, and release: this clip is not played again. */
  stop: () => void
  /** Jump to a volume with no ramp — a cut. */
  setVolume: (volume: number) => void
  /** Ramp to a volume over `ms`, replacing any ramp already running. */
  rampVolume: (volume: number, ms: number) => void
  /**
   * Aim at a volume without disturbing what the clip is doing: a ramp already
   * running is RE-AIMED over the time it has left, and a clip that is not
   * ramping simply takes the value.
   *
   * This is what a moved slider asks for. Writing the value straight onto a
   * clip mid-fade would jump the envelope and finish the fade early; ramping
   * afresh over a full second would restart a fade that was nearly done. Only
   * the player knows which case it is in, so only the player can answer.
   */
  retargetVolume: (volume: number) => void
  /** Where the sound has got to, in milliseconds. */
  positionMs: () => number
  /** How long the sound is, or NaN before its metadata has loaded. */
  durationMs: () => number
}

export interface AudioPlayer {
  /**
   * Open `src` at `volume`, not yet playing. `onEnded` fires when the sound
   * reaches its own end, which is what drives the music gap for a track whose
   * duration never became readable.
   */
  open: (src: string, options?: { volume?: number; onEnded?: () => void }) => AudioClip
}

/**
 * The real player: one `Audio` element per clip.
 *
 * One element per clip rather than a pool, because a crossfade needs two of
 * the same bed playing at once and a pooled element cannot be in two places.
 * Elements are released on `stop` (paused, rewound, source dropped) so the
 * decoder lets go of them.
 */
export function createElementAudioPlayer(): AudioPlayer {
  return {
    open(src, options) {
      const element = new Audio(src)
      element.preload = 'auto'
      // Never `element.loop`: both the music's gap and the ambience's seam are
      // scheduled BEFORE the end of the sound, and a looping element gives no
      // moment to schedule from — it just wraps, with an audible click at the
      // join that is exactly what the crossfade exists to remove.
      element.loop = false
      element.volume = clamp01(options?.volume ?? 0)
      if (options?.onEnded) element.addEventListener('ended', options.onEnded)

      let ramp: ReturnType<typeof setInterval> | undefined
      /** How much of the running ramp is left, so it can be re-aimed. */
      let rampEndsAt = 0
      /** Same rule as `play`: nothing a media element refuses reaches a caller. */
      function pauseQuietly(): void {
        try {
          element.pause()
        } catch {
          // Nothing was playing, or there is no pipeline to pause.
        }
      }
      function stopRamp(): void {
        if (ramp !== undefined) clearInterval(ramp)
        ramp = undefined
      }

      return {
        play(): void {
          /*
           * NOTHING a media element refuses may reach the caller, and this is
           * the one rule in this file that is not about sound.
           *
           * The panel is a visual monitor first and a game second: a track
           * that will not start must leave the map, the mines and the crew
           * exactly as they were. There are three ways a start fails and all
           * three are swallowed here — the autoplay policy and a decode
           * failure REJECT the promise, and an environment with no media
           * pipeline at all (jsdom, which is what the component suite mounts
           * this app in) THROWS synchronously and returns nothing to reject.
           *
           * `autoplayPolicy` in the window's webPreferences is what stops the
           * first of the three from happening at all; see
           * buildMainWindowOptions.
           */
          try {
            const started: unknown = element.play()
            if (started instanceof Promise) void started.catch(() => undefined)
          } catch {
            // Silence is the correct outcome, and the panel is untouched.
          }
        },
        pause(): void {
          stopRamp()
          pauseQuietly()
        },
        stop(): void {
          stopRamp()
          pauseQuietly()
          if (options?.onEnded) element.removeEventListener('ended', options.onEnded)
          try {
            // Rewound and detached so the decoder releases the buffer; keeping
            // six 3 MB tracks decoded because each was merely paused is how a
            // panel meant to be background furniture stops being it.
            element.currentTime = 0
            element.removeAttribute('src')
            element.load()
          } catch {
            // Same rule as `play`: releasing a sound must not break a panel.
          }
        },
        setVolume(volume: number): void {
          stopRamp()
          element.volume = clamp01(volume)
        },
        rampVolume(volume: number, ms: number): void {
          stopRamp()
          const target = clamp01(volume)
          const from = element.volume
          if (ms <= 0 || from === target) {
            element.volume = target
            return
          }
          const startedAt = Date.now()
          rampEndsAt = startedAt + ms
          ramp = setInterval(() => {
            const elapsed = Date.now() - startedAt
            element.volume = clamp01(rampValueAt(from, target, elapsed, ms))
            if (elapsed >= ms) stopRamp()
          }, RAMP_STEP_MS)
        },
        retargetVolume(volume: number): void {
          if (ramp === undefined) {
            element.volume = clamp01(volume)
            return
          }
          this.rampVolume(volume, Math.max(0, rampEndsAt - Date.now()))
        },
        positionMs(): number {
          return element.currentTime * 1000
        },
        durationMs(): number {
          return element.duration * 1000
        }
      }
    }
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
