// Shared-kernel ids and scalars as they cross the wire (06 §0.1; 05 §3 "Common value types").
// Wire ids are strings validated as UUIDv7 by the schema; `Instant` is epoch milliseconds (14 §3 intro).
import { z } from 'zod'

/** RFC 9562 UUID version 7 (version nibble 7, variant 10xx); hex digits are case-insensitive on input. */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** True for a string that is a UUIDv7 (14 §3 intro). */
export function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7.test(value)
}

/** A plain-string UUIDv7 schema, for owner types that spell a DwarfAI id as `string` (ADR-010, ADR-015). */
export const uuidV7Schema = z.string().regex(UUID_V7, 'expected a UUIDv7')

function brandedUuidV7<T extends string>(name: string) {
  return z.custom<T>(isUuidV7, { message: `expected a UUIDv7 ${name}` })
}

/** 06 §0.1: branded string, UUIDv7; surrogate, never derived from the path (INV-01). */
export type MineId = string & { readonly __brand: 'MineId' }
/** 06 §0.1: branded string, UUIDv7; ADR-015 item 7 (INV-20). */
export type DwarfId = string & { readonly __brand: 'DwarfId' }
/** 06 §0.1: branded string, UUIDv7. */
export type AskId = string & { readonly __brand: 'AskId' }
/** 06 §0.1: branded string, UUIDv7; Retry reuses it. */
export type MessageId = string & { readonly __brand: 'MessageId' }
/** 06 §0.1: branded string, UUIDv7. */
export type LaunchId = string & { readonly __brand: 'LaunchId' }
/** 06 §0.1: branded string, UUIDv7. */
export type ResetId = string & { readonly __brand: 'ResetId' }
/** 06 §0.1: string, one per Host boot (ADR-015); ADR-003 `HelloOk.epoch: string`. */
export type HostEpoch = string
/** 06 §0.1: epoch ms, passed in; the domain never reads a clock. */
export type Instant = number
/** 06 §0.1: branded string, absolute, as given. */
export type FolderPath = string & { readonly __brand: 'FolderPath' }
/** 06 §0.1: string (open catalog), never a closed enum (BR-10, INV-40, ADR-009 D2). */
export type ProviderId = string

export const mineIdSchema = brandedUuidV7<MineId>('MineId')
export const dwarfIdSchema = brandedUuidV7<DwarfId>('DwarfId')
export const askIdSchema = brandedUuidV7<AskId>('AskId')
export const messageIdSchema = brandedUuidV7<MessageId>('MessageId')
export const launchIdSchema = brandedUuidV7<LaunchId>('LaunchId')
export const resetIdSchema = brandedUuidV7<ResetId>('ResetId')
export const hostEpochSchema = z.string()
export const instantSchema = z.number().int().nonnegative()
export const folderPathSchema = z.custom<FolderPath>((value) => typeof value === 'string', {
  message: 'expected a folder path string'
})
export const providerIdSchema = z.string()
