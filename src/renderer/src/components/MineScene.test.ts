// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDwarfKicking } from '../composables/useDwarfKicking'
import { useDwarfMessaging } from '../composables/useDwarfMessaging'
import { BUBBLE_TTL_MS } from '../lib/bubbles'
import { MAX_PILE_NUGGETS } from '../lib/nuggetPile'
import { defaultDwarf, defaultMaterials, defaultMine } from '../testing/factories'
import type { Dwarf } from '../types'
import MineScene from './MineScene.vue'

describe('MineScene', () => {
  it('shows the vault chip with the mine tokensObserved in the header', () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ tokensObserved: 25_000 }) } })
    // `.vault-ore` — every token at one flat rate — went with #22; the chip now
    // breaks the vault down per material and keeps this compact token gauge.
    expect(wrapper.get('.vault-tokens').text()).toBe('25K')
  })

  it('renders no ore pile for a mine that has not mined any ore yet', () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ tokensObserved: 0 }) } })
    expect(wrapper.find('.ore-pile').exists()).toBe(false)
  })

  /*
   * The pile used to thicken through five hand-picked CSS steps driven by the
   * LIVE token gauge. It is now one painted nugget per whole unit of the mine's
   * persisted per-material vault, capped at the mound's own capacity — so this
   * checks real growth and the cap instead of the retired step ladder.
   */
  it('grows the ore pile nugget by nugget as ore increases, up to the cap', () => {
    const small = mount(MineScene, {
      props: { mine: defaultMine({ materials: defaultMaterials({ bronze: 50_000 }) }) }
    })
    expect(small.findAll('.ore-pile .nugget')).toHaveLength(5)

    const big = mount(MineScene, {
      props: { mine: defaultMine({ materials: defaultMaterials({ bronze: 90_000_000 }) }) }
    })
    expect(big.findAll('.ore-pile .nugget')).toHaveLength(MAX_PILE_NUGGETS)
  })

  it('pauses the bubble auto-hide while expanded and resumes it on close', async () => {
    vi.useFakeTimers()
    try {
      const mine = defaultMine({
        dwarfs: [defaultDwarf({ id: 'd1', lastMessage: 'A story long enough to need a hold.' })]
      })
      const wrapper = mount(MineScene, { props: { mine } })
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.speech-bubble').exists()).toBe(true)

      // Expanding holds the bubble on the board: far past the TTL it must remain.
      await wrapper.find('.bubble-hit').trigger('click')
      vi.advanceTimersByTime(BUBBLE_TTL_MS * 5)
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.speech-bubble').exists()).toBe(true)

      // Closing releases it with a fresh full TTL, after which it hides normally.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await wrapper.vm.$nextTick()
      vi.advanceTimersByTime(BUBBLE_TTL_MS)
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.speech-bubble').exists()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
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
        sendDwarfText: () => Promise.resolve({ delivered: true, via: 'claude-relay' })
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
 * back to MineScene's default cave box, which makes these positions stable.
 */
describe('MineScene as a place', () => {
  /** The `bottom: N%` a slot was positioned at. Larger means farther back. */
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

  it('sends a waiting dwarf to the foreground rest area and a working one to the rock', () => {
    const wrapper = sceneOf([
      defaultDwarf({ id: 'a', status: 'working' }),
      defaultDwarf({ id: 'b', status: 'waiting' })
    ])
    const [working, waiting] = wrapper.findAll('.scene-slot')
    // Farther back is a larger `bottom`, so the rest boulders sit lower down.
    expect(bottomOf(working!)).toBeGreaterThan(bottomOf(waiting!))
  })

  /*
    Today a leaving dwarf fades where it stands. It has to reach the painted
    passage at the back of the gallery first.
  */
  it('walks a leaving dwarf back to the painted exit rather than fading in place', () => {
    const wrapper = sceneOf([
      defaultDwarf({ id: 'a', status: 'working' }),
      defaultDwarf({ id: 'b', status: 'leaving' })
    ])
    const [leaving, working] = wrapper.findAll('.scene-slot')
    expect(bottomOf(leaving!)).toBeGreaterThan(bottomOf(working!))
  })

  it('paints the crew far to near so a nearer dwarf overlaps a farther one', () => {
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

/*
 * The owner's verdict on the CSS nuggets was that they read as grey balls
 * nobody recognises. The painted nuggets have landed, but a picture of a stone
 * still does not say how much has been mined — so the pile carries the words
 * too, and the label now names ONE material because a pile is a pile of one.
 */
describe('MineScene ore pile', () => {
  it('names the material and the amount on hover', () => {
    const wrapper = mount(MineScene, {
      props: {
        mine: defaultMine({ tier: 'gold', materials: defaultMaterials({ gold: 1_200_000 }) })
      }
    })
    const mound = wrapper.get('.ore-mound')
    expect(mound.attributes('title')).toBe('Gold ore — 12 mined (1.2M tokens)')
    expect(mound.attributes('aria-label')).toBe('Gold ore — 12 mined (1.2M tokens)')
  })

  it('stands the pile on its authored patch of floor, depth-sorted with the crew', () => {
    const wrapper = mount(MineScene, {
      props: { mine: defaultMine({ materials: defaultMaterials({ bronze: 50_000 }) }) }
    })
    const style = wrapper.get('.ore-pile').attributes('style') ?? ''
    expect(style).toMatch(/left:\s*[\d.]+%/)
    expect(style).toMatch(/bottom:\s*[\d.]+%/)
    expect(style).toMatch(/z-index:\s*\d+/)
  })
})

/*
 * The deposit is one mound PER MATERIAL, standing side by side. That is the
 * shape the non-conversion rule takes on screen (see #22): a mine that grew out
 * of copper keeps its copper heap where it was, beside its new silver, and no
 * pixel anywhere shows one material restated as another.
 */
describe('MineScene per-material deposit', () => {
  it('gives every material this mine has produced its own mound, poorest first', () => {
    const wrapper = mount(MineScene, {
      props: {
        mine: defaultMine({
          tier: 'silver',
          materials: defaultMaterials({ coal: 25_000, copper: 75_000, silver: 100_000 })
        })
      }
    })
    expect(wrapper.findAll('.ore-mound').map((mound) => mound.attributes('data-material'))).toEqual(
      ['coal', 'copper', 'silver']
    )
  })

  it('keeps what an upgraded mine already dug, in the material it was dug as', () => {
    const wrapper = mount(MineScene, {
      props: {
        mine: defaultMine({
          // Grown from copper into silver: the copper is history, not a debt to
          // be re-valued, so its four nuggets stay four copper nuggets forever.
          tier: 'silver',
          materials: defaultMaterials({ copper: 100_000, silver: 100_000 })
        })
      }
    })
    const [copper, silver] = wrapper.findAll('.ore-mound')
    expect(copper?.attributes('aria-label')).toBe('Copper ore — 4 mined (100K tokens)')
    expect(silver?.attributes('aria-label')).toBe('Silver ore — 2 mined (100K tokens)')
    expect(copper?.findAll('.nugget')).toHaveLength(4)
    expect(silver?.findAll('.nugget')).toHaveLength(2)
  })

  /*
   * Coal belongs to no tier: it is every token burned before the app existed,
   * credited once by the historical backfill. A bronze mine can therefore be
   * standing on a coal heap it will never add to.
   */
  it('stands a coal heap in a mine no tier could ever have mined coal in', () => {
    const wrapper = mount(MineScene, {
      props: {
        mine: defaultMine({ tier: 'bronze', materials: defaultMaterials({ coal: 50_000 }) })
      }
    })
    expect(wrapper.get('.ore-mound').attributes('aria-label')).toBe(
      'Coal ore — 20 mined (50K tokens)'
    )
  })

  it('leaves out a material that has not reached one whole nugget', () => {
    const wrapper = mount(MineScene, {
      props: { mine: defaultMine({ materials: defaultMaterials({ bronze: 9_999 }) }) }
    })
    expect(wrapper.find('.ore-pile').exists()).toBe(false)
  })

  /*
   * The reason the offsets are hashed rather than random: the scene re-renders
   * on every 2-second poll, and a deposit nobody touched must not twitch.
   */
  it('puts the deposit back exactly where it was on the next poll', () => {
    const mine = defaultMine({ materials: defaultMaterials({ gold: 900_000 }) })
    const first = mount(MineScene, { props: { mine } })
    const second = mount(MineScene, { props: { mine: { ...mine } } })
    expect(second.findAll('.nugget').map((n) => n.attributes('style'))).toEqual(
      first.findAll('.nugget').map((n) => n.attributes('style'))
    )
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
