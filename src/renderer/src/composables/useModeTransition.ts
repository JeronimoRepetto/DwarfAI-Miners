/*
 * One renderer's part of a mode transition run (ISSUE-284; ADR-025 item 3; 07 machines 9 and 27;
 * ADR-024 item 3). UI main's `ModeCoordinator` sends each renderer one `mode.transition` (A-N14)
 * with a shared `t0` and the role it plays:
 *
 * - `source`: at once — before `t0` — the open chat's draft and `ChatViewState` go to the UI-main
 *   session store (`patchUiSession`, A-N18), so the other window can show the same chat (S9.01).
 *   From `t0` it plays its half; the half ends with its content gone (opacity 0), and the content
 *   stays veiled until this window next plays a target half, so a window shown inactive at its
 *   final bounds never flashes old content.
 * - `target`: the carried chat's draft and view state are read back (`getUiSession`, A-N17) and
 *   restored before its content becomes visible (S27.05); its content is unveiled at `t0`, where its
 *   half starts from opacity 0.
 *
 * Either answers `modeTransitionDone` (A-N15) exactly once per `transitionId`, when its half ends.
 *
 * The chat hand-off (ISSUE-293; 07 machine 9; UC-051): before the source flushes, an input-method composition in
 * progress is ended, so what it held travels as draft text (S9.02, US-DLG-006.AC03). A target carrying a chat first
 * opens it (`onArrival`: the Panel's mine column and chat), and restores the draft and view into that chat alone. A
 * window that hears the carried chat after landing (`onLanded`: Veta's rise, S24.18) is told M + 60 ms after `t0`. A
 * window that left a run (`onLeft`) is told once its source half ended, its content veiled: a hidden frameless window
 * does not reliably report itself hidden, so this is when Veta folds its risen chat (S24.14).
 * Under reduced motion both halves last 0 ms and the answer goes at `t0` (S27.06, NFR-TIM-02). An
 * in-progress IME composition is not carried: the hand-off ends it before the flush; how each OS commits it is
 * S-025-1's record.
 *
 * The bridge, the clock and the bounded runner are injected (the house idiom over `vi.mock`).
 */
import type {
  ChatViewState,
  DwarfId,
  ModeTransition,
  UiSessionPatch,
  UiSessionSnapshot
} from '@dwarfai/contracts'
import { MODE_MOTION_MS, transitionHalf, type MotionTrack } from '../lib/mode/transitionMotion'
import { prefersReducedMotion } from '../lib/scene/sceneMotion'
import { createBoundedMotion } from '../lib/shell/boundedMotion'
import type { MotionTransition } from '../lib/shell/motionTiming'

/** The seam A members a run uses (14 §2.2 A-N14, A-N15, A-N17, A-N18). */
export interface ModeTransitionBridge {
  onModeTransition(h: (t: ModeTransition) => void): () => void
  modeTransitionDone(p: { transitionId: string }): void
  patchUiSession(p: UiSessionPatch): void
  getUiSession(): Promise<UiSessionSnapshot>
}

/** The clock `t0` is read on (the same wall clock UI main reads) and a one-shot timer. */
export interface ModeTransitionClock {
  now(): number
  after(ms: number, fire: () => void): () => void
}

/** What the open chat of this window hands over and takes back (registered by the message panel). */
export interface ChatHandoff {
  /** The dwarf whose chat is open in this window, or `null` when none is. */
  open(): DwarfId | null
  draft(): string
  view(): ChatViewState
  /** Shows the carried chat as it was: its draft, and its view state when it has one. */
  restore(state: { draft: string; view: ChatViewState | null }): void
  /** Ends an input-method composition in progress, committing what it holds into the draft (S9.02). */
  endComposition?(): void
}

/** The chat a run carries (14 §3.9 `ModeTransition.chat`). */
export type CarriedChat = NonNullable<ModeTransition['chat']>

export interface ModeTransitionDeps {
  bridge: ModeTransitionBridge
  clock: ModeTransitionClock
  reducedMotion(): boolean
  /** The tracks of this renderer's half (`lib/mode/transitionMotion.ts`). */
  half(t: ModeTransition): MotionTrack[]
  /** Hides (`true`) or shows this window's content at once. */
  veil(hidden: boolean): void
  /** Plays a half through the bounded runner; resolves when it is over by any route (NFR-TIM-16). */
  play(half: MotionTrack[]): Promise<void>
}

export interface ModeTransitionPart {
  /** Registers the open chat's hand-off; answers the unregister. */
  register(handoff: ChatHandoff): () => void
  /** Opens the carried chat in this window before its draft and view are restored; answers the unregister. */
  onArrival(open: (chat: CarriedChat) => Promise<void> | void): () => void
  /** Hears the carried chat once this window landed as a run's target; answers the unregister. */
  onLanded(hear: (chat: CarriedChat) => void): () => void
  /** Hears each run this window left, once its source half ended and its content is veiled; answers the unregister. */
  onLeft(hear: (t: ModeTransition) => void): () => void
  dispose(): void
}

/** S24.18 (`DS/docs/motion.md`, Panel → Veta): the carried chat rises this long after the shell motion, M. */
export const CHAT_RISE_AFTER_MS = 60

export function useModeTransition(deps: ModeTransitionDeps): ModeTransitionPart {
  const { bridge, clock } = deps
  let handoff: ChatHandoff | null = null
  let arrival: ((chat: CarriedChat) => Promise<void> | void) | null = null
  let landed: ((chat: CarriedChat) => void) | null = null
  let left: ((t: ModeTransition) => void) | null = null
  /** A carried chat opened here whose panel has not registered yet, and what its registration settles. */
  let awaited: { dwarfId: DwarfId; registered: () => void } | null = null
  /** The runs this renderer took part in: one answer each. */
  const seen = new Set<string>()
  const timers = new Set<() => void>()

  function flush(): void {
    const dwarfId = handoff?.open() ?? null
    if (handoff === null || dwarfId === null) return
    // S9.02: a composition in progress ends at the switch, so what it held travels as draft text, never as IME state.
    handoff.endComposition?.()
    bridge.patchUiSession({ kind: 'draft', dwarfId, text: handoff.draft() })
    bridge.patchUiSession({ kind: 'chat-view', dwarfId, view: handoff.view() })
  }

  async function restore(t: ModeTransition): Promise<void> {
    const chat = t.chat
    if (chat === undefined) return
    // S27.01: the window opens on the carried chat first (the Panel's mine column and chat, US-MSG-010.AC01).
    if (handoff?.open() !== chat.dwarfId && arrival !== null) {
      try {
        await arrival(chat)
        // The chat's panel may mount a moment after it opened: the content waits for it, at most the shell motion's
        // length. A window that opens nothing here (Veta, whose chat rises once landed) waits for nothing.
        if (handoff?.open() !== chat.dwarfId) {
          await registration(chat.dwarfId, t.t0 + MODE_MOTION_MS)
        }
      } catch {
        // The chat could not be opened here: the window shows what it shows, and the run still plays.
      }
    }
    // The carried draft and view belong to that chat alone, never to another dwarf's open here.
    if (handoff === null || handoff.open() !== chat.dwarfId) return
    try {
      const session = await bridge.getUiSession()
      if (handoff?.open() !== chat.dwarfId) return
      handoff.restore({
        draft: session.drafts[chat.dwarfId] ?? '',
        view: session.chatViews[chat.dwarfId] ?? null
      })
    } catch {
      // The session store could not be read: the chat opens as it is, and the run still plays.
    }
  }

  /**
   * Resolves once a hand-off for `dwarfId` registers (its panel mounted, which the host may do a moment after it opened
   * the chat), or at `until` when none did: the content waits for it at most that long, never the run.
   */
  function registration(dwarfId: DwarfId, until: number): Promise<void> {
    return new Promise((resolve) => {
      const cancel = clock.after(Math.max(0, until - clock.now()), () => {
        timers.delete(cancel)
        if (awaited?.dwarfId === dwarfId) awaited = null
        resolve()
      })
      timers.add(cancel)
      awaited = {
        dwarfId,
        registered: () => {
          cancel()
          timers.delete(cancel)
          resolve()
        }
      }
    })
  }

  /** Runs `fire` at `t0` (at once when `t0` has passed). */
  function atT0(t0: number, fire: () => void): void {
    const cancel = clock.after(Math.max(0, t0 - clock.now()), () => {
      timers.delete(cancel)
      fire()
    })
    timers.add(cancel)
  }

  function answer(t: ModeTransition): void {
    if (t.role === 'source') deps.veil(true)
    bridge.modeTransitionDone({ transitionId: t.transitionId })
    // The window is going away: what it hosts may close now, unseen (Veta's risen chat folds at once, S24.14).
    if (t.role === 'source') left?.(t)
  }

  function onTransition(t: ModeTransition): void {
    if (seen.has(t.transitionId)) return
    seen.add(t.transitionId)
    const playAtT0 = (): void =>
      atT0(t.t0, () => {
        if (t.role === 'target') deps.veil(false)
        const half = deps.reducedMotion() ? [] : deps.half(t)
        if (half.length === 0) {
          answer(t)
          return
        }
        void deps.play(half).then(() => answer(t))
      })
    if (t.role === 'source') {
      flush()
      playAtT0()
      return
    }
    const chat = t.chat
    if (chat !== undefined) {
      // S24.18: the carried chat is heard M + 60 ms after `t0`, once the shell motion has landed (at `t0` under
      // reduced motion, where the shell motion lasts 0 ms).
      const after = deps.reducedMotion() ? 0 : MODE_MOTION_MS + CHAT_RISE_AFTER_MS
      atT0(t.t0 + after, () => landed?.(chat))
    }
    void restore(t).then(playAtT0)
  }

  const stop = bridge.onModeTransition(onTransition)

  return {
    register(next) {
      handoff = next
      if (awaited !== null && next.open() === awaited.dwarfId) {
        const { registered } = awaited
        awaited = null
        registered()
      }
      return () => {
        if (handoff === next) handoff = null
      }
    },
    onArrival(open) {
      arrival = open
      return () => {
        if (arrival === open) arrival = null
      }
    },
    onLanded(hear) {
      landed = hear
      return () => {
        if (landed === hear) landed = null
      }
    },
    onLeft(hear) {
      left = hear
      return () => {
        if (left === hear) left = null
      }
    },
    dispose() {
      stop()
      for (const cancel of timers) cancel()
      timers.clear()
    }
  }
}

/** The part this window plays, once started (`modeTransitionPart`). */
let shared: ModeTransitionPart | null = null

/**
 * The defaults of a window's part: `window.api` (A-N14, A-N15, A-N17, A-N18), the wall clock UI main's `t0` is read on,
 * the viewer's reduced-motion answer, and the bounded runner over the window's content. The Panel's content is its
 * dock, so each track plays on the document root; the Veta parts are ISSUE-287's.
 */
function defaultDeps(): ModeTransitionDeps {
  const runner = createBoundedMotion()
  const root = (): HTMLElement => document.documentElement
  return {
    bridge: window.api,
    clock: {
      now: () => Date.now(),
      after: (ms, fire) => {
        const timer = setTimeout(fire, ms)
        return () => clearTimeout(timer)
      }
    },
    reducedMotion: () => prefersReducedMotion(),
    // The Panel's docked edge orients the Veta ⇄ Panel halves; with the Panel the one mode built (ADR-034), every run
    // is to or from `hidden`, which has no half. The Veta renderer passes its own dock and parts (ISSUE-287).
    half: (t) => transitionHalf(t, 'right', 0),
    veil: (hidden) => {
      if (hidden) root().style.opacity = '0'
      else root().style.removeProperty('opacity')
    },
    play: async (half) => {
      await Promise.all(
        half.map((track) =>
          runner.run(
            root(),
            { opacity: track.keyframes.opacity, x: track.keyframes.x, y: track.keyframes.y },
            undefined,
            { duration: track.durationMs / 1000, delay: track.delayMs / 1000 } as MotionTransition
          )
        )
      )
    }
  }
}

/**
 * This window's part of every run, started once with `window.api` and shared by whoever registers a chat hand-off
 * (the message panel). Disposing it lets the next call start a fresh one.
 */
export function modeTransitionPart(): ModeTransitionPart {
  if (shared !== null) return shared
  // A window with no bridge for runs (a golden render, a component test) plays no part.
  if (typeof window === 'undefined' || typeof window.api?.onModeTransition !== 'function') {
    return {
      register: () => () => {},
      onArrival: () => () => {},
      onLanded: () => () => {},
      onLeft: () => () => {},
      dispose: () => {}
    }
  }
  const part = useModeTransition(defaultDeps())
  shared = {
    register: (handoff) => part.register(handoff),
    onArrival: (open) => part.onArrival(open),
    onLanded: (hear) => part.onLanded(hear),
    onLeft: (hear) => part.onLeft(hear),
    dispose: () => {
      part.dispose()
      shared = null
    }
  }
  return shared
}
