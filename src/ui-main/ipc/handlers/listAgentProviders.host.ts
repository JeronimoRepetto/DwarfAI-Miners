// A-36 `listAgentProviders` / `agent:providers` served by its `host` handler from step 4b (14 §2.1 CHANGE, `host`, owner
// suppliers; §3.6 `{ refresh?: boolean }` → `IpcResult<SupplierEntryView[]>`; ADR-009 D5, D6; ADR-019 items 7, 8): the
// Add panel's chips, the model picker and the "Default provider" list read it.
//
// - From 3a to 4a the renderer's one catalog call reached `CatalogMergeAdapter` (21 §3.1), which merged the moved
//   providers' Host entries with today's catalog for the others. Step 4b moves the last provider (21 §2 cut 4b), so no
//   provider is left for the adapter: the step-4b switch (ISSUE-238) routes the call `host` and the root composes this
//   part (22 §5). The Host's `suppliers.launchable` (B-M37) is the whole answer: one entry per launchable provider of
//   this build (a public Host lists no gated entry, ADR-009 D6), each with its own `answerChannel` (ADR-011 item 7).
// - Main validates the renderer's payload against the registry's request (the same object as B-M37's params, 14 §1.2)
//   before anything is sent: an invalid payload answers `INVALID_PARAMS` and never reaches the Host (ADR-019). A valid
//   one is relayed with exactly the parsed params, and the Host's entries are the value, unchanged. A Host call error
//   is the result's error branch, never a throw into the renderer (14 §1.5). A call of any other channel is refused.
//
// Candidate decision (21 §6): `CatalogMergeAdapter`'s Host half (`hostEntries`) is not reused: it filters the entries
// by the table's moved providers, which from 4b is every provider, so the relay is the plain `launchAgent.host.ts`
// pattern; new code.
import {
  CHANNELS,
  type ChannelKey,
  type IpcError,
  type IpcResult,
  type SupplierEntryView
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-36 (invoke), by its registry key. */
export const LIST_AGENT_PROVIDERS = 'agent:providers' satisfies ChannelKey
/** The invoke rows this target serves. */
export const LIST_AGENT_PROVIDERS_ROWS = [LIST_AGENT_PROVIDERS] as const

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the supplier relay failed')
}

export function createListAgentProvidersRow(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[LIST_AGENT_PROVIDERS].request
  return {
    serve(channel, payload): Promise<IpcResult<SupplierEntryView[]>> {
      if (channel !== LIST_AGENT_PROVIDERS) {
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
      return client.call('suppliers.launchable', parsed.data).then(
        (value): IpcResult<SupplierEntryView[]> => ({ ok: true, value }),
        (error: unknown): IpcResult<SupplierEntryView[]> => ({
          ok: false,
          error: ipcErrorOf(error)
        })
      )
    }
  }
}
