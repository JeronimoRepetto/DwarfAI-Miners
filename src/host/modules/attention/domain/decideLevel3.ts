// The level-3 rule of the attention ladder (ADR-018 items 1–4, 9; 05 §3.11; 07 machine 17; 06 §14.1).
// Pure: no I/O, no clock read, no timer (R1, BR-02); every instant is passed in.
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, MineId, Result } from '../../../kernel/domain/values'

// ---- ADR-018 "Host side (pure; module attention)"; ADR-018 wins on any difference ----
export type AttentionKind = 'permission' | 'question' | 'turn-finished' // unchanged; no Host-crash kind
export interface AttentionFact {
  key: string // `${dwarfId}:${kind}:${askId | turnKey}`
  kind: AttentionKind
  dwarfId: DwarfId
  mineId: MineId
  at: number
  reannounce: boolean // from ADR-010 AskRecord.reannounce; always true for turn-finished facts
  replacesKey?: string // pre-crash key of the same need, withdrawn together with this one (ADR-015 item 5)
}
export interface Presence {
  // union over attached UI clients (ADR-024 D7)
  anyUiAttached: boolean // set by the Host from its own connection registry (not reported by the UI): at least
  // one 'ui' connection, i.e. a window is open; false = app closed (PO #75)
  anyWindowVisible: boolean
  onScreenMineIds: ReadonlySet<MineId>
  seq: number
}
export interface Level3Decision {
  show?: OsNotification
  withdraw?: readonly string[] /* keys */
}
export interface OsNotification {
  key: string
  kind: AttentionKind
  title: string // PO #44 template with customName ?? baseName
  body: string // mine display name
  mineId: MineId
  dwarfId: DwarfId
  sensitive: true // never logged (ADR-026)
}
// ---- end of the ADR-018 block ----

/**
 * The names a level-3 notification shows, resolved at emit time by the `host/wiring` route that
 * calls `onFact` (lead decision 2026-09-30, ISSUE-109): `attention` has no edge to `crew` or `mines`
 * (05 §1.3). `dwarfDisplayName` is crew's `customName ?? baseName` (OQ-27, INV-104).
 */
export interface Level3Names {
  dwarfDisplayName: string
  mineName: string
}

/** Machine 17 states (07 §17; 06 §14.1 `AttentionKey`). */
export type AttentionKeyState = 'gated' | 'emitted' | 'suppressed' | 'withdrawn'

/** What the level-3 gate reads besides the fact (ADR-018 item 2). */
export interface Level3Gate {
  prefs: { systemNotificationsOn: boolean }
  presence: Presence
}

/** What machine 17 reacts to (07 §17 transitions). */
export type AttentionKeyEvent =
  /** S17.01, S17.02 (`reannounce: false`), S17.08 (turn finished with no `ui` attached): a new fact. */
  | { type: 'fact'; fact: AttentionFact; gate: Level3Gate; emitted: ReadonlySet<string> }
  /** S17.03, S17.08: presence or the preference changed while the fact is still open. */
  | { type: 'gate-changed'; fact: AttentionFact; gate: Level3Gate }
  /** S17.04, S17.05, S17.09: the fact ended. */
  | { type: 'fact-ended' }
  /** S17.06: `attention.clicked`, a counter only. */
  | { type: 'clicked' }
  /** S17.07: a Host restart; a persisted key is never re-emitted. */
  | { type: 'host-restarted' }

/** Why machine 17 takes no transition: the key was already decided, or 07 lists no such transition. */
export type AttentionKeyRefusal = 'already-decided' | 'not-listed'

/** One transition of machine 17; `undefined` is `[*]`, a key not decided yet. */
export function nextAttentionKey(
  state: AttentionKeyState | undefined,
  event: AttentionKeyEvent
): Result<AttentionKeyState, AttentionKeyRefusal> {
  switch (state) {
    case undefined:
      if (event.type !== 'fact') return NOT_LISTED
      // INV-100: once per key; S17.07: a persisted key (emitted or suppressed) is never decided again.
      if (event.emitted.has(event.fact.key)) return { ok: false, error: 'already-decided' }
      // S17.02, INV-103: a need re-raised after a silent resume was already announced (ADR-018 item 3).
      if (!event.fact.reannounce) return to('suppressed')
      return to(level3Gate(event.fact, event.gate)) // S17.01, S17.08
    case 'gated':
      if (event.type === 'gate-changed') return to(level3Gate(event.fact, event.gate)) // S17.03, S17.08
      return event.type === 'fact-ended' ? to('withdrawn') : NOT_LISTED // S17.04
    case 'emitted':
      if (event.type === 'clicked' || event.type === 'host-restarted') return to('emitted') // S17.06, S17.07
      return event.type === 'fact-ended' ? to('withdrawn') : NOT_LISTED // S17.05
    case 'suppressed':
      return event.type === 'fact-ended' ? to('withdrawn') : NOT_LISTED // S17.09
    case 'withdrawn':
      return NOT_LISTED
  }
}

const NOT_LISTED = { ok: false, error: 'not-listed' } as const

function to(state: AttentionKeyState): Result<AttentionKeyState, AttentionKeyRefusal> {
  return { ok: true, value: state }
}

/**
 * ADR-018 item 2 for an open fact, also when its gate is re-evaluated (S17.03): `suppressed` is
 * terminal for notifying, `gated` waits. A finished turn needs an attached `ui` client, so a gated
 * one is suppressed when the last window closes and can never open because a window re-attached
 * (S17.08). "On screen" is the union the UI clients reported; a hidden window reports none.
 */
function level3Gate(fact: AttentionFact, { prefs, presence }: Level3Gate): AttentionKeyState {
  if (fact.kind === 'turn-finished' && !presence.anyUiAttached) return 'suppressed'
  if (!prefs.systemNotificationsOn) return 'gated'
  if (presence.onScreenMineIds.has(fact.mineId)) return 'gated'
  return 'emitted'
}

/**
 * The level-3 fact of a turn end, or none: an inferred end or one cancelled from the app gets no key
 * (07 S17.02; INV-102; ADR-021 item 3: silence alone is never a finished turn, PO #78). The mine is
 * resolved by the caller, since a `TurnEnded` names only the dwarf.
 */
export function turnFinishedFact(turn: TurnEnded, mineId: MineId): AttentionFact | undefined {
  if (turn.reliability !== 'reliable' || turn.cancelledFromApp) return undefined
  return {
    key: `${turn.dwarfId}:turn-finished:${turn.turnKey}`,
    kind: 'turn-finished',
    dwarfId: turn.dwarfId,
    mineId,
    at: turn.at,
    reannounce: true
  }
}

/**
 * The Host's `Presence`: the union of what every attached UI client reported (ADR-018 item 2,
 * ADR-024 D7). `anyUiAttached` comes from the Host's own registry, here the reports it holds.
 */
export function unionPresence(reports: readonly Presence[]): Presence {
  return {
    anyUiAttached: reports.length > 0,
    anyWindowVisible: reports.some((r) => r.anyWindowVisible),
    onScreenMineIds: new Set(reports.flatMap((r) => [...r.onScreenMineIds])),
    seq: Math.max(0, ...reports.map((r) => r.seq))
  }
}

/** PO #44 titles, with `<dwarf>` = `customName ?? baseName` at emit time (ADR-018 item 9, INV-104). */
export function level3Title(kind: AttentionKind, displayName: string): string {
  switch (kind) {
    case 'permission':
      return `${displayName} asks for permission`
    case 'question':
      return `${displayName} has a question`
    case 'turn-finished':
      return `${displayName} finished the turn`
  }
}

/**
 * ADR-018's `decideLevel3` for a new fact: `show` iff every item-2 condition holds (machine 17
 * S17.01); a fact with `reannounce === false` is treated as already emitted. The names come beside
 * the fact (lead decision 2026-09-30). The `{ ended }` form, the withdrawal, lands with ISSUE-110.
 */
export function decideLevel3(
  fact: AttentionFact,
  prefs: { systemNotificationsOn: boolean },
  presence: Presence,
  emitted: ReadonlySet<string>,
  names: Level3Names
): Level3Decision {
  const next = nextAttentionKey(undefined, {
    type: 'fact',
    fact,
    gate: { prefs, presence },
    emitted
  })
  return next.ok && next.value === 'emitted' ? { show: osNotification(fact, names) } : {}
}

/** The notification of an emitted fact: PO #44 title, the mine's name as body (ADR-018 item 9). */
export function osNotification(fact: AttentionFact, names: Level3Names): OsNotification {
  return {
    key: fact.key,
    kind: fact.kind,
    title: level3Title(fact.kind, names.dwarfDisplayName),
    body: names.mineName,
    mineId: fact.mineId,
    dwarfId: fact.dwarfId,
    sensitive: true
  }
}
