import { onBeforeUnmount } from 'vue'
import {
  PANEL_MOTION_EASING,
  PANEL_MOTION_MS,
  PANEL_MOTION_WATCHDOG_MS
} from '../lib/shell/panelMotion'
import {
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
 */
export interface ShellFoldOptions {
  /** The element the amber ground is painted on. */
  shell: () => HTMLElement | null
  /** The docked side, which the fold is mirrored around. */
  edge: () => PanelEdge
  /** The composition presentation is folding TO. */
  remaining: () => ShellComposition
}

interface RunningFold {
  release: () => void
  /** #266's backstop, held by the fold it bounds so it dies with it. */
  watchdog?: ReturnType<typeof setTimeout>
}

export function useShellFold(options: ShellFoldOptions) {
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')

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
   * than the box around it. The collapsed shell is the second of those — the
   * rail is 20 design pixels inside the 32 the platform will not go below (see
   * MIN_WINDOW_WIDTH) — and reading that gap as room to unfold into would start
   * an animation on every request that changed nothing.
   */
  let box: number | null = null

  /** `painted` came from a fold, so the window has not caught up with it yet. */
  let pinned = false

  let batch: { widths: number[]; resolve: () => void; promise: Promise<void> } | null = null
  let running: RunningFold | null = null

  /**
   * A hidden window cannot advance the document timeline, so an animation
   * started now would never report itself finished (#266) — and reduced motion
   * asks for the instant state change outright. Both take the same exit here,
   * and both leave the clip alone: an unfolded ground is the honest thing to
   * paint when there is no motion to hide the change inside.
   */
  function still(shell: HTMLElement): boolean {
    return Boolean(media?.matches) || document.hidden || typeof shell.animate !== 'function'
  }

  function apply(shell: HTMLElement, state: ShellFoldState, radius: string): void {
    shell.style.clipPath = state === 'whole' ? '' : shellFoldClip(state, options.edge(), radius)
  }

  function radiusOf(shell: HTMLElement): string {
    // The ground's own corners, read rather than named: the strip a fold ends
    // on then has the rail's shape instead of a second opinion about it.
    return getComputedStyle(shell).borderRadius || '0px'
  }

  function run(
    shell: HTMLElement,
    from: ShellFoldState,
    to: ShellFoldState,
    done: () => void,
    resolve: () => void
  ): void {
    running?.release()
    const radius = radiusOf(shell)
    const animation = shell.animate(shellFoldKeyframes(from, to, options.edge(), radius), {
      duration: PANEL_MOTION_MS,
      easing: PANEL_MOTION_EASING,
      fill: 'both'
    })
    const fold: RunningFold = {
      release: () => {
        if (running !== fold) return
        running = null
        clearTimeout(fold.watchdog)
        // The settled clip goes on BEFORE the animation is let go, or the
        // ground snaps back to the frame it started from.
        apply(shell, to, radius)
        animation.cancel()
        done()
        resolve()
      }
    }
    running = fold
    fold.watchdog = setTimeout(fold.release, PANEL_MOTION_WATCHDOG_MS)
    void animation.finished.then(fold.release, fold.release)
  }

  /** Measure the batch the leaving columns registered, and fold the ground. */
  function begin(): void {
    const pending = batch
    batch = null
    if (pending === null) return
    const shell = options.shell()
    if (shell === null || still(shell)) {
      pending.resolve()
      return
    }
    const style = getComputedStyle(shell)
    const folded = foldedShellWidth({
      width: shell.getBoundingClientRect().width,
      leaving: pending.widths,
      // One token, `--space-nav-gap`, spent on both the gaps and the padding —
      // read off the element rather than restated here.
      gap: parseFloat(style.columnGap) || 0,
      padding: parseFloat(style.paddingLeft) || 0,
      remaining: options.remaining()
    })
    run(
      shell,
      painted ?? 'whole',
      folded,
      () => {
        painted = folded
        pinned = true
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
  function hold(column: HTMLElement): Promise<void> | null {
    const shell = options.shell()
    if (shell === null || still(shell)) return null
    if (batch === null) {
      let resolve!: () => void
      const promise = new Promise<void>((done) => {
        resolve = done
      })
      batch = { widths: [], resolve, promise }
      // Measured a microtask later, when every column leaving in this patch has
      // registered: still inside the frame Vue is preparing, and with the row
      // it is measuring still intact.
      void Promise.resolve().then(begin)
    }
    batch.widths.push(column.getBoundingClientRect().width)
    return batch.promise
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
    if (shell === null || running !== null) return
    if (reserved) {
      if (painted !== null && !still(shell)) apply(shell, painted, radiusOf(shell))
      return
    }
    const width = shell.getBoundingClientRect().width
    if (pinned) {
      // The window has caught up with the fold: the strip IS the window now,
      // so the clip has nothing left to do and `painted` stands as it is.
      pinned = false
      box = width
      apply(shell, 'whole', radiusOf(shell))
      return
    }
    if (box === width) {
      // Nothing moved — a request that was refused, or one that only changed
      // the docked side. `painted` is left exactly as it was, which matters
      // most where it disagrees with the box: the collapsed shell paints the
      // design's 20px rail inside the platform's 32px window, and overwriting
      // that here would lose the footprint the next opening unfolds from.
      apply(shell, 'whole', radiusOf(shell))
      return
    }
    if (box !== null && painted !== null && width > box && !still(shell)) {
      apply(shell, painted, radiusOf(shell))
      run(
        shell,
        painted,
        'whole',
        () => {
          painted = width
          box = width
        },
        () => undefined
      )
      return
    }
    painted = width
    box = width
    apply(shell, 'whole', radiusOf(shell))
  }

  function release(): void {
    running?.release()
  }
  function releaseHidden(): void {
    if (document.hidden) release()
  }
  function reduceMotion(): void {
    if (media?.matches) release()
  }
  media?.addEventListener('change', reduceMotion)
  document.addEventListener('visibilitychange', releaseHidden)
  onBeforeUnmount(() => {
    media?.removeEventListener('change', reduceMotion)
    document.removeEventListener('visibilitychange', releaseHidden)
    release()
    batch?.resolve()
  })

  return { hold, settle }
}
