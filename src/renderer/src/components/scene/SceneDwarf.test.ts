// @vitest-environment jsdom
import { config, enableAutoUnmount, mount } from '@vue/test-utils'
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
   * ADDED for #635. A dwarf at rest draws at its station as it did before the walk came back: one
   * the column never walked (drawn on its way out when the column opened, or under reduced motion)
   * has reached no way out, so it stays drawn, idle, rather than fading where it stands.
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
