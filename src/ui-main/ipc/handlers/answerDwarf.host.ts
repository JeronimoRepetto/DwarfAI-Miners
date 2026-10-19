// A-40 `answerDwarfQuestion` / `agent:answerQuestion` and A-41 `answerDwarfPermission` /
// `agent:answerPermission` served by their `host` handlers (14 §2.1 CHANGE, `host`, owner asking; §3.4
// `AnswerQuestionParams`, `AnswerPermissionParams` → `IpcResult<AnswerOutcome>`; ADR-010; ADR-019
// items 7, 8): a person's answer to a dwarf's question or permission, relayed to the ask broker.
//
// - Main validates the renderer's payload against the registry's target request — the same schema
//   objects as B-M30's and B-M31's params (14 §1.2) — before anything is sent: an invalid payload,
//   today's shapes included, answers `IpcResult {ok:false, error: INVALID_PARAMS}` and never reaches
//   the Host (ADR-019). A permission is Allow or Deny only (INV-73).
// - Main mints nothing: the renderer's `requestId` is relayed, so a re-send after a reconnect reuses
//   it and the Host's `ask_answers` key returns the first result (14 §1.6, INV-79).
// - The Host's ADR-010 `AnswerOutcome` comes back unchanged as `IpcResult<AnswerOutcome>`; a
//   `not-open` renders nothing (14 §2.1 A-40). A Host call error (`FORBIDDEN`, `TIMEOUT`, …) is the
//   result's error branch, never a throw into the renderer (14 §1.5).
// - A-40 and A-41 keep their `legacy` route until the cut-2 switch (later: ISSUE-141) routes them
//   here and the root composes this part. A call of any other channel is refused, never guessed.
//
// Nothing here logs: A-40's payload carries free-text answers (14 §3.5 SENSITIVE_METHODS
// `asking.answerQuestion: 'params'`).
//
// Candidate decision (21 §6): today's handlers (`LegacyRuntimeRoute`) are not candidates; replaced by
// these rows, written against the 14 §2.1 rows (evidence: answerDwarf.host.test.ts).
import {
  CHANNELS,
  type AnswerOutcome,
  type ChannelKey,
  type HostMethod,
  type IpcError,
  type IpcResult
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-40 (invoke), by its registry key. */
export const ANSWER_DWARF_QUESTION = 'agent:answerQuestion' satisfies ChannelKey
/** A-41 (invoke), by its registry key. */
export const ANSWER_DWARF_PERMISSION = 'agent:answerPermission' satisfies ChannelKey
/** The invoke rows this target serves. */
export const ANSWER_DWARF_ROWS = [ANSWER_DWARF_QUESTION, ANSWER_DWARF_PERMISSION] as const

/** The seam B member each row relays (14 §2.1, §2.3), for the cut-2 switch. */
export const ANSWER_DWARF_MEMBERS: Readonly<
  Record<(typeof ANSWER_DWARF_ROWS)[number], readonly HostMethod[]>
> = {
  [ANSWER_DWARF_QUESTION]: ['asking.answerQuestion'],
  [ANSWER_DWARF_PERMISSION]: ['asking.answerPermission']
}

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the answer relay failed')
}

const INVALID: IpcResult<AnswerOutcome> = {
  ok: false,
  error: callError('INVALID_PARAMS', 'the params do not match the method schema')
}

function relayed(answer: Promise<AnswerOutcome>): Promise<IpcResult<AnswerOutcome>> {
  return answer.then(
    (outcome): IpcResult<AnswerOutcome> => ({ ok: true, value: outcome }),
    (error: unknown): IpcResult<AnswerOutcome> => ({ ok: false, error: ipcErrorOf(error) })
  )
}

export function createAnswerDwarfRows(client: Pick<HostClient, 'call'>): RouteTarget {
  return {
    serve(channel, payload): Promise<IpcResult<AnswerOutcome>> {
      if (channel === ANSWER_DWARF_QUESTION) {
        const parsed = CHANNELS[ANSWER_DWARF_QUESTION].request.safeParse(payload)
        if (!parsed.success) return Promise.resolve(INVALID)
        return relayed(client.call('asking.answerQuestion', parsed.data))
      }
      if (channel === ANSWER_DWARF_PERMISSION) {
        const parsed = CHANNELS[ANSWER_DWARF_PERMISSION].request.safeParse(payload)
        if (!parsed.success) return Promise.resolve(INVALID)
        return relayed(client.call('asking.answerPermission', parsed.data))
      }
      return Promise.resolve({
        ok: false,
        error: callError('METHOD_NOT_FOUND', `no route for ${channel}`)
      })
    }
  }
}
