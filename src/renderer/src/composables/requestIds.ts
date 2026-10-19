/**
 * The `requestId` of one mutation the renderer sends (14 §1.6): a UUIDv7 (RFC 9562), 48 bits of epoch milliseconds,
 * version 7, variant 10, the rest from the platform's random source. One per intent: a retry of the same intent
 * sends the same id, so the Host de-duplicates it.
 *
 * Moved here from `useStopEverything` (ISSUE-317) for ISSUE-123, unchanged, so Reset metrics (A-33) mints its id the
 * same way.
 */
export function mintRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let ms = Date.now()
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = ms % 256
    ms = Math.floor(ms / 256)
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f)
  bytes[8] = 0x80 | (bytes[8]! & 0x3f)
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
