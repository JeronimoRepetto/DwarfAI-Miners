// @vitest-environment jsdom
import { config, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FRAME_CLOCK_KEY } from '../../composables/useFramePlayer'
import { TIP_DELAY_MS } from '../../lib/overlay/tipCard'
import type { CrewSoundSignal } from '../../lib/sprite/crewSound'
import { DWARF_CREW, DWARF_SHEETS } from '../../lib/sprite/dwarfSheets'
import {
  browserFrameClockEnv,
  createFrameClock,
  type FrameClock
} from '../../lib/sprite/frameClock'
import type { SpriteSheet } from '../../lib/sprite/spriteSheet'
import { defaultDwarf } from '../../testing/factories'
import type { Dwarf } from '../../types'
import SpriteStrip from '../dwarf/SpriteStrip.vue'
import SceneDwarf from './SceneDwarf.vue'

/*
 * The dwarf in the scene (#635), `molecules/dwarf` in the design, which replaces DwarfSprite in
 * the mine column. Where each of DwarfSprite.test.ts's guarantees went is stated in that file's
 * place: see the note at the head of MineColumn.test.ts.
 *
 * Every sprite plays on a fresh frame clock on the real window host, so the fake timers a test
 * installs are the clock's timers, with the phase pinned to frame 0 (as DwarfSprite's tests did).
 */
let frameClock: FrameClock
beforeEach(() => {
  frameClock = createFrameClock({ ...browserFrameClockEnv(), random: () => 0 })
  Reflect.set(config.global.provide, FRAME_CLOCK_KEY, frameClock)
})
afterEach(() => {
  frameClock.dispose()
  Reflect.deleteProperty(config.global.provide, FRAME_CLOCK_KEY as symbol)
  document.body.innerHTML = ''
})

const lengthOf = (sheet: SpriteSheet | undefined): number =>
  (sheet?.durations ?? []).reduce((sum, hold) => sum + hold, 0)
const startOf = (sheet: SpriteSheet | undefined, frame: number): number =>
  (sheet?.durations ?? []).slice(0, frame).reduce((sum, hold) => sum + hold, 0)

function mountDwarf(dwarf: Dwarf, props: Record<string, unknown> = {}) {
  const cues: CrewSoundSignal[] = []
  const wrapper = mount(SceneDwarf, {
    props: {
      dwarf,
      x: 20,
      y: 80,
      facesLeft: true,
      onCrewSound: (signal: CrewSoundSignal) => cues.push(signal),
      ...props
    },
    attachTo: document.body
  })
  return { wrapper, cues }
}

const sheetSrc = (wrapper: ReturnType<typeof mount>): string =>
  wrapper.find('img.dm-sprite__strip').attributes('src') ?? ''

describe('SceneDwarf', () => {
  it('is a button standing on its station, named "<name>, <state>"', () => {
    const { wrapper } = mountDwarf(defaultDwarf({ id: 'k20', name: 'dwarfai-53' }))
    const button = wrapper.find('button.dm-dwarf')
    expect(button.attributes('data-dwarf')).toBe('k20')
    expect(button.attributes('data-status')).toBe('working')
    expect(button.attributes('aria-label')).toBe('dwarfai-53, working')
    expect(button.attributes('aria-pressed')).toBe('false')
    // Image percent of the painting, which the art box shares (components.md, Dwarf, Avoid).
    expect(button.attributes('style')).toContain('--x: 20%')
    expect(button.attributes('style')).toContain('--y: 80%')
  })

  it('carries the design’s parts: the "?", the "z", the mark, the name tag, the halo, the sprite', () => {
    const { wrapper } = mountDwarf(defaultDwarf({ name: 'dwarfai-53' }))
    const over = wrapper.find('.dm-dwarf__over')
    expect(over.find('.dm-dwarf__ask').text()).toBe('?')
    expect(over.find('.dm-dwarf__z').text()).toBe('z')
    expect(over.find('.dm-dwarf__mark').exists()).toBe(true)
    expect(over.find('.dm-dwarf__tag').text()).toBe('dwarfai-53')
    expect(wrapper.find('.dm-dwarf__halo').exists()).toBe(true)
    expect(wrapper.find('.dm-sprite').exists()).toBe(true)
  })

  it('says which state it is in, for the "?" and the "z" to show on', () => {
    const asking = mountDwarf(defaultDwarf({ status: 'waiting', waitingReason: 'approval' }))
    expect(asking.wrapper.find('.dm-dwarf').attributes('data-status')).toBe('asking')
    const asleep = mountDwarf(defaultDwarf({ status: 'waiting' }))
    expect(asleep.wrapper.find('.dm-dwarf').attributes('data-status')).toBe('asleep')
  })

  // The sheets are painted facing left, so a right-facing dwarf is the mirror (#156).
  it('mirrors a dwarf facing right and draws one facing left as painted', () => {
    expect(
      mountDwarf(defaultDwarf(), { facesLeft: false }).wrapper.find('.dm-sprite').classes()
    ).toContain('dm-sprite--flip')
    expect(
      mountDwarf(defaultDwarf(), { facesLeft: true }).wrapper.find('.dm-sprite').classes()
    ).not.toContain('dm-sprite--flip')
  })

  describe('selection', () => {
    it('reports the click and lets the column above decide what opens', async () => {
      const { wrapper } = mountDwarf(defaultDwarf())
      await wrapper.find('button').trigger('click')
      await wrapper.find('button').trigger('click')
      expect(wrapper.emitted('select')).toHaveLength(2)
    })

    it('says whether it is the selected one, for the halo and for anything reading', () => {
      const { wrapper } = mountDwarf(defaultDwarf(), { selected: true })
      expect(wrapper.find('.dm-dwarf').attributes('aria-pressed')).toBe('true')
    })

    // The source says a selected dwarf keeps moving and working: selection touches no sequence.
    it('never pauses the dwarf it marks', async () => {
      const { wrapper } = mountDwarf(defaultDwarf({ status: 'working' }))
      const before = sheetSrc(wrapper)
      await wrapper.setProps({ selected: true })
      expect(sheetSrc(wrapper)).toBe(before)
    })

    it('takes the look it is forced to, as the kit’s own hover state shows it', () => {
      expect(
        mountDwarf(defaultDwarf(), { state: 'hover' }).wrapper.find('.dm-dwarf').classes()
      ).toContain('is-hover')
    })
  })

  describe('delivery marks', () => {
    it('shows no mark while nothing has been sent or kicked', () => {
      const { wrapper } = mountDwarf(defaultDwarf())
      expect(wrapper.find('.dm-dwarf').attributes('data-mark')).toBeUndefined()
      expect(wrapper.find('.dm-dwarf__mark').text()).toBe('')
    })

    // A ✓ says handed over, never that the session acted on it (AGENTS.md, delivered vs reacted).
    it('marks a handed-over message ✓ without claiming a reaction, and ✓✓ once one was seen', async () => {
      const { wrapper } = mountDwarf(defaultDwarf(), { sendState: { phase: 'delivered' } })
      expect(wrapper.find('.dm-dwarf').attributes('data-mark')).toBe('delivered')
      expect(wrapper.find('.dm-dwarf__mark').text()).toBe('✓')
      await wrapper.setProps({ sendState: { phase: 'reacted' } })
      expect(wrapper.find('.dm-dwarf').attributes('data-mark')).toBe('reacted')
      expect(wrapper.find('.dm-dwarf__mark').text()).toBe('✓✓')
    })

    it('marks a failed message and carries its reason', () => {
      const { wrapper } = mountDwarf(defaultDwarf(), {
        sendState: { phase: 'failed', error: 'The session is gone.' }
      })
      const mark = wrapper.find('.dm-dwarf__mark')
      expect(mark.text()).toBe('✕')
      expect(mark.attributes('title')).toBe('The session is gone.')
    })

    it('marks a kick when no message is on its way', () => {
      const { wrapper } = mountDwarf(defaultDwarf(), { kickState: { phase: 'kicking' } })
      expect(wrapper.find('.dm-dwarf').attributes('data-mark')).toBe('pending')
      expect(wrapper.find('.dm-dwarf__mark').text()).toBe('…')
    })
  })

  describe('what it plays', () => {
    /*
     * A dwarf already in its state when the column opens is drawn on the sheet that state plays
     * (settledClips): mid-shift at the swing, asleep, or idle — the design builds it so.
     */
    it('shows a working dwarf already at the swing, an asleep foreman asleep, an asking dwarf idle', () => {
      expect(sheetSrc(mountDwarf(defaultDwarf({ status: 'working' })).wrapper)).toBe(
        DWARF_SHEETS.worker.working!.src
      )
      expect(
        sheetSrc(mountDwarf(defaultDwarf({ role: 'foreman', status: 'waiting' })).wrapper)
      ).toBe(DWARF_SHEETS.foreman.sleeping!.src)
      // It stops and raises a hand; it does not lie down (screens/mine.md, W3·2).
      expect(
        sheetSrc(
          mountDwarf(
            defaultDwarf({ role: 'worker2', status: 'waiting', waitingReason: 'approval' })
          ).wrapper
        )
      ).toBe(DWARF_SHEETS.worker2.idle.src)
    })

    it('puts the foreman on his own sheets', () => {
      expect(
        sheetSrc(mountDwarf(defaultDwarf({ role: 'foreman', status: 'leaving' })).wrapper)
      ).toBe(DWARF_SHEETS.foreman.idle.src)
    })

    // An arrival fades in (`.is-entering`) and plays its way into its state, as dwarfClips does.
    it('fades an arrival in and plays it into its state from the transition', () => {
      const worker = mountDwarf(defaultDwarf({ status: 'working' }), { entering: true }).wrapper
      expect(worker.find('.dm-dwarf').classes()).toContain('is-entering')
      expect(sheetSrc(worker)).toBe(DWARF_SHEETS.worker['start-working']!.src)
      const foreman = mountDwarf(defaultDwarf({ role: 'foreman', status: 'waiting' }), {
        entering: true
      }).wrapper
      expect(sheetSrc(foreman)).toBe(DWARF_SHEETS.foreman['start-sleep']!.src)
    })

    it('swaps the sheet in place on a status change, keeping its element', async () => {
      const { wrapper } = mountDwarf(defaultDwarf({ role: 'foreman', status: 'waiting' }))
      const box = wrapper.find('.dm-sprite').element
      await wrapper.setProps({ dwarf: defaultDwarf({ role: 'foreman', status: 'working' }) })
      expect(wrapper.find('.dm-sprite').element).toBe(box)
      // Rest ends by getting up first (dwarfClips' own rule).
      expect(sheetSrc(wrapper)).toBe(DWARF_SHEETS.foreman['end-sleep']!.src)
    })

    /*
     * The design's Panel draws no departure: a dwarf on its way out is idle where it stood, still
     * a press away from its chat (the conversation is worth reading then, #192), until the board
     * drops it.
     */
    it('draws a dwarf on its way out idle, where it stood, still pressable', async () => {
      const { wrapper } = mountDwarf(defaultDwarf({ status: 'leaving' }))
      const button = wrapper.find('.dm-dwarf')
      expect(button.attributes('data-status')).toBe('idle')
      expect(button.attributes('style')).toContain('--x: 20%')
      await button.trigger('click')
      expect(wrapper.emitted('select')).toHaveLength(1)
    })
  })

  describe('its tooltip', () => {
    it('shows the dwarf’s card at once on keyboard focus, and Esc dismisses it', async () => {
      const { wrapper } = mountDwarf(defaultDwarf({ name: 'dwarfai-53' }))
      await wrapper.find('button').trigger('focus')
      await wrapper.vm.$nextTick()
      const card = document.body.querySelector('.dm-tip')
      expect(card?.querySelector('.dm-dtip__name')?.textContent).toBe('dwarfai-53')
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await wrapper.vm.$nextTick()
      expect(document.body.querySelector('.dm-tip')).toBeNull()
    })

    it('shows it 300ms after the pointer arrives, and not while it is merely passing', async () => {
      vi.useFakeTimers()
      try {
        const { wrapper } = mountDwarf(defaultDwarf())
        await wrapper.find('button').trigger('pointerenter')
        vi.advanceTimersByTime(TIP_DELAY_MS - 1)
        await wrapper.vm.$nextTick()
        expect(document.body.querySelector('.dm-tip')).toBeNull()
        vi.advanceTimersByTime(1)
        await wrapper.vm.$nextTick()
        expect(document.body.querySelector('.dm-tip')).not.toBeNull()
        await wrapper.find('button').trigger('pointerleave')
        expect(document.body.querySelector('.dm-tip')).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

/*
 * The crew's own sounds (#330), noticed where the frames are drawn and addressed by the column
 * above. Ported from DwarfSprite.test.ts: an ARRIVAL plays its shift from the pick-up, as every
 * DwarfSprite once did, so the timings below are the ones those tests pinned.
 */
describe('SceneDwarf crew sounds (#330)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'matchMedia')
  })

  function stubReducedMotion(matches: boolean): void {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches,
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      })
    })
  }

  const firstStrikeMs = (): number => {
    const swing = DWARF_SHEETS.worker.working!
    return lengthOf(DWARF_SHEETS.worker['start-working']) + startOf(swing, swing.impactFrames![0]!)
  }
  const pastGrindCueMs = (): number => {
    const pickUp = DWARF_SHEETS.worker2['start-working']!
    return startOf(pickUp, pickUp.frames - 1)
  }
  const arriving = (dwarf: Dwarf) => mountDwarf(dwarf, { entering: true })

  it('strikes on the frame its own sheet calls an impact', async () => {
    const { wrapper, cues } = arriving(defaultDwarf({ status: 'working' }))
    vi.advanceTimersByTime(firstStrikeMs())
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([{ cue: 'strike', gain: 0.1 }])
  })

  it('strikes on both swings of the shift, not only the first', async () => {
    const { wrapper, cues } = arriving(defaultDwarf({ status: 'working' }))
    vi.advanceTimersByTime(firstStrikeMs())
    await wrapper.vm.$nextTick()
    vi.advanceTimersByTime(lengthOf(DWARF_SHEETS.worker.working))
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([
      { cue: 'strike', gain: 0.1 },
      { cue: 'strike', gain: 0.1 }
    ])
  })

  // Found mid-shift when the column opens, its first strike is the swing it is already in.
  it('strikes on the swing a dwarf found at work is already in', async () => {
    const { wrapper, cues } = mountDwarf(defaultDwarf({ status: 'working' }))
    const swing = DWARF_SHEETS.worker.working!
    vi.advanceTimersByTime(startOf(swing, swing.impactFrames![0]!))
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([{ cue: 'strike', gain: 0.1 }])
  })

  it('sounds the worker2 grind once, as its shift starts, and not again that shift', async () => {
    const { wrapper, cues } = arriving(defaultDwarf({ role: 'worker2', status: 'working' }))
    expect(cues).toEqual([{ cue: 'shift' }])
    vi.advanceTimersByTime(pastGrindCueMs())
    await wrapper.vm.$nextTick()
    vi.advanceTimersByTime(3000)
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([{ cue: 'shift' }])
  })

  it('opens exactly one grind per shift, the next as the next shift starts', async () => {
    const { wrapper, cues } = arriving(defaultDwarf({ role: 'worker2', status: 'working' }))
    const sheets = DWARF_SHEETS.worker2
    const shift =
      lengthOf(sheets['start-working']) +
      DWARF_CREW.worker2.swings! * lengthOf(sheets.working) +
      lengthOf(sheets['end-working'])
    await vi.advanceTimersByTimeAsync(shift - 1)
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([{ cue: 'shift' }])
    await vi.advanceTimersByTimeAsync(1)
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([{ cue: 'shift' }, { cue: 'shift' }])
  })

  it('opens the grind when a worker2 is put to work, from the same frame of another sheet', async () => {
    const { wrapper, cues } = mountDwarf(defaultDwarf({ role: 'worker2', status: 'leaving' }))
    expect(cues).toEqual([])
    await wrapper.setProps({ dwarf: defaultDwarf({ role: 'worker2', status: 'working' }) })
    expect(cues).toEqual([{ cue: 'shift' }])
  })

  it('says nothing off a dwarf that is resting, asking or on its way out', async () => {
    for (const dwarf of [
      defaultDwarf({ status: 'waiting' }),
      defaultDwarf({ status: 'waiting', waitingReason: 'approval' }),
      defaultDwarf({ status: 'leaving' })
    ]) {
      const { wrapper, cues } = arriving(dwarf)
      vi.advanceTimersByTime(5000)
      await wrapper.vm.$nextTick()
      expect(cues).toEqual([])
    }
  })

  // The dwarfs keep playing under reduced motion at 200ms a frame, so the impact frame is drawn.
  it('strikes under reduced motion too, on the impact frame drawn at 200ms (#635)', async () => {
    stubReducedMotion(true)
    const { wrapper, cues } = arriving(defaultDwarf({ status: 'working' }))
    const pickUp = DWARF_SHEETS.worker['start-working']!.frames
    const impact = DWARF_SHEETS.worker.working!.impactFrames![0]!
    vi.advanceTimersByTime((pickUp + impact) * 200)
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([{ cue: 'strike', gain: 0.1 }])
  })

  it('leaves the foreman silent at the rock, having no working art to sound', async () => {
    const { wrapper, cues } = arriving(defaultDwarf({ role: 'foreman', status: 'working' }))
    vi.advanceTimersByTime(10_000)
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([])
  })

  it('ends the grind when its worker2 stops working', async () => {
    const { wrapper, cues } = arriving(defaultDwarf({ role: 'worker2', status: 'working' }))
    vi.advanceTimersByTime(pastGrindCueMs())
    await wrapper.vm.$nextTick()
    await wrapper.setProps({ dwarf: defaultDwarf({ role: 'worker2', status: 'waiting' }) })
    expect(cues).toEqual([{ cue: 'shift' }, { cue: 'shift', ending: true }])
  })

  // A grind outliving the dwarf that made it is the promise the panel exists to keep, broken.
  it('takes a grind with it when it leaves the scene', async () => {
    const { wrapper, cues } = arriving(defaultDwarf({ role: 'worker2', status: 'working' }))
    vi.advanceTimersByTime(pastGrindCueMs())
    await wrapper.vm.$nextTick()
    wrapper.unmount()
    expect(cues).toEqual([{ cue: 'shift' }, { cue: 'shift', ending: true }])
  })

  it('ends nothing on unmount for a dwarf that was not at work', () => {
    const { wrapper, cues } = mountDwarf(defaultDwarf({ status: 'waiting' }))
    wrapper.unmount()
    expect(cues).toEqual([])
  })
})

/*
 * A dwarf found at work starts on a random whole frame of its swings (#635; components.md,
 * Sprite, Anatomy): the swing is the work, and its crew does not swing in lockstep. An arrival is
 * put to work from the first frame of its pick-up instead.
 */
describe('SceneDwarf found at work', () => {
  it('starts on a random whole frame of its swings, and an arrival on its pick-up', () => {
    const clock = createFrameClock({ ...browserFrameClockEnv(), random: () => 0.5 })
    Reflect.set(config.global.provide, FRAME_CLOCK_KEY, clock)
    try {
      // The worker swings twice a shift, 13 frames each: 0.5 of 26 is frame 13, the second swing.
      const found = mountDwarf(defaultDwarf({ status: 'working' })).wrapper
      expect(found.findComponent(SpriteStrip).emitted('frame')![0]).toEqual([{ clip: 1, frame: 0 }])
      const arrival = mountDwarf(defaultDwarf({ status: 'working' }), { entering: true }).wrapper
      expect(arrival.findComponent(SpriteStrip).emitted('frame')![0]).toEqual([
        { clip: 0, frame: 0 }
      ])
    } finally {
      clock.dispose()
    }
  })
})
