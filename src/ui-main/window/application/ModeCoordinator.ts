// The `ModeCoordinator` (ISSUE-284; ADR-025 items 1, 3, 8; 07 machines 27 and 10; 14 §2.2 A-N13…A-N15, §3.9;
// 16 §4.14 `ShellModeController.moveTo`): every move between mode windows is one transition run it owns.
//
// 1. The target window is placed at its final bounds and shown inactive (its renderer keeps its content at opacity 0
//    until `t0`); a target that cannot be created or shown leaves the source as it is (S27.07, FM-046).
// 2. Both renderers get one `mode.transition` (A-N14) with a shared `t0` = the UI-main clock + 16 ms and their role;
//    the source renderer flushes the open chat's draft and view state before `t0`.
// 3. Each renderer plays its half and answers `modeTransitionDone` (A-N15). No window is placed between `t0` and the
//    second answer (NFR-PERF-02).
// 4. On both answers, or the M + 40 ms watchdog (S27.04, NFR-TIM-16), the source hides, the target takes focus and
//    `lastMode` is written — here and nowhere else (14 §3.9).
//
// Hide and restore are runs to and from `hidden` (S10.08, S10.09): with no window at one end, that end's answer is the
// coordinator's own. A hide that arrives mid-run resolves the run at once (S27.08). A mode request during a run is held
// and runs as soon as the run settles, the last request winning (S27.09; owner OQ-78, AMENDMENT-10); a reveal is held
// the same way and applied in the target mode (S27.14). Any other input during a run is ignored, never queued.
//
// A run that carries a chat steps machine 9 with it (ISSUE-293; `domain/chatHandoff.ts`): the chat lands in the target
// as the run lands, stays in the source when the target fails to show (S9.06: logged, `lastMode` unwritten), ends
// read-only or closed when its dwarf departs mid-run (S9.08), and is lost with the UI process (S9.09).
//
// OS show/hide animations stay as the platform has them: disabling them is UNVERIFIED until S-025-1 is recorded
// (ADR-025 item 1), so nothing here depends on it.
import type {
  DepartureCause,
  DwarfId,
  IpcResult,
  MineId,
  ModeTransition,
  MoveToModeParams,
  Outcome,
  WindowMode
} from '@dwarfai/contracts'
import type { UiLog } from '../../diagnostics/uiLogger'
import {
  nextChatHandoff,
  startChatHandoff,
  type ChatHandoffEvent,
  type ChatHandoffNode
} from '../domain/chatHandoff'
import {
  nextModeTransition,
  type ModeTransitionEvent,
  type ModeTransitionNode
} from '../domain/modeTransition'
import {
  nextWindowLadder,
  type WindowLadderEvent,
  type WindowLadderState
} from '../domain/windowModeLadder'
import type { ModeTiming } from '../ports/modeTiming'
import type { ModeWindow, Rect } from '../ports/windowFactory'
import type { DwarfChatRevealer, RevealOutcome } from './revealDwarfChat'
import type { StoredUiPreferences } from './uiPreferences'

/** A-N14 `onModeTransition` (14 §2.2, NEW, `ui-local`). */
export const MODE_TRANSITION_PUSH = 'mode:transition'

/** S27.02: M, the length of each half (`DS/docs/motion.md`). */
export const MODE_MOTION_MS = 270
/** S27.04, NFR-TIM-16: the watchdog fires this long after M, counted from `t0`. */
export const MODE_WATCHDOG_MARGIN_MS = 40
/** ADR-025 item 3 step 2: `t0` = the UI-main clock + 16 ms. */
export const MODE_T0_LEAD_MS = 16

/** A mode a window shows (14 §3.9 `WindowMode` without `hidden`). */
export type AppMode = Exclude<WindowMode, 'hidden'>
/** Where the coordinator starts: the rung UI main opened on (S10.01 a mode, S10.03 `tray-only`). */
export type ModeCoordinatorStart = WindowMode | 'tray-only'
export type LadderState = WindowLadderState

/** The mode windows as a run needs them (composed by the UI-main root over `WindowFactory`). */
export interface ModeWindowPlacement {
  /** The window of `mode`: created lazily once, then kept (ADR-025 item 1); throws when it cannot be created. */
  window(mode: AppMode): ModeWindow
  /** Where `mode`'s window sits once shown: its final bounds; throws when they cannot be resolved. */
  bounds(mode: AppMode): Rect
  /**
   * S10.02: brings the window of `mode`, already shown, to the front and un-minimized — a second launch, the tray's
   * Open, Stop everything's confirmation. Not a run: nothing moves between windows.
   */
  bringForward(mode: AppMode): void
  /**
   * Whether the window of `mode` is on screen as the OS has it, read back without building one: a hide the coordinator
   * did not run (macOS Cmd+H, `app.hide()`) reads `false`.
   */
  isShown(mode: AppMode): boolean
}

export interface ModeCoordinatorDeps {
  windows: ModeWindowPlacement
  timing: ModeTiming
  /**
   * The UI preferences; the coordinator writes `lastMode` only, and is its one writer (14 §3.9). It reads `lastMode` and
   * "Mode at launch" (`modeAtLaunch`, written by Settings through A-N21) for the first open (S10.01, S10.13).
   */
  lastMode: Pick<StoredUiPreferences, 'get' | 'set'>
  /** The modes this build ships (ISSUE-267's feature list; BR-19, ADR-034 item 2). */
  built: readonly AppMode[]
  /** The per-mode reveal (ADR-025 item 8; `revealDwarfChat.ts`). */
  revealer: DwarfChatRevealer
  log: UiLog
  newTransitionId(): string
  /** The person asked for reduced motion (S27.06, NFR-TIM-02). */
  reducedMotion(): boolean
  /**
   * NFR-PERF-02: told `true` once a run's motion starts (`t0` sent) and `false` once it lands, so a window that would
   * place itself meanwhile (a display change, a layout request) holds that placement until the run is over.
   */
  onRunChanged?(playing: boolean): void
  start: ModeCoordinatorStart
}

export interface ModeCoordinator {
  /** A-N13: resolves when the move that carries it settles (14 §2.2 Notes, AMENDMENT-10). */
  moveToMode(p: MoveToModeParams): Promise<IpcResult<void>>
  /** A-N15 from the window of `sender`; an answer for another run is stale and dropped. */
  transitionDone(sender: AppMode, p: { transitionId: string }): void
  /** 16 §4.14 `revealDwarfChat`, held while a run plays (S27.14). */
  revealDwarfChat(t: { mineId: MineId; dwarfId: DwarfId }): Promise<RevealOutcome>
  /** S10.12: a notification click with no window open, after "Mode at launch" resolved `mode`. */
  revealAtLaunch(mode: AppMode, t: { mineId: MineId; dwarfId: DwarfId }): Promise<RevealOutcome>
  /**
   * S10.13: tray Open or a normal launch from `tray-only`, in the mode "Mode at launch" resolved; S10.12 when a
   * notification click opens it (`reveal`).
   */
  openAtLaunch(mode: AppMode, reason?: { reveal: boolean }): Promise<IpcResult<void>>
  /** S10.08 (app mark, global shortcut, Settings "Hide panel", grip "Hide window"); S27.08 mid-run. */
  hide(): Promise<IpcResult<void>>
  /**
   * S10.09: back from `hidden` to `lastMode`. The first open after a launch or a tray-only start opens in "Mode at
   * launch" instead (S10.01, S10.13; `launchMode`).
   */
  restore(): Promise<IpcResult<void>>
  /**
   * "Mode at launch" resolved (S10.01, S10.12, S10.13; ADR-034 item 2): the pinned mode, or `lastMode` with "Last
   * used"; a stored mode this build does not ship is the Panel.
   */
  launchMode(): AppMode
  /** The global shortcut: restore when hidden or hiding, else hide. */
  toggle(): Promise<IpcResult<void>>
  /** A click or a key on a mode window that is not a mode request (S27.09: ignored during a run). */
  input(): void
  /** `DwarfDeparted` (S27.11), with its cause when the caller knows it (S9.08). */
  departed(dwarfId: DwarfId, cause?: DepartureCause): void
  /** S27.10 with S10.14 (last window closed) or S10.15 (tray Quit). */
  closed(kind: 'windows-closed' | 'quit'): void
  /** S10.16: the Host closed cleanly. */
  hostClosed(): Outcome<void, 'not-listed'>
  /** S27.12, S10.17. */
  crashed(): void
  /** The mode shown: the source while a run plays. */
  mode(): WindowMode
  /** The modes a mode control may offer (BR-19). */
  offered(): AppMode[]
  /** Machine 10: the rung and the last S10 id taken (`null` before any). */
  ladder(): { state: LadderState; lastId: string | null }
  /** Machine 9: the chat the last run carried and where it stands; `null` when no run carried one. */
  handoff(): ChatHandoffNode | null
}

const OK: IpcResult<void> = { ok: true, value: undefined }
const failed = (message: string): IpcResult<void> => ({
  ok: false,
  error: { code: 'INTERNAL', message, retryable: false }
})

type Answer = (r: IpcResult<void>) => void
/** A caller of a held reveal: settled with the reveal's outcome, or with its failure. */
type RevealAnswer = { resolve: (r: RevealOutcome) => void; reject: (error: unknown) => void }

/** A move waiting for its run: the request and every caller it answers. */
interface Request {
  mode: WindowMode
  chat?: { dwarfId: DwarfId; mineId: MineId }
  answers: Answer[]
  /** From `tray-only`: S10.12 or S10.13. */
  open?: { reveal: boolean }
}

export function createModeCoordinator(deps: ModeCoordinatorDeps): ModeCoordinator {
  const { windows, timing, built, revealer, log } = deps
  const modes: readonly WindowMode[] = [...built, 'hidden']
  let node: ModeTransitionNode = {
    state: 'settled',
    mode: deps.start === 'tray-only' ? 'hidden' : deps.start
  }
  let ladder: { state: LadderState; lastId: string | null } = {
    state: deps.start,
    lastId: null
  }
  /** The request the running run carries, and its watchdog. */
  let current: { request: Request; cancelWatchdog: () => void } | null = null
  /** S27.09: the held request, the last one winning. */
  let held: Request | null = null
  /** S27.14: the held reveal, the latest one winning, with every caller it answers. */
  let heldReveal: {
    t: { mineId: MineId; dwarfId: DwarfId }
    answers: RevealAnswer[]
  } | null = null
  let revealCount = 0
  /** Whether the windows were told a run's motion is playing (NFR-PERF-02), so each start gets one end. */
  let playingTold = false
  /** Machine 9: the chat the last run carried (07 S9.01–S9.09), or `null` when it carried none. */
  let handoff: ChatHandoffNode | null = null
  /**
   * Whether no mode was shown since UI main started on no window (S10.01 a launch builds the Panel hidden; S10.03 a
   * login start is tray-only): the next open is the launch's, so "Mode at launch" decides it, not `lastMode`.
   */
  let firstOpen = deps.start === 'hidden' || deps.start === 'tray-only'

  /** Steps the carried chat's machine 9; an event 07 does not list for it leaves it where it is. */
  function stepHandoff(event: ChatHandoffEvent): void {
    if (handoff === null) return
    const next = nextChatHandoff(handoff, event)
    if (next.ok) handoff = next.value.to
  }

  function tellPlaying(playing: boolean): void {
    if (playingTold === playing) return
    playingTold = playing
    deps.onRunChanged?.(playing)
  }
  /** The mode windows a run has shown so far (and the one UI main started on): the ones a close hides. */
  const opened = new Set<AppMode>(
    deps.start === 'tray-only' || deps.start === 'hidden' ? [] : [deps.start]
  )

  function step(event: ModeTransitionEvent): boolean {
    const next = nextModeTransition(node, event, modes)
    if (!next.ok) return false
    node = next.value.to
    return true
  }

  function climb(event: WindowLadderEvent): void {
    const next = nextWindowLadder(ladder.state, event, built)
    if (next.ok) ladder = { state: next.value.to, lastId: next.value.id }
  }

  function stateOf(): ModeTransitionNode['state'] {
    return node.state
  }

  function running(): boolean {
    return node.state === 'preparing' || node.state === 'playing' || node.state === 'completing'
  }

  function shown(): WindowMode {
    if (node.state === 'settled') return node.mode
    if (node.state === 'preparing' || node.state === 'playing' || node.state === 'completing') {
      return node.run.from
    }
    return 'hidden'
  }

  function windowOf(mode: WindowMode): ModeWindow | null {
    if (mode === 'hidden') return null
    const window = windows.window(mode)
    opened.add(mode)
    return window
  }

  /** Moves the ladder for a run that landed in `to`. */
  function climbTo(request: Request): void {
    if (ladder.state === 'not-running' && request.mode !== 'hidden') {
      // S10.01: the first window after a crash opens as a launch does.
      climb({ type: 'launch', mode: request.mode })
    } else if (request.open !== undefined && request.mode !== 'hidden') {
      climb({ type: 'open', to: request.mode, reveal: request.open.reveal })
    } else climb({ type: 'move', to: request.mode })
  }

  /** `window.transition-failed` (19 §9.6): `msg` is the source and the target mode, never an error's text. */
  function logFailed(from: WindowMode, to: WindowMode): void {
    log.record({
      level: 'warn',
      event: 'window.transition-failed',
      subsystem: 'window',
      msg: `${from}->${to}`
    })
  }

  /** Runs one window action of a run; a window that throws is logged and the run goes on to settle. */
  function safely(from: WindowMode, to: WindowMode, act: () => void): void {
    try {
      act()
    } catch {
      logFailed(from, to)
    }
  }

  /** S27.03/S27.04/S27.06/S27.11 → S27.05: hide the source, focus the target, write `lastMode`, settle. */
  function land(from: WindowMode, to: WindowMode): void {
    const request = current?.request
    current?.cancelWatchdog()
    current = null
    tellPlaying(false)
    // Every path settles: a window that throws here is logged, never left holding the machine in `playing`.
    safely(from, to, () => windowOf(from)?.hide())
    safely(from, to, () => windowOf(to)?.focus())
    if (to !== 'hidden') safely(from, to, () => deps.lastMode.set('lastMode', to))
    if (to !== 'hidden') firstOpen = false
    if (node.state === 'completing') step({ type: 'landed' })
    if (request !== undefined) {
      climbTo(request)
      for (const answer of request.answers) answer(OK)
    }
    afterSettle()
  }

  /** S27.14 then S27.09: the held reveal in the mode now shown, then the held request as its own run. */
  function afterSettle(): void {
    // The domain's copies of what is held are taken here, with the requests themselves.
    if (node.state === 'settled') node = { state: 'settled', mode: node.mode }
    const reveal = heldReveal
    heldReveal = null
    if (reveal !== null) replay(reveal)
    const next = held
    held = null
    if (next !== null) begin(next)
  }

  /** Runs a held reveal and settles every caller it answers with its outcome or its failure. */
  function replay(reveal: {
    t: { mineId: MineId; dwarfId: DwarfId }
    answers: RevealAnswer[]
  }): void {
    let revealing: Promise<RevealOutcome>
    try {
      revealing = revealer.revealDwarfChat(reveal.t)
    } catch (error) {
      revealing = Promise.reject(error)
    }
    revealing.then(
      (outcome) => {
        for (const answer of reveal.answers) answer.resolve(outcome)
      },
      (error: unknown) => {
        for (const answer of reveal.answers) answer.reject(error)
      }
    )
  }

  function begin(request: Request): void {
    const from = shown()
    const transitionId = deps.newTransitionId()
    const moved = nextModeTransition(
      node,
      { type: 'move', mode: request.mode, transitionId },
      modes
    )
    if (!moved.ok) {
      // Already shown (a held request for the mode then shown settles at once, S27.09), or not built.
      const answer: IpcResult<void> =
        moved.error === 'already-shown'
          ? OK
          : {
              ok: false,
              error: {
                code: 'INTERNAL',
                message: `${request.mode} is not built`,
                retryable: false
              }
            }
      for (const a of request.answers) a(answer)
      return
    }
    node = moved.value.to
    const to = request.mode
    // S9.01: a mode control with an open chat; the run's own guard already held (the target mode is built).
    handoff = request.chat === undefined ? null : startChatHandoff({ ...request.chat }, from)
    stepHandoff({ type: 'mode-control', to, built: true })
    let target: ModeWindow | null
    try {
      // ADR-025 item 3 step 1: at the final bounds, then shown inactive; never placed again until the run lands.
      target = windowOf(to)
      if (target !== null && to !== 'hidden') {
        target.placeAt(windows.bounds(to))
        target.showInactive()
      }
    } catch {
      targetFailed(request, from, to, null)
      return
    }
    const t0 = timing.now() + MODE_T0_LEAD_MS
    const base: Omit<ModeTransition, 'role'> = { transitionId, from, to, t0 }
    if (request.chat !== undefined) base.chat = request.chat
    try {
      windowOf(from)?.send(MODE_TRANSITION_PUSH, {
        ...base,
        role: 'source'
      } satisfies ModeTransition)
      target?.send(MODE_TRANSITION_PUSH, { ...base, role: 'target' } satisfies ModeTransition)
    } catch {
      // A window that cannot be told the run cannot play it: the target is put away again (S27.07).
      targetFailed(request, from, to, target)
      return
    }
    current = { request, cancelWatchdog: () => {} }
    if (deps.reducedMotion()) {
      // S27.06: durations 0 ms, the same state transfer (S9.05).
      stepHandoff({ type: 'reduced-motion' })
      step({ type: 'reduced-motion' })
      land(from, to)
      return
    }
    // S9.02: the source was told the run before `t0` and flushes the chat on receipt.
    stepHandoff({ type: 'flushed' })
    step({ type: 'prepared' })
    tellPlaying(true)
    const run = current
    run.cancelWatchdog = timing.after(
      MODE_T0_LEAD_MS + MODE_MOTION_MS + MODE_WATCHDOG_MARGIN_MS,
      () => {
        if (current === run && step({ type: 'watchdog' })) {
          stepHandoff({ type: 'watchdog' })
          land(from, to)
        }
      }
    )
    // An end with no window has nothing to play: its answer is the coordinator's own.
    if (from === 'hidden') answerDone('source')
    if (to === 'hidden') answerDone('target')
  }

  /** S27.07, FM-046: the source mode stays; the details go to the log only (14 §1.5); a held request then runs. */
  function targetFailed(
    request: Request,
    from: WindowMode,
    to: WindowMode,
    shownTarget: ModeWindow | null
  ): void {
    if (shownTarget !== null) safely(from, to, () => shownTarget.hide())
    // S9.06: the chat stays in the source; nothing is written.
    stepHandoff({ type: 'target-failed' })
    step({ type: 'target-failed' })
    logFailed(from, to)
    for (const answer of request.answers) answer(failed('the mode window could not be shown'))
    afterSettle()
  }

  function answerDone(role: 'source' | 'target'): void {
    if (node.state !== 'playing') return
    const { from, to } = node.run
    // `step` moves `node`: read its state again once it ran.
    if (step({ type: 'done', role }) && stateOf() === 'completing') {
      stepHandoff({ type: 'done' })
      land(from, to)
    }
  }

  function request(r: Request): Promise<IpcResult<void>> {
    return new Promise((resolve) => {
      r.answers.push(resolve)
      if (r.mode !== 'hidden' && !built.includes(r.mode)) {
        resolve({
          ok: false,
          error: { code: 'INTERNAL', message: `${r.mode} is not built`, retryable: false }
        })
        return
      }
      if (running()) {
        // S27.09: held, never dropped; a later request replaces an earlier held one, whose callers it answers.
        step({ type: 'move', mode: r.mode, transitionId: 'held' })
        if (held !== null) r.answers.unshift(...held.answers)
        held = r
        return
      }
      begin(r)
    })
  }

  function chatOf(p: MoveToModeParams): Request['chat'] {
    return p.mineId !== undefined && p.dwarfId !== undefined
      ? { dwarfId: p.dwarfId, mineId: p.mineId }
      : undefined
  }

  function lastShown(): AppMode {
    const stored = deps.lastMode.get('lastMode')
    return built.includes(stored) ? stored : 'panel'
  }

  /** "Mode at launch" (US-SET-002.AC09): the pinned mode if built, else the Panel; "Last used" is `lastShown`. */
  function launchMode(): AppMode {
    const pinned = deps.lastMode.get('modeAtLaunch')
    if (pinned === 'last-used') return lastShown()
    return built.includes(pinned) ? pinned : 'panel'
  }

  function hide(): Promise<IpcResult<void>> {
    if (node.state === 'playing') {
      // S27.08: the run resolves at once, hidden; `lastMode` is the target, so restoring shows it.
      const { from, to } = node.run
      const carried = current?.request
      current?.cancelWatchdog()
      current = null
      step({ type: 'hidden' })
      stepHandoff({ type: 'hidden' })
      tellPlaying(false)
      safely(from, to, () => windowOf(from)?.hide())
      safely(from, to, () => windowOf(to)?.hide())
      if (to !== 'hidden') safely(from, to, () => deps.lastMode.set('lastMode', to))
      climb({ type: 'move', to: 'hidden' })
      for (const answer of carried?.answers ?? []) answer(OK)
      afterSettle()
      return Promise.resolve(OK)
    }
    return request({ mode: 'hidden', answers: [] })
  }

  /**
   * A hide the coordinator did not run (macOS Cmd+H, `app.hide()`) leaves the mode window off screen while the model
   * still shows it: read the window back, and take it as hidden (S10.08) before deciding a press.
   */
  function reconcile(): void {
    if (node.state !== 'settled' || node.mode === 'hidden' || windows.isShown(node.mode)) return
    node = { state: 'settled', mode: 'hidden' }
    climb({ type: 'move', to: 'hidden' })
  }

  function restore(): Promise<IpcResult<void>> {
    const now = shown()
    if (!running() && now !== 'hidden') {
      // S10.02: the mode is shown; the request is to see it, so it comes forward, un-minimized. Not a run.
      windows.bringForward(now)
      return Promise.resolve(OK)
    }
    // From tray-only the window opens as a launch does (S10.13). The first open after a launch or a tray-only start is
    // in "Mode at launch" (S10.01, S10.13); after that, back from hidden is `lastMode` (S10.09).
    const fromTray = ladder.state === 'tray-only'
    const open = fromTray ? { open: { reveal: false } } : {}
    const mode = firstOpen || fromTray ? launchMode() : lastShown()
    return request({ mode, answers: [], ...open })
  }

  return {
    moveToMode(p) {
      const r: Request = { mode: p.mode, answers: [] }
      const chat = chatOf(p)
      if (chat !== undefined) r.chat = chat
      return request(r)
    },
    transitionDone(sender, p) {
      if (node.state !== 'playing' || node.run.transitionId !== p.transitionId) return
      const role = sender === node.run.from ? 'source' : sender === node.run.to ? 'target' : null
      if (role !== null) answerDone(role)
    },
    revealDwarfChat(t) {
      if (!running()) return revealer.revealDwarfChat(t)
      return new Promise((resolve, reject) => {
        revealCount += 1
        step({ type: 'reveal', revealId: revealCount })
        const answers = [...(heldReveal?.answers ?? []), { resolve, reject }]
        heldReveal = { t, answers }
      })
    },
    async revealAtLaunch(mode, t) {
      await request({ mode, answers: [], open: { reveal: true } })
      return revealer.revealDwarfChat(t)
    },
    openAtLaunch(mode, reason = { reveal: false }) {
      return request({ mode, answers: [], open: reason })
    },
    hide,
    restore,
    launchMode,
    toggle() {
      // During a run the press asks for the opposite of where the run is going (S27.08 when it is going to a mode).
      if (node.state === 'preparing' || node.state === 'playing' || node.state === 'completing') {
        return node.run.to === 'hidden' ? restore() : hide()
      }
      reconcile()
      return shown() === 'hidden' ? restore() : hide()
    },
    input() {
      // S27.09: a click or a key that is not a mode request is ignored during a run, never queued.
      if (running()) step({ type: 'input' })
    },
    departed(dwarfId, cause) {
      if (node.state !== 'preparing' && node.state !== 'playing') return
      if (current?.request.chat?.dwarfId !== dwarfId) return
      const { from, to } = node.run
      if (step({ type: 'departed' })) {
        // S9.08: read-only or closed by cause in the target, which also hears the departure itself.
        stepHandoff(cause === undefined ? { type: 'departed' } : { type: 'departed', cause })
        land(from, to)
      }
    },
    closed(kind) {
      // S27.10: every window closes; `lastMode` keeps what it is (written only at S27.03).
      current?.cancelWatchdog()
      const pending = [...(current?.request.answers ?? []), ...(held?.answers ?? [])]
      current = null
      held = null
      tellPlaying(false)
      step({ type: 'closed' })
      for (const mode of opened) windows.window(mode).hide()
      node = { state: 'settled', mode: 'hidden' }
      climb({ type: kind === 'quit' ? 'quit' : 'windows-closed' })
      for (const answer of pending) answer(failed('the mode windows closed'))
      const reveal = heldReveal
      heldReveal = null
      if (reveal === null) return
      if (kind === 'quit') {
        // Quit closes the app for the person (S10.15): a click held mid-run reopens nothing.
        const dropped = new Error('the app quit before the reveal could run')
        for (const answer of reveal.answers) answer.reject(dropped)
        return
      }
      // The last window closed (S10.14): the click still opens the app, per "Mode at launch" (S10.12).
      replay(reveal)
    },
    hostClosed() {
      const next = nextWindowLadder(ladder.state, { type: 'host-closed' }, built)
      if (!next.ok) return { ok: false, error: 'not-listed' }
      ladder = { state: next.value.to, lastId: next.value.id }
      return { ok: true, value: undefined }
    },
    crashed() {
      // S27.12, S10.17: whatever ran is lost; the machine starts again from no window, so a later move recovers.
      current?.cancelWatchdog()
      const pending = [...(current?.request.answers ?? []), ...(held?.answers ?? [])]
      current = null
      held = null
      tellPlaying(false)
      step({ type: 'crashed' })
      // S10.01: the first window after a crash opens as a launch does.
      firstOpen = true
      // S9.09: drafts and view state are lost with the UI process, and nothing else.
      stepHandoff({ type: 'crashed' })
      node = { state: 'settled', mode: 'hidden' }
      climb({ type: 'crashed' })
      for (const answer of pending) answer(failed('the UI process crashed'))
      const reveal = heldReveal
      heldReveal = null
      const lost = new Error('the UI process crashed before the reveal could run')
      for (const answer of reveal?.answers ?? []) answer.reject(lost)
    },
    mode: shown,
    offered: () => [...built],
    ladder: () => ({ ...ladder }),
    handoff: () => (handoff === null ? null : { ...handoff })
  }
}
