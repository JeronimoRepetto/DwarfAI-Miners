// @vitest-environment jsdom
import type { DwarfId, DwarfRank, DwarfWire } from '@dwarfai/contracts'
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DWARF_SHEETS } from '../../lib/sprite/dwarfSheets'
import { SPRITE_FRAME_SIZE } from '../../lib/sprite/spriteSheet'
import { dwarfLabels } from '../../lib/veta/dwarfLabel'
import { BORIN, MORIA, dwarfWire, mineWire } from '../../lib/veta/testing/vetaFixtures'
import VetaChamber from './VetaChamber.vue'

/*
 * US-VETA-001.AC01 (DS/docs/components.md, Mine chamber; ISSUE-287): a Veta chamber holds each present dwarf at its full
 * 36 × 38 sprite size, one frame of its sheet at a time. The sprite is a one-cell box over the sheet's whole strip, so
 * the strip is drawn at the sheet's own frame count times one cell: drawn any narrower, the whole sheet is squeezed into
 * the box and every frame shows at once, side by side (the owner's live check, 2026-10-24, on asleep workers).
 */

const CELL = SPRITE_FRAME_SIZE.width

/** Every dwarf sheet's frame count, by the file it is drawn from. */
const FRAMES_OF = new Map<string, number>(
  Object.values(DWARF_SHEETS).flatMap((set) =>
    Object.values(set).map((sheet) => [sheet.src, sheet.frames] as const)
  )
)

let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** Under reduced motion every query for it answers yes. */
function reduceMotion(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false
  }))
}

interface Case {
  readonly status: DwarfWire['status']
  readonly rank: DwarfRank
  readonly walk?: 'waiting' | 'in' | 'out'
  readonly arrived?: boolean
}

function chamberWith(dwarf: DwarfWire, place: Case): VueWrapper {
  return mount(VetaChamber, {
    attachTo: document.body,
    props: {
      mine: mineWire(MORIA),
      dwarfs: [dwarf],
      attention: false,
      vertical: false,
      reverse: true,
      side: 'top',
      risen: false,
      openDwarf: null,
      labelsOf: (d: DwarfWire) => dwarfLabels(d, undefined),
      walking:
        place.walk === undefined
          ? undefined
          : new Map<DwarfId, 'waiting' | 'in' | 'out'>([[dwarf.id, place.walk]]),
      arrived: place.arrived === true ? new Set<DwarfId>([dwarf.id]) : undefined
    }
  })
}

/** The sprite box's width, and the strip's width against the one its sheet's frame count asks for. */
function drawn(view: VueWrapper): { box: string; strip: string; expected: string } {
  const box = view.get<HTMLElement>('.dm-sprite').element
  const strip = view.get<HTMLImageElement>('.dm-sprite__strip').element
  const frames = FRAMES_OF.get(strip.getAttribute('src') ?? '')
  return {
    box: box.style.width,
    strip: strip.style.width,
    expected: frames === undefined ? 'a dwarf sheet' : `${frames * CELL}px`
  }
}

const RANKS: readonly DwarfRank[] = ['worker', 'worker2', 'foreman']
const STATUSES: readonly DwarfWire['status'][] = ['working', 'idle', 'asking', 'asleep']

const CASES: readonly Case[] = RANKS.flatMap((rank) => [
  ...STATUSES.map((status) => ({ status, rank })),
  ...STATUSES.map((status) => ({ status, rank, arrived: true })),
  { status: 'asleep', rank, walk: 'waiting' },
  { status: 'working', rank, walk: 'in' },
  { status: 'asleep', rank, walk: 'out' }
])

const nameOf = (c: Case): string =>
  `${c.rank} ${c.status}${c.walk === undefined ? '' : ` walking ${c.walk}`}${c.arrived === true ? ' just arrived' : ''}`

describe('a dwarf drawn in a Veta chamber', () => {
  it.each(CASES.map((c) => [nameOf(c), c] as const))(
    '[US-VETA-001.AC01] %s shows one frame of its sheet: a one-cell box over the strip at frames × cell',
    (_name, place) => {
      wrapper = chamberWith(
        dwarfWire(BORIN, MORIA, { status: place.status, rank: place.rank }),
        place
      )
      const { box, strip, expected } = drawn(wrapper)
      expect(box).toBe(`${CELL}px`)
      expect(strip).toBe(expected)
    }
  )

  it.each(
    RANKS.flatMap((rank) =>
      STATUSES.map((status) => [`${rank} ${status}`, { status, rank }] as const)
    )
  )(
    '[US-VETA-001.AC01] %s under reduced motion still shows one frame of its sheet at frames × cell',
    (_name, place) => {
      reduceMotion()
      wrapper = chamberWith(
        dwarfWire(BORIN, MORIA, { status: place.status, rank: place.rank }),
        place
      )
      const { box, strip, expected } = drawn(wrapper)
      expect(box).toBe(`${CELL}px`)
      expect(strip).toBe(expected)
    }
  )

  it('[US-VETA-001.AC01] a worker falling asleep keeps its sprite element and shows one frame of the sleep sheet', async () => {
    const working = dwarfWire(BORIN, MORIA, { status: 'working', rank: 'worker' })
    wrapper = chamberWith(working, { status: 'working', rank: 'worker' })
    const before = wrapper.get('.dm-sprite__strip').element
    await wrapper.setProps({ dwarfs: [{ ...working, status: 'asleep' }] })
    const { box, strip, expected } = drawn(wrapper)
    expect(wrapper.get('.dm-sprite__strip').element).toBe(before)
    expect(box).toBe(`${CELL}px`)
    expect(strip).toBe(expected)
  })
})
