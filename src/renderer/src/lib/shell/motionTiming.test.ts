// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { calcGeneratorDuration, getDefaultTransition, spring } from 'motion-v'
import { WATCHDOG_MARGIN_MS, motionBoundMs, motionDurationMs } from './motionTiming'

/**
 * `motionDurationMs`/`motionBoundMs` pin the one place this app's timing comes
 * from now (#566): motion-v's own `getDefaultTransition`, never a number this
 * codebase authors. Every case here asserts against what the REAL engine
 * decides for the exact keyframes it is handed, not a literal this file
 * invented — a literal would drift the moment motion-dom changes its own
 * defaults and nobody here would notice.
 */
describe('motionDurationMs', () => {
  it('reads a non-transform value (opacity) off motion-v’s own ease default: 0.3s, always', () => {
    // `getDefaultTransition` answers `ease` for anything that is not a
    // transform prop, and `ease`'s duration is a flat 0.3s regardless of the
    // keyframe values — read straight off
    // `motion-dom/dist/es/animation/utils/default-transitions.mjs`.
    expect(motionDurationMs({ opacity: [0, 1] })).toBe(300)
    expect(motionDurationMs({ opacity: [1, 0] })).toBe(300)
  })

  it('reads a transform value (x) off motion-v’s own underdamped spring, against the engine’s own number', () => {
    // `x` is a transformProp, so `getDefaultTransition` answers the spring
    // `{ stiffness: 500, damping: 25, restSpeed: 10 }` — asserted here against
    // `spring()`/`calcGeneratorDuration()` run directly, never a duration this
    // test names itself, because a spring's settling time depends on the
    // keyframes' own delta (measured separately: 12px settles this pair in
    // 300ms at the engine's default 50ms step; a bigger delta would not).
    const engineDuration = calcGeneratorDuration(
      spring({ type: 'spring', stiffness: 500, damping: 25, restSpeed: 10, keyframes: [12, 0] })
    )
    expect(motionDurationMs({ x: [12, 0] })).toBe(engineDuration)
  })

  it('reads y off the same spring as x: both are transformProps motion-dom treats identically', () => {
    const engineDuration = calcGeneratorDuration(
      spring({ type: 'spring', stiffness: 500, damping: 25, restSpeed: 10, keyframes: [0, 12] })
    )
    expect(motionDurationMs({ y: [0, 12] })).toBe(engineDuration)
  })

  it('reads clipPath off the same flat ease as opacity: neither is a transformProp', () => {
    expect(
      motionDurationMs({
        clipPath: ['inset(0px 0px 0px 0px round 12px)', 'inset(0px 0px 0px 40px round 12px)']
      })
    ).toBe(300)
  })

  it('is the SLOWEST value in a mixed run, never the fastest or the sum', () => {
    // A panel's own keyframes fade opacity and slide one axis at once
    // (`panelKeyframes`); the run cannot report itself finished before both
    // values have settled, so the bound has to be the max, not either alone.
    const opacityOnly = motionDurationMs({ opacity: [1, 0] })
    const xOnly = motionDurationMs({ x: [0, 12] })
    expect(motionDurationMs({ opacity: [1, 0], x: [0, 12] })).toBe(Math.max(opacityOnly, xOnly))
  })

  it('is zero for a run with nothing to animate', () => {
    expect(motionDurationMs({})).toBe(0)
  })
})

describe('motionBoundMs', () => {
  it('is the duration plus one fixed watchdog margin, named once', () => {
    expect(WATCHDOG_MARGIN_MS).toBe(50)
    const keyframes = { opacity: [1, 0] as [number, number] }
    expect(motionBoundMs(keyframes)).toBe(motionDurationMs(keyframes) + WATCHDOG_MARGIN_MS)
  })
})

/**
 * ADDED for #464 (correction to T2): the shell's fold is ONE motion, so its
 * rail carry has to share the clip's own transition rather than pick up its
 * own default spring — `useShellFold.carry()` now passes
 * `getDefaultTransition('clipPath', { keyframes: <the clip strings> })`
 * straight through. `motionDurationMs`/`motionBoundMs` have to accept that
 * same explicit transition and compute from IT rather than re-deriving a
 * per-key default, or the override would be silently ignored.
 */
describe('motionDurationMs and motionBoundMs, given an explicit transition', () => {
  it('uses the given transition instead of a per-key default, and ignores the keyframes’ own delta once it is not a spring', () => {
    // clipPath is never a transformProp (motion-dom's own `transformProps`
    // set, `keys-transform.mjs`), so its own default is always the flat 0.3s
    // ease — never a spring. Handed to `x`'s run explicitly, that same flat
    // duration applies REGARDLESS of how far the rail travels, which is the
    // whole point of the fix: a rail travelling 563px must not take longer
    // than the clip it is supposed to be carried inside of.
    const clipTransition = getDefaultTransition('clipPath', {
      keyframes: ['a', 'b'] as unknown as number[]
    })
    expect(clipTransition.type).not.toBe('spring')
    expect(motionDurationMs({ x: [0, 563] }, clipTransition)).toBe(300)
  })

  it('threads the same explicit transition through motionBoundMs, so a fold’s rail bound equals its clip’s bound', () => {
    const clipTransition = getDefaultTransition('clipPath', {
      keyframes: ['a', 'b'] as unknown as number[]
    })
    const clipBound = motionBoundMs({ clipPath: ['a', 'b'] }, clipTransition)
    expect(motionBoundMs({ x: [0, 563] }, clipTransition)).toBe(clipBound)
  })

  it('still resolves a spring given explicitly, off the identical number an omitted transition would derive', () => {
    // Sanity check that passing the exact thing `getDefaultTransition` would
    // have picked anyway changes nothing — the override only matters when it
    // actually DIFFERS from the per-key default, which is the clip/rail case
    // above.
    const explicitSpring = getDefaultTransition('x', { keyframes: [12, 0] })
    expect(motionDurationMs({ x: [12, 0] }, explicitSpring)).toBe(motionDurationMs({ x: [12, 0] }))
  })
})
