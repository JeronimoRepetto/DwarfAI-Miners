import { onBeforeUnmount } from 'vue'
import { getDefaultTransition } from 'motion-v'
import { createBoundedMotion, type MotionAnimate } from '../lib/shell/boundedMotion'
import { panelLeaveBoundMs } from '../lib/shell/panelMotion'
import type { MotionTransition } from '../lib/shell/motionTiming'
import {
  columnFoldKeyframes,
  columnFoldTransform,
  columnFoldClip,
  columnSlideKeyframes,
  foldedColumnOffset,
  foldedShellWidth,
  shellFoldClip,
  shellFoldKeyframes,
  type ShellFoldState
} from '../lib/shell/shellFold'
import type { ShellComposition } from '../lib/shell/composition'
import type { PanelEdge } from '../types'

/**
 * The shell's ground folding into its rail, and unfolding back out of it
 * (#388).
 *
 * ## Why the ground is the animation
 *
 * The window is frameless and transparent, and main moves only its FREE edge:
 * opening adds pixels there, closing takes them away. Until this, the columns
 * animated and the ground did not — it followed main's applied layout — so the
 * pixels the window added or removed were painted at the moment they arrived or
 * went. That single frame is the flicker #388 reports, in both directions.
 *
 * The rule this file exists to keep is therefore one sentence: **the window may
 * only ever add or remove pixels that are already transparent.** Closing folds
 * the ground to what survives BEFORE main shrinks; opening starts the ground
 * clipped to the footprint it had and unfolds into the room main just made.
 *
 * ## What it animates, and what it must not
 *
 * `clip-path` only. It is a compositor property: nothing relayouts, and the
 * MineScene inside — which re-measures its anchors from the box it is given —
 * is not asked a new question sixty times a second. Animating width, height or
 * flex would do exactly that.
 *
 * ## The deadlines are #266's, unchanged
 *
 * A fold is what a shrink now waits on, which makes it the thing that must
 * never fail to report. Chromium freezes the document timeline for a window it
 * considers hidden, so the fold lands on the compositor while `finished` never
 * resolves: the same watchdog bounds it, the same visibility change releases
 * it, and a window that is already hidden takes the instant path and is waited
 * on by nobody. `usePanelLayout` still bounds the wait beyond that.
 *
 * All of that is `lib/shell/boundedMotion` since #389, where the message
 * panel's own window reads it too — three copies of one rule was two too many.
 * What stays here is the only part that is the fold's own: the clip it settles
 * on, written before the animation is let go.
 *
 * ## The window is the second deadline (#464)
 *
 * The fold ending is not the resize happening, and the two were treated as one
 * event. What the fold releases is the REQUEST — the shrink may go out — and
 * three things then wait on main having answered it: the columns, which may not
 * repack the row inside a rectangle that has not changed; the clip, which may
 * not be let go of over a box that is still the width the fold started from;
 * and every carried column's travel, which is the row's own again the moment
 * the row is right. A `resize` listener is the first thing the renderer can
 * observe of the resize itself, and `panelLeaveBoundMs()` is the floor under a
 * window that never answers at all.
 *
 * ## Not only the rail carries (#566 T5b)
 *
 * #464 carried the rail because it is the ONE column that is free of every
 * composition's leaving column — it stands at the free edge of every open
 * composition, so a fold that only narrowed the ground always clipped it away.
 * That is not the only column free of what is leaving: the mine column docks
 * beyond the secondary panel and the navigation stack, so when the mine itself
 * closes or opens, they stand free of IT and have to travel the same way the
 * rail does. `carried`, on `ShellFoldOptions`, is how a caller hands those in;
 * `foldedColumnOffset` (in `shellFold.ts`) is the rail's own formula
 * generalized to answer for any of them.
 *
 * The column that is actually leaving or entering gets its OWN motion now too
 * — not the fade `PanelTransition` used to have before #388 removed it, but a
 * slide the maintainer's own drawing asked for: it travels the same distance
 * the columns free of it do, clipped at its own docked-side edge so the
 * travelling content disappears there rather than painting over the row
 * beside it. `carrySelf`/`placeSelf`, below, are `carry`/`place` with that one
 * difference.
 */
export interface ShellFoldOptions {
  /** The element the amber ground is painted on. */
  shell: () => HTMLElement | null
  /** The docked side, which the fold is mirrored around. */
  edge: () => PanelEdge
  /** The composition presentation is folding TO. */
  remaining: () => ShellComposition
  /**
   * The rail, which travels with the fold (#464).
   *
   * It is the one column standing on the FREE side of EVERY composition's
   * leaving or entering column, so it is the one column that always has to be
   * asked for — `carried`, below, is what changed once the rail stopped
   * being the only one that ever could be. `null` is answered honestly where
   * the component that draws it is not mounted or is not one element: the
   * ground still folds, and only the travel is lost.
   */
  rail: () => HTMLElement | null
  /**
   * Every OTHER column that can stand free of a leaving or entering one,
   * besides the rail — in DOM/row order from the free edge toward the docked
   * one, `null` for one the current composition does not draw (#566 T5b). The
   * secondary panel and the navigation stack are both free of the mine column
   * when IT is what closes or opens beside them; neither is free of anything
   * else, and `begin`/`settle` work that out themselves by walking this list
   * free-to-docked and asking `foldedColumnOffset` for each one's own rest
   * position, the rail's own formula since #464 generalized rather than
   * restated. Optional and defaulted to none, so a caller with nothing beside
   * the rail — a test harness among them — is untouched.
   */
  carried?: () => (HTMLElement | null)[]
  /**
   * The engine `createBoundedMotion` runs, for a test to hand in a
   * hand-written fake — production never sets this, and gets the real
   * motion-v import (#566).
   */
  engine?: MotionAnimate
}

/**
 * The two moments a leaving column waits on, which used to be one (#464).
 *
 * They are different events and telling them apart is the whole of the fix. The
 * fold ending is what a shrink waits for, and it has to be: main cannot be
 * asked to resize by something that is waiting for it to have. The window
 * having caught up is what may finally unmount the column — `.shell-secondary`
 * is `flex: 1`, so letting it go on the fold repacked the row while the
 * rectangle around it had not changed, and every frame until main's reply
 * landed was the fold's strip painted over bare ground.
 */
export interface ShellFoldHold {
  /** The ground has finished folding. */
  folded: Promise<void>
  /** Main has applied the bounds it was folded for, or the bound has elapsed. */
  released: Promise<void>
}

export function useShellFold(options: ShellFoldOptions) {
  const motion = createBoundedMotion({ animate: options.engine })

  /**
   * How much of the shell was painted when it last settled.
   *
   * `null` until something has been measured. It is NOT always the shell's own
   * box: the collapsed shell paints no ground, so after a fold to the rail this
   * is the design's 20px strip inside a 32px window — which is the footprint
   * the next opening has to unfold from.
   */
  let painted: number | null = null

  /**
   * The shell's OWN width when it last settled, which is not `painted`.
   *
   * What decides an unfold: the window growing, never the ground being narrower
   * than the box around it. The collapsed shell is the second of those, where
   * the platform holds a floor above the design's 20px rail — Windows does, and
   * since #465 only Windows does (`minWindowWidth` in
   * main/platform/windowMetrics.ts) — and reading that gap as room to unfold
   * into would start an animation on every request that changed nothing. Where
   * the floor IS the rail the gap is zero, which must not read as room either:
   * both are settled by comparing the box against itself and never against
   * `painted`.
   */
  let box: number | null = null

  /**
   * Where every carried column stood when the shell last settled, measured
   * from the DOCKED edge — the one edge main never moves, and so the only one
   * a remembered position survives a resize against (#464, generalized #566
   * T5b: was `railOffset`, one number for the one column that was ever
   * carried; keyed now because several can be carried in the same fold).
   *
   * It is to a column what `painted` is to the ground, and it is read for the
   * same reason: an unfold starts from the footprint the shell had, and each
   * carried column has to start from the place it had inside it. An element
   * with no entry here has never been carried, which `settle`'s unfold branch
   * reads as "nothing to carry it FROM" rather than "carry it from zero" —
   * zero is a real, if unlikely, resting travel of its own.
   */
  const columnOffsets = new Map<HTMLElement, number>()

  /**
   * The fold the window has not caught up with yet, and how wide it may be and
   * still be said to have (#464).
   *
   * A settle is main REPORTING the layout it applied, which is not the same
   * event as the viewport becoming that wide: the report crosses one IPC hop
   * and the window's own resize reaches the renderer on its own schedule. So
   * the clip is not let go of on the report alone — the ground would be painted
   * whole inside a window still holding the width the fold started from, which
   * is the frame the fold exists to remove.
   *
   * The allowance is the shell's own frame and never a column: where the
   * platform holds a floor above the design's 20px rail the collapsed shell
   * paints the rail inside it (#465), and the narrowest column this shell has is
   * wider than both paddings put together.
   */
  let pinned: { box: number } | null = null

  interface Leaving {
    /** The columns registered for this fold, in the order they registered. */
    columns: HTMLElement[]
    /** Each column's own width, measured at registration — parallel to `columns`. */
    widths: number[]
    resolve: () => void
    release: () => void
    hold: ShellFoldHold
  }

  /** The columns registering for the next fold, before it is measured. */
  let batch: Leaving | null = null
  /**
   * Every batch a fold is standing over, until the window has caught up.
   *
   * A list rather than the last one: two changes can fold before either window
   * arrives — a mine closing takes the navigation stack with it one tick later —
   * and keeping only the newest left the first fold's columns standing for good.
   */
  let holding: Leaving[] = []
  let overrun: ReturnType<typeof setTimeout> | undefined

  /**
   * A column mounted for this change, waiting for the unfold that will reveal
   * it (#566 T5b).
   *
   * `travel` is measured and the element pre-placed at it — fully translated
   * and clipped, as if it had not arrived yet — synchronously inside `enter`,
   * before this module yields to the browser: main has already grown the
   * window by the time Vue mounts an entering column (`usePanelLayout.send`
   * awaits `setPanelLayout` before it ever flips `visibleLayout`), so the row
   * has already repacked around it, and the ONLY way to still show it
   * travelling in is to make it LOOK like it has not arrived, then carry it to
   * 0 on the same unfold that reveals the ground.
   */
  interface Entering {
    column: HTMLElement
    travel: number
  }
  /** Entering columns pre-placed since the last unfold consumed them. */
  let entering: Entering[] = []
  /**
   * Whether an unfold has already been asked for and is waiting for the rest
   * of this change to register (#585) — see `armUnfold`, which is the whole of
   * what it guards: `settle` and `enter` both ask, in either order, and one
   * unfold is what they are asking for between them.
   */
  let unfoldQueued = false

  function leaving(): Leaving {
    let resolve!: () => void
    let release!: () => void
    const folded = new Promise<void>((done) => {
      resolve = done
    })
    const released = new Promise<void>((done) => {
      release = done
    })
    return { columns: [], widths: [], resolve, release, hold: { folded, released } }
  }

  /**
   * Let the columns a fold is standing over be unmounted.
   *
   * Called where the window has caught up, where the fold was superseded, and
   * off a deadline — because the row standing at a width main never applied is
   * the worse of the two states, and nothing here can make main answer.
   */
  function letGo(): void {
    clearTimeout(overrun)
    overrun = undefined
    const held = holding
    holding = []
    for (const one of held) one.release()
  }

  /**
   * A hidden window cannot advance the document timeline, so an animation
   * started now would never report itself finished (#266) — and reduced motion
   * asks for the instant state change outright. Both take the same exit here,
   * and both leave the clip alone: an unfolded ground is the honest thing to
   * paint when there is no motion to hide the change inside.
   */
  function still(shell: HTMLElement): boolean {
    return motion.still(shell)
  }

  function apply(shell: HTMLElement, state: ShellFoldState, radius: string): void {
    shell.style.clipPath = state === 'whole' ? '' : shellFoldClip(state, options.edge(), radius)
  }

  /**
   * The whole ground, said without a radius — which is the point.
   *
   * An empty `clip-path` is the shell's own shape, corners included, so the
   * settles that end here need nothing measured to say so. Reading the radius
   * for them cost a style resolution each, and the browser served one of those
   * from an element whose `clip-path` had just been written (#396).
   */
  function unclip(shell: HTMLElement): void {
    shell.style.clipPath = ''
  }

  /**
   * Every column standing free of SOME leaving or entering column right now,
   * the rail first and then whatever `options.carried` hands over, in
   * free-to-docked order (#464, generalized #566 T5b). `null` and one with no
   * motion of its own (`still`, the same test `railOf` used to make alone)
   * are dropped — a column that cannot run Web Animations has nothing this
   * fold could carry it with.
   */
  function mountedColumns(): HTMLElement[] {
    const list = [options.rail(), ...(options.carried?.() ?? [])]
    return list.filter((el): el is HTMLElement => el !== null && !motion.still(el))
  }

  /** Where `column` stands now, measured from the docked edge (#464, generalized #566 T5b). */
  function columnStand(shell: HTMLElement, column: HTMLElement): number {
    const ground = shell.getBoundingClientRect()
    const strip = column.getBoundingClientRect()
    return options.edge() === 'right' ? ground.right - strip.right : strip.left - ground.left
  }

  /**
   * Hold a carried column `travel` px from where the row puts it, or let it go
   * there (#464, generalized #566 T5b: was `place`, for the rail alone).
   *
   * Zero is the empty transform rather than `translateX(0px)`: what the row
   * decides is the answer everywhere except across a fold, and a column that
   * kept saying so would be a second opinion about it.
   */
  function place(column: HTMLElement, travel: number): void {
    column.style.transform = travel === 0 ? '' : columnFoldTransform(travel, options.edge())
  }

  /**
   * Carry a carried column from one travel to another, and leave it at the
   * second (#464, generalized #566 T5b).
   *
   * Settled as well as animated for the reason the clip is: `place` has to own
   * `transform` once the run ends, or a column that snapped back to the free
   * edge for the frames between the fold ending and main resizing is the
   * repaint being hidden here — `boundedMotion`'s own `settle` contract, true
   * under WAAPI's `fill: 'both'` and equally true of motion-v writing its last
   * frame straight into the same property (#566).
   *
   * `transition` is the clip's own (#464), not the column's own default: the
   * fold is ONE motion, and `x` (a transformProp) would otherwise pick up the
   * underdamped spring while `clipPath` (never a transformProp) gets the flat
   * 0.3s ease — a column travelling hundreds of pixels under that spring can
   * take longer than the clip it is meant to be carried inside of, so the
   * shrink could go out while it is still mid-travel through a band the clip
   * has already cut away. `clipTransitionFor`, below, is where both `begin`
   * and `settle` compute the one transition every run of a given fold shares.
   */
  function carry(
    column: HTMLElement,
    from: number,
    to: number,
    transition: MotionTransition
  ): void {
    // A fold that leaves a column where it is has nothing to carry, and
    // running the motion anyway would be an animation the shrink then waits
    // on.
    if (from === to) return
    place(column, from)
    void motion.run(
      column,
      columnFoldKeyframes(from, to, options.edge()),
      () => place(column, to),
      transition
    )
  }

  /**
   * Hold the LEAVING or ENTERING column itself `travel` px into its own
   * docked-side edge, clipped there too (#566 T5b) — `place`'s own contract,
   * with the clip `carrySelf` also owns.
   */
  function placeSelf(column: HTMLElement, travel: number): void {
    place(column, travel)
    column.style.clipPath = travel === 0 ? '' : columnFoldClip(travel, options.edge())
  }

  /**
   * Carry the leaving or entering column itself, sharing `carry`'s own
   * contract but on `columnSlideKeyframes` — `x` AND `clipPath` together, so
   * the two compositor properties this column's own motion touches finish, or
   * watchdog-end, in the same run rather than two independently-timed ones
   * that could disagree about where it is (#566 T5b).
   */
  function carrySelf(
    column: HTMLElement,
    from: number,
    to: number,
    transition: MotionTransition
  ): void {
    if (from === to) return
    placeSelf(column, from)
    void motion.run(
      column,
      columnSlideKeyframes(from, to, options.edge()),
      () => placeSelf(column, to),
      transition
    )
  }

  function radiusOf(shell: HTMLElement): string {
    // The ground's own corners, read rather than named: the strip a fold ends
    // on then has the rail's shape instead of a second opinion about it. Every
    // caller resolves the style once and passes the answer down, `begin`
    // included — it takes the radius off the style it has already resolved.
    return getComputedStyle(shell).borderRadius || '0px'
  }

  /**
   * The ONE transition every run of a fold shares (#464): motion-v's own
   * default for the clip it is folding to, asked for directly rather than
   * left for `boundedMotion.run` to re-derive per key — the clip's own run
   * still gets `undefined` and asks for its own default too, but `carry`'s
   * and `carrySelf`'s own runs need this SAME answer handed to them
   * explicitly, or motion-v would pick `x`'s own spring for it instead.
   */
  function clipTransitionFor(
    from: ShellFoldState,
    to: ShellFoldState,
    radius: string
  ): MotionTransition {
    const clip = shellFoldKeyframes(from, to, options.edge(), radius).clipPath as [string, string]
    return getDefaultTransition('clipPath', { keyframes: clip as unknown as number[] })
  }

  function run(
    shell: HTMLElement,
    from: ShellFoldState,
    to: ShellFoldState,
    radius: string,
    done: () => void,
    resolve: () => void
  ): void {
    // Everything the end of a fold owes its callers happens in `settle` rather
    // than off the promise, because it all has to land in the frame the fold
    // ended in: the settled clip goes on BEFORE the run is let go (which is
    // what `settle` is for — `apply` has to own `clip-path` once `stop()` is
    // called, or the ground would be left wherever the engine last wrote it
    // rather than the frame this fold actually ended on), and the columns
    // waiting on the fold are released in the same turn rather than a
    // microtask later.
    //
    // `boundedMotion`'s own contract calls this settle callback TWICE by
    // design (#566 T2b): once synchronously, and once more through
    // `frame.postRender`, defending the write against a render the engine
    // still had queued. That is fine for a PURE style write — `apply` is one,
    // and runs again here on purpose — but `done`/`resolve` are not: they own
    // `holding`/`overrun` bookkeeping a caller must see happen exactly once,
    // or the SECOND, deferred write silently pushes `panelLeaveBoundMs()`'s
    // own deadline out by whatever the deferred render's own delay is. This
    // is the general form of a bug the rail's own carry could already trip
    // (T2b's re-apply fires for it too) that a batch with more to release —
    // #566 T5b's own carried columns among them — makes far more likely to
    // land inside one test's own timers.
    let settled = false
    void motion.run(shell, shellFoldKeyframes(from, to, options.edge(), radius), () => {
      apply(shell, to, radius)
      if (settled) return
      settled = true
      done()
      resolve()
      // Drain anything `enter` queued WHILE this run was in flight (#566 T5b,
      // real-window probe evidence): the ground's own fold/unfold occupies
      // `motion.running(shell)` for its own run — 300ms and more, under a
      // spring — and every `settle` that would otherwise have caught a freshly
      // pre-placed column up returns at the FIRST guard for as long as it does.
      // Nothing external is guaranteed to ask again once it is free: the
      // `flush: 'post'` watch already fired for the change that started THIS
      // run, and the next one is whatever the user does next, which could be
      // seconds away or a different column's request entirely — a pre-placed
      // column left waiting for either stayed invisible for good, live in a
      // real window. This run just became the one thing that reliably knows
      // the ground is free again, so it asks on that column's behalf.
      //
      // A BACKSTOP since #585, where it used to be the ordinary path: a column
      // of the same change registers before the unfold is measured now, so
      // what is left here is a column that genuinely arrived after one — a
      // second grow landing inside the first one's run — which is a second
      // change and honestly a second run.
      if (pendingReveal()) settle(false)
    })
  }

  /** Measure the batch the leaving columns registered, and fold the ground. */
  function begin(): void {
    const pending = batch
    batch = null
    if (pending === null) return
    const shell = options.shell()
    if (shell === null || still(shell)) {
      pending.resolve()
      pending.release()
      return
    }
    // One style resolution for everything this fold reads off the element: the
    // gaps and padding it measures with, and the corners it is drawn with.
    const style = getComputedStyle(shell)
    // One token, `--space-nav-gap`, spent on both the gaps and the padding —
    // read off the element rather than restated here.
    const padding = parseFloat(style.paddingLeft) || 0
    const gap = parseFloat(style.columnGap) || 0
    const remaining = options.remaining()
    const folded = foldedShellWidth({
      width: shell.getBoundingClientRect().width,
      leaving: pending.widths,
      gap,
      padding,
      remaining
    })
    const radius = style.borderRadius || '0px'
    const from = painted ?? 'whole'
    // Computed ONCE and shared with `run`'s own clip run below (#464): every
    // run this fold starts has to agree on exactly the same transition, not
    // independently-derived answers that happen to match today.
    const transition = clipTransitionFor(from, folded, radius)

    // Carry every OTHER column standing free of what is leaving (#566 T5b):
    // walked free-to-docked so each one's own rest position only ever
    // subtracts what is nearer the free edge than IT is — `before` starts
    // empty, which is the rail's own answer and always was.
    const rests = new Map<HTMLElement, number>()
    let before: number[] = []
    for (const column of mountedColumns()) {
      if (pending.columns.includes(column)) continue
      const own = column.getBoundingClientRect().width
      // `rest` is the REST POSITION `foldedColumnOffset` answers — the same
      // "distance from the docked edge" `columnStand` measures, comparable to
      // a LATER measurement the way `painted` is comparable to a later width
      // — never the travel `carry` runs on, which is only ever a difference
      // of two positions and goes stale the moment the row repacks again.
      const rest = foldedColumnOffset({ kept: folded, before, gap, own, padding, remaining })
      const stand = columnStand(shell, column)
      carry(column, 0, stand - rest, transition)
      rests.set(column, rest)
      before = [...before, own]
    }

    // Each leaving column slides and clips on its own account (#566 T5b): it
    // is not free of the box it is vacating, so `carry` alone — a transform
    // with nothing else changed — would paint it over whatever the row draws
    // beside it, or past the window's own edge, for as long as the run takes.
    for (const column of pending.columns) {
      const width = column.getBoundingClientRect().width
      carrySelf(column, 0, width + gap, transition)
    }

    run(
      shell,
      from,
      folded,
      radius,
      () => {
        painted = folded
        // The runs all end in the same frame or a carried column is left
        // mid-travel over a ground that has already stopped moving.
        for (const [column, rest] of rests) {
          columnOffsets.set(column, rest)
          motion.release(column)
        }
        for (const column of pending.columns) motion.release(column)
        pinned = { box: folded + 2 * padding }
        // The columns stay standing from here, and the shrink this resolves is
        // what will eventually let them go. The bound is the latest fold's,
        // which is the one the window still owes an answer to.
        holding.push(pending)
        clearTimeout(overrun)
        overrun = setTimeout(letGo, panelLeaveBoundMs())
      },
      pending.resolve
    )
  }

  /**
   * A column on its way out, handing its motion to the shell.
   *
   * Answers the ONE fold every column leaving in this change shares — the
   * ground they stand on is a single surface, and an animation each would be
   * three answers to the question of how wide it is. `null` when there is no
   * motion to wait for, which is the caller's cue to take the instant path.
   */
  function hold(column: HTMLElement): ShellFoldHold | null {
    const shell = options.shell()
    if (shell === null || still(shell)) return null
    if (batch === null) {
      batch = leaving()
      // Measured a microtask later, when every column leaving in this patch has
      // registered: still inside the frame Vue is preparing, and with the row
      // it is measuring still intact.
      void Promise.resolve().then(begin)
    }
    batch.columns.push(column)
    batch.widths.push(column.getBoundingClientRect().width)
    return batch.hold
  }

  /**
   * A column on its way in, pre-placed so the unfold that reveals the ground
   * can carry it too (#566 T5b).
   *
   * Main has already grown the window by the time this is ever called — Vue
   * only mounts an entering column once `usePanelLayout.send` has awaited
   * `setPanelLayout` and flipped `visibleLayout` to what main reported — so
   * the row has already repacked around it at its FINAL position. The only
   * way left to show it travelling in is to make it look like it has not
   * arrived: pre-place it at the travel the row's own repack just gave it,
   * synchronously, before this module yields to the browser, so nothing paints
   * the fully-arrived frame first. `settle`'s own unfold branch — the SAME
   * event that reveals the ground and carries every other free column back —
   * is what carries it the rest of the way, on the same transition.
   *
   * Unlike `hold`, nothing here is awaited: an entering column has nothing to
   * unmount and nothing a shrink needs to wait on, so there is no promise for
   * a caller to hold onto.
   */
  function enter(column: HTMLElement): void {
    const shell = options.shell()
    if (shell === null || still(shell)) return
    // One style resolution, the same reason `begin` takes one: only `gap` is
    // read here, off the shell the column has already been laid out inside.
    const gap = parseFloat(getComputedStyle(shell).columnGap) || 0
    const travel = column.getBoundingClientRect().width + gap
    placeSelf(column, travel)
    entering.push({ column, travel })
    // The last column to register is what the unfold was waiting for (#585).
    // Asked for here as well as from `settle` because the two arrive in either
    // order and neither is guaranteed: `settle` is the one App.vue's watch
    // fires first, and a column whose own grow was already consumed by an
    // earlier settle would otherwise have nothing left to ask at all.
    armUnfold()
  }

  /**
   * An entering column still waiting to be revealed, with a real distance to
   * travel (#566 T5b). `entering` alone is not the answer: a test double that
   * lays nothing out registers one at a travel of exactly 0, which is a
   * column that has NOTHING to be carried through — `carry`/`carrySelf`'s own
   * `from === to` guard already treats it as done, and this is the same
   * question asked before spending a ground animation on it too.
   */
  function pendingReveal(): boolean {
    return entering.some((one) => one.travel > 0)
  }

  /**
   * What an unfold would run from, or `null` where this settle has none to
   * run — the ONE question `settle` and the deferred `unfold` below both ask,
   * so the two can never disagree about whether there is anything to do.
   *
   * `pinned` excludes itself here rather than being tested afterwards, which
   * is the order the three tails of `settle` used to carry on their own: the
   * ground is still holding a fold the window had not caught up with, so
   * `painted` is that fold's strip rather than a footprint anything may
   * unfold FROM — including where the window it caught up with is wider than
   * the box the fold started from, which a swap can do. A box that did not
   * move is refused by `width > box` already.
   *
   * `pendingReveal()` is a second way in, added for #566 T5b from a
   * real-window probe: two grows close enough together can both land before
   * either settle runs (the mine column opening a tick after the secondary
   * panel did, in one probed case) — the FIRST unfold's own completion
   * catches the viewport up to whatever it has ALREADY reached by then, which
   * can already be the SECOND grow's own width too, leaving `width > box`
   * false for the column that arrived inside that same jump even though it is
   * still sitting exactly where `enter` pre-placed it. Gated on an actual
   * non-zero travel, not merely `entering` being non-empty: a test double
   * that lays nothing out (jsdom answers every `getBoundingClientRect` with
   * zeros) registers a column at a travel of exactly 0, and several existing
   * cases pin that environment as one this branch must stay OUT of —
   * `App.test.ts`'s own "jsdom lays out no box, so the shell never measures
   * itself as grown" is the same fact stated from the width side of this OR.
   * Nothing here is unsafe to run on a real box that has not moved further:
   * the ground's own animation is then a zero-visual-delta run (`painted`
   * already equals `width` in every pixel it draws), and every carried
   * column's own `carry` is the SAME `from === to` no-op `hold`'s own leave
   * path already relies on.
   */
  function unfoldable(shell: HTMLElement, width: number): { from: number } | null {
    if (pinned !== null || box === null || painted === null) return null
    if (width <= box && !pendingReveal()) return null
    if (still(shell)) return null
    return { from: painted }
  }

  /**
   * Ask for the unfold on the microtask after the change that wants it (#585).
   *
   * The same device `hold` uses to make ONE fold out of however many columns
   * leave in a patch, for the same reason with the sign reversed. Vue puts
   * App.vue's `flush: 'post'` watch and a `<Transition>`'s own enter hook in
   * the SAME post-flush queue and sorts it by id — the watch carries its
   * component's, an enter hook is an anonymous callback with none — so
   * `settle` is always asked first and `enter` always registers afterwards.
   * Unfolding where it was asked therefore revealed the ground with `entering`
   * still empty, every later settle bounced off `motion.running(shell)` for
   * the 300ms that took, and the content only arrived on the drain at the end
   * of it: two sequential runs, and 936px of bare amber in between, measured
   * live.
   *
   * A microtask and not a frame or a timer: Vue's flush — patch, refs, watches
   * and enter hooks alike — is one synchronous job, so this lands after all of
   * it and before the browser has painted anything. Idempotent, because both
   * `settle` and `enter` ask and either may be first.
   */
  function armUnfold(): void {
    if (unfoldQueued) return
    unfoldQueued = true
    void Promise.resolve().then(() => {
      // The flag is the token as well as the guard: teardown clears it to
      // withdraw an unfold nothing is left to run — a microtask cannot be
      // cancelled, and starting a run on a disposed runner would leave an
      // animation on an element this instance has stopped owning.
      if (!unfoldQueued) return
      unfoldQueued = false
      unfold()
    })
  }

  /**
   * Reveal the ground, and carry every column of this change with it.
   *
   * One transition, computed once and handed to every run (#464), and every
   * run started here in the same turn: the ground's own clip, each entering
   * column's slide out from behind the strip beside it, and each carried
   * column's travel back to where the row now puts it. They end together
   * because they are one motion; a column still travelling over a ground that
   * had stopped is the frame this exists to remove.
   *
   * Everything is re-read rather than carried over from the settle that armed
   * this: a microtask is long enough for the shell to have gone away, for a
   * fold to have started in the other direction, or for the window to have
   * moved again.
   */
  function unfold(): void {
    const shell = options.shell()
    if (shell === null || motion.running(shell)) return
    const width = shell.getBoundingClientRect().width
    const pending = unfoldable(shell, width)
    if (pending === null) return
    const from = pending.from
    const radius = radiusOf(shell)
    apply(shell, from, radius)
    const transition = clipTransitionFor(from, 'whole', radius)
    // Entering columns are carried on THIS unfold — the same event that
    // reveals the ground — never their own: they were pre-placed by `enter`
    // at exactly the travel `columnStand` would answer for them anyway
    // (their row already repacked around them), so nothing here re-measures
    // it.
    const enteringNow = entering
    entering = []
    const enteringColumns = new Set(enteringNow.map((one) => one.column))
    for (const { column, travel } of enteringNow) carrySelf(column, travel, 0, transition)
    // Every OTHER carried column returns from the footprint it had when the
    // fold it is answering for last settled — outside the footprint this
    // unfolds FROM when it is entering room the row only just repacked into,
    // which is exactly why it starts there and comes back with the ground.
    const stands = new Map<HTMLElement, number>()
    for (const column of mountedColumns()) {
      if (enteringColumns.has(column)) continue
      const stand = columnStand(shell, column)
      stands.set(column, stand)
      const offset = columnOffsets.get(column)
      if (offset !== undefined) carry(column, stand - offset, 0, transition)
    }
    run(
      shell,
      from,
      'whole',
      radius,
      () => {
        painted = width
        box = width
        for (const [column, stand] of stands) {
          columnOffsets.set(column, stand)
          motion.release(column)
        }
        for (const column of enteringColumns) motion.release(column)
      },
      () => undefined
    )
  }

  /**
   * Main has applied a layout, and the shell's box is whatever it made it.
   *
   * `reserved` is the swap: main holds the UNION of both compositions before
   * either column moves, so the window is briefly wider than anything
   * presentation asked for. Unfolding into that reservation would paint the
   * very pixels the fold about to start is going to take back, so the previous
   * footprint stays on the ground and the fold carries on from it.
   */
  function settle(reserved: boolean): void {
    const shell = options.shell()
    if (shell === null || motion.running(shell)) return
    if (reserved) {
      if (painted !== null && !still(shell)) apply(shell, painted, radiusOf(shell))
      return
    }
    const width = shell.getBoundingClientRect().width
    // The unfold is the one branch that waits (#585): every column arriving in
    // THIS change has to have registered before it is measured, or it reveals
    // the ground alone and leaves the content for a second run. `armUnfold`
    // below is where that wait lives; everything after this point is a settle
    // with nothing to unfold and happens on the spot, as it always has.
    if (unfoldable(shell, width) !== null) {
      armUnfold()
      return
    }
    if (pinned !== null) {
      /*
       * Either the window has caught up with the fold — the strip IS the window
       * now, so `painted` stands as it is and the clip has nothing left to do —
       * or it has gone somewhere else entirely and this footprint is spent. A
       * box that has not moved at all is neither: main's report has arrived
       * ahead of the resize it describes, and letting go of the clip on it would
       * paint the whole ground back inside the width the fold started from.
       */
      if (width > pinned.box && width === box) return
      pinned = null
      // What the row decides is the answer again, and holding the travel on top
      // of it would carry a column out of the window main has just made.
      for (const column of mountedColumns()) place(column, 0)
      // And the columns the fold was standing over may finally go: the row they
      // repack now is the row this box was made for.
      letGo()
    } else if (box === width) {
      // Nothing moved — a request that was refused, or one that only changed
      // the docked side. `painted` is left exactly as it was, which matters
      // most where it disagrees with the box: where the platform holds a floor
      // above the design's rail, the collapsed shell paints 20px inside it, and
      // overwriting that here would lose the footprint the next opening unfolds
      // from.
    } else {
      // The box changed with no fold to cross, so what is painted is the box,
      // and every carried column is wherever the row has just put it.
      painted = width
      for (const column of mountedColumns()) columnOffsets.set(column, columnStand(shell, column))
    }
    box = width
    unclip(shell)
  }

  /**
   * The viewport reaching the width a fold was made for, which main's report of
   * it is not (#464), or reaching the width a GROW asked for, which the same
   * gap applies to and #488 left as "the next lever if a symptom needs it"
   * (#566 T5b: an entering column pre-placed by `enter` is that symptom).
   *
   * The renderer cannot be told the moment the native window is resized; this
   * is the first thing it can observe of it. Answered unconditionally now,
   * not only while `pinned` — the `flush: 'post'` watch that calls `settle`
   * right after Vue's own patch can land before the BROWSER's own layout has
   * caught up with a window main already grew synchronously inside the IPC
   * handler (main's `setBounds` resolves before this renderer's `resize`
   * event ever fires), and outside a leaving fold nothing else was left to
   * ask again — an entering column pre-placed at its own vanishing point
   * stayed there for good, real-window-probe evidence for #566 T5b's fix
   * measuring instead of assuming this was already reliable. `settle` is
   * cheap and safe to call on a resize that answers nothing: its own early
   * exits (`box === width`, nothing `pinned`, no growth to unfold) make every
   * other call here a no-op past a few property reads.
   */
  function caughtUp(): void {
    settle(false)
  }
  window.addEventListener('resize', caughtUp)

  // The fold's own teardown is the batch: a fold that never began still has
  // columns waiting on the promise it would have resolved, and leaving them
  // held would strand the row inside a window nobody is going to resize now.
  onBeforeUnmount(() => {
    window.removeEventListener('resize', caughtUp)
    // Withdraw an unfold still waiting for the rest of its change (#585): the
    // columns it would have revealed are handed their settled state below
    // instead, which is the honest thing to paint with nobody left to animate
    // it.
    unfoldQueued = false
    motion.dispose()
    batch?.resolve()
    batch?.release()
    // After `dispose`, which may have ended a fold still running and taken its
    // columns into `holding` on the way past.
    letGo()
    // An entering column pre-placed by `enter` but never carried by an unfold
    // this instance saw — the component that owns the fold went away first —
    // is not this app's to leave invisible: nothing else will ever reveal it.
    for (const { column } of entering) placeSelf(column, 0)
    entering = []
  })

  return { hold, enter, settle }
}
