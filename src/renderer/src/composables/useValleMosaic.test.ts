import type {
  DwarfWire,
  MineId,
  MineWire,
  UiPreferenceWrite,
  ZoneContent
} from '@dwarfai/contracts'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, shallowRef, type EffectScope } from 'vue'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import { defaultValleLayouts, type ValleLayouts, type VallePreset } from '../lib/valle/preset'
import type { ValleFact } from '../lib/valle/valleReadModel'
import {
  BORIN,
  DAIN,
  EREBOR,
  IRONHILLS,
  KHAZAD,
  MORIA,
  dwarfWire,
  mineWire
} from '../lib/veta/testing/vetaFixtures'
import type { MineDeclareResult } from '../types'
import { DECLARE_UNREACHABLE } from './useProjectBrowse'
import { useValleMosaic } from './useValleMosaic'
import { VALLE_STORE_DEFAULTS, type ValleStores } from './useValleStores'

/*
 * The mosaic and the zones in use (ISSUE-304; 07 machines 31, 32; UC-058) over the generated fake `window.api` with
 * scripted `declareMine` outcomes: every change is written at once through A-N21 (TC-304-01), a closed column reaches
 * nothing but the stores (TC-304-02), and "A new project…" runs the ordinary folder flow (A-30, A-31) and appends its
 * mine without opening the Add panel.
 */

const NEW_MINE = '01920000-0000-7000-8000-00000000a0ff' as MineId

let scope: EffectScope | undefined
afterEach(() => {
  scope?.stop()
  scope = undefined
})

/** The fake `window.api`, as the generated fake types it. */
type WindowApi = ReturnType<typeof createFakeWindowApi>

interface World {
  api: WindowApi
  /** Every `window.api` member called, in order. */
  called: string[]
  writes: UiPreferenceWrite[]
}

/** The fake `window.api`, every member call recorded, A-N21 answering what it was given. */
function fakeApi(declare: () => Promise<MineDeclareResult>, adopt = declare): World {
  const called: string[] = []
  const writes: UiPreferenceWrite[] = []
  const inner = createFakeWindowApi({
    setUiPreference: (write) => {
      writes.push(write as UiPreferenceWrite)
      return Promise.resolve(write) as never
    },
    declareMine: () => declare() as never,
    declareMainProject: () => adopt() as never
  })
  const api = new Proxy(inner, {
    get(target, key, receiver) {
      const member = Reflect.get(target, key, receiver) as unknown
      if (typeof key !== 'string' || typeof member !== 'function') return member
      return (...args: unknown[]) => {
        called.push(key)
        return (member as (...a: unknown[]) => unknown)(...args)
      }
    }
  })
  return { api, called, writes }
}

interface Options {
  stores?: Partial<ValleStores>
  mines?: readonly MineWire[]
  dwarfs?: readonly DwarfWire[]
  preset?: VallePreset
  /** A-30's scripted answer; it may publish a mine into the Host's facts first, as the Host does (B-F06). */
  declare?: (mines: { value: readonly MineWire[] }) => Promise<MineDeclareResult>
  adopt?: () => Promise<MineDeclareResult>
}

function setup(options: Options = {}) {
  const mines = shallowRef<readonly MineWire[]>(
    options.mines ?? [mineWire(MORIA), mineWire(EREBOR), mineWire(KHAZAD), mineWire(IRONHILLS)]
  )
  const declare = options.declare ?? (() => Promise.resolve({ outcome: 'cancelled' }))
  const world = fakeApi(() => declare(mines), options.adopt)
  const stores = shallowRef<ValleStores>({ ...VALLE_STORE_DEFAULTS, ...options.stores })
  const dwarfs = shallowRef<readonly DwarfWire[]>(
    options.dwarfs ?? [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, KHAZAD)]
  )
  const listeners = new Set<(facts: readonly ValleFact[]) => void>()
  const factsRead = shallowRef(false)
  const layouts = shallowRef<ValleLayouts>(defaultValleLayouts())
  const layoutWrites: ValleLayouts[] = []
  const dives: MineId[] = []
  const toasts: string[] = []
  const scrolled: MineId[] = []
  scope = effectScope()
  const mosaic = scope.run(() =>
    useValleMosaic({
      // The members it uses, each over the page's `window.api` as the Valle root's bridge maps them.
      bridge: {
        setUiPreference: (write) => world.api.setUiPreference(write),
        declareMine: () => world.api.declareMine(),
        declareMainProject: () => world.api.declareMainProject()
      },
      stores,
      model: {
        mines,
        dwarfs,
        onFacts: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      },
      factsRead,
      view: () => ({ preset: options.preset ?? 'control', layouts: layouts.value }),
      frontMine: () => MORIA,
      writeLayouts: (next) => {
        layouts.value = next
        layoutWrites.push(next)
      },
      dive: (mineId) => dives.push(mineId),
      showToast: (text) => toasts.push(text),
      scrollTo: (mineId) => scrolled.push(mineId)
    })
  )!
  const hear = (facts: readonly ValleFact[]): void =>
    listeners.forEach((listener) => listener(facts))
  return {
    ...world,
    mosaic,
    stores,
    mines,
    dwarfs,
    factsRead,
    layouts,
    layoutWrites,
    dives,
    toasts,
    scrolled,
    hear
  }
}

/**
 * A declare that adds `NEW_MINE`: the Host publishes the new mine (B-F06) with its answer (UC-058), so the read model
 * holds it by the time the answer lands.
 */
function declaresNewMine(mines: { value: readonly MineWire[] }): Promise<MineDeclareResult> {
  mines.value = [...mines.value, mineWire(NEW_MINE)]
  return Promise.resolve({ outcome: 'added', mineId: NEW_MINE })
}

const orderWrites = (writes: readonly UiPreferenceWrite[]) =>
  writes.filter((write) => write.key === 'valleMosaicOrder').map((write) => write.value)

/** A world opened on a stored order, the Host's facts read. */
async function opened(order: readonly MineId[], options: Options = {}) {
  const world = setup({ ...options, stores: { mosaicOrder: [...order], ...options.stores } })
  world.factsRead.value = true
  await flushPromises()
  return world
}

describe('the Valle mosaic and its zones in use (ISSUE-304)', () => {
  it('[US-VALLE-006.AC03, S32.08, S32.10, S32.11] A new project… opens the ordinary folder picker and the new mine joins the mosaic', async () => {
    const world = await opened([MORIA], { declare: declaresNewMine })
    world.mosaic.openSlot()
    world.mosaic.newProject()
    await flushPromises()
    // The ordinary A-30 (US-MINES-004): UI main opens the OS folder picker over this window and declares the folder.
    expect(world.called.filter((member) => member === 'declareMine')).toHaveLength(1)
    expect(world.mosaic.order.value).toEqual([MORIA, NEW_MINE])
    expect(orderWrites(world.writes)).toEqual([[MORIA, NEW_MINE]])
    expect(world.mosaic.state.value).toBe('idle')

    // A worktree of a known project: the question first, then A-31 folds it into that project's mine, which joins.
    const worktree = await opened([MORIA], {
      declare: () =>
        Promise.resolve({
          outcome: 'worktree-of',
          worktreeOf: { worktree: '/work/erebor-wt', root: '/work/erebor', branch: 'spike' }
        } as MineDeclareResult),
      adopt: () => Promise.resolve({ outcome: 'added', mineId: EREBOR })
    })
    worktree.mosaic.openSlot()
    worktree.mosaic.newProject()
    await flushPromises()
    expect(worktree.mosaic.worktree.value).not.toBeNull()
    worktree.mosaic.answerWorktree(true)
    await flushPromises()
    expect(worktree.called).toContain('declareMainProject')
    expect(worktree.mosaic.order.value).toEqual([MORIA, EREBOR])
  })

  it('[US-VALLE-006.AC04, S32.09] cancelling the folder picker adds nothing and the mosaic is unchanged', async () => {
    const world = await opened([MORIA, KHAZAD], {
      declare: () => Promise.resolve({ outcome: 'cancelled' })
    })
    world.mosaic.openSlot()
    world.mosaic.newProject()
    await flushPromises()
    expect(world.mosaic.order.value).toEqual([MORIA, KHAZAD])
    expect(orderWrites(world.writes)).toEqual([])
    expect(world.mosaic.state.value).toBe('idle')
    expect(world.mosaic.notice.value).toBeNull()
  })

  it('[US-VALLE-006.AC07, S32.11] a mine just created there never opens the Add panel by itself', async () => {
    const world = await opened([MORIA], { declare: declaresNewMine })
    world.mosaic.openSlot()
    world.mosaic.newProject()
    await flushPromises()
    expect(world.mosaic.order.value).toEqual([MORIA, NEW_MINE])
    // No Add panel: no pin written, no session patch (Valle's Add pins are the session's), no move, no dive.
    expect(world.called).toEqual(['declareMine', 'setUiPreference'])
    expect(world.writes.map((write) => write.key)).toEqual(['valleMosaicOrder'])
    expect(world.dives).toEqual([])
    expect(world.mosaic.slot.value).toBeNull()
  })

  it('[S32.12] a refused folder shows the Mines page error and adds nothing', async () => {
    const refused = await opened([MORIA], {
      declare: () => Promise.resolve({ outcome: 'failed', reason: 'That folder is not a folder.' })
    })
    refused.mosaic.openSlot()
    refused.mosaic.newProject()
    await flushPromises()
    expect(refused.mosaic.notice.value).toBe('That folder is not a folder.')
    expect(refused.mosaic.order.value).toEqual([MORIA])
    expect(orderWrites(refused.writes)).toEqual([])
    expect(refused.mosaic.state.value).toBe('idle')

    // UI main out of reach: the Mines page's own line for a bridge that never answered.
    const unreachable = await opened([MORIA], {
      declare: () => Promise.reject(new Error('gone'))
    })
    unreachable.mosaic.openSlot()
    unreachable.mosaic.newProject()
    await flushPromises()
    expect(unreachable.mosaic.notice.value).toBe(DECLARE_UNREACHABLE)
    expect(unreachable.mosaic.order.value).toEqual([MORIA])
    // The next add slot opened clears it.
    unreachable.mosaic.openSlot()
    expect(unreachable.mosaic.notice.value).toBeNull()
  })

  // TC-304-01, TC-304-02.
  it('[US-VALLE-009.AC03, S31.09, S32.03] Close this column writes the order and raises its toast, and nothing reaches the Host', async () => {
    const world = await opened([MORIA, KHAZAD])
    world.mosaic.openMenu({ preset: 'control', mineId: KHAZAD })
    world.mosaic.pickMenu('close')
    await flushPromises()
    expect(world.mosaic.order.value).toEqual([MORIA])
    expect(orderWrites(world.writes)).toEqual([[MORIA]])
    expect(world.toasts).toEqual(['khazad left the Control room · its dwarfs keep working'])
    // Only the stores were written: no Host call, so the mine, its dwarfs and their sessions are untouched.
    expect(world.called).toEqual(['setUiPreference'])
    expect(world.mosaic.menu.value).toBeNull()
  })

  // TC-304-01.
  it('[US-VALLE-009.AC01, S31.03, S31.05, S31.08, S31.07] the zone menu swaps a zone in its slot, toggles the ambience and dives, each written at once', async () => {
    const world = await opened([MORIA, KHAZAD])
    const zones = (): Record<string, ZoneContent> =>
      Object.fromEntries(
        Object.entries(world.layouts.value.control.zones).map(([id, zone]) => [id, zone.content])
      )
    world.mosaic.openMenu({ preset: 'control', mineId: KHAZAD })
    world.mosaic.pickMenu('show-history')
    expect(world.mosaic.contentOf(KHAZAD)).toBe('history')
    expect(zones()).toEqual({ [KHAZAD]: 'history' })
    // Its column keeps its place in the mosaic (a zone never leaves its slot).
    expect(world.mosaic.order.value).toEqual([MORIA, KHAZAD])

    world.mosaic.openMenu({ preset: 'control', mineId: MORIA })
    world.mosaic.pickMenu('ambience')
    await flushPromises()
    expect(world.mosaic.isMuted(MORIA)).toBe(true)
    expect(world.writes.filter((write) => write.key === 'mutedMineIds')).toEqual([
      { key: 'mutedMineIds', value: [MORIA] }
    ])

    world.mosaic.openMenu({ preset: 'control', mineId: MORIA })
    world.mosaic.pickMenu('dive')
    expect(world.dives).toEqual([MORIA])

    // The Work front's one zone: its content is the Work front layout's own.
    const front = await opened([MORIA], { preset: 'front' })
    front.mosaic.openMenu({ preset: 'front' })
    front.mosaic.pickMenu('show-map')
    expect(front.mosaic.frontContent.value).toBe('map')
    expect(front.layouts.value.front.zone).toEqual({ content: 'map', mineId: MORIA })
    expect(front.layouts.value.control.zones).toEqual({})
  })

  it('[US-VALLE-009.AC06, US-VALLE-006.AC06, S31.02, S32.07] Esc closes an open menu or slot menu and changes nothing else', async () => {
    const world = await opened([MORIA])
    expect(world.mosaic.dismiss()).toBe(false)
    world.mosaic.openMenu({ preset: 'control', mineId: MORIA })
    expect(world.mosaic.menu.value).not.toBeNull()
    expect(world.mosaic.dismiss()).toBe(true)
    expect(world.mosaic.menu.value).toBeNull()
    world.mosaic.openSlot()
    expect(world.mosaic.slot.value).not.toBeNull()
    expect(world.mosaic.dismiss()).toBe(true)
    expect(world.mosaic.slot.value).toBeNull()
    expect(world.writes).toEqual([])
    expect(world.layoutWrites).toEqual([])
  })

  it('[S32.01, S32.02, S32.13, S32.16] the first open writes the first order, a removed mine leaves, and Reset metrics opens it anew', async () => {
    const world = setup()
    // Before the Host's facts are read, nothing is computed (07 S32.02 needs them).
    expect(world.mosaic.order.value).toEqual([])
    world.factsRead.value = true
    await flushPromises()
    expect(world.mosaic.order.value).toEqual([MORIA, KHAZAD])
    expect(orderWrites(world.writes)).toEqual([[MORIA, KHAZAD]])

    // S32.13: the Host removed a mosaic mine: its column leaves, the entry is dropped and written.
    world.hear([{ kind: 'mine-removed', mineId: KHAZAD }])
    expect(world.mosaic.order.value).toEqual([MORIA])
    expect(orderWrites(world.writes).at(-1)).toEqual([MORIA])

    // S32.16: Reset metrics rewrote the order to "never written"; read again, the first order applies anew.
    world.dwarfs.value = [dwarfWire(BORIN, IRONHILLS)]
    world.stores.value = { ...VALLE_STORE_DEFAULTS }
    await flushPromises()
    expect(world.mosaic.order.value).toEqual([IRONHILLS])
  })
})

// APPENDED for ISSUE-309: "Reset preset" in the Control room recomputes the order (07 S32.15) and closes what is open
// (S31.12), the one writer of `valleMosaicOrder` still.
describe('the mosaic recomputed by Reset preset (ISSUE-309)', () => {
  it('[US-VALLE-010.AC03, S32.15] resetting the Control room writes every mine with a crew in data order, closes an open menu and nothing reaches the Host', async () => {
    // The person's own order: Khazad first, Erebor (no crew) added.
    const world = await opened([KHAZAD, EREBOR, MORIA])
    world.mosaic.openMenu({ preset: 'control', mineId: KHAZAD })
    expect(world.mosaic.menu.value).not.toBeNull()
    world.called.length = 0

    expect(world.mosaic.resetPreset()).toBe(true)
    expect(world.mosaic.order.value).toEqual([MORIA, KHAZAD])
    expect(orderWrites(world.writes)).toEqual([[MORIA, KHAZAD]])
    expect(world.mosaic.menu.value).toBeNull()
    expect(world.mosaic.state.value).toBe('idle')
    expect(world.called).toEqual(['setUiPreference'])
  })

  it("[US-VALLE-010.AC03, S32.15] the slot's menu is closed first and a reset in the Work front recomputes nothing", async () => {
    const world = await opened([KHAZAD])
    world.mosaic.openSlot()
    expect(world.mosaic.slot.value).not.toBeNull()
    expect(world.mosaic.resetPreset()).toBe(true)
    expect(world.mosaic.slot.value).toBeNull()
    expect(world.mosaic.order.value).toEqual([MORIA, KHAZAD])

    const front = await opened([KHAZAD], { preset: 'front' })
    expect(front.mosaic.resetPreset()).toBe(false)
    expect(front.mosaic.order.value).toEqual([KHAZAD])
    expect(orderWrites(front.writes)).toEqual([])
  })
})
