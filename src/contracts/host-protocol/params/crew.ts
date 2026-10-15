// Seam-B types of the crew rows (14 §3.4, §3.5): the B-F10 `dwarf.departed` cause, and the B-M22
// `crew.rename` and B-M23 `crew.resetName` params and result.
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

// As 14 §3.4 writes them (names, fields and comments; layout by prettier): crew, B-M22, B-M23
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

/**
 * B-M22 params (ADR-019 strict()). The name is any text on the wire: its `DwarfName` normalization
 * (06 §5.1), the `'empty'` outcome and the rule that the base name is a reset are the Host's
 * (16 §4.2 `CrewCommands.rename`), re-checked there after UI main (NFR-SEC-08). The params are
 * sensitive (14 §3.5 SENSITIVE_METHODS: a custom name is never logged, INV-29).
 */
export const renameDwarfParamsSchema = z
  .object({ dwarfId: dwarfIdSchema, name: z.string(), requestId: requestIdSchema })
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
