import { WAITING_ON_HUMAN_REASON, type Dwarf, type Mine } from '../domain/types'

/**
 * Whether a system notification is owed, and what it should say (#316).
 *
 * A pure fold over two consecutive boards. Electron is never imported here —
 * the notification centre is a port (see notificationPort.ts) and the OS is the
 * one thing this file knows nothing about — so every rule the issue states is
 * assertable on any host: the two cases and no others, the dedupe key, the
 * focus condition, and the withdrawal.
 *
 * The whole decision is "which facts are NEW", which is why the memory is a
 * parameter rather than module state: a fold with its previous value passed in
 * can be replayed, and a test can state a three-poll sequence in three lines.
 */

/** Which of #316's two cases produced a notification; the third value is a turn end. */
export type MineNotificationKind = 'question' | 'permission' | 'turn-end'

export interface MineNotification {
  /**
   * The FACT this notification is about, and the reason it is never sent twice.
   *
   * (dwarf id, kind, and the toolUseId or the turn instant), exactly as #316
   * states it. A prompt that stays open across polls keeps its key and is
   * therefore never new again; a second tool call on the same dwarf carries its
   * own toolUseId and is a different fact.
   */
  key: string
  kind: MineNotificationKind
  /**
   * The whole of the copy. #316 words one sentence per case and no second line,
   * so nothing here invents a body: an OS notification already prints the app's
   * name above it, and a body would be this app writing copy nobody specified.
   */
  title: string
  /** The mine a click opens. Never a dwarf — see the click route in index.ts. */
  mineId: string
}

/**
 * What the panel is showing, from main's side.
 *
 * "Focused" is BOTH of these: the shell on screen AND that mine's interior open.
 * The map or the browse with no interior open is focused on no mine at all, so
 * every mine counts as unattended — which is the reading #316 spells out.
 */
export interface PanelFocus {
  /** The shell window visible and not minimised — main's own reading, never the page's. */
  panelVisible: boolean
  /** The mine whose interior the shell has open, or null when none is. */
  openMineId: string | null
}

/** Where a foreman was working, kept so a turn end can still name its mine after the dwarf is gone. */
interface ForemanPlace {
  mineId: string
  mineName: string
}

export interface NotifyMemory {
  /**
   * False until a board has been seen at all.
   *
   * The first board only SEEDS. "Newly present" is a statement about two
   * consecutive boards, and an app that opens on five outstanding asks has
   * discovered five old facts rather than witnessed five arrivals — firing for
   * them would make every launch a burst of notifications about work that was
   * already waiting.
   */
  readonly seeded: boolean
  /** Every ask key standing on the previous board, whether or not it was shown. */
  readonly openAsks: ReadonlySet<string>
  /** Every foreman that was `working` on the previous board, and where. */
  readonly workingForemen: ReadonlyMap<string, ForemanPlace>
}

export interface NotifyInput {
  mines: readonly Mine[]
  focus: PanelFocus
  /** Settings' switch. Off shows nothing; it does not stop the fold. */
  enabled: boolean
  /** The poll's clock, read only to make a turn end's key unique. */
  now: number
}

export interface NotifyDecision {
  show: MineNotification[]
  /**
   * Keys whose fact is gone. The adapter closes the ones it still holds, so a
   * question answered at the terminal takes its notification with it where the
   * platform allows.
   */
  withdraw: string[]
}

export function questionCopy(mineName: string): string {
  return `A question is waiting in ${mineName}`
}

export function permissionCopy(mineName: string): string {
  return `${mineName} is waiting for your approval`
}

export function turnEndCopy(mineName: string): string {
  return `${mineName} finished its turn`
}

export function emptyNotifyMemory(): NotifyMemory {
  return { seeded: false, openAsks: new Set(), workingForemen: new Map() }
}

/** One ask standing on a dwarf: which of the two kinds, and the key that identifies it. */
interface StandingAsk {
  kind: 'question' | 'permission'
  key: string
}

/**
 * What this dwarf is waiting on a human for, or nothing.
 *
 * At most ONE per dwarf, and the order is WAITING_ON_HUMAN_REASON's own
 * precedence rather than a preference: where both an ask and a permission are
 * open the session is blocked on the question, and two sentences about one dwarf
 * read as two dwarfs asking. The permission becomes new in its own right once
 * the question is answered, so nothing is lost by deferring it.
 *
 * A `leaving` dwarf is excluded outright, on the same reasoning approvalNote
 * holds in the renderer: the grace window freezes the last real snapshot, ask
 * and all, and there is nobody at the other end left to answer.
 */
function standingAsk(dwarf: Dwarf): StandingAsk | null {
  if (dwarf.status === 'leaving') return null
  if (dwarf.pendingQuestion !== undefined) {
    return { kind: 'question', key: `question:${dwarf.id}:${dwarf.pendingQuestion.toolUseId}` }
  }
  if (dwarf.pendingPermission !== undefined) {
    return { kind: 'permission', key: `permission:${dwarf.id}:${dwarf.pendingPermission.toolUseId}` }
  }
  // No structured record crossed, but the provider proved the session stopped
  // on a person. 'unknown' is deliberately absent from both branches: it is the
  // honest middle — blocked, with no condition this table recognises — and
  // treating it as either would be the panel claiming a thing it cannot know.
  if (dwarf.waitingReason === WAITING_ON_HUMAN_REASON) {
    return { kind: 'question', key: `question:${dwarf.id}:waiting` }
  }
  if (dwarf.waitingReason === 'approval') {
    return { kind: 'permission', key: `permission:${dwarf.id}:waiting` }
  }
  return null
}

function isFocused(mineId: string, focus: PanelFocus): boolean {
  return focus.panelVisible && focus.openMineId === mineId
}

export function decideNotifications(
  memory: NotifyMemory,
  input: NotifyInput
): { memory: NotifyMemory; decision: NotifyDecision } {
  const openAsks = new Set<string>()
  const workingForemen = new Map<string, ForemanPlace>()
  const show: MineNotification[] = []

  for (const mine of input.mines) {
    for (const dwarf of mine.dwarfs) {
      const ask = standingAsk(dwarf)
      if (ask !== null) {
        openAsks.add(ask.key)
        // Recorded whether or not it is shown, so walking OUT of a mine whose
        // ask was suppressed is not later read as the ask arriving.
        if (memory.seeded && !memory.openAsks.has(ask.key) && !isFocused(mine.id, input.focus)) {
          show.push({
            key: ask.key,
            kind: ask.kind,
            title: ask.kind === 'question' ? questionCopy(mine.name) : permissionCopy(mine.name),
            mineId: mine.id
          })
        }
      }
      if (dwarf.role === 'foreman' && dwarf.status === 'working') {
        workingForemen.set(dwarf.id, { mineId: mine.id, mineName: mine.name })
      }
    }
  }

  // A turn ended wherever a foreman that WAS working is not working now — a
  // status change, a departure from the board, and a dwarf the grace window is
  // walking out all count, because each of them is the turn being over. The
  // place is remembered rather than looked up, so a mine that emptied entirely
  // can still be named.
  if (memory.seeded) {
    for (const [dwarfId, place] of memory.workingForemen) {
      if (workingForemen.has(dwarfId)) continue
      if (isFocused(place.mineId, input.focus)) continue
      show.push({
        key: `turn:${dwarfId}:${input.now}`,
        kind: 'turn-end',
        title: turnEndCopy(place.mineName),
        mineId: place.mineId
      })
    }
  }

  // Only an ask is a STANDING fact with something to withdraw. An ended turn is
  // an instant: it does not stop having happened, so nothing ever closes it.
  const withdraw = [...memory.openAsks].filter((key) => !openAsks.has(key))

  return {
    memory: { seeded: true, openAsks, workingForemen },
    // The switch stops what is SHOWN and not the fold above it: memory advances
    // either way, so switching notifications back on does not fire the backlog
    // that accumulated while they were off. Withdrawals still travel, because
    // the adapter can only close what it is actually holding — and a switch
    // flipped mid-prompt must not strand a notification already on screen.
    decision: { show: input.enabled ? show : [], withdraw }
  }
}
