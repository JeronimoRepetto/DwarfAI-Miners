// @vitest-environment jsdom
import type {
  HostFrame,
  MoveToModeParams,
  VetaLayoutRequest,
  VetaLayoutResult
} from '@dwarfai/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeWindowApi } from '../../../../contracts/ipc/testing/fakeWindowApi'
import { FRAME_CLOCK_KEY } from '../../composables/useFramePlayer'
import { createFrameClock, type FrameClock } from '../../lib/sprite/frameClock'
import { checkIdleBudget } from '../../lib/sprite/idleBudget'
import { FakeTickSource, fakeFrameClockEnv } from '../../lib/sprite/testing/FakeTickSource'
import { lanternLoop } from '../../lib/veta/lantern'
import {
  BORIN,
  DAIN,
  EREBOR,
  frame,
  MORIA,
  dwarfWire,
  mineWire,
  snapshotPage,
  type VetaSnapshotData
} from '../../lib/veta/testing/vetaFixtures'
import VetaApp from './VetaApp.vue'

/*
 * ISSUE-287 (TC-287-02, TC-287-04): the Veta root draws the life state machine 20 derives from the Host facts: the
 * closed entrance with no sessions (with "+" on first run), the chambers otherwise, parts from the anchor outward. The
 * generated fake `window.api` stands in for UI main and the Host, with fixture snapshots and frames; sprites play on a
 * frame clock over a `FakeTickSource` that counts what subscribes to it.
 */

/** A frame clock that counts the sprites playing on it. */
function countingClock(): { clock: FrameClock; playing(): number } {
  const inner = createFrameClock(fakeFrameClockEnv(new FakeTickSource()).env)
  const active = new Set<object>()
  const clock: FrameClock = {
    player(onFrame) {
      const player = inner.player(onFrame)
      const handle = {
        play: (...args: Parameters<typeof player.play>) => {
          active.add(handle)
          player.play(...args)
        },
        stop: () => {
          active.delete(handle)
          player.stop()
        }
      }
      return handle
    },
    dispose: () => inner.dispose()
  }
  return { clock, playing: () => active.size }
}

interface VetaWorld {
  root: VueWrapper
  moves: MoveToModeParams[]
  layouts: VetaLayoutRequest[]
  push(frames: HostFrame[]): Promise<void>
  playing(): number
}

const PLACE: VetaLayoutResult = {
  applied: true,
  displayKey: 'Q27G2WG4|2560x1440|@1|0,0',
  dock: { edge: 'bottom', end: 'end', offset: 16 }
}

async function mountVeta(data: VetaSnapshotData): Promise<VetaWorld> {
  const moves: MoveToModeParams[] = []
  const layouts: VetaLayoutRequest[] = []
  const listeners = new Set<(frames: HostFrame[]) => void>()
  ;(window as unknown as { api: unknown }).api = createFakeWindowApi({
    getHostSnapshot: () => Promise.resolve(snapshotPage(10, data)) as never,
    onHostEvent: (listener) => {
      listeners.add(listener as (frames: HostFrame[]) => void)
      return () => listeners.delete(listener as (frames: HostFrame[]) => void)
    },
    moveToMode: (request) => {
      moves.push(request as MoveToModeParams)
      return Promise.resolve({ ok: true, value: undefined })
    },
    layoutVeta: (request) => {
      layouts.push(request as VetaLayoutRequest)
      return Promise.resolve(PLACE)
    }
  })
  const { clock, playing } = countingClock()
  const root = mount(VetaApp, {
    attachTo: document.body,
    global: { provide: { [FRAME_CLOCK_KEY as symbol]: clock } }
  })
  await flushPromises()
  return {
    root,
    moves,
    layouts,
    playing,
    async push(frames) {
      for (const listener of [...listeners]) listener(frames)
      await flushPromises()
    }
  }
}

let mounted: VueWrapper | undefined
beforeEach(() => {
  mounted = undefined
})
afterEach(() => {
  mounted?.unmount()
  delete (window as unknown as { api?: unknown }).api
  vi.restoreAllMocks()
})

describe('the Veta strip (07 machine 20; ISSUE-287)', () => {
  it('[US-VETA-001.AC03, US-VETA-011.AC04, S20.12] in no-sessions the entrance is the one click target and a click, Enter or Space moves to the Panel with no mine; no ▲ is drawn', async () => {
    const veta = await mountVeta({ minesEverKnown: true, mines: [mineWire(MORIA)], dwarfs: [] })
    mounted = veta.root
    const island = veta.root.get('[data-veta-island]')
    // The closed entrance is the only part: no expand, no chamber, no grip.
    const targets = island.findAll('button')
    expect(targets).toHaveLength(1)
    const entrance = island.get('[data-veta-entrance]')
    expect(targets[0]!.element).toBe(entrance.element)
    expect(island.find('[data-veta-expand]').exists()).toBe(false)
    expect(island.find('[data-veta-grip]').exists()).toBe(false)
    expect(island.find('[data-veta-chamber]').exists()).toBe(false)
    expect(island.text()).not.toContain('▲')
    expect(entrance.attributes('aria-label')).toBe('No sessions running. Open the Panel')
    expect(entrance.attributes('title')).toBe('No sessions · open the Panel')
    expect(entrance.attributes('data-first')).toBe('false')

    await entrance.trigger('click')
    await entrance.trigger('keydown', { key: 'Enter' })
    await entrance.trigger('keydown', { key: ' ' })
    await flushPromises()
    expect(veta.moves).toEqual([{ mode: 'panel' }, { mode: 'panel' }, { mode: 'panel' }])
    // The window hugs the closed entrance.
    expect(veta.layouts.at(-1)).toEqual({ kind: 'island-resize', length: 80 })
  })

  it('[US-VETA-001.AC04, S20.13] on first run the entrance carries + and its activation asks for the empty mine picker, never the Panel', async () => {
    const veta = await mountVeta({ minesEverKnown: false, mines: [], dwarfs: [] })
    mounted = veta.root
    const entrance = veta.root.get('[data-veta-entrance]')
    expect(entrance.attributes('data-first')).toBe('true')
    expect(entrance.attributes('aria-label')).toBe('No mines yet. Add your first mine')
    expect(entrance.attributes('title')).toBe('Add your first mine')
    expect(entrance.find('[data-veta-plus]').exists()).toBe(true)
    await entrance.trigger('click')
    await flushPromises()
    expect(veta.moves).toEqual([])
    // AMENDED for ISSUE-288 (was: the entrance only emitted the intent until the picker landed): the empty picker opens.
    expect(document.querySelector('[data-mine-picker] .dm-picker__none')?.textContent).toBe(
      'No mines yet. Add a project folder to start.'
    )
  })

  it('[US-VETA-001.AC01] a chamber holding an asking dwarf lights its lamp and outline, the dwarf raises ?, and mines keep their order', async () => {
    const veta = await mountVeta({
      minesEverKnown: true,
      mines: [mineWire(MORIA), mineWire(EREBOR)],
      dwarfs: [
        dwarfWire(BORIN, MORIA, { status: 'working' }),
        dwarfWire(DAIN, EREBOR, { status: 'asking', needsYou: true })
      ]
    })
    mounted = veta.root
    const island = veta.root.get('[data-veta-island]')
    expect(island.attributes('aria-label')).toBe('Veta')
    expect(island.attributes('role')).toBe('region')
    // Anchored at the end of the bottom edge, DOM order is visual order: grip, the chambers last-seen first, expand.
    const parts = () =>
      island
        .findAll('[data-veta-part]')
        .map((p) => p.attributes('data-veta-part') + (p.attributes('data-mine-id') ?? ''))
    expect(parts()).toEqual(['grip', 'chamber' + EREBOR, 'chamber' + MORIA, 'expand'])
    const chamber = (id: string) => island.get(`[data-veta-chamber][data-mine-id="${id}"]`)
    expect(chamber(EREBOR).attributes('data-attention')).toBe('true')
    expect(chamber(EREBOR).attributes('aria-label')).toBe(
      'Mine erebor, Silver, 1 dwarf, 1 needs you'
    )
    expect(chamber(EREBOR).find('[data-veta-lamp]').classes()).toContain('is-lit')
    expect(chamber(MORIA).attributes('data-attention')).toBe('false')
    expect(chamber(MORIA).find('[data-veta-lamp]').classes()).not.toContain('is-lit')
    const asker = chamber(EREBOR).get(`[data-veta-dwarf][data-dwarf-id="${DAIN}"]`)
    expect(asker.attributes('data-status')).toBe('asking')
    expect(asker.get('[data-veta-ask]').text()).toBe('?')
    expect(chamber(MORIA).find('[data-veta-ask]').exists()).toBe(false)
    const expand = island.get('[data-veta-expand]')
    expect(expand.attributes('aria-label')).toBe('Open the Panel')
    expect(expand.attributes('title')).toBe('Open the Panel')

    // Moria's dwarf asks too: it lights in place, and no chamber moves.
    await veta.push([
      frame(11, 'dwarf.changed', {
        dwarf: dwarfWire(BORIN, MORIA, { status: 'asking', needsYou: true })
      })
    ])
    expect(chamber(MORIA).attributes('data-attention')).toBe('true')
    expect(parts()).toEqual(['grip', 'chamber' + EREBOR, 'chamber' + MORIA, 'expand'])
    // Expand: one click back to the Panel.
    await expand.trigger('click')
    await flushPromises()
    expect(veta.moves).toEqual([{ mode: 'panel' }])
  })

  it('[US-VETA-001.AC06, NFR-PERF-04] the no-sessions entrance runs only the lantern loop and subscribes nothing to the frame clock', async () => {
    const animations: Keyframe[][] = []
    const animate = vi.fn(function (this: Element, keyframes: Keyframe[]) {
      animations.push(keyframes)
      return { cancel: () => undefined } as unknown as Animation
    })
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      writable: true,
      value: animate
    })
    try {
      const veta = await mountVeta({ minesEverKnown: true, mines: [mineWire(MORIA)], dwarfs: [] })
      mounted = veta.root
      const loops = veta.root.findAll('[data-veta-loop]')
      expect(loops.map((l) => l.attributes('data-veta-loop'))).toEqual(['dm-lantern'])
      const lantern = lanternLoop(false)
      // The browser plays it: one keyframe animation, the lantern's own.
      expect(animations).toEqual([lantern.keyframes])
      expect(veta.playing()).toBe(0)
      expect(checkIdleBudget({ loops: [lantern], clockSubscriptions: veta.playing() })).toEqual({
        ok: true
      })
    } finally {
      delete (HTMLElement.prototype as { animate?: unknown }).animate
    }
  })

  it('[NFR-PERF-03, S20.14] a status change inside a state patches the dwarf’s sheet and never rebuilds its element', async () => {
    const veta = await mountVeta({
      minesEverKnown: true,
      mines: [mineWire(MORIA)],
      dwarfs: [
        dwarfWire(BORIN, MORIA, { status: 'working' }),
        dwarfWire(DAIN, MORIA, { status: 'idle' })
      ]
    })
    mounted = veta.root
    const dain = () => veta.root.get(`[data-veta-dwarf][data-dwarf-id="${DAIN}"]`)
    const before = dain().element
    const sprite = dain().get('.dm-sprite').element
    expect(dain().attributes('data-status')).toBe('idle')
    expect(veta.playing()).toBe(2)

    await veta.push([
      frame(11, 'dwarf.changed', { dwarf: dwarfWire(DAIN, MORIA, { status: 'asleep' }) })
    ])
    expect(dain().element).toBe(before)
    expect(dain().get('.dm-sprite').element).toBe(sprite)
    expect(dain().attributes('data-status')).toBe('asleep')
    expect(dain().get('[data-veta-z]').text()).toBe('z')
    // Still sessions working, with both dwarfs on their one clock.
    expect(veta.root.get('[data-veta-root]').attributes('data-life')).toBe('sessions-working')
  })

  it('[NFR-A11Y-01] every part of the island draws the shared focus ring inside its frame, since the window hugs the island', async () => {
    // The design's precedent for a part flush with its container's edge: screens/valle.md, `.dm-vadd:focus-visible`.
    const closed = await mountVeta({ minesEverKnown: true, mines: [mineWire(MORIA)], dwarfs: [] })
    expect(closed.root.get('[data-veta-entrance]').classes()).toContain('dm-focus-inset')
    closed.root.unmount()

    const veta = await mountVeta({
      minesEverKnown: true,
      mines: [mineWire(MORIA)],
      dwarfs: [dwarfWire(BORIN, MORIA, { status: 'working' })]
    })
    mounted = veta.root
    const parts = veta.root.findAll('[data-veta-part]')
    expect(parts.map((p) => p.attributes('data-veta-part'))).toEqual(['grip', 'chamber', 'expand'])
    for (const part of parts) {
      expect(part.classes(), part.attributes('data-veta-part')).toContain('dm-focus-inset')
    }
  })
})
