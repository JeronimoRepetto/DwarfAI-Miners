// @vitest-environment jsdom
import type { HostFrame } from '@dwarfai/contracts'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VETA_MOTION, outwardOf, walkInFrames, walkOutFrames } from '../../lib/veta/choreography'
import {
  BORIN,
  DAIN,
  EREBOR,
  MORIA,
  dwarfWire,
  frame,
  mineWire,
  type VetaSnapshotData
} from '../../lib/veta/testing/vetaFixtures'
import { fakeAnimations, type FakeAnimations } from './testing/fakeAnimations'
import { mountVeta, shownRisen, type VetaWorld } from './testing/mountVeta'

/*
 * ISSUE-292 (TC-292-01, TC-292-02, TC-292-04; 07 machine 26; UC-050): a chamber in the shown Veta window as dwarfs arrive
 * and leave, over the generated fake `window.api` relaying fixture frames. The motion plays on a hand-written Web
 * Animations stand-in that ends a run only when the test says so, so what the window asks of UI main can be read
 * against what is moving at that moment. Anchored at the right end of the bottom edge (`VETA_PLACE`).
 */

const ONE_MINE: VetaSnapshotData = {
  minesEverKnown: true,
  mines: [mineWire(MORIA), mineWire(EREBOR)],
  dwarfs: [dwarfWire(BORIN, MORIA, { status: 'working' })]
}

const TWO_MINES: VetaSnapshotData = {
  minesEverKnown: true,
  mines: [mineWire(MORIA), mineWire(EREBOR)],
  dwarfs: [dwarfWire(BORIN, MORIA, { status: 'working' }), dwarfWire(DAIN, EREBOR)]
}

let world: VetaWorld | undefined
let motion: FakeAnimations | undefined
afterEach(() => {
  world?.unmount()
  world = undefined
  motion?.restore()
  motion = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const dwarf = (dwarfId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-veta-dwarf][data-dwarf-id="${dwarfId}"]`)
const chamberOf = (mineId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-veta-chamber][data-mine-id="${mineId}"]`)

const arrives = (seq: number, dwarfId = DAIN, status: 'working' | 'idle' = 'working'): HostFrame =>
  frame(seq, 'dwarf.arrived', { dwarf: dwarfWire(dwarfId, MORIA, { status }), announce: true })

/** Ends every motion in flight, and what each one's end starts, until nothing moves. */
async function finishMotion(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    motion!.finishAll()
    await flushPromises()
    if (motion!.live().length === 0) return
  }
}

/** The island from expand to grip with k dwarfs in one chamber: 4 + 2 × 36 + 22 + 36k + 4(k − 1) px. */
const islandOf = (dwarfs: number): number => 4 + 72 + 22 + 36 * dwarfs + 4 * (dwarfs - 1)

describe('VetaChamber in the shown Veta window (machine 26)', () => {
  it('[US-OBS-002.AC06] an arrival in a shown mine brightens the chamber’s lamp and widens the island for it', async () => {
    motion = fakeAnimations()
    const resizes: string[] = []
    world = await mountVeta(ONE_MINE, {
      motion: true,
      onLayout(request) {
        if (request.kind === 'island-resize') {
          resizes.push(`${request.length}:${dwarf(DAIN) === null ? 'not drawn' : 'drawn'}`)
        }
      }
    })
    expect(chamberOf(MORIA)!.querySelector('[data-veta-lamp]')!.classList).not.toContain('is-lit')

    await world.push([arrives(11)])
    // The window widened for it before it was drawn (S26.04, S21.19).
    expect(resizes).toContain(`${islandOf(2)}:not drawn`)
    expect(resizes.filter((r) => r.endsWith(':drawn'))).toEqual([])
    // The chamber's lamp brightens while the dwarf walks in, from 14 px at the chamber's far end over 360 ms.
    expect(chamberOf(MORIA)!.querySelector('[data-veta-lamp]')!.classList).toContain('is-lit')
    expect(dwarf(DAIN)?.dataset.walk).toBe('in')
    const walk = motion.live().find((run) => run.element === dwarf(DAIN))!
    expect(walk.keyframes).toEqual(walkInFrames(outwardOf(false, true)))
    expect(walk.options).toMatchObject({
      duration: VETA_MOTION.walkIn.ms,
      easing: VETA_MOTION.easeOut
    })

    await finishMotion()
    expect(dwarf(DAIN)!.dataset.walk).toBeUndefined()
    expect(chamberOf(MORIA)!.querySelector('[data-veta-lamp]')!.classList).not.toContain('is-lit')
  })

  it('[US-MINE-009.AC06, US-VETA-008.AC06, NFR-SND-03] Veta plays no footsteps, helmet clink or ambience on an arrival or a departure', async () => {
    motion = fakeAnimations()
    const played = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const opened: string[] = []
    const RealAudio = window.Audio
    window.Audio = class extends RealAudio {
      constructor(src?: string) {
        super(src)
        opened.push(String(src))
      }
    } as typeof Audio
    try {
      world = await mountVeta(ONE_MINE, { motion: true })
      await world.push([arrives(11)])
      expect(motion.live().some((run) => run.element === dwarf(DAIN))).toBe(true)
      await finishMotion()
      await world.push([
        frame(12, 'dwarf.departed', { dwarfId: DAIN, mineId: MORIA, cause: 'stopped' })
      ])
      expect(dwarf(DAIN)?.dataset.walk).toBe('out')
      await finishMotion()
      expect(dwarf(DAIN)).toBeNull()
      // Nothing was opened or played: no footstep, no helmet clink, no ambience.
      expect(opened).toEqual([])
      expect(played).not.toHaveBeenCalled()
    } finally {
      window.Audio = RealAudio
    }
  })

  it('[US-VETA-008.AC05, S24.10, S24.11] a risen chat of a departing dwarf turns read-only or closes by cause as the dwarf walks out', async () => {
    // The risen window plays its own CSS motion bounded by a watchdog (ISSUE-290): its time is the test's to advance.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame'] })
    const tick = async (ms: number): Promise<void> => {
      for (let at = 0; at < ms; at += 20) {
        vi.advanceTimersByTime(20)
        await flushPromises()
      }
    }
    motion = fakeAnimations()
    world = await mountVeta(TWO_MINES, { motion: true })
    dwarf(BORIN)!.click()
    await tick(400)
    expect(shownRisen()).toBe('shown')

    // Stopped: the chat stays, read-only, while its dwarf turns and walks out away from the anchor.
    await world.push([
      frame(11, 'dwarf.departed', { dwarfId: BORIN, mineId: MORIA, cause: 'stopped' })
    ])
    expect(document.querySelector<HTMLElement>('[data-veta-risen]')!.dataset.state).toBe(
      'read-only'
    )
    expect(dwarf(BORIN)?.dataset.walk).toBe('out')
    const out = motion.live().find((run) => run.element === dwarf(BORIN))!
    expect(out.keyframes).toEqual(walkOutFrames(outwardOf(false, true)))
    expect(out.options).toMatchObject({
      duration: VETA_MOTION.walkOut.ms,
      easing: VETA_MOTION.easeIn,
      fill: 'forwards'
    })
    await finishMotion()
    expect(dwarf(BORIN)).toBeNull()

    // Its mine removed: the chat closes as the dwarf walks out.
    dwarf(DAIN)!.click()
    await tick(400)
    expect(shownRisen()).toBe('shown')
    await world.push([
      frame(12, 'dwarf.departed', { dwarfId: DAIN, mineId: EREBOR, cause: 'mine-removed' })
    ])
    expect(dwarf(DAIN)?.dataset.walk).toBe('out')
    await tick(200)
    expect(shownRisen()).toBe('none')
    expect(dwarf(DAIN)?.dataset.walk).toBe('out')
    await finishMotion()
    vi.useRealTimers()
  })

  it('[US-VETA-007.AC05] an arrival while Veta is shown plays its in-world reaction and shows no toast in Veta', async () => {
    motion = fakeAnimations()
    world = await mountVeta(ONE_MINE, { motion: true })
    await world.push([arrives(11)])
    // Veta's own reaction: the chamber's lamp and the walk-in.
    expect(chamberOf(MORIA)!.querySelector('[data-veta-lamp]')!.classList).toContain('is-lit')
    expect(motion.live().some((run) => run.element === dwarf(DAIN))).toBe(true)
    // The "<dwarf> started in <mine>" toast is the Panel's and Valle's, never Veta's.
    expect(document.querySelector('.dm-toast')).toBeNull()
    await finishMotion()
    expect(document.querySelector('.dm-toast')).toBeNull()
  })

  it('[ADR-025, NFR-PERF-02] the window grows before a growth and shrinks after a shrink, never during a motion', async () => {
    motion = fakeAnimations()
    const asked: Array<{ kind: string; length: number | null; moving: number; drawn: boolean }> = []
    world = await mountVeta(ONE_MINE, {
      motion: true,
      onLayout(request) {
        asked.push({
          kind: request.kind,
          length: request.kind === 'island-resize' ? request.length : null,
          moving: motion!.live().length,
          drawn: dwarf(DAIN) !== null
        })
      }
    })
    asked.length = 0

    await world.push([arrives(11)])
    await finishMotion()
    const grown = asked.findIndex((a) => a.kind === 'island-resize' && a.length === islandOf(2))
    expect(grown).toBeGreaterThanOrEqual(0)
    expect(asked[grown]!.drawn).toBe(false)

    asked.length = 0
    await world.push([
      frame(12, 'dwarf.departed', { dwarfId: DAIN, mineId: MORIA, cause: 'stopped' })
    ])
    // While it walks out the window keeps its size.
    expect(dwarf(DAIN)?.dataset.walk).toBe('out')
    expect(asked.filter((a) => a.kind === 'island-resize')).toEqual([])
    await finishMotion()
    const shrunk = asked.find((a) => a.kind === 'island-resize' && a.length === islandOf(1))
    expect(shrunk).toMatchObject({ drawn: false })

    // Not once was the window asked to change while anything moved.
    expect(asked.filter((a) => a.moving > 0)).toEqual([])
  })
})
