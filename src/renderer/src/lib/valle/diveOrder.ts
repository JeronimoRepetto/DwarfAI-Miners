/*
 * The dive's tab order (07 S29.12; US-VALLE-002.AC02…AC04, AC09; decision "Dive tab order"; ISSUE-301) and the
 * `diveForDwarfId` rule (07 S28.03). Pure: the pin set of ISSUE-302 (`pins.ts`) applies the order through its injected
 * dive-order parameter, bound by `useVallePins`; `pins.ts` never imports this file (review R8B-16), and this file
 * reads the pins through its own structural types, so neither depends on the other.
 */
import type { DwarfId, MineId } from '@dwarfai/contracts'

/** A pin as the order reads and returns it: a dwarf's chat, or a mine's Add panel. */
export type DivePin =
  | { readonly kind: 'chat'; readonly dwarfId: DwarfId; readonly mineId: MineId }
  | { readonly kind: 'add'; readonly mineId: MineId }

/** The pins in their order, the mine dived into, and the dwarf the dive is for. */
export interface DiveOrderInput {
  readonly pins: readonly DivePin[]
  readonly mineId: MineId
  readonly forDwarfId: DwarfId | null
}

type PinRef = DivePin

/** What the order reads of the mine dived into, besides the pins. */
export interface DiveOrderFacts {
  /** The mine's dwarfs waiting on the person, each with when its question was asked. */
  readonly needing: readonly { readonly dwarfId: DwarfId; readonly askedAt: number }[]
  /** 07 N-16: the chat last talked to in this mine since Valle opened (the start-up pin counts), if any. */
  readonly talkedTo: DwarfId | null
  /** The mine's crew, in crew order. */
  readonly crew: readonly DwarfId[]
}

const keyOf = (ref: PinRef): string => (ref.kind === 'chat' ? ref.dwarfId : `add:${ref.mineId}`)

/**
 * S29.12: the dwarf the dive is for; then the mine's needing dwarfs, oldest question first; then the one last talked to
 * in that mine; then the rest of its crew in crew order; then the mine's other pins (a chat whose dwarf left, its Add
 * panel) in their order; then the pins of other mines, keeping their relative order. Each pin once; every crew member
 * is in the order, so the pin set pins the ones not yet pinned. A dwarf placed by an earlier step is not placed again.
 */
export function diveOrder(input: DiveOrderInput, facts: DiveOrderFacts): readonly PinRef[] {
  const { pins, mineId } = input
  const placed = new Map<string, PinRef>()
  const own = (dwarfId: DwarfId): PinRef | null => {
    const pinned = pins.find((ref) => ref.kind === 'chat' && ref.dwarfId === dwarfId)
    if (pinned !== undefined) return pinned.mineId === mineId ? pinned : null
    return facts.crew.includes(dwarfId) ? { kind: 'chat', dwarfId, mineId } : null
  }
  const place = (ref: PinRef | null): void => {
    if (ref !== null && !placed.has(keyOf(ref))) placed.set(keyOf(ref), ref)
  }
  if (input.forDwarfId !== null) place(own(input.forDwarfId))
  for (const { dwarfId } of [...facts.needing].sort((a, b) => a.askedAt - b.askedAt)) {
    place(own(dwarfId))
  }
  if (facts.talkedTo !== null) place(own(facts.talkedTo))
  for (const dwarfId of facts.crew) place(own(dwarfId))
  for (const ref of pins) if (ref.mineId === mineId) place(ref)
  for (const ref of pins) place(ref)
  return [...placed.values()]
}

/** How the chat in focus came to be focused (07 S28.03). */
export type DiveFocusOrigin = 'queue' | 'handover' | 'named-pick' | 'other'

/** The chat in focus when a dive starts, and how it was focused. */
export interface DiveFocus {
  readonly dwarfId: DwarfId
  readonly mineId: MineId
  readonly from: DiveFocusOrigin
}

/**
 * S28.03: the dwarf a dive is for, the chat in focus when it was focused from the needs-you queue, handed over from the
 * Panel or Veta, or picked with a named dwarf, and belongs to the mine dived into; else `null`.
 */
export function diveForDwarfId(focus: DiveFocus | null, mineId: MineId): DwarfId | null {
  if (focus === null || focus.from === 'other' || focus.mineId !== mineId) return null
  return focus.dwarfId
}
