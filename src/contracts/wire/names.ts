// The notifier's names-only snapshot sections (14 §3.7; ADR-003 item 12): no path, no totals.
import { z } from 'zod'
import { dwarfIdSchema, mineIdSchema, type DwarfId, type MineId } from './ids'

/** 14 §3.7 `MineNameWire`: notifier only. */
export interface MineNameWire {
  id: MineId
  name: string
}

/** 14 §3.7 `DwarfNameWire`: `displayName` = customName ?? baseName (PO #88). */
export interface DwarfNameWire {
  id: DwarfId
  mineId: MineId
  displayName: string
}

export const mineNameWireSchema = z.object({ id: mineIdSchema, name: z.string() }).strict()

export const dwarfNameWireSchema = z
  .object({ id: dwarfIdSchema, mineId: mineIdSchema, displayName: z.string() })
  .strict()
