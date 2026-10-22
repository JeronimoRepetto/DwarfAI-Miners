/*
 * What the perf case reads and drives on the Control-room page (ISSUE-298, S-034-1), exposed as
 * `window.controlRoom`. Test code of a perf-only page: nothing in the product imports it (R13).
 *
 * Per column it keeps two counts since the last reset: `requests`, every tick the column's sprite
 * frame clock asked its tick source for (one per scheduled frame change), and `frames`, every
 * sprite frame change painted in the column (a change of a `.dm-sprite__strip` inline style, which
 * is how the clock moves a sprite, SpriteStrip.vue). A paused column asks for no tick and paints
 * nothing; its strips keep the last frame they showed.
 */

/** One column as the page knows it. */
export interface ColumnEntry {
  readonly index: number
  readonly element: HTMLElement
  requests: number
  frames: number
  /** Whether the column's frame clock runs. */
  running: boolean
  /** The animation-frame count at which the clock last resumed. */
  resumedAtFrame: number | null
  /** Each strip's inline style just before the clock last resumed. */
  stylesAtResume: string[] | null
}

const columns = new Map<number, ColumnEntry>()

export function registerColumn(entry: ColumnEntry): void {
  columns.set(entry.index, entry)
}

export function unregisterColumn(index: number): void {
  columns.delete(index)
}

/** Animation frames counted while a probe runs its own frame loop (none run otherwise). */
let animationFrames = 0
export const animationFrameCount = (): number => animationFrames

/** The inline style of every sprite strip in `element`, in DOM order. */
export const stripStyles = (element: Element): string[] =>
  [...element.querySelectorAll<HTMLElement>('.dm-sprite__strip')].map(
    (strip) => strip.getAttribute('style') ?? ''
  )

/** One column as the case reads it. */
export interface ColumnReading {
  readonly index: number
  readonly inDom: boolean
  readonly sprites: number
  /** Every strip shows a frame: it has an inline style (the frame the clock last gave it). */
  readonly painted: boolean
  readonly requests: number
  readonly frames: number
  readonly running: boolean
}

function read(entry: ColumnEntry): ColumnReading {
  const styles = stripStyles(entry.element)
  return {
    index: entry.index,
    inDom: entry.element.isConnected && entry.element.querySelector('.dm-minecol') !== null,
    sprites: styles.length,
    painted: styles.length > 0 && styles.every((style) => style !== ''),
    requests: entry.requests,
    frames: entry.frames,
    running: entry.running
  }
}

/** Runs `step` on every animation frame for `ms`, and answers the time between consecutive frames. */
function frameLoop(ms: number, step: () => void = () => {}): Promise<number[]> {
  return new Promise((resolve) => {
    const deltas: number[] = []
    let last: number | undefined
    let end: number | undefined
    const frame = (now: number): void => {
      animationFrames++
      if (last !== undefined) deltas.push(now - last)
      last = now
      end ??= now + ms
      if (now >= end) {
        resolve(deltas)
        return
      }
      step()
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
}

export interface ControlRoomProbe {
  /** Settles once every column is mounted: the column count and one column's width in CSS pixels. */
  ready: Promise<{ columns: number; columnWidth: number; devicePixelRatio: number }>
  /** The columns in the DOM (`.dm-minecol`), whatever the page's own registry says. */
  columnsInDom(): number
  columns(): ColumnReading[]
  resetCounts(): void
  scrollToStart(): void
  scrollToEnd(): void
  /**
   * Scrolls column `index` into view and answers how many animation frames passed from the scroll
   * to its clock resuming, and whether its strips showed, at that moment, the frames they held
   * while it was paused.
   */
  reveal(index: number): Promise<{ framesToResume: number | null; heldFramesShown: boolean }>
  /** The frame times over `ms` with nothing else driven. */
  frameTimes(ms: number): Promise<number[]>
  /** The frame times over `ms` while the mosaic scrolls sideways `pxPerFrame` a frame, back and forth. */
  sweep(ms: number, pxPerFrame: number): Promise<number[]>
}

export function createProbe(
  mosaic: () => HTMLElement,
  ready: ControlRoomProbe['ready']
): ControlRoomProbe {
  return {
    ready,
    columnsInDom: () => document.querySelectorAll('.dm-minecol').length,
    columns: () => [...columns.values()].sort((a, b) => a.index - b.index).map(read),
    resetCounts() {
      for (const entry of columns.values()) {
        entry.requests = 0
        entry.frames = 0
      }
    },
    scrollToStart: () => mosaic().scrollTo({ left: 0, behavior: 'instant' }),
    scrollToEnd: () => mosaic().scrollTo({ left: mosaic().scrollWidth, behavior: 'instant' }),
    async reveal(index) {
      const entry = columns.get(index)
      if (entry === undefined) throw new Error(`no column ${index}`)
      const held = stripStyles(entry.element)
      entry.resumedAtFrame = null
      entry.stylesAtResume = null
      const scrolledAt = animationFrames
      const left = entry.element.offsetLeft
      const frames = frameLoop(500)
      mosaic().scrollTo({ left, behavior: 'instant' })
      await frames
      return {
        framesToResume: entry.resumedAtFrame === null ? null : entry.resumedAtFrame - scrolledAt,
        heldFramesShown:
          entry.stylesAtResume !== null &&
          JSON.stringify(entry.stylesAtResume) === JSON.stringify(held)
      }
    },
    frameTimes: (ms) => frameLoop(ms),
    sweep(ms, pxPerFrame) {
      const element = mosaic()
      let direction = 1
      return frameLoop(ms, () => {
        const max = element.scrollWidth - element.clientWidth
        let next = element.scrollLeft + direction * pxPerFrame
        if (next >= max || next <= 0) {
          direction = -direction
          next = Math.min(max, Math.max(0, next))
        }
        element.scrollTo({ left: next, behavior: 'instant' })
      })
    }
  }
}

declare global {
  interface Window {
    controlRoom: ControlRoomProbe
  }
}
