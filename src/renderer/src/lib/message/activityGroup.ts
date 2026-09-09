import type { PanelMessage } from './conversation'

/**
 * Consecutive tool calls, folded into one disclosure row (#294).
 *
 * #240 draws one line per tool call between the bubbles, and on a real session
 * an agent acts far more often than it speaks: thirty lines between two
 * replies fill the panel, and the conversation stops being readable at the
 * glance the monitor exists for. Nothing here hides any of it — every line is
 * still carried, in order, one press away.
 *
 * The rule lives in lib rather than in the two components that draw it for the
 * reason `conversation.ts` states about its own: where a run starts, where it
 * ends and what it is CALLED are decisions, and two readings of them would
 * eventually disagree between the message panel and the history tab.
 *
 * `PanelMessage` and the wire are untouched. A group is a rendering of rows
 * the wire already carried, which is why this file takes rows rather than
 * `FeedMessage`s and why it never invents one: `rows` holds the very objects
 * it was handed.
 */

/**
 * What an OPEN run says: no count, because the count is not final yet, and no
 * last verb, because the last verb is about to be another one. A number that
 * changes under a reader while it is being read is worse than no number.
 */
export const ACTIVITY_WORKING_LABEL = 'Working...'

/** One run of consecutive tool calls, drawn as a single disclosure row. */
export interface ActivityGroup<Row extends PanelMessage = PanelMessage> {
  kind: 'activity'
  /**
   * The run's own list key, and the handle its expanded/collapsed state hangs
   * on: the FIRST row's key, which is the one thing about a run that does not
   * change as the run grows.
   */
  key: string
  /** Every line of the run, in the order it happened. Never empty. */
  rows: Row[]
  /**
   * Whether nothing further can join this run — a spoken row already follows
   * it, or the session behind the conversation has ended. An open run is the
   * agent still working; a closed one is a finished stretch of work.
   */
  closed: boolean
  /** The one line the collapsed row shows. See ACTIVITY_WORKING_LABEL. */
  label: string
}

/** One thing that was SAID, drawn as the bubble it always was. */
export interface SpokenEntry<Row extends PanelMessage = PanelMessage> {
  kind: 'message'
  key: string
  message: Row
}

export type PanelEntry<Row extends PanelMessage = PanelMessage> =
  SpokenEntry<Row> | ActivityGroup<Row>

export interface GroupActivityOptions {
  /**
   * Whether the conversation is finished — a leaving dwarf (see
   * `conversationEnded`), or a record like the history tab, which is finished
   * by definition. Stated by the caller rather than guessed here: a trailing
   * run says "still working" only while there is a session left to work.
   */
  ended: boolean
}

function labelOf(rows: readonly PanelMessage[]): string {
  const count = rows.length
  // The last line rather than a verb of its own: the verb is already spelled
  // once, inside the line, by the table that owns it (#240).
  return `${count} ${count === 1 ? 'step' : 'steps'} — ${rows.at(-1)!.text}`
}

/**
 * Rows as the panel draws them: every run of consecutive activity rows folded
 * into one group, everything else left exactly as it was.
 *
 * A run of ONE is still a group. Drawing a single call as the bare line #240
 * drew and folding only from the second call on would change the shape of the
 * list under a reader mid-run — the same objection the panel already answers
 * by never resizing itself when a message arrives.
 */
export function groupActivity<Row extends PanelMessage>(
  rows: readonly Row[],
  options: GroupActivityOptions
): PanelEntry<Row>[] {
  const runs: (SpokenEntry<Row> | { key: string; rows: Row[] })[] = []
  for (const row of rows) {
    if (row.activity === undefined) {
      runs.push({ kind: 'message', key: row.key, message: row })
      continue
    }
    const open = runs.at(-1)
    if (open !== undefined && !('kind' in open)) {
      open.rows.push(row)
      continue
    }
    runs.push({ key: row.key, rows: [row] })
  }

  // Only the LAST entry can still be growing, and only while the conversation
  // has somewhere for another line to come from.
  const growingIndex = options.ended ? -1 : runs.length - 1
  return runs.map((run, index) => {
    if ('kind' in run) return run
    const closed = index !== growingIndex
    return {
      kind: 'activity',
      key: run.key,
      rows: run.rows,
      closed,
      label: closed ? labelOf(run.rows) : ACTIVITY_WORKING_LABEL
    }
  })
}
