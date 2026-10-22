/*
 * What one Valle zone shows (07 machine 31; US-VALLE-009; UC-058; ADR-024 items 1, 4; ISSUE-304): its mine, the map, the
 * mines list (the Control room only) or the mine's history, swapped from the "⋯" in its header without leaving its slot.
 * Pure: the caller hands each input with the facts its guard reads, and carries out the effects (the A-N21 writes of
 * `valleLayout` and `mutedMineIds`, the dive, machine 32's close and reveal).
 *
 * - The menu for the preset (`zoneMenu`): "Dive in · Work front" (the Control room; disabled for a mine that cannot be
 *   entered), a rule, the "Show here: …" items (the mines list in the Control room only; the item shown now disabled
 *   and marked "✓"), a rule, the ambience toggle, and in the Control room a rule and "Close this column". A disabled
 *   item keeps its place (NFR-A11Y-14).
 * - The header notes what the zone shows now: "· Map", "· Mines", "· History", nothing for its mine (`zoneSuffix`).
 * - Esc or an outside click closes the menu and changes nothing else (S31.02).
 * - Only the transitions 07 machine 31 lists are taken; anything else is refused and changes nothing (ADR-024).
 */
import type { MineId, ZoneContent } from '@dwarfai/contracts'

/** The preset a zone lies in: a Control room column, or the Work front's one zone. */
export type ZonePreset = 'control' | 'front'

/** One zone: what it shows, and whether its menu is open over it (`menu-open`, the previous content kept). */
export interface ZoneState {
  readonly content: ZoneContent
  readonly menuOpen: boolean
}

/** A zone showing its mine, its menu closed: where every zone starts (07 machine 31 `[*] → mine`). */
export const ZONE_AT_REST: ZoneState = { content: 'mine', menuOpen: false }

/** What the person did in or for a zone, or what happened to its mine. */
export type ZoneInput =
  /** "⋯" in the zone header (S31.01). */
  | { readonly kind: 'menu' }
  /** Esc or an outside click with the menu open (S31.02). */
  | { readonly kind: 'dismiss' }
  /** A "Show here: …" item (S31.03…S31.06). */
  | { readonly kind: 'show'; readonly content: ZoneContent }
  /** "Dive in · Work front" (S31.07). */
  | { readonly kind: 'dive' }
  /** "Mute mine ambience" / "Mine ambience on" (S31.08). */
  | { readonly kind: 'ambience' }
  /** "Close this column" (S31.09). */
  | { readonly kind: 'close-column' }
  /** A map marker clicked in a zone showing the map (S31.10). */
  | { readonly kind: 'map-marker'; readonly mineId: MineId }
  /** A mine-history request from a chat in the Control room stack (S31.11). */
  | { readonly kind: 'history-request' }
  /** "Reset preset" (S31.12; machine 37). */
  | { readonly kind: 'reset-preset' }
  /** `MineRemoved` of the zone's mine (S31.13). */
  | { readonly kind: 'mine-removed' }
  /** Reset metrics (S31.14; S39.10). */
  | { readonly kind: 'reset-metrics' }

/** What a guard reads besides the zone. */
export interface ZoneFacts {
  readonly preset: ZonePreset
  /** The zone's mine can be entered (S31.07). */
  readonly enterable: boolean
  /** The zone's mine is in `mutedMineIds` (S31.08). */
  readonly muted: boolean
}

/** What the caller carries out after a transition. */
export type ZoneEffect =
  /** A-N21 `valleLayout`: the zone's content written at once. */
  | { readonly kind: 'write-content'; readonly content: ZoneContent }
  /** Machine 28's dive into the zone's mine (S28.03). */
  | { readonly kind: 'dive' }
  /** A-N21 `mutedMineIds`: the mine muted (`true`) or its ambience on again. */
  | { readonly kind: 'toggle-ambience'; readonly muted: boolean }
  /** Machine 32's "Close this column" (S32.03). */
  | { readonly kind: 'close-column' }
  /** Back to the mines and to that mine: its column added and scrolled to (S32.14), the Work front swapping (S28.15). */
  | { readonly kind: 'reveal'; readonly mineId: MineId }
  /** The zone left with its mine (S32.13, S28.23). */
  | { readonly kind: 'gone' }

export type ZoneStep =
  | {
      readonly ok: true
      /** The 07 machine 31 transition taken. */
      readonly id: string
      /** The zone after it; `null` once the zone is gone (S31.09, S31.13). */
      readonly zone: ZoneState | null
      readonly effects: readonly ZoneEffect[]
    }
  | { readonly ok: false; readonly reason: 'not-listed' }

/** A zone menu item, by what it does. */
export type ZoneMenuItemId =
  'dive' | 'show-mine' | 'show-map' | 'show-mineslist' | 'show-history' | 'ambience' | 'close'

/** One line of a zone's menu: an item, or a rule between groups. */
export type ZoneMenuEntry =
  | {
      readonly kind: 'item'
      readonly id: ZoneMenuItemId
      readonly label: string
      readonly disabled: boolean
      /** The content shown now ("✓"). */
      readonly checked: boolean
    }
  | { readonly kind: 'rule' }

/** The "Show here: …" item of each content, in the menu's order (`DS/docs/copy.md`, mine zone). */
const SHOW_HERE: readonly { readonly content: ZoneContent; readonly label: string }[] = [
  { content: 'mine', label: 'Show here: the mine' },
  { content: 'map', label: 'Show here: the map' },
  { content: 'mineslist', label: 'Show here: the mines list' },
  { content: 'history', label: 'Show here: history' }
]

/** What the header adds after the zone's name for what it shows now (07 machine 31 states). */
const SUFFIX: Readonly<Record<ZoneContent, string>> = {
  mine: '',
  map: '· Map',
  mineslist: '· Mines',
  history: '· History'
}

/** The header's suffix for `content`: nothing when the zone shows its mine. */
export function zoneSuffix(content: ZoneContent): string {
  return SUFFIX[content]
}

/** The zone's menu for its preset (07 machine 31 `menu-open`; US-VALLE-009.AC02, .AC04, .AC05). */
export function zoneMenu(content: ZoneContent, facts: ZoneFacts): ZoneMenuEntry[] {
  const control = facts.preset === 'control'
  const item = (id: ZoneMenuItemId, label: string, disabled = false, checked = false) =>
    ({ kind: 'item', id, label, disabled, checked }) as const
  const rule = { kind: 'rule' } as const
  const shows = SHOW_HERE.filter((show) => control || show.content !== 'mineslist').map((show) =>
    item(`show-${show.content}`, show.label, show.content === content, show.content === content)
  )
  const ambience = item('ambience', facts.muted ? 'Mine ambience on' : 'Mute mine ambience')
  if (!control) return [...shows, rule, ambience]
  return [
    item('dive', 'Dive in · Work front', !facts.enterable),
    rule,
    ...shows,
    rule,
    ambience,
    rule,
    item('close', 'Close this column')
  ]
}

/** The input a menu item picks. */
export function zoneInputOf(id: ZoneMenuItemId): ZoneInput {
  switch (id) {
    case 'dive':
      return { kind: 'dive' }
    case 'ambience':
      return { kind: 'ambience' }
    case 'close':
      return { kind: 'close-column' }
    default:
      return { kind: 'show', content: id.slice('show-'.length) as ZoneContent }
  }
}

const REFUSED: ZoneStep = { ok: false, reason: 'not-listed' }

function taken(id: string, zone: ZoneState | null, effects: readonly ZoneEffect[] = []): ZoneStep {
  return { ok: true, id, zone, effects }
}

/** The "Show here: …" transition of each content (S31.03…S31.06). */
const SHOW_ID: Readonly<Record<ZoneContent, string>> = {
  map: 'S31.03',
  mineslist: 'S31.04',
  history: 'S31.05',
  mine: 'S31.06'
}

/** `menu-open`: an item picked, or the menu dismissed. */
function stepMenu(zone: ZoneState, input: ZoneInput, facts: ZoneFacts): ZoneStep | null {
  const control = facts.preset === 'control'
  const closed: ZoneState = { content: zone.content, menuOpen: false }
  switch (input.kind) {
    case 'dismiss':
      return taken('S31.02', closed)
    case 'show': {
      // Guard: not shown now; the mines list in the Control room only.
      if (input.content === zone.content) return REFUSED
      if (input.content === 'mineslist' && !control) return REFUSED
      return taken(SHOW_ID[input.content], { content: input.content, menuOpen: false }, [
        { kind: 'write-content', content: input.content }
      ])
    }
    case 'dive':
      return control && facts.enterable ? taken('S31.07', closed, [{ kind: 'dive' }]) : REFUSED
    case 'ambience':
      return taken('S31.08', closed, [{ kind: 'toggle-ambience', muted: !facts.muted }])
    case 'close-column':
      return control ? taken('S31.09', null, [{ kind: 'close-column' }]) : REFUSED
    default:
      return null
  }
}

export function stepZone(zone: ZoneState, input: ZoneInput, facts: ZoneFacts): ZoneStep {
  // Any content, the menu open or not.
  if (input.kind === 'reset-preset') return taken('S31.12', ZONE_AT_REST)
  if (input.kind === 'reset-metrics') return taken('S31.14', ZONE_AT_REST)
  if (input.kind === 'mine-removed') return taken('S31.13', null, [{ kind: 'gone' }])

  if (zone.menuOpen) return stepMenu(zone, input, facts) ?? REFUSED

  if (input.kind === 'menu') return taken('S31.01', { content: zone.content, menuOpen: true })
  if (input.kind === 'map-marker' && zone.content === 'map') {
    return taken('S31.10', ZONE_AT_REST, [
      { kind: 'write-content', content: 'mine' },
      { kind: 'reveal', mineId: input.mineId }
    ])
  }
  if (input.kind === 'history-request' && zone.content === 'mine' && facts.preset === 'control') {
    return taken('S31.11', { content: 'history', menuOpen: false }, [
      { kind: 'write-content', content: 'history' }
    ])
  }
  return REFUSED
}
