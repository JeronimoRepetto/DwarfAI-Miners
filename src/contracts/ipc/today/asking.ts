// Today's shapes of the rows owned by `asking` (14 §2.1 A-40, A-41, both CHANGE): the legacy answer payloads.
import { z } from 'zod'
import { legacyStringSchema } from './common'

const legacyAnswerMapSchema = z.record(legacyStringSchema, legacyStringSchema)

/** A-40 today request (`DwarfQuestionAnswerRequest`): labels picked per question, or one free text. */
export const dwarfQuestionAnswerRequestSchema = z.union([
  z
    .object({
      dwarfId: legacyStringSchema,
      toolUseId: legacyStringSchema,
      answers: legacyAnswerMapSchema,
      ownWords: legacyAnswerMapSchema.optional(),
      text: z.undefined().optional()
    })
    .strict(),
  z
    .object({
      dwarfId: legacyStringSchema,
      toolUseId: legacyStringSchema,
      text: legacyStringSchema,
      answers: z.undefined().optional(),
      ownWords: z.undefined().optional()
    })
    .strict()
])

/** A-41 today request (`DwarfPermissionAnswerRequest`). */
export const dwarfPermissionAnswerRequestSchema = z
  .object({
    dwarfId: legacyStringSchema,
    toolUseId: legacyStringSchema,
    decision: z.enum(['allow', 'deny'])
  })
  .strict()

/** A-40 and A-41 today response (`DwarfQuestionAnswerResult`). */
export const dwarfQuestionAnswerResultSchema = z
  .object({ answered: z.boolean(), error: legacyStringSchema.optional() })
  .strict()
