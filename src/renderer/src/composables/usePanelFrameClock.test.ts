// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { createFrameClock } from '../lib/sprite/frameClock'
import { loopOf, type SequencePosition, type SpriteSheet } from '../lib/sprite/spriteSheet'
import { FakeTickSource, fakeFrameClockEnv } from '../lib/sprite/testing/FakeTickSource'
import { useFramePlayer } from './useFramePlayer'
import { usePanelFrameClock, type PanelVisibilitySource } from './usePanelFrameClock'

/**
 * The Panel's sprite clock follows the Panel window (ISSUE-297; ADR-025 item 7; NFR-PERF-04): UI main says when the
 * Panel is shown or hidden (A-P1 `panel:visible:changed`, `getPanelVisible`), because a hidden frameless window's
 * `document.hidden` is a platform detail — on Windows the perf lane saw it stay `false` behind Veta while the Panel's
 * sleeping dwarf kept changing frame. Both halts hold: the window hidden, or the document hidden.
 */

const SWING: SpriteSheet = { src: 'swing.png', frames: 3, frameMs: 100, durations: [120, 60, 200] }

/** A scriptable A-P1: the first answer, and a push the test sends. */
function fakeVisibility(first: Promise<boolean> = Promise.resolve(true)): {
  source: PanelVisibilitySource
  push(visible: boolean): void
  listeners(): number
} {
  const listeners = new Set<(visible: boolean) => void>()
  return {
    source: {
      getPanelVisible: () => first,
      onPanelVisibility(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    push: (visible) => {
      for (const listener of [...listeners]) listener(visible)
    },
    listeners: () => listeners.size
  }
}

/** The Panel's app with one sprite playing SWING on whatever clock the app provides; answers the frames it showed. */
function mountPanelSprite(install: (app: ReturnType<typeof createApp>) => void): {
  frames: SequencePosition[]
  unmount(): void
} {
  const frames: SequencePosition[] = []
  const Sprite = defineComponent({
    setup() {
      const position = useFramePlayer(() => [loopOf(SWING)])
      return () => {
        frames.push(position.value)
        return h('span')
      }
    }
  })
  const app = createApp(Sprite)
  install(app)
  app.mount(document.createElement('div'))
  return { frames, unmount: () => app.unmount() }
}

/** Lets the pending promise answers and Vue's render queue run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('usePanelFrameClock (ISSUE-297, ADR-025 item 7)', () => {
  it('[ADR-025, NFR-PERF-04] a hidden Panel window requests no sprite frame and showing it again resumes the frames', async () => {
    const ticks = new FakeTickSource()
    const { env } = fakeFrameClockEnv(ticks) // the document says visible throughout, as Windows did
    const visibility = fakeVisibility()
    const panel = mountPanelSprite((app) =>
      usePanelFrameClock(app, visibility.source, createFrameClock(env))
    )
    await settle()
    ticks.advance(130)
    await settle()
    expect(panel.frames.at(-1)?.frame).toBe(1)

    visibility.push(false)
    const atHide = ticks.requests
    ticks.advance(60_000)
    await settle()
    expect(ticks.pending).toBe(0)
    expect(ticks.requests).toBe(atHide)
    expect(panel.frames.at(-1)?.frame).toBe(1)

    visibility.push(true)
    expect(ticks.pending).toBe(1)
    ticks.advance(50)
    await settle()
    expect(panel.frames.at(-1)?.frame).toBe(2)
    panel.unmount()
  })

  it('[ADR-025] a Panel that opens hidden starts with its sprite clock paused', async () => {
    const ticks = new FakeTickSource()
    const { env } = fakeFrameClockEnv(ticks)
    const visibility = fakeVisibility(Promise.resolve(false))
    const panel = mountPanelSprite((app) =>
      usePanelFrameClock(app, visibility.source, createFrameClock(env))
    )
    await settle()

    expect(ticks.pending).toBe(0)
    visibility.push(true)
    expect(ticks.pending).toBe(1)
    panel.unmount()
  })

  it('[ADR-025] a visibility push that arrives before the first answer wins over that answer', async () => {
    const ticks = new FakeTickSource()
    const { env } = fakeFrameClockEnv(ticks)
    let answer: (visible: boolean) => void = () => {}
    const visibility = fakeVisibility(new Promise<boolean>((resolve) => (answer = resolve)))
    const panel = mountPanelSprite((app) =>
      usePanelFrameClock(app, visibility.source, createFrameClock(env))
    )

    visibility.push(false)
    answer(true) // asked before the push, answered after it: stale
    await settle()

    expect(ticks.pending).toBe(0)
    panel.unmount()
  })

  it('[ADR-025] the sprite clock still halts on document.hidden while the Panel window is shown', async () => {
    const ticks = new FakeTickSource()
    const { env, host } = fakeFrameClockEnv(ticks)
    const visibility = fakeVisibility()
    const panel = mountPanelSprite((app) =>
      usePanelFrameClock(app, visibility.source, createFrameClock(env))
    )
    await settle()
    expect(ticks.pending).toBe(1)

    host.setHidden(true)
    expect(ticks.pending).toBe(0)
    host.setHidden(false)
    expect(ticks.pending).toBe(1)
    panel.unmount()
  })

  it('[ADR-025] stopping lets go of the visibility push', async () => {
    const ticks = new FakeTickSource()
    const { env } = fakeFrameClockEnv(ticks)
    const visibility = fakeVisibility()
    let stop: () => void = () => {}
    const panel = mountPanelSprite((app) => {
      stop = usePanelFrameClock(app, visibility.source, createFrameClock(env)).stop
    })
    await settle()
    expect(visibility.listeners()).toBe(1)

    stop()
    expect(visibility.listeners()).toBe(0)
    panel.unmount()
  })
})
