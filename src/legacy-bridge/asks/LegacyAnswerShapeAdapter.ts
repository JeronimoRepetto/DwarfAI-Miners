// `LegacyAnswerShapeAdapter` (21 §3.1, A-40 and A-41 for `legacy:` AskIds, cuts 2–4): the 14 shapes of the renderer
// (§3.4 `AnswerQuestionParams` / `AnswerPermissionParams` → `IpcResult<AnswerOutcome>`, ADR-010 item 5) ↔ today's
// answer call and result, for the asks whose channel is still today's runtime's (21 §3 `LegacyAskRelay`). The A-40/A-41
// dispatch (`src/ui-main/ipc/handlers/answerDwarf.dispatch.ts`) sends it every answer whose AskId is `legacy:<id>`.
//
// - The request is checked against the row's 14 request with one difference: its AskId is a `legacy:` id, not a
//   UUIDv7 (the relay's own namespace, 21 §3). A payload off that shape answers `INVALID_PARAMS`, as the `host`
//   handler does, and reaches nothing.
// - The ask must be one the relay exposes now, of the row's kind; otherwise the answer is stale: `not-open`, and
//   today's runtime is not called (ADR-010 stale drop).
// - A question's answers become today's call: step `n` names `questions[n]` of the ask, keyed by its text as today
//   keys them; several options of one step are joined as today joins them (`joinAnswerLabels`); the person's own words
//   are today's `text` for a one-question call that is not held (the console picker's "Other" row), and `ownWords`
//   otherwise. An entry naming no step of the ask, with both or neither of option and free text, or a second free text
//   for one step is `refused{'invalid-answer'}`, and today's runtime is not called. A permission is Allow or Deny.
// - Today's `DwarfQuestionAnswerResult` maps to `accepted` (`answered: true`), `not-open` (today's "no longer open"
//   and "left the mine" texts: the ask is gone) or `refused{'channel-rejected'}` (any other refusal). A result that
//   is not today's shape, or a throw, is unmappable: `refused{'channel-rejected'}` too. Every refusal is logged as
//   `ask.answer.refused` (19 §9) with its reason only: never the answer, its words or today's error text
//   (NFR-SEC-12; 14 §3.5 SENSITIVE_METHODS `asking.answerQuestion: 'params'`).
// - The renderer's `requestId` is not minted and not forwarded: today's call has no such field (today's request is
//   strict). A re-send after an accepted answer finds the ask closed and is `not-open`.
//
// Composed only by `src/ui-main/index.ts` (R16) once the cut-2 switch installs the qualified routes (later:
// ISSUE-141); deleted with `LegacyAskRelay` at the end of cut 4 (later: ISSUE-241).
//
// Candidate decision (21 §6): no candidate exists; new code.
import {
  answerPermissionParamsSchema,
  answerQuestionParamsSchema,
  todayShapeOf,
  type AnswerOutcome,
  type AnswerRefusalReason,
  type IpcError,
  type IpcResult,
  type QuestionAnswers
} from '@dwarfai/contracts'
import { z } from 'zod'
import { ASK_NO_LONGER_OPEN, joinAnswerLabels } from '../../shared/contracts'
import {
  legacyAskIdOf,
  type LegacyAnswerBody,
  type LegacyAskRelay,
  type RelayedLegacyAsk
} from '../LegacyAskRelay'
import type { LegacyLog } from '../legacyDiagnostics'
import { NO_SUCH_DWARF } from '../rowShapes/notFound'
import { PROMPT_NO_LONGER_OPEN } from '../rowShapes/notOpen'

const QUESTION = 'agent:answerQuestion' // A-40
const PERMISSION = 'agent:answerPermission' // A-41

/** A relayed AskId: `legacy:` and today's non-empty ask id. */
const legacyAskIdSchema = z.string().refine((askId) => legacyAskIdOf(askId) !== null)
const questionSchema = answerQuestionParamsSchema.extend({ askId: legacyAskIdSchema })
const permissionSchema = answerPermissionParamsSchema.extend({ askId: legacyAskIdSchema })

/** Today's A-40 and A-41 result (`DwarfQuestionAnswerResult`), as the registry's today shapes hold it. */
const TODAY_RESULT = todayShapeOf(QUESTION)?.response
interface TodayResult {
  answered: boolean
  error?: string
}

/** Today's texts for an ask that is no longer there: the closed question, the closed prompt, the dwarf gone. */
const GONE: ReadonlySet<string> = new Set([
  ASK_NO_LONGER_OPEN,
  PROMPT_NO_LONGER_OPEN,
  NO_SUCH_DWARF
])

export interface LegacyAnswerShapeAdapter {
  serve(channel: string, payload: unknown): Promise<IpcResult<AnswerOutcome>>
}

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

const INVALID: IpcResult<AnswerOutcome> = {
  ok: false,
  error: callError('INVALID_PARAMS', 'the params do not match the method schema')
}
const NOT_OPEN: IpcResult<AnswerOutcome> = { ok: true, value: { kind: 'not-open' } }

/** Today's question call for `answers`, or `null` when an entry does not answer a step of `ask`. */
function todayQuestion(
  ask: Extract<RelayedLegacyAsk, { kind: 'question' }>,
  answers: QuestionAnswers
): LegacyAnswerBody | null {
  const labels = new Map<number, string[]>()
  const words = new Map<number, string>()
  for (const { step, option, freeText } of answers) {
    if (ask.questions[step] === undefined) return null
    if ((option === undefined) === (freeText === undefined)) return null
    if (freeText !== undefined) {
      if (words.has(step)) return null
      words.set(step, freeText)
    } else labels.set(step, [...(labels.get(step) ?? []), option as string])
  }
  const textOf = (step: number) => (ask.questions[step] as { question: string }).question
  const onlyWords = words.get(0)
  if (ask.channel !== 'held' && ask.questions.length === 1 && onlyWords !== undefined) {
    return labels.size === 0 ? { kind: 'question', text: onlyWords } : null
  }
  const byText = (entries: Iterable<[number, string]>) =>
    Object.fromEntries([...entries].map(([step, value]) => [textOf(step), value]))
  return {
    kind: 'question',
    answers: byText([...labels].map(([step, picked]) => [step, joinAnswerLabels(picked)])),
    ...(words.size === 0 ? {} : { ownWords: byText(words) })
  }
}

export function createLegacyAnswerShapeAdapter(deps: {
  relay: Pick<LegacyAskRelay, 'asks' | 'answer'>
  /** The UI logger, as the bridge reaches it (`legacyDiagnostics`). */
  log: LegacyLog
}): LegacyAnswerShapeAdapter {
  const { relay, log } = deps

  function refused(reason: AnswerRefusalReason): IpcResult<AnswerOutcome> {
    log.record({
      level: 'warn',
      event: 'ask.answer.refused',
      subsystem: 'legacy-runtime',
      causeClass: reason
    })
    return { ok: true, value: { kind: 'refused', reason } }
  }

  /** Today's result as an `AnswerOutcome`; anything that is not today's shape is unmappable. */
  async function outcomeOf(result: Promise<unknown>): Promise<IpcResult<AnswerOutcome>> {
    const today = TODAY_RESULT?.safeParse(await result.catch(() => undefined))
    if (today?.success !== true) return refused('channel-rejected')
    const { answered, error } = today.data as TodayResult
    if (answered) return { ok: true, value: { kind: 'accepted' } }
    if (error !== undefined && GONE.has(error)) return NOT_OPEN
    return refused('channel-rejected')
  }

  function openAsk(askId: string, kind: RelayedLegacyAsk['kind']) {
    return relay.asks().find((ask) => ask.askId === askId && ask.kind === kind)
  }

  return {
    serve(channel, payload) {
      if (channel === QUESTION) {
        const parsed = questionSchema.safeParse(payload)
        if (!parsed.success) return Promise.resolve(INVALID)
        const ask = openAsk(parsed.data.askId, 'question')
        if (ask?.kind !== 'question') return Promise.resolve(NOT_OPEN)
        const body = todayQuestion(ask, parsed.data.answers)
        if (body === null) return Promise.resolve(refused('invalid-answer'))
        return outcomeOf(relay.answer(ask.askId, body))
      }
      if (channel === PERMISSION) {
        const parsed = permissionSchema.safeParse(payload)
        if (!parsed.success) return Promise.resolve(INVALID)
        const ask = openAsk(parsed.data.askId, 'permission')
        if (ask === undefined) return Promise.resolve(NOT_OPEN)
        return outcomeOf(
          relay.answer(ask.askId, { kind: 'permission', decision: parsed.data.decision })
        )
      }
      return Promise.resolve({
        ok: false,
        error: callError('METHOD_NOT_FOUND', `no route for ${channel}`)
      })
    }
  }
}
