// ADR-010 item 10's attribution rule and ADR-012 item 3's late-Deny status line, as pure data and
// rules (05 §2.2, R1: no I/O, no clock read; the caller passes `now`).
//
// - Attribution: a channel whose resolution evidence cannot tell who answered (keystrokes) has its
//   injection recorded as `{askId, injectedAt, decision}`; a resolution observed within 10 s of the
//   injection is `answered-in-app` (07 S6.12), any other is `answered-elsewhere` (S6.11, no notice).
//   "Within" includes the 10 s mark itself (16 §2 constants: "Keystroke-channel attribution window,
//   10 s").
// - The late-Deny status line: a Deny answered through a channel whose capability record says
//   `staleAnswerSafe: false` may arrive after the person answered Yes in the terminal, and a late
//   `Esc` interrupts the running turn (13 FM-082). The broker attaches the line's key to the close of
//   that ask; its words are today's (BR-20 parity), owned by the renderer, never written here.
import type { AskChannel } from './ask'
import type { PermissionDecision } from './permissionOptions'

/** 16 §2 / 15 §1.3 "Keystroke attribution window": 10 000 ms (ADR-010 item 10). */
export const KEYSTROKE_ATTRIBUTION_WINDOW_MS = 10_000

/** The status line a closed Deny carries on a channel that is not stale-answer safe (ADR-012). */
export const LATE_DENY_STATUS_LINE = 'late-deny-interrupts-turn'
export type LateDenyStatusLine = typeof LATE_DENY_STATUS_LINE

/** The channel kinds whose resolution evidence cannot tell who answered (ADR-010 item 10). */
const ATTRIBUTED_CHANNELS: ReadonlySet<AskChannel> = new Set<AskChannel>(['hook-keystroke'])

/** What the broker records when it hands a decision to an attributed channel. */
export interface Injection {
  readonly injectedAt: number
  readonly decision: PermissionDecision
}

/** Whether a resolution on `channel` is attributed by the injection window. */
export function attributesByInjection(channel: AskChannel): boolean {
  return ATTRIBUTED_CHANNELS.has(channel)
}

/** Whether a resolution observed at `now` is DwarfAI's injection (S6.12) rather than elsewhere. */
export function answeredInAppBy(injection: Injection | undefined, now: number): boolean {
  if (injection === undefined) return false
  const since = now - injection.injectedAt
  return since >= 0 && since <= KEYSTROKE_ATTRIBUTION_WINDOW_MS
}

/** The status line of an ask closed in-app by `decision`, or null (ADR-012 item 3). */
export function lateDenyStatusLine(
  decision: PermissionDecision,
  staleAnswerSafe: boolean
): LateDenyStatusLine | null {
  return decision === 'deny' && !staleAnswerSafe ? LATE_DENY_STATUS_LINE : null
}
