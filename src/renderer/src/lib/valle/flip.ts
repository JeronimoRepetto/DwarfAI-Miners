/*
 * Valle's dive, climb and swap motion (07 machine 28 `diving`, `climbing`, `front-swapping`; NFR-TIM-11, NFR-TIM-16,
 * NFR-PERF-01; `DS/docs/motion.md` "Dive in", "Climb out", "Work front, another mine" and their choreography; ISSUE-301).
 *
 * - FLIP: the stage measures the mine's parts where they stand, the layout changes at once, and each part plays from
 *   where it was to where it is: the plates translate and scale from their corner, the title and the roster translate
 *   by their corner, the painting by its centre, keeping its size. Only `transform` and `opacity` ever animate.
 * - Frozen copies: what leaves (the other columns and the stack on a dive, the list and the deck on a climb, the old
 *   mine on a swap) is cloned into `.dm-vghosts` over the stage at its own place, plays its exit, and is removed when the
 *   run ends. The columns' copies are clipped to the mosaic.
 * - A mine outside the mosaic rises from 8 px below on a dive and sinks 8 px fading on the climb; the mosaic's saved
 *   scroll comes back at 0 ms of the climb, before the column is measured.
 * - The run (`startValleRun`): it ends on the first of its own duration on the frame clock, a watchdog at that duration
 *   plus 40 ms (an occluded window's frames stop), or the caller resolving it when the window hides (S28.22).
 * - The input gate (`createInputGate`): while a dive or a climb runs, every press and key inside Valle is stopped before
 *   it reaches its target, never queued; a mode control ("▼ Panel", "▼ Veta") passes, for the machine to hold.
 * - Reduced motion: every duration token reads 0 ms, so the switch lands in one frame with nothing played; the climb
 *   still restores the scroll.
 *
 * The DOM, the clock, the geometry and the animation runner are injected; the Valle root composes the browser's.
 */
import type { MineId } from '@dwarfai/contracts'

/** The motion running in Valle (07 machine 28 states). */
export type ValleMotionKind = 'diving' | 'climbing' | 'front-swapping'

/** The timings and travels of the motion table (`DS/docs/motion.md`, Choreography). */
export const VALLE_MOTION = {
  /** M, 1.5 × `--dur-panel`. */
  m: 270,
  /** Input waits, and the frozen copies stay, until M + 60 ms: the dive's and the climb's input row. */
  run: 330,
  /** The climb's leavers, 0.7 × M. */
  climbLeavers: 189,
  /** "Work front, another mine", `--dur-panel`. */
  swap: 180,
  /** Every motion's watchdog fires at its own duration plus this margin (the bounded runner). */
  watchdogMargin: 40,
  /** The other columns' frozen copies slide this far away from the chosen column. */
  slide: 72,
  /** A mine outside the mosaic rises from, and sinks to, this far below; the stack's copy sinks as far. */
  rise: 8,
  /** The new mine of a swap rises from this far below. */
  swapRise: 6,
  /** The compact mines list enters from, and leaves to, this far left. */
  list: 24,
  /** The chat deck enters from, and leaves to, this far below. */
  deck: 8,
  /** "Held until eased progress p": each part's hold. */
  hold: { list: 0.25, deck: 0.3, tools: 0.45, columns: 0.2, stack: 0.3 },
  easeOut: 'cubic-bezier(0.2, 0.7, 0.1, 1)',
  easeIn: 'cubic-bezier(0.5, 0, 0.9, 0.3)'
} as const

/** A run's own duration; 0 under reduced motion, where every duration token reads 0 ms. */
export function valleRunMs(kind: ValleMotionKind, reduced: boolean): number {
  if (reduced) return 0
  return kind === 'front-swapping' ? VALLE_MOTION.swap : VALLE_MOTION.run
}

/** A rectangle as the browser measures one. */
export interface ValleBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export type ValleFrames = readonly Keyframe[]

/** The clock a run reads: animation frames, and timers for its watchdog. */
export interface ValleClock {
  frame(run: (now: number) => void): unknown
  cancelFrame(handle: unknown): void
  now(): number
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** The browser's clock: `requestAnimationFrame` on `performance.now()`, and its timers. */
export const BROWSER_CLOCK: ValleClock = {
  frame: (run) => requestAnimationFrame(run),
  cancelFrame: (handle) => {
    cancelAnimationFrame(handle as number)
  },
  now: () => performance.now(),
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export interface ValleRun {
  /** Ends the run without calling its end (resolved by another route). */
  stop(): void
}

/** Runs for `ms` on the frame clock, then calls `end` once; a watchdog at `ms` + 40 ms ends a run whose frames stopped. */
export function startValleRun(clock: ValleClock, ms: number, end: () => void): ValleRun {
  const start = clock.now()
  let done = false
  let frame: unknown = null
  let watchdog: unknown = null
  const stop = (): void => {
    done = true
    if (frame !== null) clock.cancelFrame(frame)
    if (watchdog !== null) clock.clear(watchdog)
  }
  const finish = (): void => {
    if (done) return
    stop()
    end()
  }
  const tick = (now: number): void => {
    frame = null
    if (done) return
    if (now - start >= ms) finish()
    else frame = clock.frame(tick)
  }
  frame = clock.frame(tick)
  watchdog = clock.set(() => {
    watchdog = null
    finish()
  }, ms + VALLE_MOTION.watchdogMargin)
  return { stop }
}

/** A motion the stage plays: which, on which mine, and whether that mine has a column in the mosaic. */
export interface ValleStageMotion {
  readonly kind: ValleMotionKind
  readonly mineId: MineId | null
  readonly inMosaic: boolean
}

export interface ValleAnimationTiming {
  readonly duration: number
  readonly easing: string
  /** `backwards` for an entry, `forwards` for an exit that holds its last frame. */
  readonly fill: FillMode
}

export interface ValleStageDeps {
  /** The Valle root, the stage the frozen copies are placed over. */
  root(): HTMLElement | null
  box(element: Element): ValleBox
  animate(element: Element, frames: ValleFrames, timing: ValleAnimationTiming): void
  /** Ends every animation the stage started, at once. */
  cancel(): void
  /** Runs once the new layout is rendered. */
  afterRender(run: () => void): void
  reduced(): boolean
  /** Sets the mosaic's sideways scroll. */
  scroll(element: HTMLElement, left: number): void
}

export interface ValleStage {
  /** Measures what is shown, then plays `motion` once the new layout is rendered. */
  play(motion: ValleStageMotion, scrollLeft: number): void
  /** The mosaic's scroll restored at once, with no motion (S28.23). */
  restoreScroll(scrollLeft: number): void
  /** Ends the motion: the copies removed, every animation ended. */
  end(): void
}

const CORNER = '0 0'
const CENTRE = '50% 50%'
const translate = (dx: number, dy: number): string => `translate(${dx}px, ${dy}px)`

/** The parts of a mine's zone FLIP moves, by how each one travels (`DS/docs/motion.md`, Dive in). */
const PARTS: readonly {
  readonly selector: string
  readonly kind: 'plate' | 'corner' | 'centre'
}[] = [
  { selector: '.dm-vz__bg', kind: 'plate' },
  { selector: '.dm-vz__ring', kind: 'plate' },
  { selector: '.dm-vz__barbg', kind: 'plate' },
  { selector: '.dm-vz__footbg', kind: 'plate' },
  { selector: '.dm-vz__title', kind: 'corner' },
  { selector: '.dm-vz__roster', kind: 'corner' },
  { selector: '.dm-vz__well', kind: 'centre' },
  { selector: '.dm-vz__other', kind: 'centre' }
]

/** The loops a frozen copy holds where they stood (`DS/docs/motion.md`, frozen copy). */
const LOOPS = '.dm-sprite__strip, .dm-dwarf__ask, .dm-dwarf__z, .dm-portrait__mark'

/** A plate: translate and scale from its top-left corner, from the box it had to the box it has. */
function plateFrames(first: ValleBox, last: ValleBox): ValleFrames {
  const sx = last.width === 0 ? 1 : first.width / last.width
  const sy = last.height === 0 ? 1 : first.height / last.height
  const from = `${translate(first.left - last.left, first.top - last.top)} scale(${sx}, ${sy})`
  return [
    { transform: from, transformOrigin: CORNER },
    { transform: 'none', transformOrigin: CORNER }
  ]
}

/** The title or the roster: translate by the top-left corner, never scaled. */
function cornerFrames(first: ValleBox, last: ValleBox): ValleFrames {
  return [
    { transform: translate(first.left - last.left, first.top - last.top), transformOrigin: CORNER },
    { transform: 'none', transformOrigin: CORNER }
  ]
}

/**
 * The painting: translate by its centre, keeping its size; scaled by one factor about its centre only when its height
 * changed by more than 0.2 % (the columns' scrollbar sliver), so it never changes its aspect ratio.
 */
function centreFrames(first: ValleBox, last: ValleBox): ValleFrames {
  const dx = first.left + first.width / 2 - (last.left + last.width / 2)
  const dy = first.top + first.height / 2 - (last.top + last.height / 2)
  const ratio = last.height === 0 ? 1 : first.height / last.height
  const scale = Math.abs(ratio - 1) > 0.002 ? ` scale(${ratio})` : ''
  return [
    { transform: `${translate(dx, dy)}${scale}`, transformOrigin: CENTRE },
    { transform: 'none', transformOrigin: CENTRE }
  ]
}

/** An entry held at 0 at `from` until eased progress `hold`, then arriving. */
function heldEntry(from: string, hold: number): ValleFrames {
  return [
    { transform: from, opacity: 0, transformOrigin: CENTRE },
    { offset: hold, transform: from, opacity: 0, transformOrigin: CENTRE },
    { transform: 'none', opacity: 1, transformOrigin: CENTRE }
  ]
}

/** The tools fading in late, already in their place. */
const TOOLS_FRAMES: ValleFrames = [
  { opacity: 0, transformOrigin: CENTRE },
  { offset: VALLE_MOTION.hold.tools, opacity: 0, transformOrigin: CENTRE },
  { opacity: 1, transformOrigin: CENTRE }
]

/** An exit travelling to (dx, dy) as it fades out. */
const exitTo = (dx: number, dy: number): ValleFrames => [
  { transform: translate(0, 0), opacity: 1, transformOrigin: CENTRE },
  { transform: translate(dx, dy), opacity: 0, transformOrigin: CENTRE }
]

/** An entry rising from `dy` below as it fades in. */
const riseFrom = (dy: number): ValleFrames => [
  { transform: translate(0, dy), opacity: 0, transformOrigin: CENTRE },
  { transform: 'none', opacity: 1, transformOrigin: CENTRE }
]

const FADE_OUT: ValleFrames = [
  { opacity: 1, transformOrigin: CENTRE },
  { opacity: 0, transformOrigin: CENTRE }
]

export function createValleStage(deps: ValleStageDeps): ValleStage {
  const { m, easeIn, easeOut } = VALLE_MOTION
  const entry = (duration: number): ValleAnimationTiming => ({
    duration,
    easing: easeOut,
    fill: 'backwards'
  })
  const exit = (duration: number): ValleAnimationTiming => ({
    duration,
    easing: easeIn,
    fill: 'forwards'
  })

  /** The live elements matching `selector`: never a frozen copy or anything inside one. */
  function live(root: HTMLElement, selector: string): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(selector)].filter(
      (element) => element.closest('.dm-vghosts') === null
    )
  }

  function layer(root: HTMLElement): HTMLElement {
    const found = root.querySelector<HTMLElement>('.dm-vghosts')
    if (found !== null) return found
    const made = document.createElement('div')
    made.className = 'dm-vghosts'
    made.setAttribute('aria-hidden', 'true')
    root.append(made)
    return made
  }

  /** `box` placed relative to `origin`. */
  function place(element: HTMLElement, box: ValleBox, origin: ValleBox): void {
    Object.assign(element.style, {
      position: 'absolute',
      left: `${box.left - origin.left}px`,
      top: `${box.top - origin.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      margin: '0'
    })
  }

  /** A frozen copy of `element` in `into`, at the element's own place measured from `origin`. */
  function copyOf(element: HTMLElement, into: HTMLElement, origin: ValleBox): HTMLElement {
    const copy = element.cloneNode(true) as HTMLElement
    copy.classList.add('is-ghost')
    copy.removeAttribute('id')
    copy.setAttribute('inert', '')
    for (const inner of copy.querySelectorAll('[id]')) inner.removeAttribute('id')
    for (const loop of copy.querySelectorAll<HTMLElement>(LOOPS)) {
      loop.style.animationPlayState = 'paused'
    }
    const column = copy.getAttribute('data-valle-column')
    if (column !== null) {
      copy.removeAttribute('data-valle-column')
      copy.setAttribute('data-ghost', column)
    }
    place(copy, deps.box(element), origin)
    into.append(copy)
    return copy
  }

  type Measured = Map<string, { kind: 'plate' | 'corner' | 'centre'; box: ValleBox }>

  function measure(zone: Element): Measured {
    const measured: Measured = new Map()
    for (const part of PARTS) {
      const element = zone.querySelector(part.selector)
      if (element !== null) measured.set(part.selector, { kind: part.kind, box: deps.box(element) })
    }
    return measured
  }

  /** Each part measured in the old zone plays from there to where it stands in `zone`. */
  function flip(first: Measured, zone: Element): void {
    for (const [selector, { kind, box }] of first) {
      const element = zone.querySelector(selector)
      if (element === null) continue
      const last = deps.box(element)
      const frames =
        kind === 'plate'
          ? plateFrames(box, last)
          : kind === 'corner'
            ? cornerFrames(box, last)
            : centreFrames(box, last)
      deps.animate(element, frames, entry(m))
    }
  }

  function tools(zone: Element): void {
    const group = zone.querySelector('.dm-vz__tools')
    if (group !== null) deps.animate(group, TOOLS_FRAMES, entry(m))
  }

  const columnSelector = (mineId: MineId | null): string =>
    mineId === null ? '[data-valle-column=""]' : `[data-valle-column="${mineId}"]`
  const frontSelector = (mineId: MineId | null): string =>
    mineId === null ? '[data-valle-front-mine]' : `[data-valle-front-mine="${mineId}"]`
  const OTHERS = '[data-valle-column], [data-valle-add-slot]'

  function dive(root: HTMLElement, motion: ValleStageMotion): void {
    const ghosts = layer(root)
    const origin = deps.box(root)
    const chosen = motion.inMosaic ? (live(root, columnSelector(motion.mineId))[0] ?? null) : null
    const first = chosen === null ? null : measure(chosen)
    const chosenBox = chosen === null ? null : deps.box(chosen)
    const leaving: [HTMLElement, number][] = []
    const mosaic = live(root, '[data-valle-mosaic]')[0]
    if (mosaic !== undefined) {
      const clip = document.createElement('div')
      clip.className = 'dm-vghosts__clip'
      const clipBox = deps.box(mosaic)
      place(clip, clipBox, origin)
      clip.style.overflow = 'hidden'
      ghosts.append(clip)
      for (const other of live(root, OTHERS)) {
        if (other === chosen) continue
        const left = chosenBox !== null && deps.box(other).left < chosenBox.left
        leaving.push([
          copyOf(other, clip, clipBox),
          left ? -VALLE_MOTION.slide : VALLE_MOTION.slide
        ])
      }
    }
    const stack = live(root, '.dm-cstack')[0]
    const stackCopy = stack === undefined ? null : copyOf(stack, ghosts, origin)

    deps.afterRender(() => {
      for (const [copy, dx] of leaving) deps.animate(copy, exitTo(dx, 0), exit(m))
      if (stackCopy !== null) deps.animate(stackCopy, exitTo(0, VALLE_MOTION.rise), exit(m))
      const zone = live(root, frontSelector(motion.mineId))[0]
      if (zone !== undefined) {
        if (first !== null) flip(first, zone)
        else deps.animate(zone, riseFrom(VALLE_MOTION.rise), entry(m))
        tools(zone)
      }
      const list = live(root, '.dm-mrows')[0]
      if (list !== undefined) {
        deps.animate(
          list,
          heldEntry(translate(-VALLE_MOTION.list, 0), VALLE_MOTION.hold.list),
          entry(m)
        )
      }
      const deck = live(root, '.dm-cdeck')[0]
      if (deck !== undefined) {
        deps.animate(
          deck,
          heldEntry(translate(0, VALLE_MOTION.deck), VALLE_MOTION.hold.deck),
          entry(m)
        )
      }
    })
  }

  function climb(root: HTMLElement, motion: ValleStageMotion, scrollLeft: number): void {
    const ghosts = layer(root)
    const origin = deps.box(root)
    const front = live(root, frontSelector(motion.mineId))[0]
    const first = motion.inMosaic && front !== undefined ? measure(front) : null
    const leaving: [HTMLElement, number, number][] = []
    const list = live(root, '.dm-mrows')[0]
    if (list !== undefined) leaving.push([copyOf(list, ghosts, origin), -VALLE_MOTION.list, 0])
    const deck = live(root, '.dm-cdeck')[0]
    if (deck !== undefined) leaving.push([copyOf(deck, ghosts, origin), 0, VALLE_MOTION.deck])
    if (!motion.inMosaic && front !== undefined) {
      leaving.push([copyOf(front, ghosts, origin), 0, VALLE_MOTION.rise])
    }

    deps.afterRender(() => {
      // At 0 ms, before the column is measured: the mosaic back at its saved scroll.
      const mosaic = live(root, '[data-valle-mosaic]')[0]
      if (mosaic !== undefined) deps.scroll(mosaic, scrollLeft)
      for (const [copy, dx, dy] of leaving) {
        deps.animate(copy, exitTo(dx, dy), exit(VALLE_MOTION.climbLeavers))
      }
      const chosen = motion.inMosaic ? live(root, columnSelector(motion.mineId))[0] : undefined
      if (chosen !== undefined && first !== null) {
        flip(first, chosen)
        tools(chosen)
      }
      const chosenBox = chosen === undefined ? null : deps.box(chosen)
      for (const other of live(root, OTHERS)) {
        if (other === chosen) continue
        const left = chosenBox !== null && deps.box(other).left < chosenBox.left
        const dx = left ? -VALLE_MOTION.slide : VALLE_MOTION.slide
        deps.animate(other, heldEntry(translate(dx, 0), VALLE_MOTION.hold.columns), entry(m))
      }
      const stack = live(root, '.dm-cstack')[0]
      if (stack !== undefined) {
        deps.animate(
          stack,
          heldEntry(translate(0, VALLE_MOTION.rise), VALLE_MOTION.hold.stack),
          entry(m)
        )
      }
    })
  }

  function swap(root: HTMLElement, motion: ValleStageMotion): void {
    const old = live(root, '[data-valle-front-mine]')[0]
    const copy = old === undefined ? null : copyOf(old, layer(root), deps.box(root))
    deps.afterRender(() => {
      if (copy !== null) deps.animate(copy, FADE_OUT, exit(VALLE_MOTION.swap))
      const zone = live(root, frontSelector(motion.mineId))[0]
      if (zone !== undefined) {
        deps.animate(zone, riseFrom(VALLE_MOTION.swapRise), entry(VALLE_MOTION.swap))
      }
    })
  }

  function restore(root: HTMLElement, scrollLeft: number): void {
    deps.afterRender(() => {
      const mosaic = live(root, '[data-valle-mosaic]')[0]
      if (mosaic !== undefined) deps.scroll(mosaic, scrollLeft)
    })
  }

  /** A motion was played and not ended yet. */
  let playing = false
  function end(): void {
    playing = false
    deps.cancel()
    deps.root()?.querySelector('.dm-vghosts')?.replaceChildren()
  }

  return {
    play(motion, scrollLeft) {
      const root = deps.root()
      if (root === null) return
      if (playing) end()
      playing = true
      if (deps.reduced()) {
        if (motion.kind === 'climbing') restore(root, scrollLeft)
        return
      }
      if (motion.kind === 'diving') dive(root, motion)
      else if (motion.kind === 'climbing') climb(root, motion, scrollLeft)
      else swap(root, motion)
    },
    restoreScroll(scrollLeft) {
      const root = deps.root()
      if (root !== null) restore(root, scrollLeft)
    },
    end
  }
}

/** The presses and keys a run ignores. */
const GATED = ['pointerdown', 'mousedown', 'click', 'dblclick', 'auxclick', 'keydown'] as const

/** A mode control: "▼ Panel" or "▼ Veta" in Valle's top bar (S28.21). */
const MODE_CONTROL = '[data-lever]'

/**
 * Ignores every press and key inside `root` while `running`, except on a mode control: each is stopped before it
 * reaches its target, and dropped, never queued (S28.09, S28.14). Answers its removal.
 */
export function createInputGate(root: HTMLElement, running: () => boolean): () => void {
  const stop = (event: Event): void => {
    if (!running()) return
    const target = event.target
    if (target instanceof Element && target.closest(MODE_CONTROL) !== null) return
    event.stopPropagation()
    event.preventDefault()
  }
  for (const type of GATED) root.addEventListener(type, stop, { capture: true })
  return () => {
    for (const type of GATED) root.removeEventListener(type, stop, { capture: true })
  }
}
