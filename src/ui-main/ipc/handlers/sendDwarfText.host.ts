// A-23 `sendDwarfText` / `dwarf:sendText` served by its `host` handler (14 §2.1 CHANGE, `host`, owner conversation;
// §3.4 `SendMessageParams` → `IpcResult<SendMessageResult>`; ADR-022; ADR-019 items 7, 8): a message to a dwarf, with
// its attachments.
//
// - Main validates the renderer's payload — `{ dwarfId, text, attachments, requestId }`, the registry's request, the
//   same object as B-M24's params (14 §1.2) — before anything is sent: an invalid payload, today's `pressEnter` or
//   `holdId` included, answers `IpcResult {ok:false, error: INVALID_PARAMS}` and never reaches the Host (ADR-019).
// - A valid payload is relayed as `conversation.send` (B-M24) through `HostClient.call` with exactly the parsed params
//   (the requestId is the message's durable key, minted once by the renderer, 14 §1.6). The Host answers at
//   acceptance (14 §1.7) — the message id, or `cannot-receive` / `attachment-refused` as the value — and the delivery
//   marks arrive only as `message.delivery` frames. A Host call error is the result's error branch, never a throw
//   into the renderer (14 §1.5).
// - From step 3a the row is provider-qualified by the dwarf's provider (21 §2 cut 3a, `providerQualifiers.ts`); the
//   step-3a switch (ISSUE-001) routes it and the root composes this part (22 §5). A call of any other channel is
//   refused, never guessed (14 §1.5).
//
// Nothing here logs: the params carry the text and the paths (14 §3.5 SENSITIVE_METHODS `conversation.send`).
//
// Candidate decision (21 §6): no candidate exists in UI main; new code on the `stopDwarf.host.ts` pattern.
import {
  CHANNELS,
  type ChannelKey,
  type IpcError,
  type IpcResult,
  type SendMessageResult
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-23 (invoke), by its registry key. */
export const SEND_DWARF_TEXT = 'dwarf:sendText' satisfies ChannelKey
/** The invoke rows this target serves. */
export const SEND_DWARF_TEXT_ROWS = [SEND_DWARF_TEXT] as const

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the send relay failed')
}

export function createSendDwarfTextRow(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[SEND_DWARF_TEXT].request
  return {
    serve(channel, payload): Promise<IpcResult<SendMessageResult>> {
      if (channel !== SEND_DWARF_TEXT) {
        return Promise.resolve({
          ok: false,
          error: callError('METHOD_NOT_FOUND', `no route for ${channel}`)
        })
      }
      const parsed = request.safeParse(payload)
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: callError('INVALID_PARAMS', 'the params do not match the method schema')
        })
      }
      return client.call('conversation.send', parsed.data).then(
        (value): IpcResult<SendMessageResult> => ({ ok: true, value }),
        (error: unknown): IpcResult<SendMessageResult> => ({ ok: false, error: ipcErrorOf(error) })
      )
    }
  }
}
