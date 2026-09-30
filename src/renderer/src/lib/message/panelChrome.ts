/*
 * The redesigned MessagePanel's chrome (#635), `organisms/message-panel` in the design: the meta
 * chips under the name, the turn outcome line under the header, the day divider over the log, the
 * mark a bubble wears, and the ⋯ menu with the confirmation Stop dwarf… asks first. The panel
 * draws; this decides the words, from facts the dwarf already carries and nothing else.
 */
import { compactSilence, providerLabel } from '../dwarf/dwarfTip'
import type { KickBlocked } from '../delivery/actionBar'
import type { DeliveryMarker } from '../delivery/deliveryVerdict'
import type { MenuEntry, MenuItem } from '../overlay/menu'
import { sceneDwarfStatus } from '../scene/sceneDwarf'
import { dwarfWorkplaceLabel } from '../worktree'
import { finishedTurnWord } from './turnOutcome'
import type { Dwarf } from '../../types'

/**
 * The two meta chips (components.md, MessagePanel, Anatomy): "provider · model · effort", and
 * "worktree: <branch>" for a dwarf working in a worktree of the mine. A fact nobody reported is
 * left out rather than guessed, as the dwarf tooltip does; a dwarf in the mine's own folder has no
 * worktree chip, as it had no worktree label (#348).
 */
export function messagePanelChips(
  dwarf: Pick<Dwarf, 'provider' | 'model' | 'effort' | 'workplace'>
): string[] {
  const tuning = [providerLabel(dwarf.provider), dwarf.model, dwarf.effort]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ')
  const worktree = dwarfWorkplaceLabel(dwarf.workplace)
  return worktree === '' ? [tuning] : [tuning, 'worktree: ' + worktree]
}

/** The status square the outcome line draws: green working, brass asking, steel asleep. */
export type OutcomeStatus = 'working' | 'asking' | 'asleep'

export interface MessagePanelOutcome {
  status: OutcomeStatus
  text: string
  /**
   * What the line leaves out, for its tooltip (MESSAGE-QUESTIONS 9, 18): a finished turn's closing
   * words, trimmed, or the provider's own word for a turn that ended badly. Absent when there is
   * nothing to add, and then the line has no tooltip.
   */
  tip?: string
}

/** How much of a turn's closing words the outcome line's tooltip carries (MESSAGE-QUESTIONS 9). */
export const OUTCOME_TIP_MAX_CHARS = 200

/*
 * The status sentence a turn that ended badly opens its tooltip with, before the provider's own
 * word (MESSAGE-QUESTIONS 9 and 18).
 */
const ENDED_SENTENCE = {
  capped: 'Stopped at a limit',
  errored: 'Failed',
  interrupted: 'Interrupted'
} as const

/*
 * The tooltip's words for a finished turn. A concluded turn's closing words, trimmed to 200
 * characters with an ellipsis, cut on a whole character. A turn that ended badly gives its status
 * sentence, a colon and the provider's word, verbatim ("Stopped at a limit: error_max_turns",
 * "Failed: <detail>", "Interrupted: <detail>"). With no provider word there is none: the line
 * already says "Turn failed" or "Turn interrupted", and the tooltip would only repeat it.
 */
function outcomeTip(lastTurn: Dwarf['lastTurn']): string | undefined {
  if (lastTurn === undefined) return undefined
  if (lastTurn.kind !== 'concluded') {
    const detail = lastTurn.detail
    return detail === undefined || detail === ''
      ? undefined
      : ENDED_SENTENCE[lastTurn.kind] + ': ' + detail
  }
  const words = Array.from(lastTurn.text?.trim() ?? '')
  if (words.length === 0) return undefined
  if (words.length <= OUTCOME_TIP_MAX_CHARS) return words.join('')
  return words.slice(0, OUTCOME_TIP_MAX_CHARS).join('') + '…'
}

/*
 * The turn outcome line (screens/message.md, W4·2; decision log, Turn outcome line): built only
 * from what the app observes, in up to three parts joined by " · ", and a part the app cannot stand
 * behind is left out.
 *
 * 1. The status word. An asking dwarf waits on you, first, because that is what the person has to
 *    act on; a working one is "Working"; any other has finished its turn, in the word for how it
 *    ended (finishedTurnWord).
 * 2. The count the app observes: what the ask carries ("3 questions", "permission"), or the steps
 *    of the run it counts (countedRunSteps), "so far" while the dwarf works. No run, no count.
 * 3. For a finished turn only, how long ago it ended, from the turn outcome's own end time
 *    (`lastTurn.endedAt`), written as the dwarf tooltip writes a silence and on to days
 *    (compactSilence: "41m", "2h", "7d"; MESSAGE-QUESTIONS 10). A session the app only observes
 *    reports no end, so it says nothing of one.
 *
 * `now` is the caller's clock, so the idle time is as fresh as the caller keeps it.
 */
export function messagePanelOutcome(
  dwarf: Pick<Dwarf, 'status' | 'waitingReason' | 'pendingQuestion' | 'lastTurn'>,
  steps: number | undefined,
  now: number
): MessagePanelOutcome {
  const scene = sceneDwarfStatus(dwarf)
  if (scene === 'asking') {
    const count = dwarf.pendingQuestion?.questions.length ?? 0
    const what =
      dwarf.pendingQuestion === undefined
        ? 'permission'
        : count === 1
          ? '1 question'
          : count + ' questions'
    return { status: 'asking', text: 'Waiting on you · ' + what }
  }
  const counted = steps === undefined ? undefined : steps + (steps === 1 ? ' step' : ' steps')
  if (scene === 'working') {
    const parts = ['Working', counted === undefined ? undefined : counted + ' so far']
    return { status: 'working', text: joinParts(parts) }
  }
  const ended = dwarf.lastTurn?.endedAt
  const idle =
    ended === undefined ? undefined : 'idle for ' + compactSilence(now - ended, { days: true })
  const text = joinParts([finishedTurnWord(dwarf.lastTurn), counted, idle])
  const tip = outcomeTip(dwarf.lastTurn)
  return tip === undefined ? { status: 'asleep', text } : { status: 'asleep', text, tip }
}

const joinParts = (parts: readonly (string | undefined)[]): string =>
  parts.filter((part): part is string => part !== undefined).join(' · ')

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

/**
 * The day divider over the messages of one day (`.dm-msg__day`): "TODAY" for today, the design's
 * word, and the month and day, spelled by hand so no locale moves it, for any other. Null for a
 * message the transcript gave no time, which starts no day.
 */
export function dayLabel(epochMs: number, now: number): string | null {
  if (!Number.isFinite(epochMs)) return null
  const day = new Date(epochMs)
  if (sameDay(day, new Date(now))) return 'TODAY'
  return MONTHS[day.getMonth()] + ' ' + day.getDate()
}

export type BubbleMarkName = 'pending' | 'delivered' | 'reacted' | 'failed'

export interface BubbleMark {
  mark: BubbleMarkName
  glyph: string
  title: string
}

const MARK_OF: Record<string, BubbleMarkName> = {
  'is-sending': 'pending',
  'is-delivered': 'delivered',
  'is-reacted': 'reacted',
  'is-failed': 'failed'
}

/**
 * A delivery marker as the bubble wears it (`.dm-bubble__mark`): the same reading the sprite's
 * marker is drawn from (sendMarker, #21), so the two never say different things. A failure is
 * spelled "✕ not delivered" as the design writes it, and its reason stays on the title.
 */
export function bubbleMark(marker: DeliveryMarker): BubbleMark {
  const mark = MARK_OF[marker.cls] ?? 'pending'
  return { mark, glyph: mark === 'failed' ? '✕ not delivered' : marker.glyph, title: marker.title }
}

/*
 * Why Stop dwarf… cannot act, as its title says it (MESSAGE-QUESTIONS 13), in the house form
 * "<action> · <reason>". The open turn's is OPEN_TURN_NO_INTERRUPT_HINT, shortened.
 */
const STOP_BLOCKED_TITLE: Record<KickBlocked, string> = {
  'open-turn': 'Stop dwarf · this turn can only be stopped where its session runs',
  stopping: 'Stop dwarf · already stopping'
}

/** What a row of the ⋯ menu leads to. */
export type MessagePanelAction = 'console' | 'history' | 'reset-name' | 'stop'

/*
 * The ⋯ menu's rows, each with the action it leads to: one list, so a row and what picking it does
 * can never drift apart when Reset name comes and goes.
 */
function menuRows(
  stopBlocked: KickBlocked | null,
  hasCustomName: boolean
): { entry: MenuEntry; action?: MessagePanelAction }[] {
  const stop: MenuItem =
    stopBlocked === null
      ? { label: 'Stop dwarf…', danger: true, disabled: false }
      : {
          label: 'Stop dwarf…',
          danger: true,
          disabled: true,
          title: STOP_BLOCKED_TITLE[stopBlocked]
        }
  return [
    { entry: { label: 'Open console', icon: 'console' }, action: 'console' },
    { entry: { label: 'Mine history', icon: 'history' }, action: 'history' },
    ...(hasCustomName
      ? [{ entry: { label: RESET_NAME_LABEL }, action: 'reset-name' as const }]
      : []),
    { entry: { separator: true } },
    { entry: stop, action: 'stop' }
  ]
}

/** The ⋯ menu's row that takes a dwarf's custom name away (molecules/menu). */
export const RESET_NAME_LABEL = 'Reset name'

/**
 * The ⋯ menu (components.md, MessagePanel, Anatomy): Open console, Mine history, Reset name while
 * the dwarf has a custom name, a rule, then Stop dwarf… as danger. Reset name sits above the rule,
 * apart from Stop dwarf… (decision log, Dwarf names): it acts at once, goes back to the base name
 * and confirms nothing, so it is no danger item. Stop is never hidden, so the menu keeps one shape
 * for every dwarf; it is disabled, with its reason as its title, only in the kick's own two cases
 * (`kickBlocked`), and an idle session the app only observes can still be stopped
 * (MESSAGE-QUESTIONS 13).
 */
export function messagePanelMenu(
  stopBlocked: KickBlocked | null,
  hasCustomName = false
): MenuEntry[] {
  return menuRows(stopBlocked, hasCustomName).map((row) => row.entry)
}

/** What picking the row at `index` of `messagePanelMenu` does; undefined for the rule. */
export function messagePanelMenuAction(
  index: number,
  hasCustomName = false
): MessagePanelAction | undefined {
  return menuRows(null, hasCustomName)[index]?.action
}

/** The composer's hint line when it has nothing else to say (screens/message.md, W4·5). */
export const COMPOSER_HINT = 'Enter sends · Shift+Enter new line · drop files to attach'

/**
 * Where each menu row stands in `messagePanelMenu` for a dwarf with no custom name. Reset name,
 * when it is there, stands at MENU_RESET_NAME and moves Stop dwarf… one row down: read a pick
 * through `messagePanelMenuAction` rather than these.
 */
export const MENU_CONSOLE = 0
export const MENU_HISTORY = 1
export const MENU_STOP = 3
export const MENU_RESET_NAME = 2

/** The confirmation Stop dwarf… asks first (screens/message.md, As built). */
export function stopDwarfTitle(name: string): string {
  return 'Stop ' + name + '?'
}

export const STOP_DWARF_BODY =
  'The session ends and the dwarf walks out. The conversation stays in the mine history.'
