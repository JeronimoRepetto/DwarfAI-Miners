// Seam-B params and results of `jev.suggest` that A-50 relays unchanged (14 §3.4, §1.2).
import { z } from 'zod'
import {
  jevSuggestionViewSchema,
  mineIdSchema,
  type JevSuggestionView,
  type MineId
} from '../../wire'
import { outcomeSchema, type Outcome } from '../errors'
import { messageTextSchema } from './bounds'

// As 14 §3.4 writes them (names, fields and comments; layout by prettier): jev
export interface JevSuggestParams {
  prompt: string
  mineId: MineId
} // purpose 'launch'; the prompt goes to TypeSafe (US-SET-007 notice)
export type JevSuggestResult = Outcome<
  JevSuggestionView,
  'jev-unreachable' | 'jev-could-not-choose' | 'not-configured'
>

/** B-M38 `jev.suggest` params; A-50's request is this same object (14 §1.2). */
export const jevSuggestParamsSchema = z
  .object({ prompt: messageTextSchema, mineId: mineIdSchema })
  .strict()

export const jevSuggestResultSchema = outcomeSchema(
  jevSuggestionViewSchema,
  z.enum(['jev-unreachable', 'jev-could-not-choose', 'not-configured'])
)
