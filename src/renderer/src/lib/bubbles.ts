import { truncate } from '../../../shared/truncate'
import { BUBBLE_MAX_CHARS } from './presentation'

/** How long a speech bubble stays visible after a message change. */
export const BUBBLE_TTL_MS = 6000

/** The slice of a dwarf the bubble board cares about. */
export interface BubbleSource {
  id: string
  lastMessage?: string
}

export interface BubbleBoard {
  /** Reconcile with the latest dwarf list; a changed lastMessage shows a bubble. */
  sync(dwarfs: readonly BubbleSource[]): void
  /** Cancel every pending hide timer; the board stops emitting. */
  dispose(): void
}

interface TrackedDwarf {
  message: string
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Framework-agnostic speech-bubble scheduler. `onChange` receives a fresh
 * snapshot of visible bubbles (dwarf id -> truncated text) every time one
 * appears or disappears, so a Vue component can mirror it into a ref.
 */
export function createBubbleBoard(
  onChange: (visible: ReadonlyMap<string, string>) => void,
  ttlMs: number = BUBBLE_TTL_MS
): BubbleBoard {
  const tracked = new Map<string, TrackedDwarf>()
  const visible = new Map<string, string>()
  let disposed = false

  function emit(): void {
    if (!disposed) onChange(new Map(visible))
  }

  function hideLater(id: string, entry: TrackedDwarf): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (visible.delete(id)) emit()
    }, ttlMs)
  }

  function show(id: string, entry: TrackedDwarf, message: string): void {
    entry.message = message
    visible.set(id, truncate(message, BUBBLE_MAX_CHARS))
    hideLater(id, entry)
    emit()
  }

  function drop(id: string): void {
    const entry = tracked.get(id)
    if (entry?.timer) clearTimeout(entry.timer)
    tracked.delete(id)
    if (visible.delete(id)) emit()
  }

  return {
    sync(dwarfs) {
      if (disposed) return
      const present = new Set<string>()
      for (const dwarf of dwarfs) {
        present.add(dwarf.id)
        const entry = tracked.get(dwarf.id) ?? { message: '' }
        tracked.set(dwarf.id, entry)
        if (dwarf.lastMessage && dwarf.lastMessage !== entry.message) {
          show(dwarf.id, entry, dwarf.lastMessage)
        }
      }
      for (const id of [...tracked.keys()]) {
        if (!present.has(id)) drop(id)
      }
    },
    dispose() {
      disposed = true
      for (const entry of tracked.values()) {
        if (entry.timer) clearTimeout(entry.timer)
      }
      tracked.clear()
      visible.clear()
    }
  }
}
