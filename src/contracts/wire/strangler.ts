// Strangler-only B-M41 element (14 §3.4; AMENDMENT-8, OQ-69): deleted with LegacyDwarfIdBridge at the end of cut 4
// (later: ISSUE-241).
import { z } from 'zod'
import { dwarfIdSchema, providerIdSchema, type DwarfId, type ProviderId } from './ids'
import { providerIdentitySchema, type ProviderIdentity } from './imported'

/** 14 §3.4 `StranglerDwarfIdentity`: one per present dwarf; only imported names (06 §0, ADR-015 item 7). */
export interface StranglerDwarfIdentity {
  dwarfId: DwarfId
  providerId: ProviderId
  identity: ProviderIdentity
}

export const stranglerDwarfIdentitySchema = z
  .object({
    dwarfId: dwarfIdSchema,
    providerId: providerIdSchema,
    identity: providerIdentitySchema
  })
  .strict()
