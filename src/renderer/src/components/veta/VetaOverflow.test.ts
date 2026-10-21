// @vitest-environment jsdom
import type { DwarfId, MineId, VetaLayoutRequest } from '@dwarfai/contracts'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { dwarfToOpen } from '../../lib/veta/overflow'
import {
  BALIN,
  BELEGOST,
  BORIN,
  DAIN,
  DWALIN,
  EREBOR,
  FLOI,
  IRONHILLS,
  KHAZAD,
  MORIA,
  NALI,
  NOGROD,
  ORI,
  THRAIN,
  dwarfWire,
  mineWire,
  type VetaSnapshotData
} from '../../lib/veta/testing/vetaFixtures'
import { mountVeta, shownRisen, type VetaWorld } from './testing/mountVeta'

/*
 * ISSUE-291 (TC-291-02…TC-291-04; 07 machine 25; UC-049; OQ-76 A): "+N" in the Veta root, over the generated fake
 * `window.api`. Six mines are at work and the window learns no stage length (jsdom), so four chambers are drawn and
 * the last two in mine order, belegost and nogrod, fold into "+2".
 */

const SIX_MINES = [MORIA, EREBOR, KHAZAD, IRONHILLS, BELEGOST, NOGROD] as const

/** Six mines at work, one dwarf each, unless `crews` gives a mine its own. */
function sixMines(
  crews: Partial<Record<MineId, ReturnType<typeof dwarfWire>[]>> = {}
): VetaSnapshotData {
  const lone: Record<MineId, DwarfId> = {
    [MORIA]: BORIN,
    [EREBOR]: DAIN,
    [KHAZAD]: NALI,
    [IRONHILLS]: BALIN,
    [BELEGOST]: DWALIN,
    [NOGROD]: FLOI
  }
  return {
    minesEverKnown: true,
    mines: SIX_MINES.map((id) => mineWire(id)),
    dwarfs: SIX_MINES.flatMap(
      (id) => crews[id] ?? [dwarfWire(lone[id]!, id, { status: 'working' })]
    )
  }
}

let world: VetaWorld | undefined
afterEach(() => {
  world?.unmount()
  world = undefined
  document.body.innerHTML = ''
})

const more = (): HTMLElement => document.querySelector<HTMLElement>('[data-veta-more]')!
/** "+N" with its list: what the pointer enters and leaves. */
const slot = (): HTMLElement => document.querySelector<HTMLElement>('[data-veta-more-slot]')!
const list = (): HTMLElement => document.querySelector<HTMLElement>('[data-veta-more-list]')!
const items = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-veta-more-item]')
]
const drawn = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-veta-chamber]')].map((c) => c.dataset.mineId!)
const item = (mineId: MineId): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-veta-more-item][data-mine-id="${mineId}"]`)!

async function hoverMore(): Promise<void> {
  slot().dispatchEvent(new PointerEvent('pointerenter'))
  await flushPromises()
}

describe('the "+N" fold of the Veta strip', () => {
  it('[US-VETA-006.AC02, S25.05, S25.06] hovering +N lists the folded mines and leaving hides the list', async () => {
    world = await mountVeta(sixMines())
    expect(drawn().sort()).toEqual([MORIA, EREBOR, KHAZAD, IRONHILLS].sort())
    expect(more().textContent?.trim()).toBe('+2')
    expect(more().getAttribute('aria-label')).toBe('2 more mines: belegost, nogrod')
    expect(list().dataset.shown).toBe('false')
    const asked = world.layouts.length

    await hoverMore()
    expect(list().dataset.shown).toBe('true')
    // The folded mines, in mine order, each with its crew; the design's title and hint.
    expect(items().map((row) => row.dataset.mineId)).toEqual([BELEGOST, NOGROD])
    expect(item(BELEGOST).textContent).toContain('belegost')
    expect(item(BELEGOST).textContent).toContain('1 at work')
    expect(list().textContent).toContain('More mines at work')
    expect(list().textContent).toContain('Scroll over Veta to cycle')
    // Its room was held beforehand: the hover resized nothing (a window resized under the pointer loses the hover).
    expect(world.layouts.length).toBe(asked)

    slot().dispatchEvent(new PointerEvent('pointerleave'))
    await flushPromises()
    expect(list().dataset.shown).toBe('false')
    expect(world.layouts.length).toBe(asked)
  })

  it("[US-VETA-006.AC06, NFR-A11Y-15, S25.07] Tab reaches expand, each drawn dwarf, each drawn chamber's tab and the grip, never +N", async () => {
    world = await mountVeta(sixMines())
    const island = document.querySelector<HTMLElement>('[data-veta-island]')!
    const stops = [
      ...island.querySelectorAll<HTMLElement>('button, [tabindex], a[href], input')
    ].filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled)
    const has = (selector: string): boolean => stops.some((el) => el.matches(selector))
    expect(has('[data-veta-expand]')).toBe(true)
    expect(has('[data-veta-grip]')).toBe(true)
    for (const dwarfId of [BORIN, DAIN, NALI, BALIN]) {
      expect(has(`[data-veta-dwarf][data-dwarf-id="${dwarfId}"]`)).toBe(true)
    }
    for (const mineId of [MORIA, EREBOR, KHAZAD, IRONHILLS]) {
      expect(has(`[data-veta-chamber][data-mine-id="${mineId}"] [data-tab-open]`)).toBe(true)
      expect(has(`[data-veta-chamber][data-mine-id="${mineId}"] [data-tab-add]`)).toBe(true)
    }
    // "+N" and its list are mouse and wheel only (PO #55): no stop in them, so the keyboard cannot open the list.
    expect(more().tabIndex).toBe(-1)
    expect(stops.filter((el) => el.closest('[data-veta-more]') !== null)).toEqual([])
  })

  // OQ-76
  it('[US-VETA-006.AC08, S25.05] a folded mine whose dwarf needs the person shows the needs-you signal on +N and on its list item', async () => {
    // A drawn mine asking lights its own chamber, never "+N".
    world = await mountVeta(
      sixMines({ [MORIA]: [dwarfWire(BORIN, MORIA, { status: 'asking', needsYou: true })] })
    )
    expect(more().dataset.attention).toBe('false')
    world.unmount()
    document.body.innerHTML = ''

    world = await mountVeta(
      sixMines({ [NOGROD]: [dwarfWire(FLOI, NOGROD, { status: 'asking', needsYou: true })] })
    )
    expect(more().dataset.attention).toBe('true')
    await hoverMore()
    expect(item(NOGROD).dataset.attention).toBe('true')
    expect(item(NOGROD).textContent).toContain('? needs you')
    expect(item(BELEGOST).dataset.attention).toBe('false')
    expect(item(BELEGOST).textContent).not.toContain('needs you')
  })

  // OQ-76
  it("[US-VETA-006.AC09, US-VETA-006.AC02, S25.11] a click on a +N list item unfolds that mine's chamber after the window grows and opens the chat of its dwarf that needs the person, oldest first", async () => {
    const seen: string[] = []
    const record = (request: VetaLayoutRequest): void => {
      const nogrod = drawn().includes(NOGROD) ? 'drawn' : 'folded'
      seen.push(`${request.kind}:${nogrod}`)
    }
    world = await mountVeta(
      sixMines({
        [NOGROD]: [
          dwarfWire(FLOI, NOGROD, { status: 'asking', needsYou: true, askedAt: 200 }),
          dwarfWire(ORI, NOGROD, { status: 'asking', needsYou: true, askedAt: 100 }),
          dwarfWire(THRAIN, NOGROD, { status: 'working' })
        ]
      }),
      { onLayout: record }
    )
    seen.length = 0
    const before = world.layouts.length
    await hoverMore()
    expect(items().map((row) => row.dataset.mineId)).toContain(NOGROD)
    item(NOGROD).click()
    await flushPromises()

    // The list hides; the window grows for the longer run, `unfold-overflow` names the mine, and only then is its
    // chamber drawn (S25.11 as S25.08).
    expect(list().dataset.shown).toBe('false')
    const asked = world.layouts.slice(before)
    const grow = asked.findIndex((r) => r.kind === 'island-resize')
    const unfold = asked.findIndex((r) => r.kind === 'unfold-overflow')
    expect(grow).toBeGreaterThanOrEqual(0)
    expect(unfold).toBeGreaterThan(grow)
    expect(asked[unfold]).toEqual({ kind: 'unfold-overflow', mineId: NOGROD })
    expect(seen.slice(0, 2)).toEqual(['island-resize:folded', 'unfold-overflow:folded'])
    expect(drawn()).toContain(NOGROD)
    // The chat of the dwarf that needs the person, the oldest question first: ori asked before floi.
    expect(asked.find((r) => r.kind === 'rise')).toMatchObject({ kind: 'rise', dwarfId: ORI })
    expect(shownRisen()).toBe('shown')
  })

  // OQ-76
  it('[US-VETA-006.AC09, S25.11] with no dwarf needing the person the click opens the chat last talked to in that mine, else the first of its crew; with no dwarf present it only brings the chamber into view', async () => {
    const quiet = sixMines({
      [NOGROD]: [
        dwarfWire(FLOI, NOGROD, { status: 'working' }),
        dwarfWire(ORI, NOGROD, { status: 'idle' })
      ]
    })
    // The one last talked to in that mine (the session store's record of it).
    world = await mountVeta(quiet, { session: { valle: { talkedTo: { [NOGROD]: ORI } } } })
    await hoverMore()
    expect(items().map((row) => row.dataset.mineId)).toContain(NOGROD)
    item(NOGROD).click()
    await flushPromises()
    expect(world.layouts.find((r) => r.kind === 'rise')).toMatchObject({ dwarfId: ORI })
    world.unmount()
    document.body.innerHTML = ''

    // Nobody talked to there: the first of its crew in crew order.
    world = await mountVeta(quiet)
    await hoverMore()
    expect(items().map((row) => row.dataset.mineId)).toContain(NOGROD)
    item(NOGROD).click()
    await flushPromises()
    expect(world.layouts.find((r) => r.kind === 'rise')).toMatchObject({ dwarfId: FLOI })
    expect(drawn()).toContain(NOGROD)

    // No dwarf present: no chat to open, only the chamber brought into view ('mine-only', S24.16).
    expect(dwarfToOpen([], ORI)).toBeNull()
  })
})
