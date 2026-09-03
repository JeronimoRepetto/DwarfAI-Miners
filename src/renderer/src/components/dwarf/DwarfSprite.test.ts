// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUBBLE_ROW_HEIGHT_PX } from '../../lib/overlay/bubbleLayout'
import { DWARF_SHEETS } from '../../lib/sprite/dwarfSheets'
import { dwarfClips } from '../../lib/sprite/dwarfSequence'
import { AUTHORED_SPRITE } from '../../lib/scene/sceneSizing'
import { SPRITE_FRAME_SIZE, loopOf } from '../../lib/sprite/spriteSheet'
import { defaultDwarf } from '../../testing/factories'
import { DWARF_SILENCE_WINDOW_MS, type DwarfKickState, type DwarfSendState } from '../../types'
import DwarfSprite from './DwarfSprite.vue'
import spriteSource from './DwarfSprite.vue?raw'

/*
 * Every sheet the maintainer has drawn holds at least six frames and none of
 * them declares an impact, so two live guarantees have no real dwarf to reach
 * them: "a sequence that can never change starts no timer", and "sparks fire
 * on a frame the SHEET names as a hit". Both are substituted here rather than
 * asserted through a state that happens to satisfy them today — which is what
 * lets #74's pick loop restore the sparks without a second refactor.
 *
 * (This mock replaced one of `sceneDwarfAnimation` when the per-file poses gave
 * way to packed sheets; the reason for having one is unchanged.)
 */
vi.mock('../../lib/sprite/dwarfSequence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/sprite/dwarfSequence')>()
  return { ...actual, dwarfClips: vi.fn(actual.dwarfClips) }
})

/** The real inventory, so a test that substitutes it can put it back. */
const realDwarfClips = vi.mocked(dwarfClips).getMockImplementation()!

/**
 * The sheet a sprite is drawing from, e.g. "dwarf-worker-idle-v2-Sheet".
 *
 * Read off the ROOT rather than the frame: the strip's URL is set once where it
 * inherits from, so that the per-frame write stays one short percentage (see
 * DwarfSprite's frameStyle).
 */
function sheetOf(wrapper: ReturnType<typeof mount>): string {
  const style = wrapper.attributes('style') ?? ''
  const url = /--sheet-image:\s*url\(([^)]*)\)/.exec(style)?.[1] ?? ''
  return (
    url
      .split('/')
      .pop()
      ?.replace(/\.png.*$/, '') ?? ''
  )
}

/** How far along its strip the sprite is, as the percentage the CSS carries. */
function framePercentOf(wrapper: ReturnType<typeof mount>): number {
  const style = wrapper.find('.dwarf-frame').attributes('style') ?? ''
  return Number(/--sheet-position:\s*([\d.]+)%/.exec(style)?.[1] ?? NaN)
}

/** The sheet named in the inventory, by the same basename `sheetOf` returns. */
function sheetName(src: string): string {
  return (
    src
      .split('/')
      .pop()
      ?.replace(/\.png.*$/, '') ?? ''
  )
}

const WORKER_IDLE = sheetName(DWARF_SHEETS.worker.idle.src)
const FOREMAN_IDLE = sheetName(DWARF_SHEETS.foreman.idle.src)

describe('DwarfSprite', () => {
  it('plays the worker into its swing when work starts', () => {
    // #74 lands the working strips: a worker no longer idles at the rock.
    // Freshly working plays the start-working transition first — there is
    // nothing to interrupt on a first render, mirroring how a foreman that
    // arrives already asked still falls asleep. See dwarfSequence.ts.
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'worker', status: 'working' }) }
    })
    expect(sheetOf(wrapper)).toBe(sheetName(DWARF_SHEETS.worker['start-working']!.src))
    expect(framePercentOf(wrapper)).toBe(0)
  })

  it('puts the foreman on his own sheet instead of the worker one', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'foreman', name: 'Boss', status: 'working' }) }
    })
    expect(sheetOf(wrapper)).toBe(FOREMAN_IDLE)
    expect(sheetOf(wrapper)).not.toBe(WORKER_IDLE)
  })

  it('shows the zzz overlay over a waiting worker, which is what marks the rest', () => {
    // The rest POSE went with the painted frames; the overlay is what still
    // says a dwarf is stopped, and it was already the only sleep indicator
    // (issue #72).
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'waiting' }) }
    })
    expect(sheetOf(wrapper)).toBe(WORKER_IDLE)
    expect(wrapper.find('.zzz').exists()).toBe(true)
  })

  it('mirrors a leaving dwarf toward the exit', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'leaving' }) }
    })
    expect(sheetOf(wrapper)).toBe(WORKER_IDLE)
    expect(wrapper.classes()).toContain('is-flipped')
  })

  it('does not mirror a dwarf that is staying put', () => {
    const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf({ status: 'working' }) } })
    expect(wrapper.classes()).not.toContain('is-flipped')
  })

  it('dims the dwarf while its terminal is being focused', () => {
    // The pause used to be a held neutral pose. There is no neutral frame in a
    // strip, and the dimming was always the other half of saying it.
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), activating: true }
    })
    expect(wrapper.classes()).toContain('is-activating')
  })

  it('scales the strip to one sprite box per frame, which is what the position assumes', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'worker', status: 'working' }) }
    })
    const style = wrapper.attributes('style') ?? ''
    // A freshly-working worker is on start-working (see above), not idle.
    expect(style).toContain(
      `--sheet-size: ${DWARF_SHEETS.worker['start-working']!.frames * 100}% 100%`
    )
  })

  it('writes only the frame position on the element it redraws ten times a second', () => {
    // Vite inlines a sheet under 4 KB as a base64 data URI, so four of the five
    // strips are kilobytes of string. Vue rewrites every declaration in a bound
    // style object on each patch, and a crowded valley (#42) would be rewriting
    // all of it continuously — so the strip sits on the root and inherits.
    const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
    const frame = wrapper.find('.dwarf-frame').attributes('style') ?? ''
    expect(frame).toMatch(/^--sheet-position:[^;]*;?$/)
    expect(frame).not.toContain('--sheet-image')
  })

  it('applies the animation class for its status', () => {
    for (const [status, cls] of [
      ['working', 'is-working'],
      ['waiting', 'is-waiting'],
      ['leaving', 'is-leaving']
    ] as const) {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf({ status }) } })
      expect(wrapper.classes()).toContain(cls)
    }
  })

  it('marks the provider with a badge instead of tinting the painted art', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ provider: 'codex' }) }
    })
    expect(wrapper.find('.provider-dot').classes()).toContain('provider-codex')
  })

  describe('action bar', () => {
    it('opens the action bar on click instead of activating straight away', async () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      expect(wrapper.find('.action-bar').exists()).toBe(false)

      await wrapper.find('.dwarf-hit').trigger('click')
      expect(wrapper.find('.action-bar').exists()).toBe(true)
      expect(wrapper.emitted('activate')).toBeUndefined()
    })

    it('closes the bar on a second click', async () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      await wrapper.find('.dwarf-hit').trigger('click')
      await wrapper.find('.dwarf-hit').trigger('click')
      expect(wrapper.find('.action-bar').exists()).toBe(false)
    })

    it('emits activate and closes when the console icon is chosen', async () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      await wrapper.find('.dwarf-hit').trigger('click')
      await wrapper.find('.icon-console').trigger('click')

      expect(wrapper.emitted('activate')).toHaveLength(1)
      expect(wrapper.find('.action-bar').exists()).toBe(false)
    })

    it('forwards an answer from the bar and keeps the bar open for the verdict', async () => {
      // Same reasoning as a composed message: the verdict has to land somewhere,
      // and closing the bar would take the question with it.
      const wrapper = mount(DwarfSprite, {
        props: {
          dwarf: defaultDwarf({
            pendingQuestion: {
              toolUseId: 'toolu_01',
              question: 'Which database?',
              multiSelect: false,
              options: [{ label: 'Postgres' }, { label: 'SQLite' }]
            }
          })
        }
      })
      await wrapper.find('.dwarf-hit').trigger('click')
      await wrapper.findAll('.option-card')[0]!.trigger('click')
      await wrapper.find('.question-card').trigger('keydown', { key: 'Enter' })

      expect(wrapper.emitted('answer')).toEqual([['Postgres']])
      expect(wrapper.find('.action-bar').exists()).toBe(true)
    })

    it('carries the answer verdict down to the question card', async () => {
      const wrapper = mount(DwarfSprite, {
        props: {
          dwarf: defaultDwarf({
            pendingQuestion: {
              toolUseId: 'toolu_01',
              question: 'Which database?',
              multiSelect: false,
              options: [{ label: 'Postgres' }]
            }
          }),
          answerState: {
            phase: 'refused',
            toolUseId: 'toolu_01',
            error: 'That question is no longer open.'
          }
        }
      })
      await wrapper.find('.dwarf-hit').trigger('click')
      expect(wrapper.find('.answer-error').text()).toBe('That question is no longer open.')
    })

    it('forwards a composed message and keeps the bar open for the verdict', async () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ textDelivery: 'terminal' }) }
      })
      await wrapper.find('.dwarf-hit').trigger('click')
      await wrapper.find('.icon-chat').trigger('click')
      await wrapper.find('.message-input').setValue('run the tests')
      await wrapper.find('.send-button').trigger('click')

      expect(wrapper.emitted('send-text')).toEqual([[{ text: 'run the tests', pressEnter: true }]])
      expect(wrapper.find('.action-bar').exists()).toBe(true)
    })

    it('marks a delivered message on the dwarf', () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf(), sendState: { phase: 'delivered', via: 'terminal' } }
      })
      expect(wrapper.find('.send-result').classes()).toContain('is-delivered')
    })

    it('marks a failed message and carries its reason', () => {
      const wrapper = mount(DwarfSprite, {
        props: {
          dwarf: defaultDwarf(),
          sendState: { phase: 'failed', error: 'The terminal would not come forward.' }
        }
      })
      const marker = wrapper.find('.send-result')
      expect(marker.classes()).toContain('is-failed')
      expect(marker.attributes('title')).toBe('The terminal would not come forward.')
    })

    it('shows no marker while nothing has been sent', () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      expect(wrapper.find('.send-result').exists()).toBe(false)
    })
  })

  describe('kick', () => {
    function kickableDwarf() {
      return defaultDwarf({
        capabilities: { sendText: 'terminal', cancel: 'terminal', adjustEffort: null }
      })
    }

    it('forwards a confirmed kick and keeps the bar open for the verdict', async () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: kickableDwarf() } })
      await wrapper.find('.dwarf-hit').trigger('click')
      await wrapper.find('.icon-kick').trigger('click')
      await wrapper.find('.icon-kick').trigger('click')

      expect(wrapper.emitted('kick')).toHaveLength(1)
      expect(wrapper.find('.action-bar').exists()).toBe(true)
    })

    it('marks a delivered kick on the dwarf', () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: kickableDwarf(), kickState: { phase: 'delivered', via: 'terminal' } }
      })
      expect(wrapper.find('.kick-result').classes()).toContain('is-delivered')
    })

    it('marks a failed kick and carries its reason', () => {
      const wrapper = mount(DwarfSprite, {
        props: {
          dwarf: kickableDwarf(),
          kickState: { phase: 'failed', error: 'The agent terminal could not be reached.' }
        }
      })
      const marker = wrapper.find('.kick-result')
      expect(marker.classes()).toContain('is-failed')
      expect(marker.attributes('title')).toBe('The agent terminal could not be reached.')
    })

    it('shows no kick marker while nothing has been kicked', () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: kickableDwarf() } })
      expect(wrapper.find('.kick-result').exists()).toBe(false)
    })
  })

  it('shows a speech bubble only when bubble text is provided', () => {
    const silent = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
    expect(silent.find('.speech-bubble').exists()).toBe(false)
    const talking = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf(), bubbleText: 'Refactoring the parser' }
    })
    expect(talking.find('.speech-bubble').text()).toContain('Refactoring the parser')
  })

  /*
   * Issue #43 — a bubble drawn directly above its own sprite smeared into its
   * neighbours' once several dwarfs shared one painted anchor. `bubbleRow`
   * (MineScene's `ScenePlacement.shareIndex`) lifts a sharer's bubble clear;
   * a dwarf with no anchor to share must render exactly as it always has.
   */
  describe('bubble stacking', () => {
    it('places a bubble with no bubbleRow prop exactly where it sits today', () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf(), bubbleText: 'Digging the API layer' }
      })
      // No lift means no extra style at all: the DOM is unchanged from before #43.
      expect(wrapper.find('.bubble-holder').attributes('style')).toBeUndefined()
    })

    it('leaves row 0 (the sole occupant of an anchor) unlifted too', () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf(), bubbleText: 'Digging the API layer', bubbleRow: 0 }
      })
      expect(wrapper.find('.bubble-holder').attributes('style')).toBeUndefined()
    })

    it('lifts a bubble sharing an anchor by its stack row', () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf(), bubbleText: 'Digging the API layer', bubbleRow: 2 }
      })
      const holder = wrapper.get('.bubble-holder').element as HTMLElement
      expect(holder.style.getPropertyValue('--bubble-lift')).toBe(`${2 * BUBBLE_ROW_HEIGHT_PX}px`)
    })

    it('gives two different stack rows two different lifts', () => {
      const rowOne = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf(), bubbleText: 'first', bubbleRow: 1 }
      })
      const rowTwo = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf(), bubbleText: 'second', bubbleRow: 2 }
      })
      const liftOf = (wrapper: ReturnType<typeof mount>): string =>
        (wrapper.get('.bubble-holder').element as HTMLElement).style.getPropertyValue(
          '--bubble-lift'
        )
      expect(liftOf(rowOne)).not.toBe(liftOf(rowTwo))
    })
  })

  describe('speech bubble expansion', () => {
    const FULL_MESSAGE =
      'A very long report that the truncated bubble cannot possibly show in full, spanning several sentences of agent chatter.'

    function mountTalking() {
      return mount(DwarfSprite, {
        props: {
          dwarf: defaultDwarf({ name: 'Echo', lastMessage: FULL_MESSAGE }),
          bubbleText: 'A very long report that the truncated bubble cannot…'
        }
      })
    }

    it('renders the bubble as a real button so Enter can expand it', () => {
      const hit = mountTalking().find('.bubble-hit')
      expect(hit.element.tagName).toBe('BUTTON')
      expect(hit.attributes('aria-label')).toContain('Echo')
      expect(hit.attributes('aria-expanded')).toBe('false')
    })

    it('expands on click, showing the full message and holding the bubble', async () => {
      const wrapper = mountTalking()
      expect(wrapper.find('.bubble-expanded').exists()).toBe(false)

      await wrapper.find('.bubble-hit').trigger('click')
      expect(wrapper.find('.bubble-expanded').text()).toContain(FULL_MESSAGE)
      expect(wrapper.find('.bubble-hit').attributes('aria-expanded')).toBe('true')
      expect(wrapper.emitted('bubble-hold')).toHaveLength(1)
    })

    it('does not toggle the dwarf action bar when the bubble is clicked', async () => {
      const wrapper = mountTalking()
      await wrapper.find('.bubble-hit').trigger('click')
      expect(wrapper.find('.action-bar').exists()).toBe(false)
      expect(wrapper.emitted('activate')).toBeUndefined()
    })

    it('collapses on a second bubble click and releases the hold', async () => {
      const wrapper = mountTalking()
      await wrapper.find('.bubble-hit').trigger('click')
      await wrapper.find('.bubble-hit').trigger('click')
      expect(wrapper.find('.bubble-expanded').exists()).toBe(false)
      expect(wrapper.emitted('bubble-release')).toHaveLength(1)
    })

    it('collapses on Escape and releases the hold', async () => {
      const wrapper = mountTalking()
      await wrapper.find('.bubble-hit').trigger('click')

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.bubble-expanded').exists()).toBe(false)
      expect(wrapper.emitted('bubble-release')).toHaveLength(1)
    })

    it('collapses on an outside click', async () => {
      const wrapper = mountTalking()
      await wrapper.find('.bubble-hit').trigger('click')

      document.body.click()
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.bubble-expanded').exists()).toBe(false)
      expect(wrapper.emitted('bubble-release')).toHaveLength(1)
    })

    it('stays open on a click inside the panel (scrolling a long message)', async () => {
      const wrapper = mountTalking()
      await wrapper.find('.bubble-hit').trigger('click')
      await wrapper.find('.bubble-expanded').trigger('click')
      expect(wrapper.find('.bubble-expanded').exists()).toBe(true)
      expect(wrapper.emitted('bubble-release')).toBeUndefined()
    })

    it('collapses and releases when the bubble disappears mid-read', async () => {
      const wrapper = mountTalking()
      await wrapper.find('.bubble-hit').trigger('click')

      await wrapper.setProps({ bubbleText: undefined })
      expect(wrapper.find('.bubble-expanded').exists()).toBe(false)
      expect(wrapper.emitted('bubble-release')).toHaveLength(1)
    })

    it('opening the action bar collapses the expanded bubble', async () => {
      const wrapper = mountTalking()
      await wrapper.find('.bubble-hit').trigger('click')

      await wrapper.find('.dwarf-hit').trigger('click')
      expect(wrapper.find('.action-bar').exists()).toBe(true)
      expect(wrapper.find('.bubble-expanded').exists()).toBe(false)
      expect(wrapper.emitted('bubble-release')).toHaveLength(1)
    })
  })

  it('describes the dwarf in its tooltip', () => {
    const wrapper = mount(DwarfSprite, {
      props: {
        dwarf: defaultDwarf({
          name: 'Gimli',
          provider: 'codex',
          model: 'gpt-test',
          effort: 'high',
          status: 'waiting'
        })
      }
    })
    const tooltip = wrapper.find('.dwarf-tooltip')
    for (const detail of ['Gimli', 'codex', 'gpt-test', 'high', 'Waiting']) {
      expect(tooltip.text()).toContain(detail)
    }
  })

  describe('tooltip visibility', () => {
    it('hides the tooltip until the sprite is hovered or focused', async () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      expect(wrapper.find('.tooltip-holder').classes()).not.toContain('is-visible')

      await wrapper.find('.dwarf-hit').trigger('mouseenter')
      expect(wrapper.find('.tooltip-holder').classes()).toContain('is-visible')

      await wrapper.find('.dwarf-hit').trigger('mouseleave')
      expect(wrapper.find('.tooltip-holder').classes()).not.toContain('is-visible')
    })

    it('also shows the tooltip on keyboard focus', async () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      await wrapper.find('.dwarf-hit').trigger('focus')
      expect(wrapper.find('.tooltip-holder').classes()).toContain('is-visible')
      await wrapper.find('.dwarf-hit').trigger('blur')
      expect(wrapper.find('.tooltip-holder').classes()).not.toContain('is-visible')
    })
  })

  describe('frame cycling', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('steps one frame along the strip per frame hold', async () => {
      // 'waiting' (not 'working'), so the strip under test is still the plain
      // idle loop now that working has its own start-working sheet — this
      // test is about the stepping mechanism, not any one sheet's frame count.
      const { frames, frameMs } = DWARF_SHEETS.worker.idle
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ status: 'waiting' }) }
      })
      expect(framePercentOf(wrapper)).toBe(0)
      vi.advanceTimersByTime(frameMs)
      await wrapper.vm.$nextTick()
      expect(framePercentOf(wrapper)).toBeCloseTo(100 / (frames - 1))
      vi.advanceTimersByTime(frameMs)
      await wrapper.vm.$nextTick()
      expect(framePercentOf(wrapper)).toBeCloseTo(200 / (frames - 1))
    })

    it('wraps back to the head of the strip at the end of a loop', async () => {
      // Same reasoning as above: 'waiting' keeps this on the idle loop.
      const { frames, frameMs } = DWARF_SHEETS.worker.idle
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ status: 'waiting' }) }
      })
      vi.advanceTimersByTime(frames * frameMs)
      await wrapper.vm.$nextTick()
      expect(framePercentOf(wrapper)).toBe(0)
    })

    it('holds a single-frame animation still', async () => {
      vi.mocked(dwarfClips).mockReturnValue([
        loopOf({ src: '/one-frame.png', frames: 1, frameMs: 1400 })
      ])
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ role: 'foreman', status: 'waiting' }) }
      })
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(10_000)
      await wrapper.vm.$nextTick()
      expect(sheetOf(wrapper)).toBe('one-frame')
      expect(framePercentOf(wrapper)).toBe(0)
      vi.mocked(dwarfClips).mockImplementation(realDwarfClips)
    })

    it('restarts the cycle from the first frame when the loop changes', async () => {
      // Was pinned through a status change, which used to select a different
      // pose table. Every status a WORKER can be in now draws the same sheet
      // (#74), so the foreman being asked a question is the change that is
      // actually visible — and it restarts on frame 0 exactly as before.
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ role: 'foreman', status: 'working' }) }
      })
      vi.advanceTimersByTime(DWARF_SHEETS.foreman.idle.frameMs)
      await wrapper.vm.$nextTick()
      expect(framePercentOf(wrapper)).toBeGreaterThan(0)

      await wrapper.setProps({
        dwarf: defaultDwarf({ role: 'foreman', status: 'waiting', waitingReason: 'user-input' })
      })
      expect(framePercentOf(wrapper)).toBe(0)
    })

    it('stops its timer when unmounted', () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ status: 'working' }) }
      })
      wrapper.unmount()
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})

/**
 * The marker is where the two-phase verdict becomes visible (issue #21), so
 * what it says has to stay pinned: a ✓ claims only that the message was handed
 * over, and only a ✓✓ claims the session acted.
 */
function markerSprite(states: { sendState?: DwarfSendState; kickState?: DwarfKickState }) {
  return mount(DwarfSprite, {
    props: { dwarf: defaultDwarf(), ...states }
  })
}

describe('DwarfSprite send marker', () => {
  it('marks a handed-over message without claiming a reaction', () => {
    const wrapper = markerSprite({
      sendState: { phase: 'delivered', via: 'claude-relay', awaitingReaction: true }
    })
    const marker = wrapper.get('.send-result')

    expect(marker.text()).toBe('✓')
    expect(marker.attributes('title')).toMatch(/handed to the session/i)
    expect(marker.attributes('title')).not.toMatch(/reacted/i)
  })

  it('upgrades the marker once the session was seen reacting', () => {
    const wrapper = markerSprite({ sendState: { phase: 'reacted', via: 'claude-relay' } })
    const marker = wrapper.get('.send-result')

    expect(marker.text()).toBe('✓✓')
    expect(marker.classes()).toContain('is-reacted')
    expect(marker.attributes('title')).toMatch(/reacted/i)
  })

  it('admits when the watch closed without seeing anything', () => {
    const wrapper = markerSprite({
      sendState: { phase: 'delivered', via: 'terminal', awaitingReaction: false }
    })
    expect(wrapper.get('.send-result').attributes('title')).toMatch(/no reaction/i)
  })
})

describe('DwarfSprite kick marker', () => {
  it('marks a handed-over kick without claiming the session stopped', () => {
    const wrapper = markerSprite({
      kickState: { phase: 'delivered', via: 'terminal', awaitingReaction: true }
    })
    const marker = wrapper.get('.kick-result')

    expect(marker.text()).toBe('✓')
    expect(marker.attributes('title')).toMatch(/handed to the session/i)
  })

  it('upgrades the marker once the session was seen stopping', () => {
    const wrapper = markerSprite({ kickState: { phase: 'reacted', via: 'terminal' } })
    const marker = wrapper.get('.kick-result')

    expect(marker.text()).toBe('✓✓')
    expect(marker.classes()).toContain('is-reacted')
  })

  it('shows both verdicts at once, on their own corners', () => {
    const wrapper = markerSprite({
      sendState: { phase: 'reacted', via: 'terminal' },
      kickState: { phase: 'delivered', via: 'terminal', awaitingReaction: true }
    })

    expect(wrapper.find('.send-result').exists()).toBe(true)
    expect(wrapper.find('.kick-result').exists()).toBe(true)
  })
})

/*
 * Issue #19 — the sprite is now placed in the cave by MineScene rather than
 * standing in a row. Every scene prop is optional and every one of them falls
 * back to the behaviour above, which is why the tests before this point mount
 * a bare sprite and still pass.
 */
describe('DwarfSprite in the scene', () => {
  it('keeps its own sheet while crossing the floor, having no walk strip', () => {
    // Was `dwarf-walk-1`. No walk sheet has been drawn (#74), and a dwarf that
    // slid across the cave on the retired painted frames would be the only
    // AI-painted thing left on screen. Style consistency over motion fidelity,
    // chosen deliberately — the crossing itself is unchanged, MineScene still
    // walks him there. `walking` is a scene prop, not a sequence input: the
    // STATUS still decides the sheet, so a worker already `working` while
    // crossing the floor now plays its working sequence rather than idling —
    // only `waiting`, still undrawn, falls back to idle.
    const working = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true, walking: true }
    })
    expect(sheetOf(working)).toBe(sheetName(DWARF_SHEETS.worker['start-working']!.src))

    const waiting = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'waiting' }), anchored: true, walking: true }
    })
    expect(sheetOf(waiting)).toBe(WORKER_IDLE)
  })

  it('drops back into its own loop the moment it arrives', () => {
    // Arrived and working now means the working sequence, not idle — see the
    // note above on `walking` being a scene prop rather than a sequence input.
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true, walking: false }
    })
    expect(sheetOf(wrapper)).toBe(sheetName(DWARF_SHEETS.worker['start-working']!.src))
  })

  it('faces the rock the scene put it at, not the direction the old rule assumed', () => {
    const facingLeft = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true, facesLeft: true }
    })
    expect(facingLeft.classes()).toContain('is-flipped')

    // A leaving dwarf used to be mirrored unconditionally; the exit is painted
    // at the centre of the gallery, so the scene decides instead.
    const leavingRight = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'leaving' }), anchored: true, facesLeft: false }
    })
    expect(leavingRight.classes()).not.toContain('is-flipped')
  })

  it('stands down its own walk-out slide once the scene owns its position', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'leaving' }), anchored: true }
    })
    expect(wrapper.classes()).toContain('is-anchored')
    expect(wrapper.classes()).toContain('is-leaving')
  })

  it('shrinks a dwarf standing further back into the gallery', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf(), anchored: true, depthScale: 0.8 }
    })
    expect(wrapper.attributes('style')).toContain('--depth-scale: 0.8')
  })

  it('draws a lone sprite at full size, as it did before the cave had depth', () => {
    const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
    expect(wrapper.attributes('style')).toContain('--depth-scale: 1')
  })
})

/*
 * The cave reacting to the crew, not just holding it: a hit on the rock throws
 * debris. It used to fire off a pose NAME (`pick-2`); a strip has no pose
 * names, so the sheet declares its own impact frames and the sprite reads them.
 * That is what keeps the burst alive across the art swap — no sheet drawn so
 * far names an impact, because no swing has been drawn, and #74's pick loop
 * restores the sparks by declaring one.
 */
describe('DwarfSprite pick sparks', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(dwarfClips).mockImplementation(realDwarfClips)
  })

  /** A four-frame swing whose third frame is the moment it bites. */
  function stubSwing(): void {
    vi.mocked(dwarfClips).mockReturnValue([
      loopOf({ src: '/swing.png', frames: 4, frameMs: 120, impactFrames: [2] })
    ])
  }

  it('throws sparks when the pick comes down on the rock', async () => {
    stubSwing()
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true }
    })
    expect(wrapper.find('.spark-burst').exists()).toBe(false)

    vi.advanceTimersByTime(240)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.spark-burst').exists()).toBe(true)
    expect(wrapper.findAll('.spark').length).toBeGreaterThan(0)
  })

  it('throws none while the dwarf is still walking to the vein', async () => {
    stubSwing()
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true, walking: true }
    })
    vi.advanceTimersByTime(5000)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.spark-burst').exists()).toBe(false)
  })

  it('throws none off a dwarf that is resting or walking out', async () => {
    stubSwing()
    for (const status of ['waiting', 'leaving'] as const) {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ status }), anchored: true }
      })
      vi.advanceTimersByTime(5000)
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.spark-burst').exists(), status).toBe(false)
    }
  })

  it('throws none off the idle loop, which still claims no hit', () => {
    // The idle sheet is what every rank falls back to and has never drawn a
    // swing — a dwarf standing at ease must never throw debris. (Previously
    // this test covered a REAL working dwarf too, back when no sheet at all
    // declared a hit; #74 below gives `working` its own strike frame, so
    // that half of the claim moved to the test that follows.)
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'waiting' }), anchored: true }
    })
    vi.advanceTimersByTime(10_000)
    expect(wrapper.find('.spark-burst').exists()).toBe(false)
  })

  it('throws sparks off the real working sheet now that #74 declares its strike', async () => {
    // The stub above exists because no sheet used to claim a hit; the
    // worker's own working sheet now does (index 4, the artist's frame 5 —
    // see dwarfSheets.test.ts), so the genuine, unstubbed dwarfClips must
    // reach the same burst without a substitute.
    //
    // A single, exact jump rather than a long `advanceTimersByTime`: Vue
    // coalesces a watcher across a synchronous run of interval callbacks
    // down to one job reflecting the FINAL elapsed value, so a coarse
    // advance can sail straight past the one frame that matters and land
    // somewhere else in the loop's other ten frames. 300ms clears the
    // 3-frame start-working transition; +400ms lands exactly on index 4 of
    // the working loop behind it (see dwarfSequence.ts).
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true }
    })
    vi.advanceTimersByTime(700)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.spark-burst').exists()).toBe(true)
  })
})

/*
 * The strike's own light (#74's last piece): a brief glow the sprite adds
 * beside the art's own sparks, keyed off the sheet's own glowFrames exactly
 * the way the burst above is keyed off impactFrames — declared data, never a
 * frame number written into the component.
 */
describe('DwarfSprite strike glow', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(dwarfClips).mockImplementation(realDwarfClips)
  })

  /** Mirrors the artist's map: index 4-5 are the two brightest, 6-8 disperse. */
  function stubGlowSwing(): void {
    vi.mocked(dwarfClips).mockReturnValue([
      loopOf({
        src: '/glow-swing.png',
        frames: 9,
        frameMs: 100,
        impactFrames: [4],
        glowFrames: [4, 5]
      })
    ])
  }

  it('lights the strike and its brightest echo, index 4 and 5', async () => {
    stubGlowSwing()
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true }
    })
    vi.advanceTimersByTime(400) // frame 4
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dwarf-frame').classes()).toContain('is-strike-glow')

    vi.advanceTimersByTime(100) // frame 5
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dwarf-frame').classes()).toContain('is-strike-glow')
  })

  it('leaves the dispersal frames glow-free — the art carries 6-8 alone', async () => {
    stubGlowSwing()
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true }
    })
    vi.advanceTimersByTime(600) // frame 6
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dwarf-frame').classes()).not.toContain('is-strike-glow')

    vi.advanceTimersByTime(200) // frame 8
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dwarf-frame').classes()).not.toContain('is-strike-glow')
  })

  it('never glows a dwarf still walking to the vein', async () => {
    stubGlowSwing()
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true, walking: true }
    })
    vi.advanceTimersByTime(400)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dwarf-frame').classes()).not.toContain('is-strike-glow')
  })

  it('lights the real working sheet too, not only a stub', async () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true }
    })
    // 300ms clears the 3-frame start-working transition; +400ms lands on
    // index 4 of the working loop behind it (see dwarfSequence.ts).
    vi.advanceTimersByTime(700)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dwarf-frame').classes()).toContain('is-strike-glow')
  })
})

/*
 * Issue #47 — the first change that lets the person watching form their own
 * judgement about a probable ghost. Every earlier ghost fix argued with itself
 * behind the user's back; a dwarf that stops swinging and stands with its pick
 * shouldered says "nothing has come out of this one in a long time" without a
 * single new asset, and without silence ever becoming a state anything else
 * can key off.
 */
describe('DwarfSprite silence', () => {
  /** Just past the worker's half hour — a dwarf the provider is about to judge. */
  const WORKER_SILENT = DWARF_SILENCE_WINDOW_MS.unattended

  /*
   * REMOVED with the painted poses, and stated here rather than left to be
   * noticed: three cases pinned the silence POSE — a silent worker standing on
   * `dwarf-idle`, and two keeping the swing (`dwarf-pick-1`) for a dwarf that
   * had produced something or whose provider reported nothing. Neither pose
   * exists as a sheet; #74 has drawn one loop for a worker and no more.
   *
   * The RULE they were pinning is untouched and still tested: `isDwarfSilent`
   * in lib/presentation.test.ts holds both windows and #68's attendance
   * binding. What is gone is the sprite drawing the answer, and the case below
   * is what replaces them — the honest one, which says so.
   */
  it('draws a silent worker exactly like a busy one, having no silence pose', () => {
    const busy = mount(DwarfSprite, { props: { dwarf: defaultDwarf({ status: 'working' }) } })
    const quiet = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working', silentForMs: WORKER_SILENT }) }
    })
    expect(sheetOf(quiet)).toBe(sheetOf(busy))
  })

  it('leaves everything else about the dwarf saying working', () => {
    // Silence is a picture layered over `working`, not a fourth status: the
    // animation class, the accessible name and the resting overlay must all
    // read exactly as they do for a busy dwarf.
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working', silentForMs: WORKER_SILENT }) }
    })
    expect(wrapper.classes()).toContain('is-working')
    expect(wrapper.find('.dwarf-hit').attributes('aria-label')).toContain('working')
    expect(wrapper.find('.zzz').exists()).toBe(false)
  })

  /*
   * Issue #68. Rank made a `claude -p` run a foreman — it is the root of its
   * own session tree — and the hour that came with the rank exists for a human
   * who might be typing. There is none, so the ATTENDANCE the provider stamped
   * picks the window, never the rank.
   *
   * REMOVED with the painted poses: three cases read that rule off the sprite,
   * by advancing one frame and separating a foreman still looking up from his
   * log book (`foreman-check`) from one that had stopped (`foreman-idle`). A
   * foreman has one idle strip and no silence strip, so there is no longer a
   * drawing to read the answer from.
   *
   * The rule itself is where it always was and is fully covered there:
   * `isDwarfSilent` in lib/presentation.test.ts, "judges a headless foreman on
   * the half hour" and the two beside it. Nothing about the windows changed
   * here; only the sprite stopped drawing them. When #74 delivers a working
   * loop, a silent foreman gets a pose again and these belong back.
   */
  it('reads a silent foreman no differently from a busy one, having no silence strip', () => {
    for (const attendance of ['unattended', 'attended', 'unknown'] as const) {
      const wrapper = mount(DwarfSprite, {
        props: {
          dwarf: defaultDwarf({
            role: 'foreman',
            status: 'working',
            silentForMs: WORKER_SILENT,
            attendance
          })
        }
      })
      expect(sheetOf(wrapper), attendance).toBe(FOREMAN_IDLE)
    }
  })

  it('shows the exact figure in the tooltip beside the name and model', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ name: 'Durin', silentForMs: 25 * 60_000 }) }
    })
    const tooltip = wrapper.find('.dwarf-tooltip')
    expect(tooltip.text()).toContain('Durin')
    expect(tooltip.text()).toContain('no output for 25 minutes')
  })

  /*
   * REMOVED with the painted poses: the "cost of standing still" trio, which
   * held that a dwarf we suspect is dead costs LESS to draw than a live one —
   * a single-frame silence loop never reached setInterval at all, the foreman
   * visibly stopped looking up from his log book, and the swing came back the
   * moment output resumed.
   *
   * Every sheet drawn so far holds at least six frames, so no state a real
   * dwarf can be in reaches the no-timer branch any more. The branch is still
   * live and still guaranteed — "holds a single-frame animation still" above
   * substitutes a one-frame clip to reach it — and reduced motion now owns the
   * only timer a dwarf actually stops for.
   */
  it('runs one timer per sprite, whatever the dwarf is doing', () => {
    vi.useFakeTimers()
    try {
      mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ status: 'working', silentForMs: WORKER_SILENT }) }
      })
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

/*
 * Issue #44 — the sprite's size is a CSS contract, so these read the component's
 * own <style> block rather than a mounted element: vitest does not apply scoped
 * styles, so `getComputedStyle` here would report nothing at all and quietly
 * agree with whatever it was asked.
 */
describe('DwarfSprite sizing', () => {
  /** The body of one rule from the component's style block, by exact selector. */
  function styleRule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const body = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(spriteSource)?.[1]
    if (body === undefined) throw new Error(`no ${selector} rule in DwarfSprite.vue`)
    return body
  }

  it('takes its height from the panel-derived sprite size, with depth still on top', () => {
    // `--sprite-height` is the scene's own scale (MineScene, from the measured
    // cave box); `--depth-scale` is perspective WITHIN that scene. Both, in
    // that order — the hard-coded 100px was what issue #44 came to remove.
    expect(styleRule('.dwarf-frame')).toMatch(
      /height:\s*calc\(\s*var\(--sprite-height[^)]*\)\s*\*\s*var\(--depth-scale/
    )
  })

  it('still draws a sprite mounted outside any scene at its authored size', () => {
    // The var fallbacks are what keep a bare sprite byte-for-byte what it was.
    expect(styleRule('.dwarf-frame')).toContain('--sprite-height, 100px')
    // 95, not 96: the box follows the 36x38 frame now (94.74, rounded whole).
    expect(styleRule('.dwarf-sprite')).toContain(
      `--sprite-width, ${Math.round(AUTHORED_SPRITE.width)}px`
    )
  })

  it('scales its own box with its height, so the pose stays centred on the anchor', () => {
    expect(styleRule('.dwarf-sprite')).toMatch(/width:\s*var\(--sprite-width/)
    expect(styleRule('.dwarf-name')).toMatch(/max-width:\s*var\(--sprite-width/)
  })

  /*
    The constraint the sizing mechanism had to route around, and the reason it
    is a custom property driving `height` rather than the obvious `transform:
    scale()`. The tooltip, action bar and expanded bubble are `position: fixed`
    and placed in viewport coordinates by computeTooltipPlacement; a transform
    on `.dwarf-sprite` would make it their containing block and every one of
    them would land in the wrong place.

    Two neighbours were considered and left alone: `.is-flipped .dwarf-frame`
    keeps its `scale: -1 1` (the frame is a leaf <img> with no fixed descendants
    to capture), and the unanchored `walk-out` keyframes keep their `translate`
    (a sprite outside a scene has no anchored popover placement to break).
  */
  it('puts no transform on the sprite, so the fixed tooltip, bar and bubble stay clamped', () => {
    expect(styleRule('.dwarf-frame')).not.toMatch(/transform\s*:/)
    expect(styleRule('.dwarf-sprite')).not.toMatch(/transform\s*:/)
  })

  /*
   * Issue #90's second coupling, and the reason it is a test rather than a
   * line of CSS nobody looks at again. `--sprite-height` and `--depth-scale`
   * both scale the drawing continuously, so a 38px-tall frame is essentially
   * never drawn at a whole multiple of itself. Without this the browser
   * interpolates, the pixel art renders soft, and the art gets the blame.
   */
  it('scales the pixel art with nearest-neighbour rather than letting it blur', () => {
    expect(styleRule('.dwarf-frame')).toMatch(/image-rendering:\s*pixelated/)
  })

  it('takes the frame box from the sheet geometry rather than a literal pair', () => {
    // 36 x 38 lives in SPRITE_FRAME_SIZE and reaches the CSS as a custom
    // property, so a redraw at another size is one constant and not a hunt.
    expect(styleRule('.dwarf-frame')).toMatch(/aspect-ratio:\s*var\(--frame-aspect/)
    const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
    expect(wrapper.attributes('style')).toContain(
      `--frame-aspect: ${SPRITE_FRAME_SIZE.width} / ${SPRITE_FRAME_SIZE.height}`
    )
  })
})

/*
 * Issue #72 — a resting dwarf used to carry two sleep indicators at once: the
 * `z` painted into `rest-2`, and this CSS overlay drawn over the same image.
 * The overlay is the one that stayed, which leaves rest a single pose the
 * sprite never has to run a timer for.
 */
describe('DwarfSprite sleep indicator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('says a dwarf is asleep exactly once, and it is the drifting overlay', async () => {
    const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf({ status: 'waiting' }) } })
    expect(wrapper.find('.zzz').exists()).toBe(true)

    // A worker has one strip and no sleep art, so the sprite says nothing
    // about rest at all and the overlay is the whole of the indicator — which
    // is exactly the shape #72 left it in, arrived at from the other side.
    vi.advanceTimersByTime(10_000)
    await wrapper.vm.$nextTick()
    expect(sheetOf(wrapper)).toBe(WORKER_IDLE)
  })

  /*
   * REPLACED twice now. First: this used to hold that resting started no
   * timer at all, because rest was a single pose — the worker's idle strip is
   * six frames, so resting costs a timer again. Second, with #74's working
   * art: resting and working used to draw identically (both idle, neither
   * drawn); working now has its own sequence, so the comparison inverts. What
   * stays pinned throughout is the invariant that motivated the test: the
   * overlay is still the only thing claiming SLEEP for a worker — a second
   * sleep indicator is what #72 came to remove, and the foreman's sleep
   * sheets are the first art since that could reintroduce one. A worker
   * resting still has no rest sheet of its own and still idles.
   */
  it('does not draw a worker asleep, though working no longer matches resting', () => {
    const resting = mount(DwarfSprite, { props: { dwarf: defaultDwarf({ status: 'waiting' }) } })
    const working = mount(DwarfSprite, { props: { dwarf: defaultDwarf({ status: 'working' }) } })
    expect(sheetOf(resting)).toBe(WORKER_IDLE)
    expect(sheetOf(working)).not.toBe(WORKER_IDLE)
    expect(sheetOf(resting)).not.toBe(sheetOf(working))
  })

  it('draws a foreman actually asleep when a person was asked, and says so once', async () => {
    const wrapper = mount(DwarfSprite, {
      props: {
        dwarf: defaultDwarf({ role: 'foreman', status: 'waiting', waitingReason: 'user-input' })
      }
    })
    // Falls asleep first, then stays asleep: two sheets, one movement.
    expect(sheetOf(wrapper)).toBe(sheetName(DWARF_SHEETS.foreman['start-sleep']!.src))

    const { frames, frameMs } = DWARF_SHEETS.foreman['start-sleep']!
    vi.advanceTimersByTime(frames * frameMs)
    await wrapper.vm.$nextTick()
    expect(sheetOf(wrapper)).toBe(sheetName(DWARF_SHEETS.foreman.sleeping!.src))
  })

  it('wakes a foreman up once the question has been answered', async () => {
    const wrapper = mount(DwarfSprite, {
      props: {
        dwarf: defaultDwarf({ role: 'foreman', status: 'waiting', waitingReason: 'user-input' })
      }
    })
    await wrapper.setProps({ dwarf: defaultDwarf({ role: 'foreman', status: 'working' }) })
    expect(sheetOf(wrapper)).toBe(sheetName(DWARF_SHEETS.foreman['end-sleep']!.src))

    const { frames, frameMs } = DWARF_SHEETS.foreman['end-sleep']!
    vi.advanceTimersByTime(frames * frameMs)
    await wrapper.vm.$nextTick()
    expect(sheetOf(wrapper)).toBe(FOREMAN_IDLE)
  })

  it('never wakes a foreman that was never put to sleep', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'foreman', status: 'waiting' }) }
    })
    expect(sheetOf(wrapper)).toBe(FOREMAN_IDLE)
  })
})

/*
 * Issue #71 — `prefers-reduced-motion` was honoured in four places and skipped
 * the one thing on screen that is unmistakably animation. A viewer who asked
 * their operating system for less movement still got a dwarf changing pose 109
 * times a minute at the vein, and 171 for anyone leaving.
 */
describe('DwarfSprite with reduced motion', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'matchMedia')
    vi.mocked(dwarfClips).mockImplementation(realDwarfClips)
  })

  /**
   * jsdom leaves `window.matchMedia` undefined, so the preference has to be
   * stubbed in — and the stub answers change events, because the sprite has to
   * follow the setting being turned on under a panel that is already open.
   */
  function stubReducedMotion(matches: boolean) {
    const listeners = new Set<() => void>()
    const query = {
      matches,
      addEventListener: (_type: 'change', listener: () => void) => void listeners.add(listener),
      removeEventListener: (_type: 'change', listener: () => void) =>
        void listeners.delete(listener)
    }
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => query })
    return {
      flip(next: boolean): void {
        query.matches = next
        for (const listener of [...listeners]) listener()
      },
      get listenerCount(): number {
        return listeners.size
      }
    }
  }

  it('holds one frame and starts no timer for a viewer who asked for less', async () => {
    stubReducedMotion(true)
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }) }
    })
    expect(vi.getTimerCount()).toBe(0)

    const held = framePercentOf(wrapper)
    vi.advanceTimersByTime(10_000)
    await wrapper.vm.$nextTick()
    expect(framePercentOf(wrapper)).toBe(held)
  })

  it('holds the end of the loop, where the gesture finishes', () => {
    // The rule the painted loops used, kept exactly: the last frame, not the
    // wind-up into it (see stillFrameOf).
    stubReducedMotion(true)
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }) }
    })
    expect(framePercentOf(wrapper)).toBe(100)
  })

  /*
   * The constraint the change hangs on: reduced motion asks for less MOVEMENT,
   * not for less information. A panel that answered it by drawing every dwarf
   * the same has failed even with every timer stopped.
   *
   * NARROWED, and the narrowing is the art's doing rather than this
   * preference's. The four-way case that stood here — working, silent, resting
   * and leaving all tellable apart — cannot hold while a worker has one strip
   * for all four (#74). The claim is therefore made where it is still true: a
   * foreman waiting on a person is drawn differently from one at his post, and
   * the two states a worker's sprite no longer separates are separated by the
   * overlay and the leaving fade instead. Restore the four-way case with the
   * working and walking sheets.
   */
  it('still tells a foreman waiting on a person from one at his post', () => {
    stubReducedMotion(true)
    const asked = mount(DwarfSprite, {
      props: {
        dwarf: defaultDwarf({ role: 'foreman', status: 'waiting', waitingReason: 'user-input' })
      }
    })
    const posted = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'foreman', status: 'working' }) }
    })
    expect(sheetOf(asked)).not.toBe(sheetOf(posted))
  })

  it('shows a sleeping foreman asleep rather than caught halfway down', () => {
    // Holding the FIRST clip would draw him mid-fall, which is a foreman
    // frozen in an action rather than a foreman in a state.
    stubReducedMotion(true)
    const wrapper = mount(DwarfSprite, {
      props: {
        dwarf: defaultDwarf({ role: 'foreman', status: 'waiting', waitingReason: 'user-input' })
      }
    })
    expect(sheetOf(wrapper)).toBe(sheetName(DWARF_SHEETS.foreman.sleeping!.src))
  })

  it('keeps the states the sprite no longer separates readable in the overlays', () => {
    // Where the information went. Both were always drawn on top of the sprite
    // rather than into it, which is why neither was lost with the poses.
    stubReducedMotion(true)
    const resting = mount(DwarfSprite, { props: { dwarf: defaultDwarf({ status: 'waiting' }) } })
    const leaving = mount(DwarfSprite, { props: { dwarf: defaultDwarf({ status: 'leaving' }) } })
    const working = mount(DwarfSprite, { props: { dwarf: defaultDwarf({ status: 'working' }) } })

    expect(resting.find('.zzz').exists()).toBe(true)
    expect(working.find('.zzz').exists()).toBe(false)
    expect(leaving.classes()).toContain('is-leaving')
  })

  it('animates exactly as it always did where the platform cannot be asked at all', async () => {
    // jsdom has no matchMedia, and neither does the very first render. Asking
    // must not throw, and no answer means motion is welcome.
    expect(window.matchMedia).toBeUndefined()
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }) }
    })
    expect(framePercentOf(wrapper)).toBe(0)
    vi.advanceTimersByTime(DWARF_SHEETS.worker.idle.frameMs)
    await wrapper.vm.$nextTick()
    expect(framePercentOf(wrapper)).toBeGreaterThan(0)
  })

  it('follows the preference being turned on under a panel already open', async () => {
    const media = stubReducedMotion(false)
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }) }
    })
    expect(vi.getTimerCount()).toBe(1)

    media.flip(true)
    await wrapper.vm.$nextTick()
    expect(vi.getTimerCount()).toBe(0)

    const held = framePercentOf(wrapper)
    vi.advanceTimersByTime(10_000)
    await wrapper.vm.$nextTick()
    expect(framePercentOf(wrapper)).toBe(held)
  })

  it('animates again the moment the preference is turned back off', async () => {
    const media = stubReducedMotion(true)
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }) }
    })
    media.flip(false)
    await wrapper.vm.$nextTick()

    expect(framePercentOf(wrapper)).toBe(0)
    vi.advanceTimersByTime(DWARF_SHEETS.worker.idle.frameMs)
    await wrapper.vm.$nextTick()
    expect(framePercentOf(wrapper)).toBeGreaterThan(0)
  })

  it('stops listening to the preference when the sprite goes', () => {
    const media = stubReducedMotion(false)
    const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
    expect(media.listenerCount).toBe(1)

    wrapper.unmount()
    expect(media.listenerCount).toBe(0)
  })

  /*
   * The strike glow's own guard (#74): a pulsing light is exactly the
   * movement this preference asks to stop, so it must never appear — not
   * even by the coincidence of the held still frame landing on a declared
   * glow frame.
   */
  it('never lights the strike glow, even on a still frame the artist marked bright', () => {
    stubReducedMotion(true)
    // Built so the held STILL frame (the loop's last, see stillFrameOf) IS
    // itself the declared glow frame — proving the refusal is explicit
    // rather than a lucky accident of which frame a loop settles on.
    vi.mocked(dwarfClips).mockReturnValue([
      loopOf({ src: '/glow-swing.png', frames: 6, frameMs: 100, glowFrames: [5] })
    ])
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true }
    })
    expect(framePercentOf(wrapper)).toBe(100) // held on frame 5 of 6 — the glow frame
    expect(wrapper.find('.dwarf-frame').classes()).not.toContain('is-strike-glow')
  })
})
