// The run files the Host writes into `<hostDataDir>/run/` that the UI reads (09 §1 row "Run-time
// credentials and locks"): today `host.identity` (ADR-002 D3).
//
// `host.identity` is the running Host's process identity — the ProcessIdentity of ADR-014 item 1
// (`pid`, `processStartTimeMs`, `bootId`) plus its boot epoch — written `0600` by temp + rename
// right after the endpoint bind and before any `hello` is answered, and deleted at the clean exit.
// It is not a secret and grants nothing: the UI's Host-launcher adapter reads it only to end a hung
// Host (ADR-002 D9; later: ISSUE-052), and the ADR-015 item 6 cleanup sweeps it when stale. The
// Host writes it through this schema and the UI reads it through the same one.
import { z } from 'zod'

/** The file name under `<hostDataDir>/run/` (ADR-002 D3). */
export const HOST_IDENTITY_FILE = 'host.identity'

/** ADR-002 D3: `{ pid, processStartTimeMs, bootId, epoch }` of the running Host. */
export interface HostIdentityRecord {
  pid: number
  processStartTimeMs: number
  bootId: string
  epoch: string
}

export const hostIdentityRecordSchema = z
  .object({
    pid: z.number().int().positive(),
    processStartTimeMs: z.number().finite(),
    bootId: z.string().min(1),
    epoch: z.string().min(1)
  })
  .strict() satisfies z.ZodType<HostIdentityRecord>
