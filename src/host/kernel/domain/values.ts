// Common value types of the Host's shared kernel (05 §3 "Common value types"; 06 §0.1).
// Pure types: no I/O, no clock read (05 §2.2, R1).

/** Epoch milliseconds, always passed in; domain code never reads a clock (05 §2.2). */
export type Instant = number

/** An expected outcome as a value (16 §2.1): every `E` literal is part of the port's contract. */
export type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E }

/** The DwarfAI UUID of a dwarf (05 §3 "Common value types", ADR-015); never a provider session id. */
export type DwarfId = string & { readonly __brand: 'DwarfId' }

/** The surrogate id of a mine, UUIDv7; never derived from its path (06 §0.1, INV-01). */
export type MineId = string & { readonly __brand: 'MineId' }

/**
 * The provider's own ids of a session (06 §0.1, §3; ADR-015 item 7), a key separate from the
 * `DwarfId` and UNIQUE across dwarfs (INV-21). `providerAgentId` is absent for a root session and
 * present for a provider subagent sharing its parent's session; stored as `''` when absent.
 */
export interface ProviderIdentity {
  providerId: ProviderId
  providerSessionId: string
  providerAgentId?: string
}

/** UUIDv7 minted by the kernel `IdGenerator` (08 §1.2, 06 §0.1). */
export type EventId = string & { readonly __brand: 'EventId' }

/** One opaque id per Host boot (06 §0.1, ADR-015 item 1). */
export type HostEpoch = string

/** A provider id: an open catalog string, never a closed enum (06 §0.1, BR-10, INV-40). */
export type ProviderId = string

/** The DwarfAI id of an ask (05 §4 "Common value types"; ADR-010 item 5). */
export type AskId = string & { readonly __brand: 'AskId' }

/** Stable id of a message; Retry reuses it (06 §0.1, ADR-022). */
export type MessageId = string & { readonly __brand: 'MessageId' }

/** UUIDv7 of one launch (06 §0.1). */
export type LaunchId = string & { readonly __brand: 'LaunchId' }

/** An absolute folder path, as given (06 §0.1). */
export type FolderPath = string & { readonly __brand: 'FolderPath' }

/** The integrations that can gate an answer channel (06 §0.1; ADR-011 item 7, ADR-016 item 5). */
export type IntegrationId = 'opencode-permissions' | 'claude-hooks'

/** An integration's state (06 §0.1; ADR-011 item 7). */
export type IntegrationState = 'off' | 'on-unverified' | 'on-verified'
