/*
 * The order of the dialogs open at once (ISSUE-141, lead decision 2026-10-14). The design draws one dialog at a time
 * (components.md, Dialog), but two can be due together: the first-run step, which has no close and no skip
 * (US-SET-012.AC06), and Stop everything and quit's confirmation, the one person-facing way to stop the Host, which
 * must always be reachable (ADR-002 D7, OQ-63). So the dialogs open at once are a stack: only the top one is drawn
 * above the rest, holds the keys and the focus, and takes the pointer; the ones beneath stay open, inert, until it
 * closes.
 *
 * A dialog opened `overAll` (Stop everything's) is above every ordinary one, whichever opened first; among dialogs of
 * the same rank, the later one is on top. Pure: ModalDialog keeps one stack and draws from it.
 */

export interface DialogStack {
  /** Opens `id` (again, it moves to the top of its rank). */
  open(id: number, overAll: boolean): void
  close(id: number): void
  /** The dialog on top, or undefined when none is open. */
  top(): number | undefined
  /** Where `id` stands from the bottom, 0 first; -1 when it is not open. */
  depth(id: number): number
}

/** The levels a dialog may rise above `--z-dialog`, and no further: `--z-toast` is 10 above it (foundations.md). */
export const MAX_DIALOG_LIFT = 9

export function createDialogStack(): DialogStack {
  let opened = 0
  const entries = new Map<number, { overAll: boolean; at: number }>()

  const ordered = (): number[] =>
    [...entries.entries()]
      .sort(([, a], [, b]) => Number(a.overAll) - Number(b.overAll) || a.at - b.at)
      .map(([id]) => id)

  return {
    open(id, overAll) {
      entries.set(id, { overAll, at: ++opened })
    },
    close(id) {
      entries.delete(id)
    },
    top() {
      return ordered().at(-1)
    },
    depth(id) {
      return ordered().indexOf(id)
    }
  }
}
