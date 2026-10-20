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
 * Under reduced motion both halves last 0 ms and the answer goes at `t0` (S27.06, NFR-TIM-02). An
 * in-progress IME composition is not carried; how each OS ends it at the switch is UNVERIFIED until
 * S-025-1 is recorded, so nothing here depends on it.
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
import type { MotionTrack } from '../lib/mode/transitionMotion'

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
  /** The chat open in this window, or `null` when none is. */
  open(): { dwarfId: DwarfId; mineId: MineId } | null
  draft(): string
  view(): ChatViewState
  /** Shows the carried chat as it was: its draft, and its view state when it has one. */
  restore(state: { draft: string; view: ChatViewState | null }): void
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

export interface ModeTransitionPart {
  /** Registers the open chat's hand-off; answers the unregister. */
  register(handoff: ChatHandoff): () => void
  dispose(): void
}

export function useModeTransition(deps: ModeTransitionDeps): ModeTransitionPart {
  const { bridge, clock } = deps
  let handoff: ChatHandoff | null = null
  /** The runs this renderer took part in: one answer each. */
  const seen = new Set<string>()
  const timers = new Set<() => void>()

  function flush(): void {
    const chat = handoff?.open() ?? null
    if (handoff === null || chat === null) return
    bridge.patchUiSession({ kind: 'draft', dwarfId: chat.dwarfId, text: handoff.draft() })
    bridge.patchUiSession({ kind: 'chat-view', dwarfId: chat.dwarfId, view: handoff.view() })
  }

  async function restore(t: ModeTransition): Promise<void> {
    if (t.chat === undefined || handoff === null) return
    try {
      const session = await bridge.getUiSession()
      handoff?.restore({
        draft: session.drafts[t.chat.dwarfId] ?? '',
        view: session.chatViews[t.chat.dwarfId] ?? null
      })
    } catch {
      // The session store could not be read: the chat opens as it is, and the run still plays.
    }
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
    void restore(t).then(playAtT0)
  }

  const stop = bridge.onModeTransition(onTransition)

  return {
    register(next) {
      handoff = next
      return () => {
        if (handoff === next) handoff = null
      }
    },
    dispose() {
      stop()
      for (const cancel of timers) cancel()
      timers.clear()
    }
  }
}
