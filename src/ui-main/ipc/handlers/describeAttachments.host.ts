// A-25 `describeDwarfAttachments` / `dwarf:attachments:describe` served by its `host` handler (14 §2.1 KEEP, `host`,
// owner conversation; `string[]` → `DwarfAttachmentPick[]`, eA as `[]` + per-item `refusal`; ADR-019 item 9; 14 §8
// I-10): the composer's description of the files a person picked or dropped, one pick per path.
//
// - Main validates the renderer's payload — the paths, the registry's request — and the B-M28 params it would send
//   before anything is sent (ADR-019): a renderer sends a path only here and in A-23 (14 §1.10 "Paths from the
//   renderer"), and nothing malformed reaches the Host.
// - Valid paths are relayed as `conversation.describeAttachments` (B-M28) with `{ paths }` through `HostClient.call`.
//   The Host re-validates every path and answers one `AttachmentPick` per path, in the order asked, each with its
//   attachment or its refusal; the picks come back unchanged (`AttachmentPick` is today's `DwarfAttachmentPick`,
//   14 §8 I-10).
// - A-25 is KEEP, so its failure is its legacy shape, never an `IpcResult` (14 §1.5): an invalid payload, a path the
//   B-M28 params refuse and a Host call error all answer `[]` — no pick, no guessed refusal.
// - From step 3a A-25 routes `host` for every provider (21 §2 cut 3a); the step-3a switch (ISSUE-001) routes it here
//   and the root composes this part (22 §5). A call of any other channel is refused, never guessed (14 §1.5).
//
// Nothing here logs: the params and the result carry paths (14 §3.5 SENSITIVE_METHODS
// `conversation.describeAttachments`).
//
// Candidate decision (21 §6): no candidate exists in UI main (today's runtime serves A-25 on its `legacy` route); new
// code on the `stopDwarf.host.ts` pattern.
import {
  CHANNELS,
  describeAttachmentsParamsSchema,
  type ChannelKey,
  type HostResult,
  type IpcError,
  type IpcResult
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-25 (invoke), by its registry key. */
export const DESCRIBE_ATTACHMENTS = 'dwarf:attachments:describe' satisfies ChannelKey
/** The invoke rows this target serves. */
export const DESCRIBE_ATTACHMENTS_ROWS = [DESCRIBE_ATTACHMENTS] as const

/** B-M28's answer: one `AttachmentPick` per path, today's `DwarfAttachmentPick[]` (14 §8 I-10). */
type Picks = HostResult['conversation.describeAttachments']

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

export function createDescribeAttachmentsRow(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[DESCRIBE_ATTACHMENTS].request
  /** A-25's legacy failure shape (14 §1.5): no pick. */
  const none = (): Promise<Picks> => Promise.resolve([])
  return {
    serve(channel, payload): Promise<Picks | IpcResult<never>> {
      if (channel !== DESCRIBE_ATTACHMENTS) {
        return Promise.resolve({
          ok: false,
          error: callError('METHOD_NOT_FOUND', `no route for ${channel}`)
        })
      }
      const paths = request.safeParse(payload)
      if (!paths.success) return none()
      const params = describeAttachmentsParamsSchema.safeParse({ paths: paths.data })
      if (!params.success) return none()
      return client.call('conversation.describeAttachments', params.data).then(
        (picks): Picks => picks,
        (): Promise<Picks> => none()
      )
    }
  }
}
