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
 * window that hears the carried chat after landing (`onLanded`: Veta's rise, S24.18) is told M + 60 ms after `t0`.
 * Both hear the run's slot (`ModeTransition.slot`, AMENDMENT-27; S24.13): on `'history'` the target opens the mine's
 * history on that dwarf's tab instead of the chat, waits for no chat, and keeps the carried draft and view in the session
 * store for when that chat next opens here, restoring them then. A
 * carried chat heard before the window could open it (Valle's root mounts once its stores were read, S39.03; ISSUE-311)
 * is kept and opened when `onArrival` registers, its draft and view restored into it then; the run never waits for it. A
 * run into the Panel carrying no chat opens the mine the session store names as the Panel's current mine
 * (`onMineArrival`, ISSUE-295; S27.01, S22.13), since A-N14 carries no mine of its own. A
 * window that left a run (`onLeft`) is told once its source half ended, its content veiled: a hidden frameless window
 * does not reliably report itself hidden, so this is when Veta folds its risen chat (S24.14). A window that enters a run
 * (`onEntered`) is told at `t0`, as its content is unveiled for its target half: with `onLeft`, Valle's shown state
 * (VQA-09).
 * Under reduced motion both halves last 0 ms and the answer goes at `t0` (S27.06, NFR-TIM-02). An
 * in-progress IME composition is not carried: the hand-off ends it before the flush; how each OS commits it is
 * S-025-1's record.
 *
 * The bridge, the clock and the bounded runner are injected (the house idiom over `vi.mock`).
 */
import type {
  ChatViewState,
  DwarfId,
  MineId,
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

/**
 * What the target opens for the carried chat (14 §3.9 `ModeTransition.slot`, AMENDMENT-27; 07 S24.13): the chat, or the
 * mine's history on that dwarf's tab. A transition without it means the chat.
 */
export type CarriedSlot = NonNullable<ModeTransition['slot']>

/** The run's slot, `'chat'` when it names none. */
export function carriedSlot(t: Pick<ModeTransition, 'slot'>): CarriedSlot {
  return t.slot ?? 'chat'
}

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

/**
 * The window's music in a run (owner ruling 2026-10-24, "one music, one playlist"; AMENDMENT-28): every mode window has
 * its own sound engine, so the music is handed from the window a run leaves to the window it enters.
 */
export interface MusicHandoffPart {
  /** A run this window leaves has started: hand the music over and stop it here. */
  leave(): void
  /** A run this window enters reached `t0`: take over the music handed over. */
  enter(): Promise<void> | void
}

export interface ModeTransitionPart {
  /** Registers the open chat's hand-off; answers the unregister. */
  register(handoff: ChatHandoff): () => void
  /**
   * Registers the window's music: `leave` as a run it leaves starts, with the open chat's flush and before `t0`, so the
   * window it enters reads it; `enter` at that run's `t0`, before the window hears it entered. Answers the unregister.
   */
  registerMusic(music: MusicHandoffPart): () => void
  /** Opens the carried chat in this window before its draft and view are restored; answers the unregister. */
  onArrival(open: (chat: CarriedChat, slot: CarriedSlot) => Promise<void> | void): () => void
  /**
   * Opens the mine the session store names for this window's host (`currentMine`) when a run with no chat lands here,
   * before the content shows (S27.01, S22.13); answers the unregister.
   */
  onMineArrival(open: (mineId: MineId) => void): () => void
  /** Hears the carried chat once this window landed as a run's target; answers the unregister. */
  onLanded(hear: (chat: CarriedChat, slot: CarriedSlot) => void): () => void
  /** Hears each run this window left, once its source half ended and its content is veiled; answers the unregister. */
  onLeft(hear: (t: ModeTransition) => void): () => void
  /**
   * Hears each run this window enters, at `t0`, as its content is unveiled to play its target half; answers the
   * unregister. With `onLeft`, what tells a window it is shown again (VQA-09): a hidden frameless window does not
   * reliably report its visibility.
   */
  onEntered(hear: (t: ModeTransition) => void): () => void
  dispose(): void
}

/** S24.18 (`DS/docs/motion.md`, Panel → Veta): the carried chat rises this long after the shell motion, M. */
export const CHAT_RISE_AFTER_MS = 60

export function useModeTransition(deps: ModeTransitionDeps): ModeTransitionPart {
  const { bridge, clock } = deps
  let handoff: ChatHandoff | null = null
  let arrival: ((chat: CarriedChat, slot: CarriedSlot) => Promise<void> | void) | null = null
  let mineArrival: ((mineId: MineId) => void) | null = null
  let landed: ((chat: CarriedChat, slot: CarriedSlot) => void) | null = null
  let left: ((t: ModeTransition) => void) | null = null
  let entered: ((t: ModeTransition) => void) | null = null
  let music: MusicHandoffPart | null = null
  /** A carried chat heard before this window registered how to open it (`onArrival`), opened once it does. */
  let unopened: { chat: CarriedChat; slot: CarriedSlot } | null = null
  /**
   * A chat carried here on the history slot (S24.13): the history fills the slot, so its draft and view are kept in the
   * session store and restored when that chat opens here later ("the draft is kept for when that chat opens").
   */
  let kept: CarriedChat | null = null
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

  /**
   * S27.01, S22.13 (ISSUE-295): a run into the Panel with no chat opens on the mine the session store names as the
   * Panel's current mine — A-N14 carries no mine of its own (14 §3.9), so a hand-off that names one writes it there first.
   */
  async function openNamedMine(t: ModeTransition): Promise<void> {
    if (t.to !== 'panel' || mineArrival === null) return
    try {
      const mineId = (await bridge.getUiSession()).currentMine.panel ?? null
      if (mineId !== null) mineArrival?.(mineId)
    } catch {
      // The session store could not be read: the Panel opens as it is, and the run still plays.
    }
  }

  async function restore(t: ModeTransition): Promise<void> {
    const chat = t.chat
    kept = null
    if (chat === undefined) return openNamedMine(t)
    const slot = carriedSlot(t)
    if (slot === 'history') {
      // S24.13: the window opens on the mine's history, on this dwarf's tab; no chat mounts, so nothing waits for one.
      kept = chat
      if (arrival === null) unopened = { chat, slot }
      else await opened(arrival, chat, slot)
      return
    }
    // S27.01: the window opens on the carried chat first (the Panel's mine column and chat, US-MSG-010.AC01).
    if (handoff?.open() !== chat.dwarfId && arrival === null) unopened = { chat, slot }
    if (handoff?.open() !== chat.dwarfId && arrival !== null) {
      await open(arrival, chat, t.t0 + MODE_MOTION_MS)
    }
    await restoreInto(chat)
  }

  /** Runs the window's opener; one that fails leaves the window as it is, and the run still plays. */
  async function opened(
    opening: (chat: CarriedChat, slot: CarriedSlot) => Promise<void> | void,
    chat: CarriedChat,
    slot: CarriedSlot
  ): Promise<void> {
    try {
      await opening(chat, slot)
    } catch {
      // Nothing opened: the window shows what it shows.
    }
  }

  /**
   * Opens the carried chat here; its panel may mount a moment after it opened, so this waits for its registration until
   * `until` at most: during a run, the shell motion's end; after it (`null`, a chat opened late), the shell motion's
   * length from the moment it opened. A window that opens nothing here (Veta, whose chat rises once landed) waits for
   * nothing.
   */
  async function open(
    opening: (chat: CarriedChat, slot: CarriedSlot) => Promise<void> | void,
    chat: CarriedChat,
    until: number | null
  ): Promise<void> {
    try {
      await opening(chat, 'chat')
      if (handoff?.open() !== chat.dwarfId) {
        await registration(chat.dwarfId, until ?? clock.now() + MODE_MOTION_MS)
      }
    } catch {
      // The chat could not be opened here: the window shows what it shows, and the run still plays.
    }
  }

  /** Restores the carried draft and view into the carried chat, once it is the one open here. */
  async function restoreInto(chat: CarriedChat): Promise<void> {
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
        if (t.role === 'target') {
          // The music first, so the window's own shown state, opened by `entered`, starts nothing of its own.
          void music?.enter()
          deps.veil(false)
          // The window is shown again: what hides with it may come back (Valle's page, VQA-09).
          entered?.(t)
        }
        const half = deps.reducedMotion() ? [] : deps.half(t)
        if (half.length === 0) {
          answer(t)
          return
        }
        void deps.play(half).then(() => answer(t))
      })
    if (t.role === 'source') {
      kept = null
      flush()
      // With the flush, before t0: the window the run enters reads where the music was (AMENDMENT-28).
      music?.leave()
      playAtT0()
      return
    }
    const chat = t.chat
    if (chat !== undefined) {
      // S24.18: the carried chat is heard M + 60 ms after `t0`, once the shell motion has landed (at `t0` under
      // reduced motion, where the shell motion lasts 0 ms).
      const after = deps.reducedMotion() ? 0 : MODE_MOTION_MS + CHAT_RISE_AFTER_MS
      atT0(t.t0 + after, () => landed?.(chat, carriedSlot(t)))
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
      // S24.13: the chat the history slot kept opens here now: its draft and view come back, once.
      if (kept !== null && next.open() === kept.dwarfId) {
        const chat = kept
        kept = null
        void restoreInto(chat)
      }
      return () => {
        if (handoff === next) handoff = null
      }
    },
    onArrival(opening) {
      arrival = opening
      // A chat carried here before this window could open it (ISSUE-311): opened now, its draft and view restored.
      const carried = unopened
      unopened = null
      if (carried?.slot === 'history') void opened(opening, carried.chat, 'history')
      else if (carried !== null) {
        const { chat } = carried
        void open(opening, chat, null).then(() => restoreInto(chat))
      }
      return () => {
        if (arrival === opening) arrival = null
      }
    },
    onMineArrival(open) {
      mineArrival = open
      return () => {
        if (mineArrival === open) mineArrival = null
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
    registerMusic(next) {
      music = next
      return () => {
        if (music === next) music = null
      }
    },
    onEntered(hear) {
      entered = hear
      return () => {
        if (entered === hear) entered = null
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
      registerMusic: () => () => {},
      onArrival: () => () => {},
      onMineArrival: () => () => {},
      onLanded: () => () => {},
      onLeft: () => () => {},
      onEntered: () => () => {},
      dispose: () => {}
    }
  }
  const part = useModeTransition(defaultDeps())
  shared = {
    register: (handoff) => part.register(handoff),
    registerMusic: (music) => part.registerMusic(music),
    onArrival: (open) => part.onArrival(open),
    onMineArrival: (open) => part.onMineArrival(open),
    onLanded: (hear) => part.onLanded(hear),
    onLeft: (hear) => part.onLeft(hear),
    onEntered: (hear) => part.onEntered(hear),
    dispose: () => {
      part.dispose()
      shared = null
    }
  }
  return shared
}
