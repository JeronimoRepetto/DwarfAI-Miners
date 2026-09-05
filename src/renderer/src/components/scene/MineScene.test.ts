// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDwarfKicking } from '../../composables/useDwarfKicking'
import { useDwarfMessaging } from '../../composables/useDwarfMessaging'
import { HISTORY_ICON_SRC, INTERIOR_ART_SIZE, INTERIOR_SRC, maskImageValue } from '../../lib/art'
import { BUBBLE_TTL_MS } from '../../lib/overlay/bubbles'
import { INTERIOR_STATIONS } from '../../lib/scene/interiorMap'
import { assignScene, type SceneOccupant } from '../../lib/scene/sceneAssignment'
import { sceneLayout } from '../../lib/scene/sceneLayout'
import {
  AUTHORED_INTERIOR_BOX,
  MINE_ACTION_SIZE,
  spriteFootprintPx
} from '../../lib/scene/sceneSizing'
import { SPRITE_FRAME_SIZE } from '../../lib/sprite/spriteSheet'
import { defaultDwarf, defaultMaterials, defaultMine } from '../../testing/factories'
import type { Dwarf, MineTier } from '../../types'
import MineScene from './MineScene.vue'

/*
 * REMOVED with the cave (#137), stated here rather than passing unseen: the ORE
 * PILE, and the nine cases that covered it — "renders no ore pile for a mine
 * that has not mined any ore yet", "grows the ore pile nugget by nugget", both
 * `MineScene ore pile` cases, and all five `MineScene per-material deposit`
 * cases.
 *
 * The heap stood on a `deposit` anchor, which was one of the cave's hand-
 * authored spots; the design's spatial map has no such marker, and none of the
 * four acceptance exports draws a pile of ore on the interior floor. In a 245px
 * column six 48px mounds would not fit side by side anyway. Where the design
 * DOES put a mine's materials is a strip along the bottom edge of the interior,
 * which is the VaultChip — so the vault did not leave the screen, it moved to
 * where the mock draws it, and the first case below now finds it there.
 *
 * The invariant those cases were guarding (#22: materials never convert into
 * one another, so the breakdown is per material and never one merged figure)
 * did NOT go with them. `VaultChip.test.ts` pins it independently in three
 * cases — "shows one labelled entry per material, poorest first", "never
 * renders one merged figure across materials", "gives each pile its own painted
 * ore and its own hover line" — against the very component this interior now
 * renders, and `presentation.test.ts` pins the wording. `NuggetPile.vue` and
 * `lib/vault/nuggetPile.ts` are untouched and keep their own suites.
 */

describe('MineScene', () => {
  it('shows the vault chip with the mine tokensObserved along the interior', () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ tokensObserved: 25_000 }) } })
    // `.vault-ore` — every token at one flat rate — went with #22; the chip now
    // breaks the vault down per material and keeps this compact token gauge.
    expect(wrapper.get('.vault-chip .vault-tokens').text()).toBe('25K')
  })

  /*
   * Materials still reach the screen per material rather than as one figure —
   * the #22 rule — now through the chip the design draws instead of through a
   * heap on the floor.
   */
  it('gives every material this mine has produced its own entry, poorest first', () => {
    const wrapper = mount(MineScene, {
      props: {
        mine: defaultMine({
          tier: 'silver',
          materials: defaultMaterials({ coal: 25_000, copper: 75_000, silver: 100_000 })
        })
      }
    })
    expect(
      wrapper.findAll('.vault-chip .vault-material').map((row) => row.attributes('data-material'))
    ).toEqual(['coal', 'copper', 'silver'])
  })

  /*
   * #153's twelfth correction. The strip rendered as loose nugget images
   * floating at the interior's TOP, and it was a specificity race: the chip's
   * own `.vault-chip.is-inline { position: static }` — two classes plus a scope
   * attribute — beat this scene's one-class `.interior-vault { position:
   * absolute; bottom: 6px }`, so the strip fell back into normal flow and landed
   * at the top-left of the first positioned ancestor. The chip places itself
   * now, and this scene asks for the variant rather than for a class it then has
   * to out-specify.
   */
  it('asks the vault for its own bottom-edge strip rather than placing one', () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ tokensObserved: 1 }) } })
    const chip = wrapper.get('.vault-chip')
    expect(chip.classes()).toContain('is-strip')
    expect(chip.classes()).not.toContain('is-floating')
    // Nothing left out here to lose a specificity race with.
    expect(wrapper.find('.interior-vault').exists()).toBe(false)
  })

  it('keeps the strip inside the interior, so it follows the painting’s frame', () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ tokensObserved: 1 }) } })
    expect(wrapper.find('.interior > .vault-chip').exists()).toBe(true)
  })

  /*
   * #153's eleventh correction, end to end: "a new dwarf materialized at its
   * workstation. Arrivals must enter via a spawn point and WALK to their
   * station." The board draws the line between the two cases by which snapshot
   * a dwarf first appeared in (see lib/scene/sceneMotion.ts); this is the check
   * that the scene actually hands it a spawn point to come in at.
   */
  describe('arrivals', () => {
    /** The walk duration the scene put on this dwarf's slot, in ms. */
    function walkMsOf(wrapper: ReturnType<typeof mount>, id: string): string {
      const slot = wrapper
        .findAll('.scene-slot')
        .find((candidate) => candidate.get('.dwarf-name').text() === id)
      if (!slot) throw new Error(`no rendered slot for ${id}`)
      return (slot.element as HTMLElement).style.getPropertyValue('--walk-ms')
    }

    const first = defaultDwarf({ id: 'first', name: 'first', status: 'working' })
    const later = defaultDwarf({ id: 'later', name: 'later', status: 'working' })

    it('places the crew that was already working when the mine opened', async () => {
      const wrapper = mount(MineScene, { props: { mine: defaultMine({ dwarfs: [first] }) } })
      await wrapper.vm.$nextTick()
      expect(walkMsOf(wrapper, 'first')).toBe('0ms')
    })

    it('walks in a dwarf that turns up in a later snapshot', async () => {
      const wrapper = mount(MineScene, { props: { mine: defaultMine({ dwarfs: [first] }) } })
      await wrapper.vm.$nextTick()
      await wrapper.setProps({ mine: defaultMine({ dwarfs: [first, later] }) })
      await wrapper.vm.$nextTick()
      expect(walkMsOf(wrapper, 'later')).not.toBe('0ms')
    })

    /*
     * The launch case, end to end (#86). A mine nobody is working is empty when
     * the Add Panel is opened in it, so the dwarf a launch starts is the FIRST
     * one this scene ever sees — which is exactly the reading #156 had to
     * correct: the first-sync rule alone calls that "crew who were already
     * here" and puts it on its rock.
     *
     * Nothing new is built for it; these pin that the machinery that already
     * ships covers it, so a later change to the board cannot quietly take the
     * walk away from a launch.
     */
    it('walks in the first dwarf to reach a mine that was opened empty', async () => {
      const wrapper = mount(MineScene, { props: { mine: defaultMine({ dwarfs: [] }) } })
      await wrapper.vm.$nextTick()
      await wrapper.setProps({ mine: defaultMine({ dwarfs: [later] }) })
      await wrapper.vm.$nextTick()
      expect(walkMsOf(wrapper, 'later')).not.toBe('0ms')
    })

    it('starts that dwarf at a spawn point rather than on its workstation', async () => {
      const wrapper = mount(MineScene, { props: { mine: defaultMine({ dwarfs: [] }) } })
      await wrapper.vm.$nextTick()
      await wrapper.setProps({ mine: defaultMine({ dwarfs: [later] }) })
      await wrapper.vm.$nextTick()

      const slot = wrapper.get('.scene-slot')
      const bottom = Math.round(Number.parseFloat((slot.element as HTMLElement).style.bottom))
      const target = assignScene([later as SceneOccupant], sceneLayout('bronze')).get(later.id)
      const stationBottom = Math.round(100 - (target?.point.y ?? -1))

      // It is somewhere on its route rather than parked on the rock it is
      // walking to — the arrival-not-parade rule, in one number.
      expect(bottom).not.toBe(stationBottom)
    })

    it('leaves an arrival in place for a viewer who asked for less movement', async () => {
      const matchMedia = vi.fn().mockReturnValue({ matches: true })
      vi.stubGlobal('matchMedia', matchMedia)
      try {
        const wrapper = mount(MineScene, { props: { mine: defaultMine({ dwarfs: [first] }) } })
        await wrapper.vm.$nextTick()
        await wrapper.setProps({ mine: defaultMine({ dwarfs: [first, later] }) })
        await wrapper.vm.$nextTick()
        expect(walkMsOf(wrapper, 'later')).toBe('0ms')
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })

  it('pauses the bubble auto-hide while expanded and resumes it on close', async () => {
    vi.useFakeTimers()
    try {
      const mine = defaultMine({
        dwarfs: [defaultDwarf({ id: 'd1', lastMessage: 'A story long enough to need a hold.' })]
      })
      const wrapper = mount(MineScene, { props: { mine } })
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.status-dialog').exists()).toBe(true)

      // Expanding holds the bubble on the board: far past the TTL it must remain.
      await wrapper.find('.status-dialog').trigger('click')
      vi.advanceTimersByTime(BUBBLE_TTL_MS * 5)
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.status-dialog').exists()).toBe(true)

      // Closing releases it with a fresh full TTL, after which it hides normally.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await wrapper.vm.$nextTick()
      vi.advanceTimersByTime(BUBBLE_TTL_MS)
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.status-dialog').exists()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

/*
 * Issue #43 — a crowded crew used to draw every bubble at the same spot above
 * its own sprite, with no idea another one was doing the same thing on the
 * rock next door: readable at one or two dwarfs, an unreadable smear at
 * seven. MineScene now hands each sprite the shareIndex sceneAssignment
 * already computed for it (issue #19), which DwarfSprite turns into a
 * vertical row (see lib/bubbleLayout.ts) so bubbles that land on the same
 * anchor stack into distinct lines instead of one smear.
 */
describe('MineScene bubble stacking', () => {
  /**
   * Finds an id group that `assignScene` puts on the very same anchor for a
   * synthetic all-working crew, without hardcoding which ids collide — that
   * depends on assignSlots' internal hashing, which this test has no business
   * knowing about. `count` workers over the layout's fixed worker-station pool
   * guarantees a collision by pigeonhole once `count` exceeds the pool size.
   */
  function idsSharingAnAnchor(count: number): string[] {
    const occupants: SceneOccupant[] = Array.from({ length: count }, (_, index) => ({
      id: `w${index}`,
      status: 'working',
      role: 'worker'
    }))
    const placements = assignScene(occupants, sceneLayout('bronze'))
    const byAnchor = new Map<string, string[]>()
    for (const [id, placement] of placements) {
      byAnchor.set(placement.anchor.id, [...(byAnchor.get(placement.anchor.id) ?? []), id])
    }
    const shared = [...byAnchor.values()].find((group) => group.length > 1)
    if (!shared) throw new Error('test setup expected at least one shared anchor')
    return shared
  }

  /** The dwarf whose rendered `.dwarf-name` label reads `id` (see below). */
  function bubbleStyleOf(wrapper: ReturnType<typeof mount>, id: string): string | undefined {
    const slot = wrapper
      .findAll('.scene-slot')
      .find((candidate) => candidate.get('.dwarf-name').text() === id)
    if (!slot) throw new Error(`no rendered slot for ${id}`)
    return slot.find('.bubble-holder').attributes('style')
  }

  it('gives bubbles sharing an anchor distinct positions instead of stacking on each other', async () => {
    const CREW_SIZE = 25 // more workers than the map has worker stations (18)
    const sharedIds = idsSharingAnAnchor(CREW_SIZE)
    // `name` doubles as the id here purely so the test can find a dwarf's own
    // rendered slot back afterwards — production always sets a real name.
    const dwarfs = Array.from({ length: CREW_SIZE }, (_, index) =>
      defaultDwarf({
        id: `w${index}`,
        name: `w${index}`,
        status: 'working',
        lastMessage: `busy on task ${index}`
      })
    )
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ dwarfs }) } })
    await wrapper.vm.$nextTick()

    const styles = sharedIds.map((id) => bubbleStyleOf(wrapper, id))
    expect(new Set(styles).size).toBe(sharedIds.length)
  })

  it('leaves a lone dwarf bubble exactly where it sits today', async () => {
    const wrapper = mount(MineScene, {
      props: {
        mine: defaultMine({
          dwarfs: [defaultDwarf({ id: 'solo', name: 'solo', lastMessage: 'digging alone' })]
        })
      }
    })
    await wrapper.vm.$nextTick()
    // No sharer means no lift: the same unstyled `.bubble-holder` as before #43.
    expect(bubbleStyleOf(wrapper, 'solo')).toBeUndefined()
  })
})

/**
 * The scene is the one place that already receives a fresh snapshot of every
 * dwarf on each poll, so it is what feeds reaction detection (issue #21). No
 * new IPC and no new main-process field: the panel simply watches the stream it
 * was already rendering.
 */
describe('MineScene reaction feed', () => {
  const WORKING = defaultDwarf({ id: 'claude:s1', status: 'working', lastMessage: 'a' })

  function stubApi(): void {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        kickDwarf: () => Promise.resolve({ delivered: true, via: 'claude-relay' }),
        sendDwarfText: () => Promise.resolve({ delivered: true, via: 'claude-relay' }),
        // A promoted kick retires its dwarf through this (issue #46). Stubbed
        // rather than made optional in the composable: a missing member should
        // fail a test loudly here, not be swallowed at every call site.
        retireDwarf: () => undefined
      }
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    stubApi()
    useDwarfKicking().clearAll()
    useDwarfMessaging().clearAll()
  })

  afterEach(() => {
    useDwarfKicking().clearAll()
    useDwarfMessaging().clearAll()
    vi.useRealTimers()
  })

  it('promotes a delivered kick when the next poll shows the session stopped', async () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ dwarfs: [WORKING] }) } })
    const { kick, stateFor } = useDwarfKicking()

    await kick('claude:s1')
    expect(stateFor('claude:s1')?.phase).toBe('delivered')

    await wrapper.setProps({
      mine: defaultMine({ dwarfs: [{ ...WORKING, status: 'waiting' }] })
    })
    expect(stateFor('claude:s1')?.phase).toBe('reacted')
  })

  it('promotes a delivered message when the next poll shows new output', async () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ dwarfs: [WORKING] }) } })
    const { send, stateFor } = useDwarfMessaging()

    await send('claude:s1', 'hi', true)
    expect(stateFor('claude:s1')?.phase).toBe('delivered')

    await wrapper.setProps({
      mine: defaultMine({ dwarfs: [{ ...WORKING, lastMessage: 'on it' }] })
    })
    expect(stateFor('claude:s1')?.phase).toBe('reacted')
  })

  it('leaves a delivery alone while nothing about the session changed', async () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ dwarfs: [WORKING] }) } })
    const { kick, stateFor } = useDwarfKicking()

    await kick('claude:s1')
    await wrapper.setProps({ mine: defaultMine({ dwarfs: [{ ...WORKING }] }) })

    expect(stateFor('claude:s1')?.phase).toBe('delivered')
  })
})

/*
 * Issue #19 — the crew stopped being a row along the bottom edge and started
 * inhabiting the painting. jsdom lays nothing out, so every measurement falls
 * back to MineScene's default interior box, which makes these positions stable.
 *
 * REMOVED with the cave (#137): "sends a waiting dwarf to the foreground rest
 * area and a working one to the rock". The design's spatial map draws no rest
 * area, so waiting no longer moves anyone — the case that replaced it is
 * "leaves a waiting dwarf standing where it was working" below, which pins the
 * new rule rather than the old one.
 */
describe('MineScene as a place', () => {
  /** The `bottom: N%` a slot was positioned at. Larger means higher up the shaft. */
  function bottomOf(slot: { attributes: (name: string) => string | undefined }): number {
    return Number(/bottom:\s*([\d.]+)%/.exec(slot.attributes('style') ?? '')?.[1] ?? NaN)
  }

  function zIndexOf(slot: { attributes: (name: string) => string | undefined }): number {
    return Number(/z-index:\s*(\d+)/.exec(slot.attributes('style') ?? '')?.[1] ?? NaN)
  }

  function sceneOf(dwarfs: Dwarf[]): ReturnType<typeof mount> {
    return mount(MineScene, { props: { mine: defaultMine({ dwarfs }) } })
  }

  it('stands every dwarf on its own spot in the painting', () => {
    const wrapper = sceneOf([
      defaultDwarf({ id: 'a', name: 'Ann' }),
      defaultDwarf({ id: 'b', name: 'Bob' }),
      defaultDwarf({ id: 'c', name: 'Cid' })
    ])
    const slots = wrapper.findAll('.scene-slot')
    expect(slots).toHaveLength(3)
    const spots = slots.map((slot) => slot.attributes('style'))
    expect(new Set(spots).size).toBe(3)
  })

  /*
    A dwarf waiting for its user is asleep at its own workstation, not walked
    off to a bunk: the design's map has no rest class, and the sleeping frames
    draw exactly that. So a waiting dwarf and a working one of the same rank
    share the same pool of spots.
  */
  it('leaves a waiting dwarf standing where it was working', () => {
    const same = defaultDwarf({ id: 'a', status: 'working' })
    const working = sceneOf([same])
    const waiting = sceneOf([{ ...same, status: 'waiting' }])
    expect(waiting.get('.scene-slot').attributes('style')).toBe(
      working.get('.scene-slot').attributes('style')
    )
  })

  /*
    A leaving dwarf walks out rather than fading where it stands (#19). It goes
    to a spawn circle, of which the design marks three up the shaft rather than
    one door at the bottom — which is why this checks that the spot MOVED and
    lands on one of the three, and not that it ends up near the floor.
  */
  it('sends a leaving dwarf to a spawn point rather than fading in place', () => {
    const working = sceneOf([defaultDwarf({ id: 'a', status: 'working' })])
    const leaving = sceneOf([defaultDwarf({ id: 'a', status: 'leaving' })])
    expect(leaving.get('.scene-slot').attributes('style')).not.toBe(
      working.get('.scene-slot').attributes('style')
    )
    const spawns = INTERIOR_STATIONS.filter((station) => station.kind === 'spawn')
    const bottoms = spawns.map((spawn) => Math.round(100 - spawn.y))
    expect(bottoms).toContain(Math.round(bottomOf(leaving.get('.scene-slot'))))
  })

  it('paints the crew high to low so a nearer dwarf overlaps one above it', () => {
    const wrapper = sceneOf([
      defaultDwarf({ id: 'a', status: 'waiting' }),
      defaultDwarf({ id: 'b', status: 'leaving' }),
      defaultDwarf({ id: 'c', status: 'working' })
    ])
    const slots = wrapper.findAll('.scene-slot')
    const bottoms = slots.map(bottomOf)
    expect(bottoms).toEqual([...bottoms].sort((a, b) => b - a))
    const zIndexes = slots.map(zIndexOf)
    expect(zIndexes).toEqual([...zIndexes].sort((a, b) => a - b))
  })

  it('keeps every dwarf inside the panel, never off the edge of it', () => {
    const wrapper = sceneOf(
      Array.from({ length: 12 }, (_, index) => defaultDwarf({ id: `w${index}` }))
    )
    for (const slot of wrapper.findAll('.scene-slot')) {
      const style = slot.attributes('style') ?? ''
      const left = Number(/left:\s*([\d.]+)%/.exec(style)?.[1] ?? NaN)
      expect(left).toBeGreaterThanOrEqual(0)
      expect(left).toBeLessThanOrEqual(100)
      expect(bottomOf(slot)).toBeGreaterThanOrEqual(0)
      expect(bottomOf(slot)).toBeLessThanOrEqual(100)
    }
  })

  it('gives the same crew the same spots on every poll, so nobody teleports', async () => {
    const dwarfs = [defaultDwarf({ id: 'a' }), defaultDwarf({ id: 'b' }), defaultDwarf({ id: 'c' })]
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ dwarfs }) } })
    const before = wrapper.findAll('.scene-slot').map((slot) => slot.attributes('style'))

    // A fresh snapshot of the identical crew, in the order a re-poll may hand it over.
    await wrapper.setProps({ mine: defaultMine({ dwarfs: [...dwarfs].reverse() }) })
    expect(wrapper.findAll('.scene-slot').map((slot) => slot.attributes('style'))).toEqual(before)
  })
})

describe('MineScene with reduced motion', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia')
  })

  function stubReducedMotion(matches: boolean): void {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches })
    })
  }

  /*
    A viewer who asked for less movement keeps the whole scene — everyone is
    still standing on a painted feature — and loses only the walking.
  */
  it('still places the crew in the cave, but marks the floor still', () => {
    stubReducedMotion(true)
    const wrapper = mount(MineScene, {
      props: { mine: defaultMine({ dwarfs: [defaultDwarf({ id: 'a' })] }) }
    })
    expect(wrapper.findAll('.scene-slot')).toHaveLength(1)
    expect(wrapper.get('.crew-floor').classes()).toContain('is-still')
  })

  it('animates the walks for everyone who did not ask it to stop', () => {
    stubReducedMotion(false)
    const wrapper = mount(MineScene, {
      props: { mine: defaultMine({ dwarfs: [defaultDwarf({ id: 'a' })] }) }
    })
    expect(wrapper.get('.crew-floor').classes()).not.toContain('is-still')
  })
})

/*
 * Issue #44 — the crew used to be drawn at a hard-coded 100px whatever the
 * panel was doing, so a smaller panel held the same sprites in less room rather
 * than the same scene in a smaller frame. MineScene already measured the
 * interior box for the workstation projection; it hands that measurement to the
 * sprites as well, so the crew scales with the painting they stand in.
 *
 * REMOVED with the cave (#137): "keeps --depth-scale as a per-dwarf multiplier
 * on top of the panel size" and "floors the cave at the height the window
 * minimum is derived from". The first tested perspective within a single
 * gallery seen in three-quarter view; the production interior is isometric, a
 * tower of galleries where every dwarf is the same size, so MineScene no longer
 * passes `depth-scale` at all and `depthScale` is gone from sceneLayout. The
 * second tested a `--cave-min-height` bound into the scene from the constant the
 * WINDOW minimum was derived from — the panel is docked and derives its own
 * bounds now (#90), and the interior is `contain`-fitted, so neither the
 * constant nor the floor it enforced exists.
 */
describe('MineScene sprite scaling', () => {
  afterEach(() => vi.restoreAllMocks())

  /** Make jsdom, which lays nothing out, report an interior of a given size. */
  function stubInteriorBox(box: { width: number; height: number }): void {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: box.width,
      height: box.height,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: box.width,
      bottom: box.height,
      toJSON: () => ({})
    } as DOMRect)
  }

  function customPropertyOf(wrapper: ReturnType<typeof mount>, name: string): number {
    const style = wrapper.get('.crew-floor').attributes('style') ?? ''
    return Number(new RegExp(`${name}:\\s*([\\d.]+)px`).exec(style)?.[1] ?? NaN)
  }

  /*
    The measurement lands in `onMounted`, so the first render still carries the
    design fallback and the measured size only reaches the DOM a tick later.
    Every reader here waits for that tick — without it these would silently
    assert the fallback and agree with themselves.
  */
  async function sceneOfOne(): Promise<ReturnType<typeof mount>> {
    const wrapper = mount(MineScene, {
      props: { mine: defaultMine({ dwarfs: [defaultDwarf({ id: 'a' })] }) }
    })
    await wrapper.vm.$nextTick()
    return wrapper
  }

  /*
    The scale the design actually specifies: 36x38 sheet frames at 1x inside a
    245px interior. The cave drew them at 100px tall, 2.6x too big.
  */
  it('draws a dwarf at one sheet frame in the column the design gives it', async () => {
    stubInteriorBox(AUTHORED_INTERIOR_BOX)
    const wrapper = await sceneOfOne()
    expect(customPropertyOf(wrapper, '--sprite-height')).toBeCloseTo(SPRITE_FRAME_SIZE.height)
    expect(customPropertyOf(wrapper, '--sprite-width')).toBeCloseTo(SPRITE_FRAME_SIZE.width)
  })

  it('tracks the measured interior box across a range of column shapes', async () => {
    for (const box of [
      { width: 123, height: 376 },
      { width: 245, height: 749 },
      { width: 245, height: 1040 },
      { width: 245, height: 2160 },
      { width: 490, height: 1498 }
    ]) {
      stubInteriorBox(box)
      const wrapper = await sceneOfOne()
      const expected = spriteFootprintPx(box, INTERIOR_ART_SIZE)
      const where = `${box.width}x${box.height}`
      expect(customPropertyOf(wrapper, '--sprite-height'), where).toBeCloseTo(expected.height)
      expect(customPropertyOf(wrapper, '--sprite-width'), where).toBeCloseTo(expected.width)
      vi.restoreAllMocks()
    }
  })

  it('holds the same scene in a narrower column, not the same sprites in less room', async () => {
    stubInteriorBox({ width: 123, height: 376 })
    const small = customPropertyOf(await sceneOfOne(), '--sprite-height')
    vi.restoreAllMocks()
    stubInteriorBox(AUTHORED_INTERIOR_BOX)
    const authored = customPropertyOf(await sceneOfOne(), '--sprite-height')
    expect(small).toBeLessThan(authored)
  })

  /*
    Every dwarf is the same size now: the interior is drawn isometrically rather
    than in perspective, so there is no depth multiplier left to compose with
    the column's own scale. This is the case that would fail if one crept back.
  */
  it('draws every dwarf at the one scale, with no per-dwarf multiplier', async () => {
    stubInteriorBox({ width: 245, height: 1040 })
    const wrapper = mount(MineScene, {
      props: {
        mine: defaultMine({
          dwarfs: [
            defaultDwarf({ id: 'out', status: 'leaving' }),
            defaultDwarf({ id: 'resting', status: 'waiting' })
          ]
        })
      }
    })
    await wrapper.vm.$nextTick()
    expect(customPropertyOf(wrapper, '--sprite-height')).toBeCloseTo(
      spriteFootprintPx({ width: 245, height: 1040 }, INTERIOR_ART_SIZE).height
    )
    const depths = wrapper
      .findAll('.dwarf-sprite')
      .map((sprite) => /--depth-scale:\s*([\d.]+)/.exec(sprite.attributes('style') ?? '')?.[1])
    expect(depths).toHaveLength(2)
    expect(new Set(depths).size).toBe(1)
  })
})

/*
 * The interior shell itself: the five tier paintings, and the two round actions
 * the design floats on top of them (#137).
 */
describe('MineScene interior shell', () => {
  const TIERS: MineTier[] = ['bronze', 'copper', 'silver', 'gold', 'uranium']

  it('draws the production painting for the tier it is handed', () => {
    for (const tier of TIERS) {
      const wrapper = mount(MineScene, { props: { mine: defaultMine({ tier }) } })
      expect(wrapper.get('.interior-art').attributes('src'), tier).toBe(INTERIOR_SRC[tier])
    }
  })

  /*
    The drawing tier is `tierOf`'s, placeholder included — the AGENTS.md
    invariant says a provisional tier is FOR drawing and only sealing a value
    needs `knownTierOf`. A mine nobody has measured yet still has to have an
    interior to stand in, and bronze is the one it gets.
  */
  it('gives an unmeasured mine the placeholder tier own painting rather than nothing', () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ tier: 'bronze' }) } })
    expect(wrapper.get('.interior-art').attributes('src')).toBe(INTERIOR_SRC.bronze)
  })

  it('fits the painting into its column without ever cropping a workstation away', () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine() } })
    expect(wrapper.get('.interior').attributes('data-fit')).toBe('contain')
    // The frame carries the painting's own shape, so it hugs the art rather
    // than leaving a border round a letterboxed image.
    expect(wrapper.get('.interior').attributes('style')).toContain(
      `--interior-aspect: ${INTERIOR_ART_SIZE.width} / ${INTERIOR_ART_SIZE.height}`
    )
  })

  /*
   * #197: Close was 18x18 and Add was 28x28 — 10.8px of glyph against 16.8px
   * at the shared 60% fill — though `components.md` marks icon sizes
   * Unspecified. `MINE_ACTION_SIZE` (lib/scene/sceneSizing.ts) is the measured
   * fix: both glyphs are an 18px circle in the verified Canva export, so all
   * three round actions now share one size rather than Add standing apart.
   */
  it('draws Close, History and Add at the same size', () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine() } })
    expect(wrapper.get('.interior').attributes('style')).toContain(
      `--action-size: ${MINE_ACTION_SIZE}px`
    )
  })

  it('closes the mine from the round action at the top right', async () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine() } })
    await wrapper.get('.interior .close-mine').trigger('click')
    expect(wrapper.emitted('back')).toHaveLength(1)
  })

  /*
    AMENDED for #86, stated rather than passing unseen. This case was "draws the
    Add action disabled, saying why, until its panel exists" and asserted
    `disabled` plus a "not built yet" title. That panel now exists, so the
    control is live and the assertion is its opposite; the aria-label it also
    pinned is unchanged and still pinned below.
  */
  it('opens the launch panel from the round action at the lower right', async () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine() } })
    const add = wrapper.get('.interior .add-agent')

    expect(add.attributes('disabled')).toBeUndefined()
    expect(add.attributes('aria-label')).toBe('Launch an agent in this mine')

    await add.trigger('click')
    expect(wrapper.emitted('add')).toHaveLength(1)
  })

  /*
   * The design's History action (#192, `screens/mine.md`): directly below
   * Close, opening the read-only mine-wide history. Like Close and Add it
   * emits and decides nothing — App owns the dock the panel opens in.
   */
  it('opens the mine history from the round action directly below Close', async () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine() } })
    const history = wrapper.get('.interior .mine-history')

    expect(history.attributes('aria-label')).toBe('Mine history')
    // A mask of the designer's own history.svg, exactly as Close is drawn.
    expect(history.get('.action-glyph').attributes('style')).toContain(
      maskImageValue(HISTORY_ICON_SRC)
    )
    // Below Close in the DOM, so a reader meets them in the order the design draws them.
    const actions = wrapper.findAll('.interior > button').map((button) => button.classes()[0])
    expect(actions.indexOf('mine-history')).toBe(actions.indexOf('close-mine') + 1)

    await history.trigger('click')
    expect(wrapper.emitted('history')).toHaveLength(1)
    expect(wrapper.emitted('back')).toBeUndefined()
  })

  it('keeps the mine name as the section own accessible name, with no header on screen', () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ name: 'ledger-service' }) } })
    expect(wrapper.get('#mine-title').text()).toBe('ledger-service')
    expect(wrapper.get('.mine-scene').attributes('aria-labelledby')).toBe('mine-title')
  })
})

/*
 * An agent's question (#125) travels the same way a message does: the scene
 * names which dwarf it came from, and App owns the IPC.
 */
/*
 * AMENDED for #159. This block was "MineScene pending question", and it drove
 * the question card through a sprite's own action bar. The card lives in the
 * MessagePanel now — docked at the bottom of the screen, outside this scene
 * entirely — so the two cases that answered a question here went with the bar:
 *
 * - "names the dwarf when an answer travels up from its sprite"
 * - "hands each dwarf its own answer verdict, keyed by that dwarf's id"
 * - "leaves a dwarf with nothing outstanding exactly as it was", whose subject
 *   — no card for a dwarf that asked nothing — is now the panel's, and is
 *   pinned there as "shows no question surface for a dwarf with nothing
 *   outstanding".
 *
 * No subject was lost. Answering an ask and carrying its verdict are pinned in
 * components/message/DwarfMessagePanel.test.ts, and keying the verdict by
 * dwarf id is pinned in App.test.ts, where the panel is actually handed one
 * store's entry per dwarf.
 *
 * What the scene still owes is what replaced it: naming which dwarf was
 * clicked, and marking the one the panel is open on.
 */
describe('MineScene selection', () => {
  it('names the dwarf that was clicked, so the panel above knows whose it is', async () => {
    const dwarf = defaultDwarf({ id: 'claude:s1' })
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ dwarfs: [dwarf] }) } })
    await wrapper.find('.dwarf-hit').trigger('click')
    expect(wrapper.emitted('select')).toEqual([[dwarf]])
  })

  it('marks the selected dwarf and no other', async () => {
    const first = defaultDwarf({ id: 'claude:s1', name: 'One' })
    const second = defaultDwarf({ id: 'claude:s2', name: 'Two' })
    const wrapper = mount(MineScene, {
      props: { mine: defaultMine({ dwarfs: [first, second] }), selectedId: 'claude:s2' }
    })
    const selected = wrapper
      .findAll('.dwarf-sprite')
      .filter((sprite) => sprite.classes().includes('is-selected'))
    expect(selected).toHaveLength(1)
    expect(selected[0]!.text()).toContain('Two')
  })

  it('marks nobody when the panel is closed', () => {
    const wrapper = mount(MineScene, {
      props: { mine: defaultMine({ dwarfs: [defaultDwarf()] }), selectedId: null }
    })
    expect(wrapper.find('.dwarf-sprite.is-selected').exists()).toBe(false)
  })
})

/**
 * The third acceptance run's seventh correction (#165).
 *
 * More than one dwarf could be selected at once, and since a click opens the
 * message panel, that implied more than one panel. Selection itself was already
 * singular — App holds one id and DwarfSprite has no selected state of its own
 * — so the leak was in the DRAWING: the scene lays out one sprite per crew
 * ENTRY, and nothing guaranteed a crew held one entry per dwarf. Two entries
 * for one dwarf both matched the one selected id, and both wore the halo.
 */
describe('MineScene single selection', () => {
  it('draws one sprite per dwarf even when the crew lists one twice', () => {
    const twice = defaultDwarf({ id: 'claude:s1', name: 'One' })
    const wrapper = mount(MineScene, {
      props: { mine: defaultMine({ dwarfs: [twice, { ...twice }] }) }
    })

    expect(wrapper.findAll('.dwarf-sprite')).toHaveLength(1)
  })

  it('marks exactly one sprite however often the selected dwarf is listed', () => {
    const twice = defaultDwarf({ id: 'claude:s1', name: 'One' })
    const wrapper = mount(MineScene, {
      props: {
        mine: defaultMine({ dwarfs: [twice, { ...twice }, defaultDwarf({ id: 'claude:s2' })] }),
        selectedId: 'claude:s1'
      }
    })

    const selected = wrapper
      .findAll('.dwarf-sprite')
      .filter((sprite) => sprite.classes().includes('is-selected'))
    expect(selected).toHaveLength(1)
  })

  it('keeps the FIRST listing of a dwarf, which is the one the board saw first', () => {
    const wrapper = mount(MineScene, {
      props: {
        mine: defaultMine({
          dwarfs: [
            defaultDwarf({ id: 'claude:s1', name: 'First' }),
            defaultDwarf({ id: 'claude:s1', name: 'Second' })
          ]
        })
      }
    })

    expect(wrapper.get('.dwarf-sprite').text()).toContain('First')
  })
})
