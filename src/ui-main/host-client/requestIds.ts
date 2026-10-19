// The `requestId` rules of 14 §1.6 (ADR-003 item 6) on the UI side.
//
// - Every mutating seam-B method carries a client `requestId`, a UUIDv7; the renderer composable mints it once per
//   user intent and main mints it only for a call whose legacy shape has none (`mintRequestId`). A call is a mutation
//   exactly when its params carry a `requestId`.
// - After a reconnect main re-sends an in-flight mutation once, with the same `requestId`, never a new one. On a hot
//   reconnect (same `epoch`) any in-flight mutation may be re-sent: the Host's in-memory table still holds it. After a
//   Host restart (new `epoch`) only the methods whose key is durable are re-sent: `conversation.send`
//   (`messages.request_id` UNIQUE) and `asking.answerQuestion` / `asking.answerPermission` (`ask_answers` PK).
export interface RequestIdSource {
  /** Epoch milliseconds. */
  now(): number
  /** `n` random bytes. */
  random(n: number): Uint8Array
}

/** The methods whose `requestId` is a durable key across Host epochs (14 §1.6). */
export const DURABLE_KEY_METHODS: ReadonlySet<string> = new Set([
  'conversation.send',
  'asking.answerQuestion',
  'asking.answerPermission'
])

/** A UUIDv7 (RFC 9562): 48 bits of epoch milliseconds, version 7, variant 10, the rest random. */
export function mintRequestId(source: RequestIdSource): string {
  const bytes = source.random(16)
  let ms = Math.max(0, Math.floor(source.now()))
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = ms % 256
    ms = Math.floor(ms / 256)
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f)
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f)
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Whether a call with these params is a mutation (14 §1.6: it carries a `requestId`). */
export function isMutation(params: unknown): boolean {
  return (
    typeof params === 'object' &&
    params !== null &&
    typeof (params as { requestId?: unknown }).requestId === 'string'
  )
}

/** Whether an in-flight mutation of `method` is re-sent once after a reconnect (14 §1.6). */
export function resendAfterReconnect(
  method: string,
  reconnect: { epochChanged: boolean }
): boolean {
  return !reconnect.epochChanged || DURABLE_KEY_METHODS.has(method)
}
