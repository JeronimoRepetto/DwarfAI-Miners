// @vitest-environment jsdom
import type {
  ChatViewState,
  DwarfId,
  MessageId,
  MineId,
  ModeTransition,
  UiSessionPatch,
  UiSessionSnapshot
} from '@dwarfai/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createFakeWindowApi } from '../../../contracts/ipc/testing/fakeWindowApi'
import type { MotionTrack } from '../lib/mode/transitionMotion'
import {
  modeTransitionPart,
  useModeTransition,
  type ChatHandoff,
  type ModeTransitionDeps
} from './useModeTransition'

const DWARF = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a01' as DwarfId
const MINE = '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a02' as MineId
const VIEW: ChatViewState = {
  scrollAnchor: { messageId: 'msg-7' as MessageId, offsetPx: 12 },
  selection: { start: 3, end: 9, direction: 'forward' }
}
const HALF: MotionTrack[] = [
  {
    part: 'panel-dock',
    delayMs: 0,
    durationMs: 270,
    keyframes: { opacity: [0, 1], x: [56, 0], y: [0, 0] }
  }
]

/** A clock that moves only when the test says so, and the timers it runs. */
function fakeClock(start = 5_000) {
  let now = start
  const timers: { due: number; fire: () => void }[] = []
  return {
    now: () => now,
    after(ms: number, fire: () => void) {
      const timer = { due: now + ms, fire }
      timers.push(timer)
      return () => timers.splice(timers.indexOf(timer), 1)
    },
    advance(ms: number) {
      now += ms
      for (const timer of timers.filter((t) => t.due <= now)) {
        timers.splice(timers.indexOf(timer), 1)
        timer.fire()
      }
    }
  }
}

function setup(options: { reduced?: boolean; session?: Partial<UiSessionSnapshot> } = {}) {
  const clock = fakeClock()
  const events: string[] = []
  const patches: UiSessionPatch[] = []
  const done: string[] = []
  let listener: ((t: ModeTransition) => void) | null = null
  const playing: (() => void)[] = []
  const deps: ModeTransitionDeps = {
    bridge: {
      onModeTransition(h) {
        listener = h
        return () => (listener = null)
      },
      modeTransitionDone(p) {
        events.push(`done ${p.transitionId}`)
        done.push(p.transitionId)
      },
      patchUiSession(p) {
        events.push(`patch ${p.kind}`)
        patches.push(p)
      },
      getUiSession: () =>
        Promise.resolve({
          drafts: {},
          chatViews: {},
          askPicks: {},
          openChat: {},
          currentMine: {},
          valle: {},
          ...options.session
        })
    },
    clock,
    reducedMotion: () => options.reduced ?? false,
    half: () => HALF,
    veil(hidden) {
      events.push(`veil ${hidden}`)
    },
    play(half) {
      events.push(`play ${half.length}`)
      return new Promise<void>((resolve) => playing.push(resolve))
    }
  }
  const transition = useModeTransition(deps)
  const handoff: ChatHandoff = {
    open: () => DWARF,
    draft: () => 'half a thought',
    view: () => VIEW,
    restore(state) {
      events.push(`restore ${state.draft} ${JSON.stringify(state.view)}`)
    }
  }
  transition.register(handoff)
  const push = (t: Partial<ModeTransition> & Pick<ModeTransition, 'role'>): void =>
    listener!({ transitionId: 't-1', from: 'panel', to: 'veta', t0: clock.now() + 16, ...t })
  return {
    clock,
    events,
    patches,
    done,
    push,
    finish: () => playing.splice(0).forEach((resolve) => resolve()),
    transition
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('useModeTransition (ADR-025 item 3; 07 machines 9 and 27)', () => {
  it("[US-VETA-009.AC03, S9.01] the source renderer flushes the open chat's draft and chat view state before t0", async () => {
    const s = setup()
    s.push({ role: 'source' })
    // Flushed at once, before t0 and before any motion.
    expect(s.patches).toEqual([
      { kind: 'draft', dwarfId: DWARF, text: 'half a thought' },
      { kind: 'chat-view', dwarfId: DWARF, view: VIEW }
    ])
    expect(s.events).toEqual(['patch draft', 'patch chat-view'])
    s.clock.advance(16)
    await flush()
    expect(s.events.at(-1)).toBe('play 1')
    // Its half ends with the content gone (opacity 0), and it stays so until the window next plays a target half.
    s.finish()
    await flush()
    expect(s.events.slice(-2)).toEqual(['veil true', 'done t-1'])
  })

  it("[US-VETA-009.AC03, S27.05, INV-114] the target renderer restores the carried chat's draft, scroll anchor and selection before its content becomes visible", async () => {
    const s = setup({
      session: { drafts: { [DWARF]: 'carried text' }, chatViews: { [DWARF]: VIEW } }
    })
    s.push({ role: 'target', from: 'veta', to: 'panel', chat: { dwarfId: DWARF, mineId: MINE } })
    await flush()
    s.clock.advance(16)
    await flush()
    // The target's content is at opacity 0 until its half plays from t0: the restore comes first.
    expect(s.events).toEqual([
      `restore carried text ${JSON.stringify(VIEW)}`,
      'veil false',
      'play 1'
    ])
    s.finish()
    await flush()
    expect(s.done).toEqual(['t-1'])
  })

  it('[S27.06, NFR-TIM-02] under reduced motion both halves last 0 ms and done is answered at t0', async () => {
    const s = setup({ reduced: true })
    s.push({ role: 'source' })
    s.clock.advance(15)
    await flush()
    expect(s.done).toEqual([])
    s.clock.advance(1)
    await flush()
    expect(s.done).toEqual(['t-1'])
    expect(s.events.filter((e) => e.startsWith('play'))).toEqual([])
  })

  it('[ADR-025] a renderer answers modeTransitionDone exactly once per transitionId', async () => {
    const s = setup()
    s.push({ role: 'source' })
    s.push({ role: 'source' })
    s.clock.advance(16)
    await flush()
    s.finish()
    await flush()
    s.finish()
    await flush()
    expect(s.done).toEqual(['t-1'])
    // The next run has its own answer.
    s.push({ role: 'source', transitionId: 't-2' })
    s.clock.advance(16)
    await flush()
    s.finish()
    await flush()
    expect(s.done).toEqual(['t-1', 't-2'])
  })
})

describe('the window part of a run (ISSUE-284)', () => {
  it('[S27.05, S10.08, S10.09] one part per window speaks window.api, veils the content after its source half and unveils it at its target t0', async () => {
    vi.useFakeTimers({ now: 10_000 })
    let listener: ((t: ModeTransition) => void) | null = null
    const done: string[] = []
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: createFakeWindowApi({
        onModeTransition: (h) => {
          listener = h
          return () => (listener = null)
        },
        modeTransitionDone: (p) => void done.push(p.transitionId),
        patchUiSession: () => {},
        getUiSession: () =>
          Promise.resolve({
            drafts: {},
            chatViews: {},
            askPicks: {},
            openChat: {},
            currentMine: {},
            valle: {}
          })
      })
    })
    try {
      const part = modeTransitionPart()
      expect(modeTransitionPart()).toBe(part)
      // Hide: the Panel is the source of a run to hidden, with no half to play; it answers at t0, veiled.
      listener!({
        transitionId: 'run-1',
        from: 'panel',
        to: 'hidden',
        t0: Date.now() + 16,
        role: 'source'
      })
      await vi.advanceTimersByTimeAsync(16)
      expect(done).toEqual(['run-1'])
      expect(document.documentElement.style.opacity).toBe('0')
      // Restore: the target of a run from hidden; unveiled at its t0.
      listener!({
        transitionId: 'run-2',
        from: 'hidden',
        to: 'panel',
        t0: Date.now() + 16,
        role: 'target'
      })
      await vi.advanceTimersByTimeAsync(16)
      expect(done).toEqual(['run-1', 'run-2'])
      expect(document.documentElement.style.opacity).toBe('')
    } finally {
      modeTransitionPart().dispose()
      vi.useRealTimers()
    }
  })
})
