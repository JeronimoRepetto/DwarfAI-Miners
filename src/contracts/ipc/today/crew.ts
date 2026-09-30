// Today's shapes of the legacy crew rows (14 §2.1 A-18; the two §8 I-21 legacy rows `dwarf:setName` and
// `dwarf:resetName`, AMENDMENT-12): all RETIRE, so each target schema is this today schema.
import { z } from 'zod'
import { legacyStringSchema } from './common'

/** A-18 request (`DwarfTuningRequest`). */
export const dwarfTuningRequestSchema = z
  .object({
    dwarfId: legacyStringSchema,
    change: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('model'), model: legacyStringSchema }).strict(),
      z.object({ kind: z.literal('effort'), effort: legacyStringSchema }).strict()
    ])
  })
  .strict()

/** A-18 response (`DwarfTuningResult`). */
export const dwarfTuningResultSchema = z.discriminatedUnion('applied', [
  z.object({ applied: z.literal(true) }).strict(),
  z.object({ applied: z.literal(false), reason: legacyStringSchema }).strict()
])

/** `dwarf:setName` request (`DwarfNameRequest`, §8 I-21). */
export const dwarfNameRequestSchema = z
  .object({ dwarfId: legacyStringSchema, name: legacyStringSchema })
  .strict()

/** `dwarf:setName` and `dwarf:resetName` response (`DwarfNameResult`, §8 I-21). */
export const dwarfNameResultSchema = z.discriminatedUnion('saved', [
  z.object({ saved: z.literal(true), customName: legacyStringSchema.optional() }).strict(),
  z.object({ saved: z.literal(false), reason: legacyStringSchema }).strict()
])
