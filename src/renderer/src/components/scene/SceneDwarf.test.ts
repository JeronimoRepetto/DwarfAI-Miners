// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config, enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FRAME_CLOCK_KEY } from '../../composables/useFramePlayer'
import { WALK_OUT_KEY, type WalkOutReporter } from '../../composables/useMines'
import { LEAVING_EXIT_MS } from '../../lib/presentation'
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

// Every mounted wrapper is unmounted after its test, so no walk leg, fade or timer it started
// outlives the page a later test tears down (#635: CI caught one updating a removed column).
enableAutoUnmount(afterEach)

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
    // AMENDED for #635 (PANEL-QUESTIONS 14): an arrival walks in as today's dwarf does, so it no
    // longer fades in; what stays is that it plays its way into its state.
    it('plays an arrival into its state from the transition', () => {
      const worker = mountDwarf(defaultDwarf({ status: 'working' }), { entering: true }).wrapper
      expect(worker.find('.dm-dwarf').classes()).not.toContain('is-entering')
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
     * AMENDED for #635 (PANEL-QUESTIONS 14; was: "draws a dwarf on its way out idle, where it
     * stood, still pressable"): a dwarf on its way out walks to the way out as today's does, drawn
     * idle and taking no presses, and fades once it is there (below).
     */
    it('draws a dwarf on its way out idle, and takes no more presses', () => {
      const { wrapper } = mountDwarf(defaultDwarf({ status: 'leaving' }), { walking: true })
      const button = wrapper.find('.dm-dwarf')
      expect(button.attributes('data-status')).toBe('idle')
      expect(button.classes()).toContain('is-leaving')
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

/*
 * The walk (#635, PANEL-QUESTIONS 14: today's walk stays in the mine column). RESTORED from
 * DwarfSprite.test.ts (88ee3fc), each under its old name: "keeps its own idle loop while crossing
 * the floor, having arrived at nothing yet", "starts the working sequence only once it arrives, not
 * on the status alone", "holds a leaver at full strength for as long as it is still walking out",
 * "fades a leaver only once it has reached the way out", "never calls a working dwarf departed,
 * however still it is standing". The column owns where it walks; the dwarf moves by transform
 * alone (motion.md: transform and opacity only).
 */
describe('SceneDwarf in the scene', () => {
  it('keeps its own idle loop while crossing the floor, having arrived at nothing yet', () => {
    const working = mountDwarf(defaultDwarf({ status: 'working' }), { walking: true }).wrapper
    expect(sheetSrc(working)).toBe(DWARF_SHEETS.worker.idle.src)
    const waiting = mountDwarf(defaultDwarf({ status: 'waiting' }), { walking: true }).wrapper
    expect(sheetSrc(waiting)).toBe(DWARF_SHEETS.worker.idle.src)
  })

  it('starts the working sequence only once it arrives, not on the status alone', async () => {
    const { wrapper } = mountDwarf(defaultDwarf({ status: 'working' }), { walking: true })
    expect(sheetSrc(wrapper)).toBe(DWARF_SHEETS.worker.idle.src)
    await wrapper.setProps({ walking: false })
    expect(sheetSrc(wrapper)).toBe(DWARF_SHEETS.worker['start-working']!.src)
  })

  it('holds a leaver at full strength for as long as it is still walking out', () => {
    const { wrapper } = mountDwarf(defaultDwarf({ status: 'leaving' }), { walking: true })
    expect(wrapper.find('.dm-dwarf').classes()).not.toContain('is-departed')
  })

  // AMENDED for #635 (was: mounted already at rest): the fade marks arriving at the way out, so the
  // leaver walks there first, as the column walks it.
  it('fades a leaver only once it has reached the way out', async () => {
    const { wrapper } = mountDwarf(defaultDwarf({ status: 'leaving' }), { walking: true })
    await wrapper.setProps({ walking: false })
    expect(wrapper.find('.dm-dwarf').classes()).toContain('is-departed')
  })

  /*
   * ADDED for #635: a live run tabbed onto "Freya, idle" after she had faded out. A dwarf that has
   * reached the way out is gone to the eye, so it is gone to the keyboard and the screen reader
   * too, at once rather than when the board next drops it; one still walking out is still there.
   */
  it('takes a departed leaver out of the tab order and the accessibility tree at once', async () => {
    const { wrapper } = mountDwarf(defaultDwarf({ status: 'leaving' }), { walking: true })
    const button = () => wrapper.find('.dm-dwarf')
    expect(button().attributes('inert')).toBeUndefined()
    expect(button().attributes('aria-hidden')).toBeUndefined()
    await wrapper.setProps({ walking: false })
    expect(button().attributes('inert')).toBeDefined()
    expect(button().attributes('tabindex')).toBe('-1')
    expect(button().attributes('aria-hidden')).toBe('true')
  })

  /*
   * ADDED for #635: a session that comes back under the same id (DwarfLifecycleTracker's
   * "Reappeared", and every turn of the simulation's status cycle) is real again, so its next
   * departure fades only once that walk out has reached the way out, not from its first step.
   */
  it('fades a returning leaver only once its next walk out arrives', async () => {
    const leaver = defaultDwarf({ status: 'leaving' })
    const { wrapper } = mountDwarf(leaver, { walking: true })
    const button = () => wrapper.find('.dm-dwarf')
    await wrapper.setProps({ walking: false })
    expect(button().classes()).toContain('is-departed')
    await wrapper.setProps({ dwarf: { ...leaver, status: 'working' }, walking: true })
    await wrapper.setProps({ walking: false })
    await wrapper.setProps({ dwarf: leaver, walking: true })
    expect(button().classes()).not.toContain('is-departed')
    expect(button().attributes('inert')).toBeUndefined()
    await wrapper.setProps({ walking: false })
    expect(button().classes()).toContain('is-departed')
  })

  /*
   * ADDED for #635. A dwarf at rest draws at its station as it did before the walk came back: one
   * the column never walked (drawn on its way out when the column opened, or under reduced motion)
   * has reached no way out, so it stays drawn, idle, rather than fading where it stands.
   * AMENDED for ISSUE-255 (comment only): under reduced motion a leaver is now gone at once
   * (US-MINE-009.AC05), see "SceneDwarf walk-in and walk-out"; this case runs without it.
   */
  it('draws a leaver it never walked at full strength, idle on its station', () => {
    const { wrapper } = mountDwarf(defaultDwarf({ status: 'leaving' }), { walking: false })
    const button = wrapper.find('.dm-dwarf')
    expect(button.classes()).not.toContain('is-departed')
    expect(button.attributes('data-status')).toBe('idle')
  })

  it('never calls a working dwarf departed, however still it is standing', () => {
    const { wrapper } = mountDwarf(defaultDwarf({ status: 'working' }), { walking: false })
    expect(wrapper.find('.dm-dwarf').classes()).not.toContain('is-departed')
  })

  /*
   * ADDED for #635. Where it stood when it was first drawn is its anchor, and every step after is
   * a transform from there over the leg's own duration: never a change of left or top, so a walk
   * animates only transform (motion.md) and a dwarf at rest is drawn exactly as the design places it.
   */
  it('walks by transform from where it was first drawn, over each leg’s own duration', async () => {
    const { wrapper } = mountDwarf(defaultDwarf(), { x: 20, y: 80, walking: true, walkMs: 400 })
    const button = () => wrapper.find('.dm-dwarf')
    expect(button().attributes('style')).toContain('--x: 20%')
    expect(button().attributes('style')).toContain('--dx: 0')
    await wrapper.setProps({ x: 30, y: 60 })
    const style = button().attributes('style') ?? ''
    expect(style).toContain('--x: 20%')
    expect(style).toContain('--y: 80%')
    expect(style).toContain('--dx: 10')
    expect(style).toContain('--dy: -20')
    expect(style).toContain('--walk-ms: 400ms')
  })
})

/*
 * The footsteps (#330), for exactly as long as the column walks a dwarf. RESTORED from
 * DwarfSprite.test.ts (88ee3fc), each under its old name: "says nothing at all while the dwarf is
 * still walking to the vein", "starts the footsteps when a dwarf sets off and ends them when it
 * arrives", "walks every rank, the foreman included", "ends the grind when its worker2 walks away
 * from the rock", "takes the footsteps with it too, mid-walk". NOT restored: "still walks audibly
 * under reduced motion, the walk being a position" — the ruling plays no footsteps under reduced
 * motion, and the column walks nobody then (MineColumn.test.ts).
 */
describe('SceneDwarf footsteps (#330)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('says nothing at all while the dwarf is still walking to the vein', async () => {
    const { wrapper, cues } = mountDwarf(defaultDwarf({ status: 'working' }), { walking: true })
    vi.advanceTimersByTime(5000)
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([{ cue: 'walk', gain: 0.05 }])
  })

  it('starts the footsteps when a dwarf sets off and ends them when it arrives', async () => {
    const { wrapper, cues } = mountDwarf(defaultDwarf({ status: 'waiting' }), { walking: false })
    expect(cues).toEqual([])
    await wrapper.setProps({ walking: true })
    expect(cues).toEqual([{ cue: 'walk', gain: 0.05 }])
    await wrapper.setProps({ walking: false })
    expect(cues).toEqual([
      { cue: 'walk', gain: 0.05 },
      { cue: 'walk', ending: true }
    ])
  })

  it('walks every rank, the foreman included', () => {
    for (const role of ['worker', 'worker2', 'foreman'] as const) {
      const { cues } = mountDwarf(defaultDwarf({ role, status: 'working' }), { walking: true })
      expect(cues, role).toEqual([{ cue: 'walk', gain: 0.05 }])
    }
  })

  it('ends the grind when its worker2 walks away from the rock', async () => {
    const { wrapper, cues } = mountDwarf(defaultDwarf({ role: 'worker2', status: 'working' }), {
      entering: true
    })
    await wrapper.setProps({ walking: true })
    expect(cues).toEqual([
      { cue: 'shift' },
      { cue: 'shift', ending: true },
      { cue: 'walk', gain: 0.05 }
    ])
  })

  it('takes the footsteps with it too, mid-walk', () => {
    const { wrapper, cues } = mountDwarf(defaultDwarf({ status: 'working' }), { walking: true })
    wrapper.unmount()
    expect(cues).toEqual([
      { cue: 'walk', gain: 0.05 },
      { cue: 'walk', ending: true }
    ])
  })
})

// Dwarf names (#635; decision log, Dwarf names): the scene tag and the accessible name.
describe('SceneDwarf, dwarf names (#635)', () => {
  it('tags and names a renamed dwarf by its custom name', () => {
    const { wrapper } = mountDwarf(defaultDwarf({ name: 'dwarfai-55', customName: 'Watcher' }))
    expect(wrapper.find('.dm-dwarf__tag').text()).toBe('Watcher')
    expect(wrapper.find('button.dm-dwarf').attributes('aria-label')).toBe('Watcher, working')
  })

  it('keeps the base name on a dwarf with no custom name', () => {
    const { wrapper } = mountDwarf(defaultDwarf({ name: 'dwarfai-53' }))
    expect(wrapper.find('.dm-dwarf__tag').text()).toBe('dwarfai-53')
  })
})

/*
 * APPENDED for ISSUE-255. Under reduced motion there is no walk: an arrival is on its station at once
 * and a leaver is gone at once, with no footsteps either way (US-MINE-009.AC05; components.md, Dwarf
 * in the scene: "Under reduced motion the walk reads 0ms"). And the walk-out lasts as long as the
 * sprite's own route and fade, so the sprite is what tells the board when its dwarf has gone
 * (useMines `walkingOut` / `walkedOut`), recorded here through WALK_OUT_KEY.
 */
describe('SceneDwarf walk-in and walk-out (ISSUE-255)', () => {
  let told: string[]
  beforeEach(() => {
    vi.useFakeTimers()
    told = []
    const reporter: WalkOutReporter = {
      walkingOut: (id) => told.push('walking-out ' + id),
      walkedOut: (id) => told.push('walked-out ' + id)
    }
    Reflect.set(config.global.provide, WALK_OUT_KEY, reporter)
  })
  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(config.global.provide, WALK_OUT_KEY as symbol)
    Reflect.deleteProperty(window, 'matchMedia')
  })

  function stubReducedMotion(): void {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      })
    })
  }

  it('[US-MINE-009.AC05, NFR-A11Y-10] under reduced motion an arriving or leaving dwarf appears or disappears at once on its station with no walk and no footsteps', () => {
    stubReducedMotion()
    // The column walks nobody under reduced motion, so an arrival comes with `walking` false.
    const arrival = mountDwarf(defaultDwarf({ id: 'in', status: 'working' }), { entering: true })
    const shown = arrival.wrapper.find('.dm-dwarf')
    expect(shown.classes()).not.toContain('is-gone')
    expect(shown.attributes('style')).toContain('--x: 20%')
    expect(arrival.cues.filter((cue) => cue.cue === 'walk')).toEqual([])

    const leaver = mountDwarf(defaultDwarf({ id: 'out', status: 'leaving' }))
    const gone = leaver.wrapper.find('.dm-dwarf')
    expect(gone.classes()).toContain('is-gone')
    expect(gone.attributes('aria-hidden')).toBe('true')
    expect(gone.attributes('inert')).toBeDefined()
    expect(leaver.cues.filter((cue) => cue.cue === 'walk')).toEqual([])
    // And the board is told at once, not after a walk that never happens.
    expect(told).toEqual(['walked-out out'])
  })

  it('[NFR-TIM-09] a sprite walking a departed dwarf out holds it until it has walked out and faded', async () => {
    const { wrapper } = mountDwarf(defaultDwarf({ id: 'out', status: 'leaving' }), {
      walking: true
    })
    expect(told).toEqual(['walking-out out'])
    // However long the walk: nine seconds of corridor and it is still walking.
    vi.advanceTimersByTime(9_000)
    expect(told).toEqual(['walking-out out'])
    // At the way out it fades, and only once the fade is over is it gone.
    await wrapper.setProps({ walking: false })
    vi.advanceTimersByTime(LEAVING_EXIT_MS - 1)
    expect(told).toEqual(['walking-out out'])
    vi.advanceTimersByTime(1)
    expect(told).toEqual(['walking-out out', 'walked-out out'])
  })

  it('[NFR-TIM-09] a sprite taken away mid walk-out lets its dwarf go at once', () => {
    const { wrapper } = mountDwarf(defaultDwarf({ id: 'out', status: 'leaving' }), {
      walking: true
    })
    wrapper.unmount()
    expect(told).toEqual(['walking-out out', 'walked-out out'])
  })

  it('[NFR-TIM-09] tells the board nothing about a dwarf that is not leaving', async () => {
    const { wrapper } = mountDwarf(defaultDwarf({ id: 'w', status: 'working' }), { walking: true })
    await wrapper.setProps({ walking: false })
    vi.advanceTimersByTime(LEAVING_EXIT_MS * 2)
    wrapper.unmount()
    expect(told).toEqual([])
  })
})

/*
 * APPENDED for ISSUE-254: the dwarf in the mine column as US-MINE-001, US-MINE-002, US-OBS-004 and
 * US-OBS-008 read it. The "?", the "z", the halo and the tag are drawn by the stylesheet off the
 * button's own attributes, so what the scene shows is read from the component's own rules, as the
 * design's dwarf.css writes them.
 */
describe('SceneDwarf, the mine column (ISSUE-254)', () => {
  const SFC = readFileSync(join(import.meta.dirname, 'SceneDwarf.vue'), 'utf8')
  const tipLines = (): string[] =>
    [...document.body.querySelectorAll('.dm-tip .dm-dtip__lines > div')].map((line) =>
      (line.textContent ?? '').replace(/\s+/g, ' ').trim()
    )

  it('[US-MINE-001.AC01, US-MINE-001.AC02, NFR-TIM-01, NFR-A11Y-05] a dwarf’s tooltip opens after 300 ms of hover and at once on keyboard focus with name, rank and provider, model and effort, silence and status', async () => {
    expect(TIP_DELAY_MS).toBe(300)
    vi.useFakeTimers()
    try {
      const { wrapper } = mountDwarf(
        defaultDwarf({
          name: 'dwarfai-53',
          provider: 'claude',
          model: 'opus',
          effort: 'high',
          silentForMs: 120_000,
          status: 'working'
        })
      )
      const lines = ['dwarfai-53', 'worker · Claude', 'opus · high effort', 'silent 2m · working']
      const button = wrapper.find('button')
      await button.trigger('pointerenter')
      vi.advanceTimersByTime(TIP_DELAY_MS - 1)
      await wrapper.vm.$nextTick()
      expect(document.body.querySelector('.dm-tip')).toBeNull()
      vi.advanceTimersByTime(1)
      await wrapper.vm.$nextTick()
      expect(tipLines()).toEqual(lines)
      await button.trigger('pointerleave')
      expect(document.body.querySelector('.dm-tip')).toBeNull()

      // Keyboard focus: no delay at all, not a single timer tick.
      await button.trigger('focus')
      await wrapper.vm.$nextTick()
      expect(tipLines()).toEqual(lines)
    } finally {
      vi.useRealTimers()
    }
  })

  it('[US-OBS-008.AC08, US-OBS-008.AC07] the tooltip reads rank · provider, and a subagent differs from any dwarf only in its portrait and sprite sheet', async () => {
    const root = defaultDwarf({ id: 'f1', role: 'foreman', name: 'boss', status: 'waiting' })
    const sub = defaultDwarf({
      id: 'w2',
      role: 'worker2',
      name: 'boss',
      status: 'waiting',
      parentId: 'f1'
    })
    const shown: Array<{ label?: string; status?: string; sheet: string; rank: string }> = []
    for (const dwarf of [root, sub]) {
      const { wrapper } = mountDwarf(dwarf)
      const button = wrapper.find('button.dm-dwarf')
      await button.trigger('focus')
      await wrapper.vm.$nextTick()
      shown.push({
        label: button.attributes('aria-label'),
        status: button.attributes('data-status'),
        sheet: sheetSrc(wrapper),
        rank: tipLines()[1] ?? ''
      })
      // Pressed, it reports itself as any dwarf does: the column above opens its chat.
      await button.trigger('click')
      expect(wrapper.emitted('select')).toHaveLength(1)
      wrapper.unmount()
    }
    expect(shown[0]!.rank).toBe('foreman · Claude')
    expect(shown[1]!.rank).toBe('worker · Claude')
    // Same name, same status: the same button, and only the sheet differs.
    expect(shown[1]!.label).toBe(shown[0]!.label)
    expect(shown[1]!.status).toBe(shown[0]!.status)
    expect(shown[0]!.sheet).toBe(DWARF_SHEETS.foreman.sleeping!.src)
    expect(shown[1]!.sheet).not.toBe(shown[0]!.sheet)
  })

  it('[US-OBS-004.AC12, US-OBS-004.AC13] an asleep dwarf shows z and an asking dwarf shows the idle sprite with a floating ?', async () => {
    // The stylesheet shows the "z" and the "?" off the state, and nothing else does.
    expect(SFC).toMatch(/\.dm-dwarf\[data-status='asleep'\] \.dm-dwarf__z \{\s*display: block;/)
    expect(SFC).toMatch(/\.dm-dwarf\[data-status='asking'\] \.dm-dwarf__ask \{\s*display: grid;/)

    const asleep = mountDwarf(defaultDwarf({ name: 'z1', status: 'waiting' })).wrapper
    expect(asleep.find('.dm-dwarf').attributes('data-status')).toBe('asleep')
    expect(asleep.find('.dm-dwarf__z').text()).toBe('z')
    await asleep.find('button').trigger('focus')
    await asleep.vm.$nextTick()
    expect(tipLines()[3]).toBe('asleep')
    asleep.unmount()

    const asking = mountDwarf(
      defaultDwarf({ name: 'q1', status: 'waiting', waitingReason: 'approval' })
    ).wrapper
    expect(asking.find('.dm-dwarf').attributes('data-status')).toBe('asking')
    expect(asking.find('.dm-dwarf__ask').text()).toBe('?')
    // The dedicated asking sprite is not drawn yet (PO #59): the idle sheet stands in.
    expect(sheetSrc(asking)).toBe(DWARF_SHEETS.worker.idle.src)
    await asking.find('button').trigger('focus')
    await asking.vm.$nextTick()
    expect(tipLines()[3]).toBe('needs you')
  })

  it('[US-MINE-002.AC01, US-MINE-002.AC02, US-MINE-002.AC06] a click, Enter or Space on a sprite or its portrait selects it with halo and name tag and opens its chat in the anchored MessagePanel', async () => {
    const { wrapper } = mountDwarf(defaultDwarf({ name: 'dwarfai-53' }))
    const button = wrapper.find('button.dm-dwarf')
    // A native button: Enter and Space press it exactly as a click does (PO #32).
    expect(button.element.tagName).toBe('BUTTON')
    expect(button.attributes('type')).toBe('button')
    await button.trigger('click')
    expect(wrapper.emitted('select')).toHaveLength(1)
    // Selected, it wears the halo and the name tag at full strength.
    await wrapper.setProps({ selected: true })
    expect(button.attributes('aria-pressed')).toBe('true')
    expect(SFC).toMatch(/\.dm-dwarf\[aria-pressed='true'\] \.dm-dwarf__halo \{\s*opacity: 1;/)
    expect(SFC).toMatch(/\.dm-dwarf\[aria-pressed='true'\] \.dm-dwarf__tag,/)
    expect(wrapper.find('.dm-dwarf__tag').text()).toBe('dwarfai-53')
  })

  /*
   * The story says "only its name tag, with no halo"; the pinned design (dwarf.css, d12d3fc) also
   * lifts the halo to 0.6 on hover as a hint, keeping the full halo for the selected dwarf. The new
   * design wins (lead rule); what holds either way is that a hover selects nothing and shows the tag.
   */
  it('[US-MINE-002.AC07] hovering a dwarf that is not selected shows only its name tag', async () => {
    const { wrapper } = mountDwarf(defaultDwarf({ name: 'dwarfai-53' }))
    const button = wrapper.find('button.dm-dwarf')
    await button.trigger('pointerenter')
    expect(button.attributes('aria-pressed')).toBe('false')
    expect(wrapper.emitted('select')).toBeUndefined()
    expect(SFC).toMatch(/\.dm-dwarf:hover \.dm-dwarf__tag,/)
    expect(wrapper.find('.dm-dwarf__tag').text()).toBe('dwarfai-53')
  })

  it('[US-MINE-002.AC08, US-MINE-003.AC07, NFR-A11Y-09] a dwarf’s accessible name is its name and state word', () => {
    const named = (dwarf: Dwarf) =>
      mountDwarf(dwarf).wrapper.find('button.dm-dwarf').attributes('aria-label')
    expect(named(defaultDwarf({ name: 'a', status: 'working' }))).toBe('a, working')
    expect(named(defaultDwarf({ name: 'b', status: 'waiting', waitingReason: 'approval' }))).toBe(
      'b, needs you'
    )
    expect(named(defaultDwarf({ name: 'c', status: 'waiting' }))).toBe('c, asleep')
    expect(named(defaultDwarf({ name: 'd', status: 'leaving' }))).toBe('d, Waiting')
  })
})

/*
 * APPENDED for ISSUE-263. The Panel's reduced-motion stand-ins for a dwarf (motion.md, Reduced
 * motion, d12d3fc): its "?" and its "z" stop bobbing and stay drawn, while its sprite keeps
 * playing, every frame a flat 200 ms, as every duration token reads 0 ms. jsdom applies no media
 * query, so what the stylesheets hold under `prefers-reduced-motion: reduce` is read from them; the
 * sprite's frames are read from the strip, the frame shown, under a fake `matchMedia`.
 */
describe('SceneDwarf under reduced motion (ISSUE-263)', () => {
  const REDUCED = '@media (prefers-reduced-motion: reduce)'
  const OWN = readFileSync(join(import.meta.dirname, 'SceneDwarf.vue'), 'utf8')
  const TOKENS = readFileSync(join(import.meta.dirname, '../../assets/design-tokens.css'), 'utf8')

  /** Every rule inside a reduced-motion block of `source`: its selectors and its declarations. */
  function reducedRules(source: string): Array<{ selectors: string[]; body: Map<string, string> }> {
    const rules: Array<{ selectors: string[]; body: Map<string, string> }> = []
    for (let at = source.indexOf(REDUCED); at !== -1; at = source.indexOf(REDUCED, at + 1)) {
      const open = source.indexOf('{', at)
      let depth = 1
      let end = open + 1
      for (; depth > 0; end += 1) depth += source[end] === '{' ? 1 : source[end] === '}' ? -1 : 0
      const block = source.slice(open + 1, end - 1).replace(/\/\*[\s\S]*?\*\//g, '')
      for (const [, head, body] of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        rules.push({
          selectors: head!.split(',').map((selector) => selector.trim()),
          body: new Map(
            body!
              .split(';')
              .map((line) => [
                line.slice(0, line.indexOf(':')).trim(),
                line.slice(line.indexOf(':') + 1).trim()
              ])
              .filter(([name]) => name)
              .map(([name, value]) => [name!, value!])
          )
        })
      }
    }
    return rules
  }
  const reducedFor = (part: string) =>
    [OWN, TOKENS].flatMap(reducedRules).filter((rule) => rule.selectors.includes(part))

  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'matchMedia')
  })

  function stubReducedMotion(): void {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      })
    })
  }

  it("[US-SHELL-011.AC02] a dwarf's ? or z stays drawn without bobbing", () => {
    for (const part of ['.dm-dwarf__ask', '.dm-dwarf__z']) {
      const rules = reducedFor(part)
      // The bob stops...
      expect(
        rules.map((rule) => rule.body.get('animation')),
        `${part} under reduced motion`
      ).toContainEqual(expect.stringMatching(/^none( !important)?$/))
      // ...and nothing under reduced motion hides the mark it stops.
      for (const rule of rules) {
        expect(rule.body.has('display'), part).toBe(false)
        expect(rule.body.has('visibility'), part).toBe(false)
        expect(rule.body.has('opacity'), part).toBe(false)
      }
    }
    stubReducedMotion()
    const asking = mountDwarf(defaultDwarf({ status: 'waiting', waitingReason: 'approval' }))
    expect(asking.wrapper.find('.dm-dwarf').attributes('data-status')).toBe('asking')
    expect(asking.wrapper.find('.dm-dwarf__ask').text()).toBe('?')
    const asleep = mountDwarf(defaultDwarf({ status: 'waiting' }))
    expect(asleep.wrapper.find('.dm-dwarf').attributes('data-status')).toBe('asleep')
    expect(asleep.wrapper.find('.dm-dwarf__z').text()).toBe('z')
  })

  it('[US-SHELL-011.AC07, NFR-TIM-02] dwarf sprites keep every frame at 200 ms while every duration token reads 0 ms', async () => {
    // Every duration token reads 0 ms, and the sprite frame alone reads 200 ms.
    const root = reducedRules(TOKENS).find((rule) => rule.selectors.includes(':root'))!
    const durations = [...root.body].filter(([name]) => name.startsWith('--dur-'))
    expect(durations.length).toBeGreaterThan(0)
    for (const [name, value] of durations) expect(value, name).toBe('0ms')
    expect(root.body.get('--frame-ms')).toBe('200ms')

    // The pick-up's own frames are not 200 ms each, so a flat 200 ms is the reduced-motion rule.
    const pickUp = DWARF_SHEETS.worker['start-working']!
    expect(pickUp.durations!.some((hold) => hold !== 200)).toBe(true)

    vi.useFakeTimers()
    stubReducedMotion()
    const { wrapper } = mountDwarf(defaultDwarf({ status: 'working' }), { entering: true })
    const strip = wrapper.findComponent(SpriteStrip)
    const shown = () => strip.emitted('frame')!.map(([at]) => at as { clip: number; frame: number })
    expect(shown()).toEqual([{ clip: 0, frame: 0 }])
    // Every frame of the pick-up, then into the swing: each one held exactly 200 ms, none stopped.
    const steps = pickUp.frames + 3
    for (let step = 1; step <= steps; step += 1) {
      vi.advanceTimersByTime(199)
      await wrapper.vm.$nextTick()
      expect(shown(), `frame ${step} early`).toHaveLength(step)
      vi.advanceTimersByTime(1)
      await wrapper.vm.$nextTick()
      expect(shown(), `frame ${step}`).toHaveLength(step + 1)
    }
    expect(
      shown()
        .slice(0, pickUp.frames)
        .map((at) => at.frame)
    ).toEqual(Array.from({ length: pickUp.frames }, (_, frame) => frame))
    expect(shown()[pickUp.frames]).toEqual({ clip: 1, frame: 0 })
  })
})
