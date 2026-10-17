// Seam-B types of the crew rows (14 §3.4, §3.5): the B-F10 `dwarf.departed` cause, the B-M21
// `crew.stop` params and result, and the B-M22 `crew.rename` and B-M23 `crew.resetName` params and
// result.
import { z } from 'zod'
import { dwarfIdSchema, type DwarfId } from '../../wire'
import { outcomeSchema, type Outcome } from '../errors'
import { requestIdSchema } from '../requestId'

// As 06 §0.2 writes it (crew `DepartureCause`, VO): the `sessionClosed` causes plus the two recovery ones (OQ-43)
export type DepartureCause =
  | 'stopped'
  | 'mine-removed'
  | 'closed-elsewhere'
  | 'crashed'
  | 'recovery-dismissed'
  | 'recovery-failed'

export const departureCauseSchema = z.enum([
  'stopped',
  'mine-removed',
  'closed-elsewhere',
  'crashed',
  'recovery-dismissed',
  'recovery-failed'
])

// As 14 §3.4 writes them (names, fields and comments; layout by prettier): crew, B-M21, B-M22, B-M23
export interface StopDwarfParams {
  dwarfId: DwarfId
  requestId: string
}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty value as {}
export type StopDwarfResult = Outcome<{}, 'already-stopping' | 'could-not-end'> // AMENDMENT-2 (OQ-54): an open turn is not a refusal
export interface RenameDwarfParams {
  dwarfId: DwarfId
  name: string
  requestId: string
} // trimmed, collapsed, 1..24 (06 DwarfName)
export type RenameDwarfResult = Outcome<{ customName: string | null }, 'empty'> // null: the name equals baseName after normalization → Reset name (US-MSG-005; AMENDMENT-2, SC-AR-05)
export interface ResetDwarfNameParams {
  dwarfId: DwarfId
  requestId: string
}

/** B-M21 params (ADR-019 strict()): no member interrupts only the turn (OQ-49, OQ-54), so no mode. */
export const stopDwarfParamsSchema = z
  .object({ dwarfId: dwarfIdSchema, requestId: requestIdSchema })
  .strict()

/** B-M21 result: `{}` once the session ended, else one of the two refusals (AMENDMENT-2). */
export const stopDwarfResultSchema = outcomeSchema(
  z.object({}).strict(),
  z.enum(['already-stopping', 'could-not-end'])
)

/**
 * Package gap (14 is silent): the raw text a rename may carry before the Host normalizes it, so the
 * schema refuses an oversized string (14 §6.5 "Schemas"; ADR-019 Verification "Fuzz"). 256 UTF-16
 * units are far above 24 graphemes with their combining marks, white space and the emoji the Host
 * drops, so every text a person can type or paste into the field still reaches the Host's rule.
 */
export const DWARF_NAME_WIRE_MAX_CHARS = 256

/**
 * B-M22 params (ADR-019 strict()). The name is any text on the wire: its `DwarfName` normalization
 * (06 §5.1), the `'empty'` outcome and the rule that the base name is a reset are the Host's
 * (16 §4.2 `CrewCommands.rename`), re-checked there after UI main (NFR-SEC-08). The params are
 * sensitive (14 §3.5 SENSITIVE_METHODS: a custom name is never logged, INV-29).
 */
export const renameDwarfParamsSchema = z
  .object({
    dwarfId: dwarfIdSchema,
    name: z.string().max(DWARF_NAME_WIRE_MAX_CHARS),
    requestId: requestIdSchema
  })
  .strict()

/** B-M22 result: the stored custom name, `null` when the name was the base name (SC-AR-05). */
export const renameDwarfResultSchema = outcomeSchema(
  z.object({ customName: z.string().nullable() }).strict(),
  z.literal('empty')
)

/** B-M23 params (ADR-019 strict()). */
export const resetDwarfNameParamsSchema = z
  .object({ dwarfId: dwarfIdSchema, requestId: requestIdSchema })
  .strict()
