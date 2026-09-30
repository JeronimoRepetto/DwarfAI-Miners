// Seam-B params and results of `asking.*` that host-placed seam A rows relay unchanged (14 §3.4, §1.2).
import { z } from 'zod'
import {
  answerRefusalReasonSchema,
  askIdSchema,
  type AnswerRefusalReason,
  type AskId
} from '../../wire'
import { requestIdSchema } from '../requestId'
import { messageTextSchema } from './bounds'

/** 06 §0 `QuestionAnswers` (asking VO): one entry per step, an `option` or a non-empty `freeText`. */
export type QuestionAnswers = { step: number; option?: string; freeText?: string }[]

/** ADR-010 item 5 `AnswerOutcome` (the answer is a domain result, 14 §1.5). */
export type AnswerOutcome =
  { kind: 'accepted' } | { kind: 'not-open' } | { kind: 'refused'; reason: AnswerRefusalReason }

// As 14 §3.4 writes them (names, fields and comments; layout by prettier): asking
export interface AnswerQuestionParams {
  askId: AskId
  answers: QuestionAnswers
  requestId: string
}
export interface AnswerPermissionParams {
  askId: AskId
  decision: 'allow' | 'deny'
  requestId: string
}

/** An option label or a person's own words: bounded like a message (06 `MessageText`). */
export const questionAnswersSchema = z.array(
  z
    .object({
      step: z.number().int().nonnegative(),
      option: messageTextSchema.optional(),
      freeText: messageTextSchema.optional()
    })
    .strict()
)

export const answerOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('accepted') }).strict(),
  z.object({ kind: z.literal('not-open') }).strict(),
  z.object({ kind: z.literal('refused'), reason: answerRefusalReasonSchema }).strict()
])

/** B-M30 `asking.answerQuestion` params; A-40's request is this same object (14 §1.2). */
export const answerQuestionParamsSchema = z
  .object({ askId: askIdSchema, answers: questionAnswersSchema, requestId: requestIdSchema })
  .strict()

/** B-M31 `asking.answerPermission` params; A-41's request is this same object (14 §1.2). */
export const answerPermissionParamsSchema = z
  .object({ askId: askIdSchema, decision: z.enum(['allow', 'deny']), requestId: requestIdSchema })
  .strict()
