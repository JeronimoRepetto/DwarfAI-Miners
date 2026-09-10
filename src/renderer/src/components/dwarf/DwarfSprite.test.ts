// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUBBLE_ROW_HEIGHT_PX } from '../../lib/overlay/bubbleLayout'
import { DWARF_SHEETS } from '../../lib/sprite/dwarfSheets'
import type { CrewSoundSignal } from '../../lib/sprite/crewSound'
import { dwarfClips } from '../../lib/sprite/dwarfSequence'
import { SPRITE_FRAME_SIZE, loopOf } from '../../lib/sprite/spriteSheet'
import { defaultDwarf } from '../../testing/factories'
import {
  DWARF_SILENCE_WINDOW_MS,
  type Dwarf,
  type DwarfKickState,
  type DwarfSendState
} from '../../types'
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

/**
 * The frame box the CSS is given, e.g. "36 / 38". On the ROOT beside the strip,
 * for the same reason: it changes only when the authored frame size does.
 */
function frameAspectOf(wrapper: ReturnType<typeof mount>): string {
  const style = wrapper.attributes('style') ?? ''
  return /--frame-aspect:\s*([^;]*)/.exec(style)?.[1]?.trim() ?? ''
}

/**
 * The VERTICAL term of `--sheet-size`, which is what decides whether a sheet's
 * own pixel height can reach the drawn box (issue #211). The horizontal term
 * varies with the frame count and is `backgroundSizePercent`'s business.
 */
function sheetSizeHeightOf(wrapper: ReturnType<typeof mount>): string {
  const style = wrapper.attributes('style') ?? ''
  const size = /--sheet-size:\s*([^;]*)/.exec(style)?.[1]?.trim() ?? ''
  return size.split(/\s+/)[1] ?? ''
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

  /*
   * The scale question #211 asked, answered where it can actually be observed:
   * on the rendered box rather than on the sheet's pixels.
   *
   * Nothing about a sheet's own dimensions reaches the drawn size. The box is
   * `--sprite-height` (from sceneSizing, which derives it from
   * SPRITE_FRAME_SIZE and the measured column) times `--depth-scale`, with the
   * width following `--frame-aspect` — all three independent of which strip is
   * showing. The sheet contributes `--sheet-image` and `--sheet-size`, and the
   * vertical term of that size is the constant `100%`: one frame is STRETCHED
   * to exactly the box in both axes, so a strip of any pixel height fills the
   * same box. That is the property that makes the swap seamless, and it is
   * asserted here rather than reasoned about in a comment.
   */
  it('draws a worker2 at the same size working as idling, whatever the strip (#211)', () => {
    const idling = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'worker2', status: 'waiting' }) }
    })
    const working = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'worker2', status: 'working' }) }
    })

    // It really did change strip — otherwise the equalities below prove nothing.
    expect(sheetOf(idling)).toBe(sheetName(DWARF_SHEETS.worker2.idle.src))
    expect(sheetOf(working)).toBe(sheetName(DWARF_SHEETS.worker2['start-working']!.src))

    expect(frameAspectOf(working)).toBe(frameAspectOf(idling))
    // The vertical term, which is what would have to vary for a taller or
    // shorter sheet to change the drawn height. It does not.
    expect(sheetSizeHeightOf(idling)).toBe('100%')
    expect(sheetSizeHeightOf(working)).toBe('100%')
  })

  it('puts the foreman on his own sheet instead of the worker one', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'foreman', name: 'Boss', status: 'working' }) }
    })
    expect(sheetOf(wrapper)).toBe(FOREMAN_IDLE)
    expect(sheetOf(wrapper)).not.toBe(WORKER_IDLE)
  })

  /*
   * AMENDED for #153's thirteenth correction. This case looked for `.zzz`, the
   * hand-typed `z z z` the sprite floated over a resting dwarf. The design has
   * its own sleep glyph — 15px, cream, from the designer's own `sleep.svg` —
   * and the maintainer ruled the improvised overlays out. What is being asserted
   * is unchanged: a waiting worker keeps its idle sheet and is MARKED as resting.
   */
  it('shows the design’s sleep glyph over a waiting worker, which is what marks the rest', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'waiting' }) }
    })
    expect(sheetOf(wrapper)).toBe(WORKER_IDLE)
    expect(wrapper.find('.status-sleep').exists()).toBe(true)
  })

  /*
   * AMENDED for #156's twelfth correction. This asserted that a leaving dwarf
   * was MIRRORED, on the strength of a sentence carried since #131 flagged it
   * as unconfirmed: "the art is painted facing right". It is painted facing
   * LEFT — measured off the committed sheets in lib/sprite/sheetFacing.test.ts
   * — and the exit slide runs left, so a leaver reaches the exit by being drawn
   * exactly as painted. The subject is unchanged: which way a leaver faces.
   */
  it('leaves a leaving dwarf unmirrored, because the art already faces the exit', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'leaving' }) }
    })
    expect(sheetOf(wrapper)).toBe(WORKER_IDLE)
    expect(wrapper.classes()).not.toContain('is-flipped')
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

  /*
   * REMOVED with the provider dot (#153), stated here rather than passing
   * unseen: "marks the provider with a badge instead of tinting the painted
   * art". The dot was never in the design and the maintainer ruled it out of the
   * sprite — it floated over every dwarf and said nothing the tooltip does not.
   * The provider still has a surface: `DwarfTooltip` prints `<role> · <provider>`
   * on hover and focus, and the sprite's own accessible name carries it too, so
   * nothing was lost with the badge. This is what replaces the case.
   */
  it('leaves the painted sprite clean, with nothing floating over it', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ provider: 'codex' }) }
    })
    expect(wrapper.find('.provider-dot').exists()).toBe(false)
    // Still recoverable, which is why the dot could go.
    expect(wrapper.get('.dwarf-hit').attributes('aria-label')).toContain('codex')
  })

  /*
   * AMENDED for #159. This block described the icon action bar this sprite used
   * to unfold on click. The design docks one MessagePanel at the bottom of the
   * screen instead, so a click now only REPORTS that this dwarf was chosen and
   * the app above decides what opens — which is also the only arrangement in
   * which "exactly one dwarf is selected" can be true, since no sprite can know
   * that about its neighbours.
   *
   * Five cases went with the bar, and their subjects all moved rather than
   * disappearing — every one of them is pinned against the real surface in
   * components/message/DwarfMessagePanel.test.ts:
   *
   * - "emits activate and closes when the console icon is chosen" — the console
   *   action is the panel's own agent-name control now.
   * - "forwards an answer from the bar and keeps the bar open for the verdict"
   *   and "carries the answer verdict down to the question card" — the question
   *   card is re-homed above the panel's input (#128, #159).
   * - "forwards a composed message and keeps the bar open for the verdict" —
   *   the panel's input is the composer.
   * - "forwards a confirmed kick and keeps the bar open for the verdict" (in the
   *   kick block below) — the panel's kick control still arms then fires.
   *
   * The two verdict MARKERS stay here, because they are still drawn on the
   * sprite: a ✓ on the dwarf is what says which dwarf a delivery was for.
   */
  describe('selection', () => {
    it('reports the click and lets the app above decide what opens', async () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      await wrapper.find('.dwarf-hit').trigger('click')
      expect(wrapper.emitted('select')).toHaveLength(1)
    })

    it('reports every click, because who is selected is not its own to decide', async () => {
      // Clicking the selected dwarf again closes its panel — but that is a
      // toggle the owner performs, so what the sprite does is say so twice.
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      await wrapper.find('.dwarf-hit').trigger('click')
      await wrapper.find('.dwarf-hit').trigger('click')
      expect(wrapper.emitted('select')).toHaveLength(2)
    })

    it('says whether it is the selected one, for anything reading rather than looking', () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf(), selected: true } })
      expect(wrapper.get('.dwarf-hit').attributes('aria-pressed')).toBe('true')
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

  /*
   * AMENDED for #153's thirteenth correction. This case asserted the truncated
   * parchment balloon and its text. The design draws a 19px message glyph over
   * a talking dwarf instead — `dialog.svg`, cream for a worker and white for a
   * foreman — and the balloon is gone with `SpeechBubble.vue`. WHEN it shows is
   * unchanged, which is what this still asserts; the message itself is one click
   * away, in the panel the expansion cases below already cover.
   */
  it('shows the design’s message glyph only when bubble text is provided', () => {
    const silent = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
    expect(silent.find('.status-dialog').exists()).toBe(false)
    const talking = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf(), bubbleText: 'Refactoring the parser' }
    })
    expect(talking.find('.status-dialog').exists()).toBe(true)
  })

  /*
   * Issue #43 — a bubble drawn directly above its own sprite smeared into its
   * neighbours' once several dwarfs shared one painted anchor. `bubbleRow`
   * (MineScene's `ScenePlacement.shareIndex`) lifts a sharer's bubble clear;
   * a dwarf with no anchor to share must render exactly as it always has.
   */
  /*
   * #153's ninth and thirteenth corrections, which are one surface.
   *
   * `screens/mine.md` specifies a RED HALO on the selected dwarf and says in as
   * many words that selection does NOT pause it — it keeps moving and working —
   * and `components.md` specifies the three status icons: a 19px message glyph
   * (cream for a worker, white for a foreman), a 19px important-dialog glyph for
   * a question put to the user, and a 15px cream sleep glyph. None of it was
   * built; the sprite floated a parchment balloon, a typed `z z z` and a
   * provider dot instead.
   */
  describe('the design’s status icons', () => {
    const asking = defaultDwarf({
      status: 'waiting',
      pendingQuestion: {
        toolUseId: 'tool-1',
        question: 'Which branch?',
        channel: 'held',
        multiSelect: false,
        questionCount: 1,
        options: [{ label: 'main' }]
      }
    })

    it('raises the important-dialog glyph for a question put to the user', () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: asking } })
      expect(wrapper.find('.status-important').exists()).toBe(true)
      expect(wrapper.get('.status-important').attributes('title')).toMatch(/answer/i)
    })

    it('raises nothing important for a dwarf nobody has been asked about', () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      expect(wrapper.find('.status-important').exists()).toBe(false)
    })

    /*
     * #203's observed half. The design names three status icons and no fourth,
     * and its important-dialog glyph is "a question/consultation" — a session
     * asking whether it may proceed is one, so it raises the same glyph rather
     * than one this repository invented. Only the title tells the two apart,
     * because only the wording differs.
     */
    it('raises the important-dialog glyph for a session asking to be allowed to proceed', () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ status: 'waiting', waitingReason: 'approval' }) }
      })
      expect(wrapper.find('.status-important').exists()).toBe(true)
      expect(wrapper.get('.status-important').attributes('title')).toMatch(/approv/i)
    })

    it('raises nothing important for a dwarf whose provider named no condition', () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ status: 'waiting', waitingReason: 'unknown' }) }
      })
      expect(wrapper.find('.status-important').exists()).toBe(false)
    })

    it('raises the glyph even where the provider still reads the session as working', () => {
      // A hook can name the open dialog before the registry records that the
      // session stopped, and the two facts have two sources: the mark must not
      // wait on the provider catching up (see stampPermissionPrompts).
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ status: 'working', waitingReason: 'approval' }) }
      })
      expect(wrapper.find('.status-important').exists()).toBe(true)
    })

    it('colours the message glyph by rank, as the component table states', () => {
      const worker = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ role: 'worker' }), bubbleText: 'x' }
      })
      const foreman = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ role: 'foreman' }), bubbleText: 'x' }
      })
      expect(worker.get('.status-dialog').classes()).toContain('is-worker')
      expect(foreman.get('.status-dialog').classes()).toContain('is-foreman')
    })

    it('leaves the message readable: the glyph is the control that opens it', () => {
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf(), bubbleText: 'Refactoring the parser' }
      })
      const glyph = wrapper.get('.status-dialog')
      expect(glyph.element.tagName).toBe('BUTTON')
      expect(glyph.attributes('aria-label')).toMatch(/full message/i)
    })
  })

  /*
   * AMENDED for #159: the halo follows the `selected` PROP now rather than a
   * popover this sprite owned. What the halo is and what it must never do are
   * unchanged, which is what these still assert — including the source's own
   * rule that a selected dwarf keeps moving and working.
   */
  describe('the red halo on a selected dwarf', () => {
    it('marks the dwarf red once it is selected', async () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf() } })
      expect(wrapper.classes()).not.toContain('is-selected')
      await wrapper.setProps({ selected: true })
      expect(wrapper.classes()).toContain('is-selected')
    })

    it('takes the halo off again when the selection closes', async () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf(), selected: true } })
      await wrapper.setProps({ selected: false })
      expect(wrapper.classes()).not.toContain('is-selected')
    })

    it('never pauses the dwarf it marks, which the source states outright', async () => {
      const wrapper = mount(DwarfSprite, { props: { dwarf: defaultDwarf({ status: 'working' }) } })
      const before = sheetOf(wrapper)
      await wrapper.setProps({ selected: true })
      // Same sequence, still animating: selection is a marker, not a pause.
      expect(sheetOf(wrapper)).toBe(before)
      expect(wrapper.classes()).toContain('is-working')
    })
  })

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

  /*
   * AMENDED throughout for #153's thirteenth correction: the control that opens
   * the full message was `.bubble-hit`, the button inside the parchment balloon,
   * and it is now `.status-dialog`, the design's own 19px message glyph. The
   * balloon is gone with `SpeechBubble.vue`; every behaviour these cases pin —
   * a real button, the hold and release contract with the bubble board, Escape,
   * the outside click, and never toggling the dwarf's own action bar — is
   * unchanged and still asserted below.
   */
  describe('message glyph expansion', () => {
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
      const hit = mountTalking().find('.status-dialog')
      expect(hit.element.tagName).toBe('BUTTON')
      expect(hit.attributes('aria-label')).toContain('Echo')
      expect(hit.attributes('aria-expanded')).toBe('false')
    })

    it('expands on click, showing the full message and holding the bubble', async () => {
      const wrapper = mountTalking()
      expect(wrapper.find('.bubble-expanded').exists()).toBe(false)

      await wrapper.find('.status-dialog').trigger('click')
      expect(wrapper.find('.bubble-expanded').text()).toContain(FULL_MESSAGE)
      expect(wrapper.find('.status-dialog').attributes('aria-expanded')).toBe('true')
      expect(wrapper.emitted('bubble-hold')).toHaveLength(1)
    })

    it('does not toggle the dwarf action bar when the bubble is clicked', async () => {
      const wrapper = mountTalking()
      await wrapper.find('.status-dialog').trigger('click')
      expect(wrapper.find('.action-bar').exists()).toBe(false)
      expect(wrapper.emitted('activate')).toBeUndefined()
    })

    it('collapses on a second bubble click and releases the hold', async () => {
      const wrapper = mountTalking()
      await wrapper.find('.status-dialog').trigger('click')
      await wrapper.find('.status-dialog').trigger('click')
      expect(wrapper.find('.bubble-expanded').exists()).toBe(false)
      expect(wrapper.emitted('bubble-release')).toHaveLength(1)
    })

    it('collapses on Escape and releases the hold', async () => {
      const wrapper = mountTalking()
      await wrapper.find('.status-dialog').trigger('click')

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.bubble-expanded').exists()).toBe(false)
      expect(wrapper.emitted('bubble-release')).toHaveLength(1)
    })

    it('collapses on an outside click', async () => {
      const wrapper = mountTalking()
      await wrapper.find('.status-dialog').trigger('click')

      document.body.click()
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.bubble-expanded').exists()).toBe(false)
      expect(wrapper.emitted('bubble-release')).toHaveLength(1)
    })

    it('stays open on a click inside the panel (scrolling a long message)', async () => {
      const wrapper = mountTalking()
      await wrapper.find('.status-dialog').trigger('click')
      await wrapper.find('.bubble-expanded').trigger('click')
      expect(wrapper.find('.bubble-expanded').exists()).toBe(true)
      expect(wrapper.emitted('bubble-release')).toBeUndefined()
    })

    it('collapses and releases when the bubble disappears mid-read', async () => {
      const wrapper = mountTalking()
      await wrapper.find('.status-dialog').trigger('click')

      await wrapper.setProps({ bubbleText: undefined })
      expect(wrapper.find('.bubble-expanded').exists()).toBe(false)
      expect(wrapper.emitted('bubble-release')).toHaveLength(1)
    })

    // AMENDED for #159: selecting the dwarf is what used to open the bar. One
    // popover at a time is the rule that survived, and it is what this asserts.
    it('selecting the dwarf collapses the expanded bubble', async () => {
      const wrapper = mountTalking()
      await wrapper.find('.status-dialog').trigger('click')

      await wrapper.find('.dwarf-hit').trigger('click')
      expect(wrapper.emitted('select')).toHaveLength(1)
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

    // AMENDED for #306: passed `waitingReason: 'user-input'` on the claim
    // that "the foreman being asked a question is the change that is
    // actually visible" — under `isAwaitingAnswer` that reason was what made
    // the sleep sequence engage at all. It no longer is: `status: 'waiting'`
    // alone is the visible change now, so the reason is dropped to prove it.
    it('restarts the cycle from the first frame when the loop changes', async () => {
      // Was pinned through a status change, which used to select a different
      // pose table. Every status a WORKER can be in now draws the same sheet
      // (#74), so the foreman entering rest is the change that is actually
      // visible — and it restarts on frame 0 exactly as before.
      const wrapper = mount(DwarfSprite, {
        props: { dwarf: defaultDwarf({ role: 'foreman', status: 'working' }) }
      })
      vi.advanceTimersByTime(DWARF_SHEETS.foreman.idle.frameMs)
      await wrapper.vm.$nextTick()
      expect(framePercentOf(wrapper)).toBeGreaterThan(0)

      await wrapper.setProps({
        dwarf: defaultDwarf({ role: 'foreman', status: 'waiting' })
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
    // AMENDED for #383 (was: via: 'terminal', asserting the title matched
    // /handed to the session/i — true before #329/#383 made the terminal
    // tier end the session outright, which now says "The session was
    // ended…" instead. This test's point is the generic handed-over-not-
    // stopped wording, not the terminal tier's own, so a channel that still
    // only asks, claude-relay, keeps that point covered — the same swap the
    // sibling send-marker test above already makes.)
    const wrapper = markerSprite({
      kickState: { phase: 'delivered', via: 'claude-relay', awaitingReaction: true }
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
  // AMENDED for #262 (was: "keeps its own sheet while crossing the floor,
  // having no walk strip" — asserted that a worker already `working` played
  // its working sequence while still crossing the floor, because "`walking`
  // is a scene prop, not a sequence input: the STATUS still decides the
  // sheet"). #262 reverses that #74 ruling: arrival, not status, now gates
  // the working sequence, exactly as it always gated the sparks and the
  // strike glow (see `DwarfSprite strike sparks` / `strike glow` below).
  it('keeps its own idle loop while crossing the floor, having arrived at nothing yet', () => {
    // No walk sheet has been drawn (#74) either, so a walking dwarf keeps
    // reading its rank's idle rather than a strip painted for the crossing —
    // that part of the original claim is unchanged.
    const working = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true, walking: true }
    })
    expect(sheetOf(working)).toBe(WORKER_IDLE)

    const waiting = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'waiting' }), anchored: true, walking: true }
    })
    expect(sheetOf(waiting)).toBe(WORKER_IDLE)
  })

  // AMENDED for #262 (was: "drops back into its own loop the moment it
  // arrives" — a static mount already `working` with `walking: false`, which
  // could not tell "arrived" apart from "born standing at the rock" since a
  // fresh mount has no previous render either way). This now drives a real
  // arrival — `walking` flips on an already-mounted, already-walking worker —
  // which is the one thing a static mount or a pure `dwarfClips` call cannot
  // exercise: the sequence restarting on the SAME sprite instance.
  it('starts the working sequence only once it arrives, not on the status alone', async () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true, walking: true }
    })
    expect(sheetOf(wrapper)).toBe(WORKER_IDLE)

    await wrapper.setProps({ walking: false })
    expect(sheetOf(wrapper)).toBe(sheetName(DWARF_SHEETS.worker['start-working']!.src))
  })

  /*
   * AMENDED for #156's twelfth correction, and this is the case that would have
   * caught it. It asserted that a station facing LEFT mirrors the sprite, which
   * is only true of art painted facing right. The sheets are painted facing
   * LEFT, so a station facing left is drawn as painted and it is a station
   * facing RIGHT that has to be mirrored. Every dwarf in the mine rendered in a
   * mirror until this turned round. Subject unchanged: the scene's station
   * decides the facing, not the status.
   */
  it('draws a dwarf facing left as painted, and mirrors only one facing right', () => {
    const facingLeft = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true, facesLeft: true }
    })
    expect(facingLeft.classes()).not.toContain('is-flipped')

    const facingRight = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true, facesLeft: false }
    })
    expect(facingRight.classes()).toContain('is-flipped')
  })

  it('lets the station override the status, for a leaver as much as a worker', () => {
    // A leaving dwarf used to be mirrored unconditionally; the exit is painted
    // at the centre of the gallery, so the scene decides instead.
    const leavingRight = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'leaving' }), anchored: true, facesLeft: false }
    })
    expect(leavingRight.classes()).toContain('is-flipped')
    const leavingLeft = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'leaving' }), anchored: true, facesLeft: true }
    })
    expect(leavingLeft.classes()).not.toContain('is-flipped')
  })

  it('stands down its own walk-out slide once the scene owns its position', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'leaving' }), anchored: true }
    })
    expect(wrapper.classes()).toContain('is-anchored')
    expect(wrapper.classes()).toContain('is-leaving')
  })

  /*
   * #156's tenth correction: a kicked dwarf must disappear ON ARRIVAL at the
   * nearest way out, never on a clock.
   *
   * The fade was an animation started the moment the status turned 'leaving',
   * running for a fixed LEAVING_EXIT_MS while the scene was still walking the
   * dwarf to the exit. Anything further from a spawn point than 1.2 seconds
   * therefore faded out mid-route, which is what the maintainer watched happen
   * to a foreman. The runtime's grace window still caps how long a departure may
   * take; what it must not do is decide when the fade begins.
   */
  it('holds a leaver at full strength for as long as it is still walking out', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'leaving' }), anchored: true, walking: true }
    })
    expect(wrapper.classes()).not.toContain('is-departed')
  })

  it('fades a leaver only once it has reached the way out', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'leaving' }), anchored: true, walking: false }
    })
    expect(wrapper.classes()).toContain('is-departed')
  })

  it('never calls a working dwarf departed, however still it is standing', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ status: 'working' }), anchored: true, walking: false }
    })
    expect(wrapper.classes()).not.toContain('is-departed')
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
    expect(wrapper.find('.status-sleep').exists()).toBe(false)
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

  /*
    AMENDED for #137, which retired `AUTHORED_SPRITE` along with the cave this
    file used to read it from: the scene's own scale is now derived from the
    design ("one 36x38 sheet frame at 1x in a 245px interior", see sceneSizing)
    and is handed in through `--sprite-width`/`--sprite-height` from the
    measured column. The literals below are DwarfSprite's own fallbacks and
    always were — the size a sprite draws at when nothing sets those variables,
    which is what "outside any scene" means. They are stated as literals here
    because that is what they are in the component, rather than borrowed from a
    scene constant that no longer describes them.
  */
  it('still draws a sprite mounted outside any scene at its authored size', () => {
    // The var fallbacks are what keep a bare sprite byte-for-byte what it was.
    expect(styleRule('.dwarf-frame')).toContain('--sprite-height, 100px')
    // 95, not 96: the box follows the 36x38 frame (94.74, rounded whole).
    expect(styleRule('.dwarf-sprite')).toContain('--sprite-width, 95px')
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
    expect(wrapper.find('.status-sleep').exists()).toBe(true)

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

  // AMENDED for #306: passed `waitingReason: 'user-input'`, which is what
  // `isAwaitingAnswer` required before the sleep sequence would engage at
  // all. Rest is a status now, not a proven reason, so the fixture drops it
  // — a foreman resting with no reason offered falls asleep exactly the same.
  it('draws a foreman actually asleep once it starts resting, and says so once', async () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'foreman', status: 'waiting' }) }
    })
    // Falls asleep first, then stays asleep: two sheets, one movement.
    expect(sheetOf(wrapper)).toBe(sheetName(DWARF_SHEETS.foreman['start-sleep']!.src))

    const { frames, frameMs } = DWARF_SHEETS.foreman['start-sleep']!
    vi.advanceTimersByTime(frames * frameMs)
    await wrapper.vm.$nextTick()
    expect(sheetOf(wrapper)).toBe(sheetName(DWARF_SHEETS.foreman.sleeping!.src))
  })

  // AMENDED for #306, same reason as above: dropped `waitingReason` — leaving
  // rest wakes the foreman regardless of why it was resting.
  it('wakes a foreman up once rest ends', async () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'foreman', status: 'waiting' }) }
    })
    await wrapper.setProps({ dwarf: defaultDwarf({ role: 'foreman', status: 'working' }) })
    expect(sheetOf(wrapper)).toBe(sheetName(DWARF_SHEETS.foreman['end-sleep']!.src))

    const { frames, frameMs } = DWARF_SHEETS.foreman['end-sleep']!
    vi.advanceTimersByTime(frames * frameMs)
    await wrapper.vm.$nextTick()
    expect(sheetOf(wrapper)).toBe(FOREMAN_IDLE)
  })

  /*
   * AMENDED for #306 — this is the bug itself, pinned as if it were correct.
   * It asserted FOREMAN_IDLE: a foreman mounted directly in `'waiting'` status
   * with no `waitingReason` used to draw awake, because `isAwaitingAnswer`
   * needed a proven reason before the sleep sequence would even consider him
   * resting. The marker (`DwarfStatusIcons`, `status === 'waiting'`) drew him
   * asleep the whole time — see issue #306's reproduction. He now falls
   * asleep exactly like any other dwarf that mounts already resting (the
   * first-render rule in dwarfSequence.ts): nothing to interrupt, so the fall
   * plays rather than being skipped.
   */
  it('falls asleep on mount when found already resting, with no proof anybody asked it anything', () => {
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'foreman', status: 'waiting' }) }
    })
    expect(sheetOf(wrapper)).toBe(sheetName(DWARF_SHEETS.foreman['start-sleep']!.src))
  })

  /*
   * The watch that feeds `dwarfClips` (#306): `resting` is computed off
   * `isResting(dwarf.status)` alone now, so a `waitingReason` other than
   * `'user-input'` — which used to keep `isAwaitingAnswer` false and the
   * sprite idle — no longer has anything to disagree with the marker about.
   */
  it('falls asleep resting on any waitingReason at all, status being the only thing that matters', () => {
    const wrapper = mount(DwarfSprite, {
      props: {
        dwarf: defaultDwarf({ role: 'foreman', status: 'waiting', waitingReason: 'approval' })
      }
    })
    expect(sheetOf(wrapper)).toBe(sheetName(DWARF_SHEETS.foreman['start-sleep']!.src))
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
  // AMENDED for #306: dropped `waitingReason: 'user-input'` — resting is
  // what tells these two apart now, not a proven reason for the rest.
  it('still tells a resting foreman from one at his post', () => {
    stubReducedMotion(true)
    const resting = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'foreman', status: 'waiting' }) }
    })
    const posted = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'foreman', status: 'working' }) }
    })
    expect(sheetOf(resting)).not.toBe(sheetOf(posted))
  })

  // AMENDED for #306: dropped `waitingReason: 'user-input'`, same reason.
  it('shows a sleeping foreman asleep rather than caught halfway down', () => {
    // Holding the FIRST clip would draw him mid-fall, which is a foreman
    // frozen in an action rather than a foreman in a state.
    stubReducedMotion(true)
    const wrapper = mount(DwarfSprite, {
      props: { dwarf: defaultDwarf({ role: 'foreman', status: 'waiting' }) }
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

    expect(resting.find('.status-sleep').exists()).toBe(true)
    expect(working.find('.status-sleep').exists()).toBe(false)
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

/*
 * Which side of the frame the pick lands on (#156).
 *
 * The sheets are painted facing LEFT — measured off the committed art in
 * lib/sprite/sheetFacing.test.ts — so the strike falls on the LEFT of an
 * unmirrored frame and on the right of a mirrored one. Both the debris and the
 * strike's own light were placed the other way round, under the same wrong
 * assumption that turned the whole mine's facing into a mirror: the default
 * threw sparks off the dwarf's back, and mirroring moved them to his back on
 * the other side.
 */
describe('DwarfSprite strike side', () => {
  /**
   * The body of one CSS rule, found by plain search rather than by a regex the
   * selector would have to be escaped into: every selector here carries a `.`
   * and one carries a `::`.
   */
  function styleRule(selector: string): string {
    const at = spriteSource.indexOf('\n' + selector + ' {')
    if (at === -1) throw new Error(`no ${selector} rule in DwarfSprite.vue`)
    const open = spriteSource.indexOf('{', at)
    const close = spriteSource.indexOf('}', open)
    return spriteSource.slice(open + 1, close)
  }

  /** The `left` percentage a rule places its box at. */
  function leftPercent(selector: string): number {
    const value = /left:\s*(-?[\d.]+)%/.exec(styleRule(selector))?.[1]
    if (value === undefined) throw new Error(`no left percentage in ${selector}`)
    return Number(value)
  }

  it('throws the debris off the pick side of the art as painted, which is the left', () => {
    expect(leftPercent('.spark-burst')).toBeLessThan(50)
  })

  it('throws it off the other side once the dwarf is mirrored to face right', () => {
    expect(leftPercent('.is-flipped .spark-burst')).toBeGreaterThan(50)
  })

  /**
   * Where the glow's box is CENTRED, which is what a round gradient reads as.
   * Its width is declared once on the base rule; the mirrored rule moves only
   * the left edge.
   */
  function glowCentrePercent(selector: string): number {
    const base = styleRule('.dwarf-frame.is-strike-glow::after')
    const width = /width:\s*([\d.]+)%/.exec(base)?.[1]
    if (width === undefined) throw new Error('no width percentage on the strike glow')
    return leftPercent(selector) + Number(width) / 2
  }

  it('lights the strike on the same side the debris leaves from, in both facings', () => {
    // One origin, said twice: a glow on the pick side and sparks off the
    // dwarf's back would read as two different events.
    expect(glowCentrePercent('.dwarf-frame.is-strike-glow::after')).toBeLessThan(50)
    expect(glowCentrePercent('.is-flipped .dwarf-frame.is-strike-glow::after')).toBeGreaterThan(50)
  })
})

/*
 * Where the departure fade is declared (#156).
 *
 * The class above is only half the guarantee: the fade has to be attached to
 * ARRIVING and not to leaving, or a dwarf still walking out would fade anyway.
 * Asserted against the stylesheet, because jsdom runs no animations.
 */
describe('DwarfSprite departure fade', () => {
  function styleRule(selector: string): string {
    const at = spriteSource.indexOf('\n' + selector + ' {')
    if (at === -1) throw new Error(`no ${selector} rule in DwarfSprite.vue`)
    const open = spriteSource.indexOf('{', at)
    const close = spriteSource.indexOf('}', open)
    return spriteSource.slice(open + 1, close)
  }

  it('fades a leaver that has arrived, and nothing else', () => {
    expect(styleRule('.is-anchored.is-departed')).toMatch(/animation:\s*exit-fade/)
  })

  it('starts no clock on a dwarf that is merely leaving', () => {
    // The bug itself: this rule ran the fade from the moment the status
    // changed, while the scene was still walking the dwarf to the exit.
    expect(() => styleRule('.is-anchored.is-leaving')).toThrow()
  })
})

/*
 * How a selected dwarf is marked (#156).
 *
 * #153 drew the design's red halo as two stacked drop-shadows in `--danger-line`
 * at 3px and 7px, and the acceptance run reports the outline as too thick and
 * too loud. The maintainer's ruling: a thinner outline, and the red moved ONTO
 * the sprite as a tint at about half strength.
 *
 * `screens/mine.md`'s own constraint survives intact — selection does not pause
 * the dwarf, it keeps moving and working — and so does the reduced-motion one:
 * there is no animation in any of this to switch off, which is why a viewer who
 * asked for less movement still gets the whole marker.
 */
describe('DwarfSprite selection styling', () => {
  function styleRule(selector: string): string {
    const at = spriteSource.indexOf('\n' + selector + ' {')
    if (at === -1) throw new Error(`no ${selector} rule in DwarfSprite.vue`)
    const open = spriteSource.indexOf('{', at)
    const close = spriteSource.indexOf('}', open)
    return spriteSource.slice(open + 1, close)
  }

  /** Every drop-shadow blur radius the selected frame declares, in px. */
  function selectedOutlineBlurs(): number[] {
    const rule = styleRule('.is-selected .dwarf-frame')
    return [...rule.matchAll(/drop-shadow\([^)]*?(\d+(?:\.\d+)?)px\s+var\(--danger-line\)/g)].map(
      (match) => Number(match[1])
    )
  }

  it('draws one outline rather than a stack of them', () => {
    expect(selectedOutlineBlurs()).toHaveLength(1)
  })

  it('draws it thinner than the halo the acceptance run called too thick', () => {
    // #153's was 3px and 7px stacked.
    expect(Math.max(...selectedOutlineBlurs())).toBeLessThan(3)
  })

  it('tints the sprite itself, at about half strength', () => {
    // A filter on the frame, which is the one place a tint can reach pixel art
    // drawn as a background image. `sepia()` takes its strength as an amount,
    // so half of it is what "about 50%" means in a filter chain.
    const rule = styleRule('.is-selected .dwarf-frame')
    expect(rule).toMatch(/sepia\(0?\.5\)/)
    expect(rule).toMatch(/hue-rotate\(/)
  })

  it('keeps the shadow the sprite is always drawn with', () => {
    // `filter` replaces rather than adds: dropping the base shadow here would
    // lift a selected dwarf off the rock every other dwarf stands on.
    expect(styleRule('.is-selected .dwarf-frame')).toMatch(/drop-shadow\(0 4px 5px/)
  })

  it('animates nothing, so a viewer who asked for less movement keeps the marker', () => {
    expect(styleRule('.is-selected .dwarf-frame')).not.toMatch(/animation:/)
  })
})

/*
 * The crew's own sounds (#330). The sprite is where they are noticed, because
 * two of the three ARE frames — a strike is the frame the sheet already calls
 * an impact, and a shift is a moment inside the pick-up — and this is the one
 * place that knows which frame is showing. It decides nothing about sound: it
 * emits a cue, MineScene says which mine and which dwarf, and the engine
 * decides whether anything can be heard at all.
 */
describe('DwarfSprite crew sounds (#330)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'matchMedia')
    vi.mocked(dwarfClips).mockImplementation(realDwarfClips)
  })

  /** Reduced motion, stubbed the way the block above stubs it. */
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

  /**
   * A sprite, and every crew cue it emits, in order.
   *
   * Collected through the LISTENER rather than read off `wrapper.emitted()`,
   * because two of the cases below are about what a sprite emits as it
   * unmounts and the wrapper's own record does not carry across teardown.
   */
  function mountSprite(
    dwarf: Dwarf,
    walking?: boolean
  ): { wrapper: ReturnType<typeof mount>; cues: CrewSoundSignal[] } {
    const cues: CrewSoundSignal[] = []
    const wrapper = mount(DwarfSprite, {
      props: {
        dwarf,
        anchored: true,
        walking,
        onCrewSound: (signal: CrewSoundSignal) => cues.push(signal)
      }
    })
    return { wrapper, cues }
  }

  it('strikes on the frame its own sheet calls an impact', async () => {
    // 300ms clears the worker's 3-frame pick-up; +400ms lands exactly on index
    // 4 of the swing behind it, which is the frame the sparks fire on. One
    // exact jump rather than a long advance, for the reason the spark test
    // above gives: Vue coalesces a run of interval callbacks into one job.
    // AMENDED for the maintainer's first live listen of #339 (issue #330), dated
    // 2026-09-09: the strike now carries the gain DWARF_CREW.worker declares.
    const { wrapper, cues } = mountSprite(defaultDwarf({ status: 'working' }))
    vi.advanceTimersByTime(700)
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([{ cue: 'strike', gain: 0.1 }])
  })

  it('strikes on both swings of the shift, not only the first', async () => {
    // The second swing is a clip of its own drawn from the same strip (#325).
    const { wrapper, cues } = mountSprite(defaultDwarf({ status: 'working' }))
    vi.advanceTimersByTime(700)
    await wrapper.vm.$nextTick()
    // 3 frames of pick-up + 13 of the first swing + 4 into the second.
    vi.advanceTimersByTime(1300)
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([
      { cue: 'strike', gain: 0.1 },
      { cue: 'strike', gain: 0.1 }
    ])
  })

  it('sounds the worker2 grind once, as its pick-up crosses the declared frame', async () => {
    // A COARSE advance, and deliberately so: Vue coalesces the interval's
    // callbacks into one watcher job, so the position steps from frame 0
    // straight to 15 and frame 14 is never drawn. The cue is a CROSSING for
    // exactly this — a grind that silently did not start is a worker2 miming
    // its whole shift.
    const { wrapper, cues } = mountSprite(defaultDwarf({ role: 'worker2', status: 'working' }))
    vi.advanceTimersByTime(1500)
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([{ cue: 'shift' }])

    // And not again on the frames after it, however far into the shift.
    vi.advanceTimersByTime(3000)
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([{ cue: 'shift' }])
  })

  it('sounds a new grind on the next shift, a cycle being a shift', async () => {
    // Stepped frame by frame here (the async advance lets the watcher run
    // between ticks) rather than coalesced, because what is under test is the
    // cycle coming round: 113 frames, 11.3s, and the pick-up crosses its
    // declared frame at 1.4s of each of them.
    const { cues } = mountSprite(defaultDwarf({ role: 'worker2', status: 'working' }))
    await vi.advanceTimersByTimeAsync(12_800)
    expect(cues).toEqual([{ cue: 'shift' }, { cue: 'shift' }])
  })

  it('says nothing at all while the dwarf is still walking to the vein', async () => {
    // Except its footsteps, which are what walking sounds like — the strike
    // and the shift are the work, and the work has not started.
    const { wrapper, cues } = mountSprite(defaultDwarf({ status: 'working' }), true)
    vi.advanceTimersByTime(5000)
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([{ cue: 'walk', gain: 0.05 }])
  })

  it('says nothing off a dwarf that is resting or walking out', async () => {
    for (const status of ['waiting', 'leaving'] as const) {
      const { wrapper, cues } = mountSprite(defaultDwarf({ status }))
      vi.advanceTimersByTime(5000)
      await wrapper.vm.$nextTick()
      expect(cues, status).toEqual([])
    }
  })

  it('strikes nothing under reduced motion, the cue being a frame', async () => {
    // A viewer who asked for no motion sees no frames — the sprite holds one
    // pose and runs no timer — so there is no strike to hear. Guarded here as
    // well as by the held frame, for the reason the strike glow is: belt and
    // suspenders on the one preference this panel must not get wrong.
    stubReducedMotion(true)
    const { wrapper, cues } = mountSprite(defaultDwarf({ status: 'working' }))
    vi.advanceTimersByTime(10_000)
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([])
  })

  it('still walks audibly under reduced motion, the walk being a position', () => {
    // THE ONE CREW CUE THAT SURVIVES IT. The scene still moves the sprite
    // across the interior — that is a position, not an animation — so the
    // footsteps are still the truth about what is on screen.
    stubReducedMotion(true)
    const { cues } = mountSprite(defaultDwarf({ status: 'working' }), true)
    expect(cues).toEqual([{ cue: 'walk', gain: 0.05 }])
  })

  it('starts the footsteps when a dwarf sets off and ends them when it arrives', async () => {
    const { wrapper, cues } = mountSprite(defaultDwarf({ status: 'working' }), false)
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
      const { cues } = mountSprite(defaultDwarf({ role, status: 'working' }), true)
      expect(cues, role).toEqual([{ cue: 'walk', gain: 0.05 }])
    }
  })

  it('leaves the foreman silent at the rock, having no working art to sound', async () => {
    const { wrapper, cues } = mountSprite(defaultDwarf({ role: 'foreman', status: 'working' }))
    vi.advanceTimersByTime(10_000)
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([])
  })

  it('ends the grind when its worker2 stops working', async () => {
    const { wrapper, cues } = mountSprite(defaultDwarf({ role: 'worker2', status: 'working' }))
    vi.advanceTimersByTime(1500)
    await wrapper.vm.$nextTick()

    await wrapper.setProps({ dwarf: defaultDwarf({ role: 'worker2', status: 'waiting' }) })
    expect(cues).toEqual([{ cue: 'shift' }, { cue: 'shift', ending: true }])
  })

  it('ends the grind when its worker2 walks away from the rock', async () => {
    // Leaving the cycle is leaving the cycle, whether the status changed or
    // the scene simply started walking it somewhere (#262's own gate).
    const { wrapper, cues } = mountSprite(defaultDwarf({ role: 'worker2', status: 'working' }))
    vi.advanceTimersByTime(1500)
    await wrapper.vm.$nextTick()

    await wrapper.setProps({ walking: true })
    expect(cues).toEqual([
      { cue: 'shift' },
      { cue: 'shift', ending: true },
      { cue: 'walk', gain: 0.05 }
    ])
  })

  it('takes a grind with it when the sprite leaves the scene', async () => {
    // A dwarf can vanish from the crew between polls with no status to change
    // through — the mine's own cut catches most of that, but a sprite
    // unmounting is the strongest form of "no longer drawn" there is, and a
    // grind outliving the dwarf that made it is the promise broken.
    const { wrapper, cues } = mountSprite(defaultDwarf({ role: 'worker2', status: 'working' }))
    vi.advanceTimersByTime(1500)
    await wrapper.vm.$nextTick()
    expect(cues).toEqual([{ cue: 'shift' }])

    wrapper.unmount()
    expect(cues).toEqual([{ cue: 'shift' }, { cue: 'shift', ending: true }])
  })

  it('takes the footsteps with it too, mid-walk', () => {
    const { wrapper, cues } = mountSprite(defaultDwarf({ status: 'working' }), true)
    wrapper.unmount()
    expect(cues).toEqual([
      { cue: 'walk', gain: 0.05 },
      { cue: 'walk', ending: true }
    ])
  })

  it('ends nothing on unmount for a dwarf that was neither walking nor at work', () => {
    const { wrapper, cues } = mountSprite(defaultDwarf({ status: 'waiting' }))
    wrapper.unmount()
    expect(cues).toEqual([])
  })
})
