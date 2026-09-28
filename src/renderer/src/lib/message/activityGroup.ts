import { sceneDwarfStatus } from '../scene/sceneDwarf'
import type { Dwarf } from '../../types'
import { conversationEnded, type PanelMessage } from './conversation'

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

/**
 * The design's own label for a folded run (#635; copy.md, Activity disclosure): "{stepsCount}
 * step[s] · activity". The redesigned mine history draws it; the MessagePanel keeps the label
 * below until its own slice rebuilds it.
 */
export function activityStepsLabel(count: number): string {
  return count + (count === 1 ? ' step' : ' steps') + ' · activity'
}

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
   * Whether nothing further can join this run — the dwarf has spoken since, a
   * later run started, or its turn is over (`ended`). The person's own words
   * after it never close it (#635). An open run is the agent still working; a
   * closed one is a finished stretch of work.
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

  // Only the LAST run can still be growing, and only while the conversation has somewhere for
  // another line to come from. The person's own words after it do not close it (#635; decision
  // log, Activity run closes on the dwarf): a message somebody sent is not the agent finishing,
  // delivered or not, so they are skipped on the way back, and only the dwarf speaking stops it.
  let growingIndex = -1
  for (let i = runs.length - 1; i >= 0 && !options.ended; i--) {
    const run = runs[i]!
    if (!('kind' in run)) {
      growingIndex = i
      break
    }
    if (run.message.from !== 'user') break
  }
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

/**
 * The steps of the run the turn outcome line counts (#635; decision log, Turn outcome line): the
 * last run with nothing the dwarf said after it, open or closed, the person's own words skipped as
 * they are for closing one. Undefined when the dwarf has spoken since its last run, or there is
 * none: with no run to count, the line leaves the count out rather than reach back past a reply.
 */
export function countedRunSteps(entries: readonly PanelEntry[]): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.kind === 'activity') return entry.rows.length
    if (entry.message.from !== 'user') return undefined
  }
  return undefined
}

/**
 * Whether the conversation's runs are over as far as `groupActivity`'s `ended` asks (#635;
 * components.md, Activity disclosure, As built): a run grows only while its turn is still going,
 * "the dwarf working, the session not ended". A dwarf asking, resting or leaving adds no steps, so
 * its last run reads as the finished stretch of work it is, with its count, never "Working...".
 */
export function runsHaveEnded(
  dwarf: Pick<Dwarf, 'status' | 'pendingQuestion' | 'waitingReason'>
): boolean {
  return conversationEnded(dwarf) || sceneDwarfStatus(dwarf) !== 'working'
}
