// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDwarfKicking } from '../composables/useDwarfKicking'
import { useDwarfMessaging } from '../composables/useDwarfMessaging'
import { BUBBLE_TTL_MS } from '../lib/bubbles'
import { defaultDwarf, defaultMine } from '../testing/factories'
import type { Dwarf } from '../types'
import MineScene from './MineScene.vue'

describe('MineScene', () => {
  it('shows the vault chip with the mine tokensObserved in the header', () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ tokensObserved: 25_000 }) } })
    expect(wrapper.get('.vault-ore').text()).toBe('2 ore')
    expect(wrapper.get('.vault-tokens').text()).toBe('25K')
  })

  it('renders no ore pile for a mine that has not mined any ore yet', () => {
    const wrapper = mount(MineScene, { props: { mine: defaultMine({ tokensObserved: 0 }) } })
    expect(wrapper.find('.ore-pile').exists()).toBe(false)
  })

  it('grows the ore pile in discrete steps as ore increases', () => {
    // 5 ore -> orePileStep(5) = 2 nuggets.
    const small = mount(MineScene, { props: { mine: defaultMine({ tokensObserved: 50_000 }) } })
    expect(small.findAll('.ore-pile .nugget')).toHaveLength(2)

    // 150 ore -> orePileStep(150) = 5 (max) nuggets.
    const big = mount(MineScene, { props: { mine: defaultMine({ tokensObserved: 1_500_000 }) } })
    expect(big.findAll('.ore-pile .nugget')).toHaveLength(5)
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
 * nobody recognises. Painted per-material art is coming; until it does, the
 * pile has to at least be able to say what it is.
 */
describe('MineScene ore pile', () => {
  it('names the material and the amount on hover', () => {
    const wrapper = mount(MineScene, {
      props: { mine: defaultMine({ tier: 'gold', tokensObserved: 125_000 }) }
    })
    const pile = wrapper.get('.ore-pile')
    expect(pile.attributes('title')).toBe('Gold ore — 12 mined (125K tokens)')
    expect(pile.attributes('aria-label')).toBe('Gold ore — 12 mined (125K tokens)')
  })

  it('stands the pile on its authored patch of floor, depth-sorted with the crew', () => {
    const wrapper = mount(MineScene, {
      props: { mine: defaultMine({ tokensObserved: 50_000 }) }
    })
    const style = wrapper.get('.ore-pile').attributes('style') ?? ''
    expect(style).toMatch(/left:\s*[\d.]+%/)
    expect(style).toMatch(/bottom:\s*[\d.]+%/)
    expect(style).toMatch(/z-index:\s*\d+/)
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
