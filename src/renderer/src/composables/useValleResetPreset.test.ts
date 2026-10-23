// @vitest-environment jsdom
import type { MineId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import type { ValleBox, ValleClock, ValleFrames } from '../lib/valle/flip'
import {
  defaultValleLayouts,
  type ValleLayouts,
  type ValleMotion,
  type VallePreset
} from '../lib/valle/preset'
import { useValleResetPreset, type ValleResetMotion } from './useValleResetPreset'

/*
 * "Reset preset" in use (ISSUE-309; 07 machine 37; UC-062): the menu, the reset carried out through the one owner of
 * each thing it touches (the layouts' writer, the mosaic, the split, the splitter, the toast queue), and the FLIP.
 * Everything it reaches is a hand-written fake that records the order of the calls.
 */

const MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a11' as MineId

const CHANGED: ValleLayouts = {
  control: {
    chatWidth: 520,
    split: false,
    foldedList: false,
    zones: { [MINE]: { content: 'map' } }
  },
  front: { chatWidth: 610, split: true, foldedList: true, zone: { content: 'history' } }
}

/** A clock driven by hand: a frame each 10 ms, a timer at its time. */
function manualClock() {
  let now = 0
  let id = 0
  const frames = new Map<number, (at: number) => void>()
  const timers = new Map<number, { at: number; run: () => void }>()
  const clock: ValleClock & { advance(ms: number): void } = {
    frame(run) {
      frames.set((id += 1), run)
      return id
    },
    cancelFrame: (handle) => {
      frames.delete(handle as number)
    },
    now: () => now,
    set(run, ms) {
      timers.set((id += 1), { at: now + ms, run })
      return id
    },
    clear: (handle) => {
      timers.delete(handle as number)
    },
    advance(ms) {
      const until = now + ms
      while (now < until) {
        now = Math.min(now + 10, until)
        for (const [key, timer] of [...timers]) {
          if (timer.at > now) continue
          timers.delete(key)
          timer.run()
        }
        const due = [...frames.values()]
        frames.clear()
        for (const run of due) run(now)
      }
    }
  }
  return clock
}

interface Options {
  preset?: VallePreset
  motion?: ValleMotion
  /** What the layouts' writer answers: whether UI main took the write. */
  taken?: boolean
  /** The FLIP's motion, or none (the run settles at once). */
  flip?: boolean
  reduced?: boolean
}

function setup(options: Options = {}) {
  const log: string[] = []
  const view = shallowRef({
    preset: options.preset ?? 'control',
    layouts: CHANGED,
    motion: options.motion
  })
  const toasts: string[] = []
  const written: ValleLayouts[] = []
  const animated: { element: Element; frames: ValleFrames }[] = []
  const clock = manualClock()
  const moved = document.createElement('div')
  document.body.append(moved)
  let rendered: (() => void) | null = null
  let left = 0
  const motion: ValleResetMotion = {
    clock,
    reduced: () => options.reduced ?? false,
    targets: () => [moved],
    box: (): ValleBox => {
      log.push('measure')
      return { left, top: 0, width: 100, height: 100 }
    },
    animate: (element, frames) => {
      animated.push({ element, frames })
    },
    afterRender: (run) => {
      rendered = run
    }
  }
  const scope = effectScope()
  const part = scope.run(() =>
    useValleResetPreset({
      view: () => view.value,
      resetLayouts: (layouts) => {
        log.push('layouts')
        written.push(layouts)
        view.value = { ...view.value, layouts }
        return Promise.resolve(options.taken ?? true)
      },
      recomputeMosaic: () => log.push('mosaic'),
      splitOff: () => log.push('split-off'),
      splitterRest: () => log.push('splitter'),
      showToast: (text) => {
        log.push('toast')
        toasts.push(text)
      },
      ...(options.flip === false ? {} : { motion })
    })
  )!
  return {
    part,
    log,
    toasts,
    written,
    animated,
    clock,
    view,
    /** The defaults are rendered: the part has moved, and the FLIP plays. */
    render() {
      left = 40
      rendered?.()
    },
    scope
  }
}

describe('Reset preset in use (ISSUE-309)', () => {
  it('[US-VALLE-010.AC01, S37.03, S37.04] picking Reset preset writes the preset shown at its defaults through the layouts writer and raises the toast naming it', async () => {
    const control = setup({ preset: 'control', flip: false })
    control.part.toggle()
    expect(control.part.state.value).toBe('menu-open')
    expect(control.part.reset()).toBe(true)
    expect(control.written).toHaveLength(1)
    expect(control.written[0]!.control).toEqual(defaultValleLayouts().control)
    expect(control.written[0]!.front).toBe(CHANGED.front)
    expect(control.toasts).toEqual(['Control room is back to its preset'])
    // The splitter returns to rest (S33.10), the mosaic is recomputed (S32.15); no split to turn off.
    expect(control.log).toEqual(['layouts', 'splitter', 'mosaic', 'toast'])
    // Nothing to play: the run settled at once (S37.05).
    expect(control.part.state.value).toBe('idle')
    control.scope.stop()

    const front = setup({ preset: 'front', flip: false })
    front.part.toggle()
    expect(front.part.reset()).toBe(true)
    expect(front.written[0]!.front).toEqual(defaultValleLayouts().front)
    expect(front.written[0]!.control).toBe(CHANGED.control)
    expect(front.toasts).toEqual(['Work front is back to its preset'])
    expect(front.log).toEqual(['layouts', 'splitter', 'split-off', 'toast'])
    expect(front.part.state.value).toBe('idle')
    front.scope.stop()
  })

  it('[S37.01] the menu opens only outside a dive or a climb, and a swap does not stop it', () => {
    for (const kind of ['diving', 'climbing'] as const) {
      const world = setup({ motion: { kind, mineId: MINE, inMosaic: true, held: null } })
      expect(world.part.offered.value).toBe(false)
      world.part.toggle()
      expect(world.part.state.value).toBe('idle')
      expect(world.part.reset()).toBe(false)
      expect(world.log).toEqual([])
      world.scope.stop()
    }
    const swap = setup({
      preset: 'front',
      motion: { kind: 'front-swapping', mineId: MINE, inMosaic: false, held: null }
    })
    expect(swap.part.offered.value).toBe(true)
    swap.part.toggle()
    expect(swap.part.state.value).toBe('menu-open')
    swap.scope.stop()
  })

  it('[S37.02] Esc or an outside press closes the menu and changes nothing; the "⋯" again closes it too', () => {
    const world = setup()
    expect(world.part.dismiss()).toBe(false)
    world.part.toggle()
    expect(world.part.menuOpen.value).toBe(true)
    expect(world.part.dismiss()).toBe(true)
    expect(world.part.state.value).toBe('idle')
    world.part.toggle()
    world.part.toggle()
    expect(world.part.state.value).toBe('idle')
    expect(world.log).toEqual([])
    expect(world.toasts).toEqual([])
    expect(world.view.value.layouts).toBe(CHANGED)
    world.scope.stop()
  })

  it('[S37.03, S37.05] the zones FLIP from where they stood: measured before the defaults, played after them with transform alone, then idle', () => {
    const world = setup({ preset: 'control' })
    world.part.toggle()
    world.part.reset()
    // Measured first, then the defaults applied.
    expect(world.log.slice(0, 2)).toEqual(['measure', 'layouts'])
    expect(world.part.state.value).toBe('resetting')
    world.render()
    expect(world.animated).toHaveLength(1)
    expect(world.animated[0]!.frames).toEqual([
      { transform: 'translate(-40px, 0px)', transformOrigin: '0 0' },
      { transform: 'none', transformOrigin: '0 0' }
    ])
    // The run ends on its duration (180 ms), not before.
    world.clock.advance(100)
    expect(world.part.state.value).toBe('resetting')
    world.clock.advance(100)
    expect(world.part.state.value).toBe('idle')
    world.scope.stop()
  })

  it('[S37.05] under reduced motion the FLIP resolves in the same frame and nothing is animated', () => {
    const world = setup({ reduced: true })
    world.part.toggle()
    world.part.reset()
    expect(world.part.state.value).toBe('resetting')
    world.clock.advance(10)
    expect(world.part.state.value).toBe('idle')
    world.render()
    expect(world.animated).toEqual([])
    world.scope.stop()
  })

  it('[S37.06] a failed layouts write ends the reset at once and the defaults stay applied for the session', async () => {
    const world = setup({ preset: 'front', taken: false })
    world.part.toggle()
    world.part.reset()
    expect(world.part.state.value).toBe('resetting')
    await Promise.resolve()
    await Promise.resolve()
    expect(world.part.state.value).toBe('idle')
    expect(world.view.value.layouts.front).toEqual(defaultValleLayouts().front)
    expect(world.toasts).toEqual(['Work front is back to its preset'])
    world.scope.stop()
  })
})
