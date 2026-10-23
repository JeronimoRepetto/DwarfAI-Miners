import type { DwarfId, MineId, UiSessionPatch } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import type { ValleNavPage, VallePreset } from '../lib/valle/preset'
import { useValleReveal, type ValleRevealDeps } from './useValleReveal'

/*
 * The reveal of a notification click in Valle (07 S39.06, S39.07, S10.10, S10.11; ADR-025 item 8; ADR-018 item 6;
 * UC-064): through the composables that own each part, one writer per key, and never through the preset or the mode.
 * The parts, the mosaic's scroller and the window's visibility are hand-written fakes over one small Valle: a mosaic of
 * columns 300 px wide in a viewport 600 px wide.
 */
const MORIA = '01920000-0000-7000-8000-00000000a001' as MineId
const EREBOR = '01920000-0000-7000-8000-00000000a002' as MineId
const KHAZAD = '01920000-0000-7000-8000-00000000a003' as MineId
const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId
const DAIN = '01920000-0000-7000-8000-00000000d002' as DwarfId

const COLUMN = 300
const VIEWPORT = 600

function valle(options: {
  preset?: VallePreset
  page?: ValleNavPage | null
  mosaic?: MineId[]
  frontMine?: MineId | null
  present?: DwarfId[]
  shown?: boolean
  reduced?: boolean
}) {
  const state = {
    preset: options.preset ?? 'control',
    page: options.page ?? null,
    mosaic: [...(options.mosaic ?? [MORIA, EREBOR])],
    frontMine: options.frontMine ?? null,
    scrollLeft: 0,
    shown: options.shown ?? true,
    mode: 'valle' as const
  }
  const calls: string[] = []
  const scrolls: { left: number; behavior: ScrollBehavior }[] = []
  const patches: UiSessionPatch[] = []
  const present = new Set(options.present ?? [BORIN, DAIN])
  /** The reveal under test, which the fake mosaic calls back as useValleMosaic does. */
  const self: { reveal?: ReturnType<typeof useValleReveal> } = {}
  const deps: ValleRevealDeps = {
    view: () => ({ preset: state.preset, page: state.page, frontMine: state.frontMine }),
    present: (dwarfId) => present.has(dwarfId),
    shown: () => state.shown,
    reduced: () => options.reduced ?? false,
    parts: {
      leavePage: () => {
        calls.push('leave-page')
        state.page = null
      },
      // The mosaic's S32.14, as useValleMosaic does it: a missing column appended, then scrolled to.
      column: (mineId) => {
        calls.push(`column ${mineId}`)
        if (!state.mosaic.includes(mineId)) state.mosaic.push(mineId)
        self.reveal?.scrollIntoView(mineId)
      },
      pin: (dwarfId, mineId) => calls.push(`pin ${dwarfId} ${mineId}`),
      current: (mineId) => calls.push(`current ${mineId}`),
      // The preset's S28.15: the Work front's mine swapped, its tab order led by the dwarf.
      swap: (mineId, dwarfId) => {
        calls.push(`swap ${mineId} ${dwarfId}`)
        state.frontMine = mineId
      }
    },
    scroller: {
      viewport: () => ({ scrollLeft: state.scrollLeft, width: VIEWPORT }),
      zone: (mineId) => {
        const at = state.mosaic.indexOf(mineId)
        return at === -1 ? null : { left: at * COLUMN, width: COLUMN }
      },
      scrollTo: (left, behavior) => {
        scrolls.push({ left, behavior })
        state.scrollLeft = left
      }
    },
    patchUiSession: (patch) => void patches.push(patch)
  }
  const reveal = useValleReveal(deps)
  self.reveal = reveal
  return { reveal, state, calls, scrolls, patches }
}

describe('the reveal of a notification click in Valle (ISSUE-311)', () => {
  it('[S39.06, ADR-025] a reveal in the Control room adds a missing column, scrolls it into view updating the saved scroll, and opens the chat with its card, the preset unchanged', () => {
    const v = valle({ preset: 'control', mosaic: [MORIA, EREBOR] })
    expect(v.reveal.reveal({ mineId: KHAZAD, dwarfId: DAIN })).toBe('chat-open')
    // KHAZAD's column is appended (S32.14), its zone [600, 900] lies past the viewport's right edge, so the mosaic
    // scrolls to show it whole, smoothly; the scroll is saved for the session (ADR-024).
    expect(v.state.mosaic).toEqual([MORIA, EREBOR, KHAZAD])
    expect(v.scrolls).toEqual([{ left: 300, behavior: 'smooth' }])
    expect(v.patches).toEqual([{ kind: 'valle', patch: { mosaicScrollLeft: 300 } }])
    // Then the chat pinned and focused with its card (S29.19), its mine current (S35.01).
    expect(v.calls).toEqual([`column ${KHAZAD}`, `pin ${DAIN} ${KHAZAD}`, `current ${KHAZAD}`])
    expect(v.state.preset).toBe('control')

    // A column already in view is not scrolled, and nothing is saved.
    const inView = valle({ preset: 'control', mosaic: [MORIA, EREBOR] })
    inView.reveal.reveal({ mineId: EREBOR, dwarfId: DAIN })
    expect(inView.scrolls).toEqual([])
    expect(inView.patches).toEqual([])
    expect(inView.state.preset).toBe('control')

    // A page over the main zone gives way to the mines first (S28.20).
    const paged = valle({ preset: 'control', page: 'settings' })
    paged.reveal.reveal({ mineId: MORIA, dwarfId: BORIN })
    expect(paged.calls[0]).toBe('leave-page')
    expect(paged.state.page).toBeNull()
  })

  it("[S39.06] a reveal in the Work front swaps to the mine and selects the dwarf's tab", () => {
    const v = valle({ preset: 'front', frontMine: MORIA })
    expect(v.reveal.reveal({ mineId: EREBOR, dwarfId: DAIN })).toBe('chat-open')
    expect(v.calls).toEqual([`swap ${EREBOR} ${DAIN}`, `pin ${DAIN} ${EREBOR}`])
    expect(v.state.preset).toBe('front')
    expect(v.scrolls).toEqual([])

    // The mine already shown: no swap, the tab alone.
    const same = valle({ preset: 'front', frontMine: EREBOR })
    same.reveal.reveal({ mineId: EREBOR, dwarfId: DAIN })
    expect(same.calls).toEqual([`pin ${DAIN} ${EREBOR}`])
  })

  it('[S39.07] a reveal for a dwarf that left brings the mine into view with no chat', () => {
    // UI main says so (`dwarfId: null`), or the dwarf left since: the mine alone, no pin.
    const named = valle({ preset: 'control', mosaic: [MORIA, EREBOR] })
    expect(named.reveal.reveal({ mineId: KHAZAD, dwarfId: null })).toBe('mine-only')
    expect(named.calls).toEqual([`column ${KHAZAD}`, `current ${KHAZAD}`])
    expect(named.scrolls).toEqual([{ left: 300, behavior: 'smooth' }])

    const left = valle({ preset: 'control', present: [BORIN] })
    expect(left.reveal.reveal({ mineId: EREBOR, dwarfId: DAIN })).toBe('mine-only')
    expect(left.calls).toEqual([`column ${EREBOR}`, `current ${EREBOR}`])

    const front = valle({ preset: 'front', frontMine: MORIA, present: [] })
    expect(front.reveal.reveal({ mineId: EREBOR, dwarfId: DAIN })).toBe('mine-only')
    expect(front.calls).toEqual([`swap ${EREBOR} null`])
  })

  it('[S10.10, S10.11] a reveal never changes the mode; a hidden Valle is restored first', () => {
    // Hidden: UI main restores the window in its own mode (S10.11), and the reveal plays once it is shown again.
    const v = valle({ preset: 'control', mosaic: [MORIA, EREBOR], shown: false })
    v.reveal.reveal({ mineId: KHAZAD, dwarfId: DAIN })
    expect(v.calls).toEqual([])
    expect(v.scrolls).toEqual([])
    v.state.shown = true
    v.reveal.shownChanged()
    expect(v.calls).toEqual([`column ${KHAZAD}`, `pin ${DAIN} ${KHAZAD}`, `current ${KHAZAD}`])
    expect(v.scrolls).toEqual([{ left: 300, behavior: 'smooth' }])
    // Played once: showing the window again reveals nothing more.
    v.reveal.shownChanged()
    expect(v.calls).toHaveLength(3)
    // Neither the mode nor the preset moved (S10.10): the reveal has no part that could move them.
    expect(v.state.mode).toBe('valle')
    expect(v.state.preset).toBe('control')
  })
})
