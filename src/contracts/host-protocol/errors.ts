// Seam-B protocol error codes (14 §3.2) and the call-error types (14 §3.3), with their strict() schemas.
// Three layers, never mixed (14 §1.5): protocol errors before hello.ok, call errors, domain outcomes as results.
import { z } from 'zod'

export type ProtocolErrorCode =
  'AUTH_FAILED' | 'PROTOCOL_ERROR' | 'HELLO_TIMEOUT' | 'INCOMPATIBLE_GENERATION' | 'RATE_LIMITED'

export type IpcErrorCode =
  | 'INVALID_PARAMS' // schema refusal (zod strict), both seams
  | 'SENDER_REJECTED' // seam A: senderFrame / webContents not a known mode window (ADR-019 item 8)
  | 'HOST_UNAVAILABLE' // seam A: HostConnection not 'connected'; mutations disabled (ADR-002 D9)
  | 'HOST_NOT_READY' // seam B: Host state 'starting' | 'migrating' (saga resume first, ADR-023 item 4)
  | 'NOT_SUPPORTED' // seam A: the Host did not advertise this method (ADR-027 D4 feature gate)
  | 'METHOD_NOT_FOUND' // seam B: unknown method (ADR-003 item 6); never silence
  | 'FORBIDDEN' // seam B: method outside the connection's role scope (ADR-003 item 12)
  | 'SNAPSHOT_EXPIRED' // seam B: snapshotId evicted before the last page was read (§4.2)
  | 'TIMEOUT' // seam A: main's per-method deadline passed; the Host may still settle it (§3.10)
  | 'INTERNAL' // unexpected failure; details in the local log only (ADR-026)
export interface IpcError {
  code: IpcErrorCode
  message: string // diagnostics only: never copy, never a secret, never a custom name
  retryable: boolean // true for HOST_UNAVAILABLE, HOST_NOT_READY, TIMEOUT
}
/** Seam A result of every CHANGE and NEW invoke member (KEEP members keep their legacy failure shape). */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError }
/** Domain outcome on the wire: 05's Result with the same discriminant names (a refusal is a value, not an error). */
export type Outcome<T, E extends string> = { ok: true; value: T } | { ok: false; error: E }

export const protocolErrorCodeSchema = z.enum([
  'AUTH_FAILED',
  'PROTOCOL_ERROR',
  'HELLO_TIMEOUT',
  'INCOMPATIBLE_GENERATION',
  'RATE_LIMITED'
])

export const ipcErrorCodeSchema = z.enum([
  'INVALID_PARAMS',
  'SENDER_REJECTED',
  'HOST_UNAVAILABLE',
  'HOST_NOT_READY',
  'NOT_SUPPORTED',
  'METHOD_NOT_FOUND',
  'FORBIDDEN',
  'SNAPSHOT_EXPIRED',
  'TIMEOUT',
  'INTERNAL'
])

export const ipcErrorSchema = z
  .object({ code: ipcErrorCodeSchema, message: z.string(), retryable: z.boolean() })
  .strict()

/** Schema of `IpcResult<T>` for the given value schema. */
export const ipcResultSchema = <T extends z.ZodTypeAny>(value: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), error: ipcErrorSchema }).strict()
  ])

/** Schema of `Outcome<T, E>` for the given value schema and closed error-string schema. */
export const outcomeSchema = <T extends z.ZodTypeAny, E extends z.ZodType<string>>(
  value: T,
  error: E
) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), error }).strict()
  ])
