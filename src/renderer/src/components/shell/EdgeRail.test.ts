// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { motion } from 'motion-v'
import type { ShellComposition } from '../../lib/shell/composition'
import { pressHoverVariants } from '../../lib/shell/presence'
import EdgeRail from './EdgeRail.vue'

/*
 * AMENDED for #156's first correction. The rail used to be handed `expanded`
 * and to decide the rest for itself — which surface to paint and whether to draw
 * the app mark. It cannot know either: both depend on whether the navigation
 * stack is on screen beside it, and with a mine held open beyond a closed
 * secondary panel it is. It is handed the shell's COMPOSITION now, and the two
 * facts can no longer disagree.
 *
 * Every case below kept its subject; `expanded: true` became `composition:
 * 'pages'`, and the mine-only composition the shell did not have a name for is
 * the new case at the end.
 */
function mountRail(props: { edge?: 'left' | 'right'; composition?: ShellComposition } = {}) {
  return mount(EdgeRail, {
    props: { edge: 'right' as const, composition: 'rail' as const, ...props }
  })
}

describe('EdgeRail', () => {
  it('is one real button, so the whole rail opens the panel', () => {
    // The design says selecting the RAIL expands the panel, not selecting a
    // hit area somewhere inside a 20px strip.
    const rail = mountRail()
    expect(rail.element.tagName).toBe('BUTTON')
    expect(rail.attributes('type')).toBe('button')
  })

  it('carries the state on the control rather than only in its name', () => {
    expect(mountRail().attributes('aria-expanded')).toBe('false')
    expect(mountRail({ composition: 'pages' }).attributes('aria-expanded')).toBe('true')
  })

  /*
   * AMENDED for #153's fifth correction. This case asserted the open label said
   * "collapse", because the arrow collapsed the WHOLE shell. The maintainer's
   * ruling is that it closes only the secondary panel and leaves an open mine
   * standing — collapsing everything is the app mark's job now (ShellNav) — so
   * the name has to stop promising the bigger action.
   */
  it('says what pressing it will do, in both states', () => {
    expect(mountRail().attributes('aria-label')).toMatch(/open/i)
    const open = mountRail({ composition: 'pages' }).attributes('aria-label')
    expect(open).toMatch(/close/i)
    expect(open).not.toMatch(/collapse/i)
  })

  it('asks to be toggled, and decides nothing itself', () => {
    // The window is main's: the rail reports the press and renders whatever
    // layout comes back, so a refused resize can never leave it drawn open.
    const rail = mountRail()
    rail.trigger('click')
    expect(rail.emitted('toggle')).toHaveLength(1)
    expect(rail.attributes('aria-expanded')).toBe('false')
  })

  it('points the arrow inward while closed, and back at its edge while open', () => {
    expect(mountRail({ edge: 'right' }).find('.rail-arrow').classes()).toContain('points-left')
    expect(mountRail({ edge: 'left' }).find('.rail-arrow').classes()).toContain('points-right')
    expect(
      mountRail({ edge: 'right', composition: 'pages' }).find('.rail-arrow').classes()
    ).toContain('points-right')
    expect(
      mountRail({ edge: 'left', composition: 'pages' }).find('.rail-arrow').classes()
    ).toContain('points-left')
  })

  /*
   * AMENDED for #156's first correction: the mine-only composition is the case
   * that was missing, and it is the one the acceptance run caught. The rail went
   * on drawing the mark there because the secondary panel was closed, while the
   * navigation stack drew its own beside it — two app icons on one edge.
   */
  it('shows the app mark only while it IS the whole shell', () => {
    expect(mountRail().find('.rail-mark').exists()).toBe(true)
    expect(mountRail({ composition: 'pages' }).find('.rail-mark').exists()).toBe(false)
    expect(mountRail({ composition: 'mine' }).find('.rail-mark').exists()).toBe(false)
  })

  it('paints the rail surface only while it IS the rail', () => {
    expect(mountRail().classes()).toContain('is-rail')
    expect(mountRail({ composition: 'pages' }).classes()).not.toContain('is-rail')
    // The shell paints one amber ground under everything in this composition;
    // a second rounded, shadowed surface inside it is a seam, not a rail.
    expect(mountRail({ composition: 'mine' }).classes()).not.toContain('is-rail')
  })

  it('reports which edge it hangs on, so the frame can mirror with it', () => {
    expect(mountRail({ edge: 'left' }).classes()).toContain('edge-left')
    expect(mountRail({ edge: 'right' }).classes()).toContain('edge-right')
  })
})

/*
 * ADDED for #566 (the follow-up #592 left for after #585): the arrow answers a
 * pointer through the shared vocabulary, like every other control in the shell.
 *
 * NOT on the root button, and these cases exist to keep it off there. The root
 * IS the column the fold carries (`App.vue` hands `railEl.$el` to
 * `useShellFold` as `rail`): the fold writes its travel into that element's own
 * inline `transform`, runs its carry on the same property, and measures the
 * element with `getBoundingClientRect`, which includes any transform on it. A
 * `motion.button` root would have motion-v writing `scale(...)` into that one
 * property — erasing the fold's `translateX` mid-carry, and handing the fold a
 * box 3% off the one the row laid out, at exactly the moment a pointer is on
 * the arrow: the press that starts the fold.
 */
describe('EdgeRail press and hover feedback', () => {
  async function settle(): Promise<void> {
    for (let frame = 0; frame < 20; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }

  it('gives the arrow the shared press/hover variants, on a face inside the rail', () => {
    const rail = mountRail({ composition: 'pages' })
    const face = rail.getComponent(motion.span)

    expect(face.classes()).toContain('rail-face')
    expect(face.props('whileHover')).toEqual(pressHoverVariants.whileHover)
    expect(face.props('whilePress')).toEqual(pressHoverVariants.whilePress)
    expect(face.find('.rail-arrow').exists()).toBe(true)
  })

  it('leaves the rail itself a plain button carrying no gesture of its own', () => {
    const rail = mountRail()

    expect(rail.element.tagName).toBe('BUTTON')
    expect(rail.findAllComponents(motion.button)).toHaveLength(0)
    // The face is the only thing that answers a pointer; the app mark stays
    // outside it, at the top of the rail, where a grow would push it off the
    // edge of the window.
    expect(rail.findAllComponents(motion.span)).toHaveLength(1)
    expect(rail.get('.rail-face').find('.rail-mark').exists()).toBe(false)
  })

  it('still reports the press when it lands on the face', async () => {
    const rail = mountRail()

    await rail.get('.rail-face').trigger('click')
    expect(rail.emitted('toggle')).toHaveLength(1)
  })

  // Against the real engine, because "the gesture writes somewhere else" is a
  // claim about where motion-v puts its transform, and only running it says so.
  it('grows the face under a hover and leaves the transform the fold wrote on the rail alone', async () => {
    const rail = mount(EdgeRail, {
      props: { edge: 'right', composition: 'pages' },
      attachTo: document.body
    })
    const root = rail.element as HTMLElement
    const face = rail.get('.rail-face').element as HTMLElement
    // What `useShellFold`'s `place` writes on a carried column mid-fold.
    root.style.transform = 'translateX(40px)'

    face.dispatchEvent(new window.PointerEvent('pointerenter'))
    await settle()

    expect(face.style.transform).toBe(`scale(${pressHoverVariants.whileHover.scale})`)
    expect(root.style.transform).toBe('translateX(40px)')
    rail.unmount()
  })
})
