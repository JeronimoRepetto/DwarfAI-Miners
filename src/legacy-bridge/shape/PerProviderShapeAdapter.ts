// `PerProviderShapeAdapter` (21 §3.1, A-13, A-23 and A-35 with its Retry path, steps 3a–4b): from 3a the renderer calls
// these rows with the 14 shapes for every provider (21 §2 cut 3 common rules); for a provider whose launcher has not
// moved to the Host yet, this adapter turns the target request into today's legacy call and today's answer into the
// target response. It changes no channel, payload, port or frozen shape (21 §3), and has no Host command path.
//
// - A-35 `LaunchParams` → today's `AgentLaunchRequest`: the supplier way's provider, the mine, the prompt and the
//   tuning pass as they are; `jevOn`, `jevAutoAccept`, `requestId` and `retryOf` have no today field. A Retry is today's
//   launch with the same request (today has no retry of its own). A Jev launch never reaches it: from 3a Jev chooses
//   among the Host's launchable suppliers only (21 §2 cut 3 "Let Jev choose"). The built request is checked against
//   today's strict schema, so a provider today's runtime does not know reaches nothing (`INVALID_PARAMS`).
// - Today's `launched: true` answers `LaunchAccepted` with a fresh `LaunchId` (UUIDv7, 14 §1.6): today's receipt id is
//   not a UUIDv7. The settlement stays on today's A-P3 push until it retires at the end of 4b (21 §3.1). A launch today
//   refuses at once answers an `INTERNAL` call error naming only today's closed cause, never today's text (ADR-026).
// - A-23 `SendMessageParams` → today's `DwarfTextRequest` (`pressEnter: true`, today's send); its picked paths are
//   described first by today's A-25 handler, as the Host's legacy send of a provider not yet moved receives them
//   (21 §2 cut 3), and any refused pick is `attachment-refused` with nothing sent. Today's delivered or held send
//   (`holdId`, settled on A-P4) is accepted with a fresh `MessageId`; any other answer is `cannot-receive`.
// - A-13 `ActivateDwarfRequest` → today's activation by dwarf id: a focused terminal is `raised`, an opened one
//   `opened` (`attach`); neither is `failed` in the purpose's own mode. Today's feed fallback is dropped (14 §2.1 A-13).
// - Dwarf ids reach today's runtime through `LegacyDwarfIdBridge`'s rows (the `legacy` it is handed): an unmatched
//   dwarf answers that row's own not-found, which maps to `cannot-receive` or `failed` here, never a guess.
// - A payload off the 14 request is `INVALID_PARAMS`; an answer that is not today's shape, or a throw, is `INTERNAL`.
//
// Composed only by `src/ui-main/index.ts` (R16) where a route of the table names it (the step switch issues add those
// rows); it shrinks with every provider step and is deleted after 4b (later: ISSUE-240).
//
// Candidate decision (21 §6): no candidate exists; new code.
import {
  activateDwarfRequestSchema,
  CHANNELS,
  launchParamsSchema,
  sendMessageParamsSchema,
  todayShapeOf,
  type ConsoleOpenResult,
  type IpcError,
  type IpcResult,
  type LaunchAccepted,
  type SendMessageResult
} from '@dwarfai/contracts'

/** The name the route table lists and the rows' `legacy` + `target` routes name (21 §3.1). */
export const PER_PROVIDER_SHAPE_ADAPTER = 'PerProviderShapeAdapter'

const ACTIVATE = 'dwarf:activate' // A-13
const SEND = 'dwarf:sendText' // A-23
const DESCRIBE = 'dwarf:attachments:describe' // A-25, today's handler
const LAUNCH = 'agent:launch' // A-35

/** The rows it converts (21 §3.1). */
export const PER_PROVIDER_SHAPE_CHANNELS: readonly string[] = [ACTIVATE, SEND, LAUNCH]

export interface PerProviderShapeAdapterDeps {
  /** Today's runtime behind `LegacyDwarfIdBridge`'s rows: today's wire names, today's shapes. */
  legacy: { serve(channel: string, payload: unknown): Promise<unknown> }
  /** A fresh UUIDv7, for the `LaunchId` and the `MessageId` today's runtime does not give. */
  mintId(): string
}

export interface PerProviderShapeAdapter {
  serve(channel: string, payload: unknown): Promise<IpcResult<unknown>>
}

function callError(code: IpcError['code'], message: string): IpcResult<never> {
  return { ok: false, error: { code, message, retryable: false } }
}

const TODAY_LAUNCH = todayShapeOf(LAUNCH)
const TODAY_SEND = todayShapeOf(SEND)
const TODAY_ACTIVATE = todayShapeOf(ACTIVATE)
const TODAY_PICKS = CHANNELS[DESCRIBE].response

interface TodayLaunchResult {
  launched: boolean
  cause?: string
}
interface TodayTextResult {
  delivered: boolean
  holdId?: string
}
interface TodayActivation {
  focused: boolean
  openedTerminal: boolean
}
interface TodayPick {
  attachment?: unknown
  refusal?: string
}

/** Today's answer of `channel` parsed with `schema`, or `null` when it is not today's shape or the call threw. */
async function todayAnswer<T>(
  legacy: PerProviderShapeAdapterDeps['legacy'],
  channel: string,
  payload: unknown,
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } } | undefined
): Promise<T | null> {
  const answer = await legacy.serve(channel, payload).catch(() => undefined)
  const parsed = schema?.safeParse(answer)
  return parsed?.success === true ? (parsed.data as T) : null
}

export function createPerProviderShapeAdapter(
  deps: PerProviderShapeAdapterDeps
): PerProviderShapeAdapter {
  const { legacy, mintId } = deps

  async function launch(payload: unknown): Promise<IpcResult<LaunchAccepted>> {
    const parsed = launchParamsSchema.safeParse(payload)
    if (!parsed.success) return callError('INVALID_PARAMS', 'the params do not match LaunchParams')
    const { mineId, way, model, effort, permissionMode, prompt } = parsed.data
    if (way.kind !== 'supplier') {
      return callError('INVALID_PARAMS', 'a Jev launch is served by the Host only')
    }
    const today = TODAY_LAUNCH?.request.safeParse({
      mineId,
      provider: way.providerId,
      prompt,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(permissionMode === undefined ? {} : { permissionMode })
    })
    if (today?.success !== true) {
      return callError('INVALID_PARAMS', 'the launch has no legacy request shape')
    }
    const result = await todayAnswer<TodayLaunchResult>(
      legacy,
      LAUNCH,
      today.data,
      TODAY_LAUNCH?.response
    )
    if (result === null) return callError('INTERNAL', 'the legacy launch answer is unmappable')
    if (!result.launched) {
      return callError(
        'INTERNAL',
        `the legacy launch was refused (${result.cause ?? 'unclassified'})`
      )
    }
    return { ok: true, value: { launchId: mintId() as LaunchAccepted['launchId'] } }
  }

  /** Today's attachments for the picked paths, or `null` when today's runtime refused one of them. */
  async function described(paths: readonly string[]): Promise<unknown[] | null | 'unmappable'> {
    if (paths.length === 0) return []
    const picks = await todayAnswer<TodayPick[]>(legacy, DESCRIBE, [...paths], TODAY_PICKS)
    if (picks === null) return 'unmappable'
    if (picks.length !== paths.length) return null
    const attachments: unknown[] = []
    for (const pick of picks) {
      if (pick.refusal !== undefined || pick.attachment === undefined) return null
      attachments.push(pick.attachment)
    }
    return attachments
  }

  async function send(payload: unknown): Promise<IpcResult<SendMessageResult>> {
    const parsed = sendMessageParamsSchema.safeParse(payload)
    if (!parsed.success) {
      return callError('INVALID_PARAMS', 'the params do not match SendMessageParams')
    }
    const { dwarfId, text, attachments } = parsed.data
    const picked = await described(attachments)
    if (picked === 'unmappable') {
      return callError('INTERNAL', 'the legacy attachment answer is unmappable')
    }
    if (picked === null) return { ok: true, value: { ok: false, error: 'attachment-refused' } }
    const result = await todayAnswer<TodayTextResult>(
      legacy,
      SEND,
      { dwarfId, text, pressEnter: true, ...(picked.length === 0 ? {} : { attachments: picked }) },
      TODAY_SEND?.response
    )
    if (result === null) return callError('INTERNAL', 'the legacy send answer is unmappable')
    if (!result.delivered && result.holdId === undefined) {
      return { ok: true, value: { ok: false, error: 'cannot-receive' } }
    }
    const messageId = mintId() as Extract<SendMessageResult, { ok: true }>['value']['messageId']
    return { ok: true, value: { ok: true, value: { messageId } } }
  }

  async function activate(payload: unknown): Promise<IpcResult<ConsoleOpenResult>> {
    const parsed = activateDwarfRequestSchema.safeParse(payload)
    if (!parsed.success) {
      return callError('INVALID_PARAMS', 'the params do not match ActivateDwarfRequest')
    }
    const { dwarfId, purpose } = parsed.data
    const result = await todayAnswer<TodayActivation>(
      legacy,
      ACTIVATE,
      dwarfId,
      TODAY_ACTIVATE?.response
    )
    if (result === null) return callError('INTERNAL', 'the legacy activation answer is unmappable')
    if (result.focused) return { ok: true, value: { outcome: 'raised', mode: 'focus-terminal' } }
    if (result.openedTerminal) return { ok: true, value: { outcome: 'opened', mode: 'attach' } }
    return {
      ok: true,
      value: {
        outcome: 'failed',
        mode: purpose === 'jump-to-terminal' ? 'focus-terminal' : 'attach'
      }
    }
  }

  return {
    serve(channel, payload) {
      if (channel === LAUNCH) return launch(payload)
      if (channel === SEND) return send(payload)
      if (channel === ACTIVATE) return activate(payload)
      return Promise.resolve(callError('METHOD_NOT_FOUND', `no route for ${channel}`))
    }
  }
}
