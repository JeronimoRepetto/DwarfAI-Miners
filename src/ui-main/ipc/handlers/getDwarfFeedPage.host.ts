// A-15 `getDwarfFeedPage` / `dwarf:feed:page` served by its `host` handler (14 §2.1 CHANGE, `host`, owner
// conversation; §3.6 `FeedParams` → `IpcResult<FeedPage>`; §3.8; ADR-007 item 6; ADR-019 items 7, 8): the scroll-back
// of a chat, one page of a dwarf's feed from the Host's message log, never from a provider.
//
// - Main validates the renderer's payload against the registry's target request — `FeedParams`, the same schema
//   object as B-M26's params (14 §1.2) — before anything is sent: an invalid payload answers
//   `IpcResult {ok:false, error: INVALID_PARAMS}` and never reaches the Host (ADR-019). The router's seam A gate
//   checks the same schema for a `host` + `target` route (validate.ts); this check keeps the handler safe on its own.
// - A valid payload is relayed unchanged as `conversation.feed` through `HostClient.call`, and the page comes back
//   unchanged as `IpcResult<FeedPage>`: its items are `MessageView` (the renderer's composable maps them to today's
//   `FeedMessage`, 14 §2.1). A Host call error (`FORBIDDEN`, `HOST_NOT_READY`, …) is the result's error branch, never
//   a throw into the renderer (14 §1.5).
// - A-15 keeps `shape: 'today'` on its `legacy` route until the cut-1 switch (ISSUE-123) routes it here and the root
//   composes this part (21 §3.1 "(none; switch in the moving cut)"). A call of any other channel is refused, never
//   guessed (14 §1.5).
//
// Nothing here logs: the result carries message text (14 §3.5 SENSITIVE_METHODS `conversation.feed: 'result'`).
import {
  CHANNELS,
  type ChannelKey,
  type FeedPage,
  type FeedParams,
  type IpcError,
  type IpcResult
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-15 (invoke), by its registry key. */
export const GET_DWARF_FEED_PAGE = 'dwarf:feed:page' satisfies ChannelKey
/** The invoke rows this target serves. */
export const GET_DWARF_FEED_PAGE_ROWS = [GET_DWARF_FEED_PAGE] as const

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the feed page relay failed')
}

export function createGetDwarfFeedPageRow(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[GET_DWARF_FEED_PAGE].request
  return {
    serve(channel, payload): Promise<IpcResult<FeedPage>> {
      if (channel !== GET_DWARF_FEED_PAGE) {
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
      const params: FeedParams = parsed.data
      return client.call('conversation.feed', params).then(
        (page): IpcResult<FeedPage> => ({ ok: true, value: page }),
        (error: unknown): IpcResult<FeedPage> => ({ ok: false, error: ipcErrorOf(error) })
      )
    }
  }
}
