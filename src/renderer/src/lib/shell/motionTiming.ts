import { calcGeneratorDuration, getDefaultTransition, spring } from 'motion-v'
import type { AnyResolvedKeyframe, DOMKeyframesDefinition } from 'motion-v'

/**
 * How this app's own timing is decided, since the user's ruling on #566
 * ("si vamos, cualquier cosa sino la cambiamos luego"): the runner
 * (`boundedMotion.ts`) passes motion-v's `animate()` no transition at all, so
 * motion-dom's own `getDefaultTransition` picks one per value key. Quoted
 * verbatim from `motion-dom@13.3.0`'s own
 * `dist/es/animation/utils/default-transitions.mjs` — the one place this
 * app's timing comes from now, so this file reads it rather than restates it
 * from memory:
 *
 * ```js
 * const underDampedSpring = {
 *     type: "spring",
 *     stiffness: 500,
 *     damping: 25,
 *     restSpeed: 10,
 * };
 * const ease = {
 *     type: "keyframes",
 *     ease: [0.25, 0.1, 0.35, 1],
 *     duration: 0.3,
 * };
 * const getDefaultTransition = (valueKey, { keyframes }) => {
 *     if (keyframes.length > 2) {
 *         return keyframesTransition;
 *     }
 *     else if (transformProps.has(valueKey)) {
 *         return valueKey.startsWith("scale")
 *             ? criticallyDampedSpring(keyframes[1])
 *             : underDampedSpring;
 *     }
 *     return ease;
 * };
 * ```
 *
 * `transformProps` (`keys-transform.mjs`) includes `x` and `y`, the two axes
 * this app's own keyframe builders ever animate, so every panel motion this
 * app runs is `underDampedSpring` on its axis and the flat 0.3s `ease` on
 * everything else (`opacity`, `clipPath` — neither is a transform prop, and
 * this app's own runs are always a two-element `[from, to]`, never the
 * `keyframes.length > 2` branch). Nothing in this codebase authors a duration
 * any more; this file only asks the engine how long the keyframes it was
 * actually handed will take, so a run's own watchdog and every caller that
 * used to wait a fixed 250ms instead wait on this.
 */

/**
 * How far past a run's own settling time its watchdog waits before ending it
 * anyway (#266): #266's whole premise is that `animation.finished` is not a
 * promise of completion on an occluded window, so an honest run has to have
 * FINISHED settling before the watchdog may end it early, never merely be
 * expected to. Named once so every caller that adds this margin on top of
 * `motionDurationMs` — the run's own watchdog inside `boundedMotion.run`, and
 * the further margins layered on top of that in `panelMotion.ts` — says the
 * same 50ms rather than three call sites agreeing by coincidence.
 */
export const WATCHDOG_MARGIN_MS = 50

/**
 * What `getDefaultTransition` answers, and what `boundedMotion.run`'s own
 * optional fourth argument passes straight to motion-v's `animate()` (#464):
 * named off the function's own return type rather than imported by a guessed
 * name, since motion-v re-exports `ValueAnimationOptions` under its own
 * naming from deep inside motion-dom.
 */
export type MotionTransition = ReturnType<typeof getDefaultTransition>

/**
 * One value key's run, narrowed to what this app's own keyframe builders
 * (`panelKeyframes`, `shellFoldKeyframes`, `railFoldKeyframes`) ever produce:
 * a two-element run from what an element shows now to what it should show at
 * rest. Never a single value and never motion-v's "keep animating from the
 * live value" `null` placeholder — `DOMKeyframesDefinition`'s own
 * `UnresolvedValueKeyframe[]` allows both, and this app has no use for either.
 */
function resolvedRunOf(
  value: DOMKeyframesDefinition[keyof DOMKeyframesDefinition]
): AnyResolvedKeyframe[] | undefined {
  if (!Array.isArray(value)) return undefined
  // Asserted rather than filtered: this app's own builders never emit `null`,
  // and a run that somehow did would be a keyframe bug worth a type error
  // somewhere upstream of here, not a value this function should silently
  // drop and understate the duration for.
  return value as AnyResolvedKeyframe[]
}

/**
 * How long motion-v's own transition takes to settle the keyframes a run is
 * actually handed — the slowest of the run's own values, because the run as
 * a whole cannot report itself finished before every value has.
 *
 * A spring's settling time depends on the keyframes' own delta (`spring()`'s
 * own physics, not `getDefaultTransition`'s literal object, which is the same
 * `{ stiffness, damping, restSpeed }` regardless of what is being animated) —
 * which is exactly why this reads the real engine's own number rather than a
 * constant: a 12px panel offset and a rail travelling several hundred pixels
 * settle in different times under the identical spring.
 *
 * `transition`, when given, is used for EVERY key instead of asking
 * `getDefaultTransition` per key (#464): the shell's fold is one motion, and
 * `useShellFold.carry()` passes the clip's own transition so the rail shares
 * it rather than picking up its own default spring — a rail run whose
 * duration still depended on its own travel distance could finish after the
 * clip that is supposed to be carrying it. Omitted, behaviour is unchanged:
 * every key asks for its own default, as motion-v's `animate()` would if
 * handed no transition either.
 */
export function motionDurationMs(
  keyframes: DOMKeyframesDefinition,
  transition?: MotionTransition
): number {
  let longest = 0
  for (const [key, value] of Object.entries(keyframes)) {
    const values = resolvedRunOf(value)
    if (values === undefined) continue
    // `getDefaultTransition`'s own type pins `ValueAnimationOptions`'s
    // generic to its default, `number` — not a mistake worth working around
    // with a cast at every call site, because the ONLY thing it reads off a
    // non-transform key's (clipPath's) values is `.length`, string or number
    // alike (motion-dom's own source, quoted in this file's own header
    // comment). A transformProp key (x/y) is where the element TYPE starts
    // to matter, and this app's own builders only ever pass numbers there —
    // never motion-v's string transform shortcuts.
    const numeric = values as number[]
    const valueTransition = transition ?? getDefaultTransition(key, { keyframes: numeric })
    const duration =
      valueTransition.type === 'spring'
        ? calcGeneratorDuration(spring({ ...valueTransition, keyframes: numeric }))
        : (valueTransition.duration ?? 0) * 1000
    if (duration > longest) longest = duration
  }
  return longest
}

/**
 * A run's own watchdog deadline (#266): the time the engine's transition
 * needs to actually settle, plus one margin, so the watchdog is a BACKSTOP
 * against an occluded window's frozen timeline rather than a race against an
 * honest run's own completion. `transition` is forwarded to
 * `motionDurationMs` unchanged — see its own comment for why (#464).
 */
export function motionBoundMs(
  keyframes: DOMKeyframesDefinition,
  transition?: MotionTransition
): number {
  return motionDurationMs(keyframes, transition) + WATCHDOG_MARGIN_MS
}
