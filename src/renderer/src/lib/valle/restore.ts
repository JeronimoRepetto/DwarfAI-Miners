/*
 * What Valle restores when it opens (07 S28.01, S28.02, S29.02, S18.05, S32.02, S30.13; ADR-024 items 1, 4; INV-117;
 * ISSUE-300): the stored preset and both layouts, the pins and the mosaic order, and the split wish. Pure.
 */
import type { DwarfId, MineId, UiPreferencesMap } from '@dwarfai/contracts'
import { defaultValleLayouts, type ValleLayouts, type ValleView, type VallePreset } from './preset'

/** What the Valle window read before its first paint (A-N20). */
export interface StoredValleView {
  readonly preset: VallePreset
  /** `null`: no layout stored (each preset's defaults apply). */
  readonly layout: ValleLayouts | null
}

/**
 * S28.01, S28.02: the stored preset (the Control room when none was ever stored, UI main answering its default) with
 * both stored layouts, or each preset's defaults when no layout was ever stored. A nav page is never restored.
 */
export function restoreValleView(stored: StoredValleView): ValleView {
  return { preset: stored.preset, page: null, layouts: stored.layout ?? defaultValleLayouts() }
}

/** A stored pin (14 §3.9 `pins`). */
export type StoredPin = NonNullable<UiPreferencesMap['pins']>[number]

/** A restored pin: `live` while its dwarf is alive, `gone` (read-only) once its session ended (machine 18). */
export interface RestoredPin {
  readonly dwarfId: DwarfId
  readonly mineId: MineId
  readonly state: 'live' | 'gone'
}

/** What a pin's restore reads of the Host's facts. */
export interface PinFacts {
  mineExists(mineId: MineId): boolean
  /** `alive`: the dwarf is present; `ended`: its session ended meanwhile; `deleted`: its row no longer exists. */
  dwarf(dwarfId: DwarfId): 'alive' | 'ended' | 'deleted'
}

/**
 * S29.02 (S18.05; INV-117): the stored pins in their order; a dwarf alive comes back `live`, a dwarf whose session
 * ended meanwhile comes back `gone`, read-only until the person closes it; a dwarf whose row no longer exists, or a pin
 * whose mine is gone, is dropped. `null` (never written) stays `null`: the start-up pins apply (S29.01).
 */
export function restorePins(
  pins: UiPreferencesMap['pins'],
  facts: PinFacts
): readonly RestoredPin[] | null {
  if (pins === null) return null
  const restored: RestoredPin[] = []
  for (const pin of [...pins].sort((a, b) => a.order - b.order)) {
    if (!facts.mineExists(pin.mineId)) continue
    const dwarf = facts.dwarf(pin.dwarfId)
    if (dwarf === 'deleted') continue
    restored.push({
      dwarfId: pin.dwarfId,
      mineId: pin.mineId,
      state: dwarf === 'alive' ? 'live' : 'gone'
    })
  }
  return restored
}

/** S32.02: the mosaic order as arranged, a mine that no longer exists dropped; `null` = the first mosaic applies. */
export function restoreMosaicOrder(
  order: UiPreferencesMap['valleMosaicOrder'],
  mineExists: (mineId: MineId) => boolean
): readonly MineId[] | null {
  return order === null ? null : order.filter(mineExists)
}

/** The split as machine 30 shows it: the wish re-evaluated against the room and the pins. */
export type ValleSplit = 'on' | 'suspended' | 'off'

/** Two chats side by side need this much room beside the mine (07 machine 30). */
export const VALLE_SPLIT_ROOM = 640

/**
 * S30.13: the persisted wish re-evaluated when Valle opens. Off stays off; on needs two pins (S30.10) and, with less
 * than 640 px of room beside the mine, is `suspended` (the wish kept). The room itself is machine 30's (ISSUE-303).
 */
export function restoreSplit(wish: boolean, facts: { pins: number; room: number }): ValleSplit {
  if (!wish || facts.pins < 2) return 'off'
  return facts.room >= VALLE_SPLIT_ROOM ? 'on' : 'suspended'
}
