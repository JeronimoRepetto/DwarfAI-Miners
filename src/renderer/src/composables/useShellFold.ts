import { onBeforeUnmount } from 'vue'
import { createBoundedMotion } from '../lib/shell/boundedMotion'
import { PANEL_LEAVE_BOUND_MS } from '../lib/shell/panelMotion'
import {
  foldedRailOffset,
  foldedShellWidth,
  railFoldKeyframes,
  railFoldTransform,
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
 * and the rail's travel, which is the row's own again the moment the row is
 * right. A `resize` listener is the first thing the renderer can observe of the
 * resize itself, and `PANEL_LEAVE_BOUND_MS` is the floor under a window that
 * never answers at all.
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
   * It is the one column standing on the FREE side of everything that ever
   * leaves, so it is the one column the row rearranges — and the fold clips
   * away the free edge it stands at. `null` is answered honestly where the
   * component that draws it is not mounted or is not one element: the ground
   * still folds, and only the travel is lost.
   */
  rail: () => HTMLElement | null
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
  const motion = createBoundedMotion()

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
   * Where the rail stood when the shell last settled, measured from the DOCKED
   * edge — the one edge main never moves, and so the only one a remembered
   * position survives a resize against.
   *
   * It is to the rail what `painted` is to the ground, and it is read for the
   * same reason: an unfold starts from the footprint the shell had, and the rail
   * has to start from the place it had inside it.
   */
  let railOffset: number | null = null

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
   * and the earlier batch is waiting on the same thing the later one is. Keeping
   * only the newest left the first fold's columns standing for good.
   */
  let holding: Leaving[] = []
  let overrun: ReturnType<typeof setTimeout> | undefined

  function leaving(): Leaving {
    let resolve!: () => void
    let release!: () => void
    const folded = new Promise<void>((done) => {
      resolve = done
    })
    const released = new Promise<void>((done) => {
      release = done
    })
    return { widths: [], resolve, release, hold: { folded, released } }
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

  /** The rail, when there is one and it has motion of its own to run. */
  function railOf(): HTMLElement | null {
    const rail = options.rail()
    return rail === null || motion.still(rail) ? null : rail
  }

  /** Where the rail stands now, measured from the docked edge. */
  function railStand(shell: HTMLElement, rail: HTMLElement): number {
    const ground = shell.getBoundingClientRect()
    const strip = rail.getBoundingClientRect()
    return options.edge() === 'right' ? ground.right - strip.right : strip.left - ground.left
  }

  /**
   * Hold the rail `travel` px from where the row puts it, or let it go there.
   *
   * Zero is the empty transform rather than `translateX(0px)`: what the row
   * decides is the answer everywhere except across a fold, and a shell that kept
   * saying so would be a second opinion about it.
   */
  function place(rail: HTMLElement, travel: number): void {
    rail.style.transform = travel === 0 ? '' : railFoldTransform(travel, options.edge())
  }

  /**
   * Carry the rail from one travel to another, and leave it at the second.
   *
   * Settled as well as animated for the reason the clip is: cancelling drops
   * `fill: 'both'`, and a rail that snapped back to the free edge for the frames
   * between the fold ending and main resizing is the repaint being hidden here.
   */
  function carry(rail: HTMLElement, from: number, to: number): void {
    // A fold that leaves the rail where it is has nothing to carry, and running
    // the motion anyway would be an animation the shrink then waits on.
    if (from === to) return
    place(rail, from)
    void motion.run(rail, railFoldKeyframes(from, to, options.edge()), () => place(rail, to))
  }

  function radiusOf(shell: HTMLElement): string {
    // The ground's own corners, read rather than named: the strip a fold ends
    // on then has the rail's shape instead of a second opinion about it. Every
    // caller resolves the style once and passes the answer down, `begin`
    // included — it takes the radius off the style it has already resolved.
    return getComputedStyle(shell).borderRadius || '0px'
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
    // ended in: the settled clip goes on BEFORE the animation is let go (which
    // is what `settle` is for — cancelling drops `fill: 'both'` and the ground
    // would snap back to the frame it started from), and the columns waiting on
    // the fold are released in the same turn rather than a microtask later.
    void motion.run(shell, shellFoldKeyframes(from, to, options.edge(), radius), () => {
      apply(shell, to, radius)
      done()
      resolve()
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
    const remaining = options.remaining()
    const folded = foldedShellWidth({
      width: shell.getBoundingClientRect().width,
      leaving: pending.widths,
      gap: parseFloat(style.columnGap) || 0,
      padding,
      remaining
    })
    const rail = railOf()
    // Where the row is about to put the rail, and how far that is from where it
    // stands: the fold's end keyframe is these two as much as it is the strip,
    // because a strip of the right width is not yet a strip the rail is in.
    const rests =
      rail === null
        ? null
        : foldedRailOffset({
            kept: folded,
            rail: rail.getBoundingClientRect().width,
            padding,
            remaining
          })
    if (rail !== null && rests !== null) carry(rail, 0, railStand(shell, rail) - rests)
    run(
      shell,
      painted ?? 'whole',
      folded,
      style.borderRadius || '0px',
      () => {
        painted = folded
        railOffset = rests
        // The two end in the same frame or the rail is left mid-travel over a
        // ground that has already stopped moving.
        if (rail !== null) motion.release(rail)
        pinned = { box: folded + 2 * padding }
        // The columns stay standing from here, and the shrink this resolves is
        // what will eventually let them go. The bound is the latest fold's,
        // which is the one the window still owes an answer to.
        holding.push(pending)
        clearTimeout(overrun)
        overrun = setTimeout(letGo, PANEL_LEAVE_BOUND_MS)
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
    batch.widths.push(column.getBoundingClientRect().width)
    return batch.hold
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
    /*
     * The one branch that folds, and so the one that has a radius to read.
     *
     * `pinned` excludes itself here rather than being tested first, which is
     * the order the three tails below used to carry on their own: the ground
     * is still holding a fold the window had not caught up with, so `painted`
     * is that fold's strip rather than a footprint anything may unfold FROM —
     * including where the window it caught up with is wider than the box the
     * fold started from, which a swap can do. A box that did not move is
     * refused by `width > box` already.
     */
    if (pinned === null && box !== null && painted !== null && width > box && !still(shell)) {
      const radius = radiusOf(shell)
      apply(shell, painted, radius)
      const rail = railOf()
      // The row has already put the rail out at the new free edge, which is
      // outside the footprint this unfolds FROM: it starts where it was inside
      // that footprint and comes back with the ground.
      const stand = rail === null ? null : railStand(shell, rail)
      if (rail !== null && stand !== null && railOffset !== null) carry(rail, stand - railOffset, 0)
      run(
        shell,
        painted,
        'whole',
        radius,
        () => {
          painted = width
          box = width
          railOffset = stand
          if (rail !== null) motion.release(rail)
        },
        () => undefined
      )
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
      const rail = options.rail()
      // What the row decides is the answer again, and holding the travel on top
      // of it would carry the rail out of the window main has just made.
      if (rail !== null) place(rail, 0)
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
      // and the rail is wherever the row has just put it.
      painted = width
      const rail = railOf()
      railOffset = rail === null ? null : railStand(shell, rail)
    }
    box = width
    unclip(shell)
  }

  /**
   * The viewport reaching the width a fold was made for, which main's report of
   * it is not (#464).
   *
   * The renderer cannot be told the moment the native window is resized; this is
   * the first thing it can observe of it, and it is what keeps the frames
   * between the two from being painted under a clip that has stopped being true.
   * It answers nothing outside a fold, which is every resize but these.
   */
  function caughtUp(): void {
    if (pinned !== null) settle(false)
  }
  window.addEventListener('resize', caughtUp)

  // The fold's own teardown is the batch: a fold that never began still has
  // columns waiting on the promise it would have resolved, and leaving them
  // held would strand the row inside a window nobody is going to resize now.
  onBeforeUnmount(() => {
    window.removeEventListener('resize', caughtUp)
    motion.dispose()
    batch?.resolve()
    batch?.release()
    // After `dispose`, which may have ended a fold still running and taken its
    // columns into `holding` on the way past.
    letGo()
  })

  return { hold, settle }
}
