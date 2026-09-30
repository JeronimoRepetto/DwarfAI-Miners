// Common value types of the Host's shared kernel (05 §3 "Common value types"; 06 §0.1).
// Pure types: no I/O, no clock read (05 §2.2, R1).

/** Epoch milliseconds, always passed in; domain code never reads a clock (05 §2.2). */
export type Instant = number

/** An expected outcome as a value (16 §2.1): every `E` literal is part of the port's contract. */
export type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E }

/** UUIDv7 minted by the kernel `IdGenerator` (08 §1.2, 06 §0.1). */
export type EventId = string & { readonly __brand: 'EventId' }

/** One opaque id per Host boot (06 §0.1, ADR-015 item 1). */
export type HostEpoch = string
