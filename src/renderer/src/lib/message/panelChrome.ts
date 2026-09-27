/*
 * The redesigned MessagePanel's chrome (#635), `organisms/message-panel` in the design: the meta
 * chips under the name, the turn outcome line under the header, the day divider over the log, the
 * mark a bubble wears, and the ⋯ menu with the confirmation Stop dwarf… asks first. The panel
 * draws; this decides the words, from facts the dwarf already carries and nothing else.
 */
import { providerLabel } from '../dwarf/dwarfTip'
import type { DeliveryMarker } from '../delivery/deliveryVerdict'
import type { MenuEntry } from '../overlay/menu'
import { sceneDwarfStatus } from '../scene/sceneDwarf'
import { dwarfWorkplaceLabel } from '../worktree'
import { turnOutcomeLine } from './turnOutcome'
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
}

/*
 * The turn outcome line (screens/message.md, W4·2, "kept from today"): how the dwarf's last turn
 * ended, in today's words (turnOutcomeLine, #510), under the status square the design adds. An
 * asking dwarf says it waits on you first, because that is what the person has to act on, and a
 * permission names itself (copy.md, State: "Waiting on you · permission"). With nothing to say
 * about a turn, the line carries the state word the prototype prints when it has no outcome
 * ("Working", "Idle"). The sample's own outcome sentences are illustrative, and nothing the app
 * observes stands behind their step counts, so none of them is invented here.
 */
export function messagePanelOutcome(
  dwarf: Pick<Dwarf, 'status' | 'waitingReason' | 'pendingQuestion' | 'lastTurn'>
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
  const status: OutcomeStatus = scene === 'working' ? 'working' : 'asleep'
  const turn = turnOutcomeLine(dwarf.lastTurn)
  if (turn !== undefined) {
    const said = turn.text ? turn.headline + ': ' + turn.text : turn.headline
    // The wire cut the words at its bound (#510), and the line says so rather than passing it off.
    return { status, text: turn.trimmed ? said + ' (trimmed)' : said }
  }
  return { status, text: status === 'working' ? 'Working' : 'Idle' }
}

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

/**
 * The ⋯ menu (components.md, MessagePanel, Anatomy): Open console, Mine history, a rule, then Stop
 * dwarf… as danger. Reset name, which the design lists while a custom name is set, arrives with
 * the dwarf names slice. Stop is disabled where the session cannot be stopped, the kick's own
 * capability.
 */
export function messagePanelMenu(canStop: boolean): MenuEntry[] {
  return [
    { label: 'Open console', icon: 'console' },
    { label: 'Mine history', icon: 'history' },
    { separator: true },
    { label: 'Stop dwarf…', danger: true, disabled: !canStop }
  ]
}

/** The composer's hint line when it has nothing else to say (screens/message.md, W4·5). */
export const COMPOSER_HINT = 'Enter sends · Shift+Enter new line · drop files to attach'

/** Where each menu row leads, by its place in `messagePanelMenu`. */
export const MENU_CONSOLE = 0
export const MENU_HISTORY = 1
export const MENU_STOP = 3

/** The confirmation Stop dwarf… asks first (screens/message.md, As built). */
export function stopDwarfTitle(name: string): string {
  return 'Stop ' + name + '?'
}

export const STOP_DWARF_BODY =
  'The session ends and the dwarf walks out. The conversation stays in the mine history.'
