// Seam A types of the changed members (14 §3.8 `contracts/ipc/window-api.ts`), with their strict() schemas.
// The NEW members of `DwarfAiMinersApiDelta` and their types land with the issues that build their handlers.
import { z } from 'zod'
import {
  consentOriginSchema,
  dwarfIdSchema,
  integrationStateSchema,
  secretBackendSchema,
  type ConsentOrigin,
  type DwarfId,
  type IntegrationState,
  type SecretBackend
} from '../wire'

// Fields and names exactly as 14 §3.8 writes them.
export interface ActivateDwarfRequest {
  dwarfId: DwarfId
  purpose: 'open-console' | 'jump-to-terminal'
}
export type ConsoleOpenResult =
  | { outcome: 'raised'; mode: 'focus-terminal' } // the dwarf's own terminal came to the front
  | { outcome: 'opened'; mode: 'attach' | 'log' } // a terminal was opened (attach, or the read-only live view)
  // the UI could not execute the target; no toast (PO #42). `mode` is `ConsoleTarget['mode']` (ADR-031 item 1),
  // that is `ProviderCapabilities['console']` (ADR-009 D2); ConsoleTarget itself is not a seam A type.
  | { outcome: 'failed'; mode: 'focus-terminal' | 'attach' | 'log' }

export interface OpenCodeSettingsView {
  // successor of OpenCodeSettings (contracts.ts:4916)
  permissions: IntegrationState // 'off' | 'on-unverified' | 'on-verified'
  consentOrigin?: ConsentOrigin
  permissionsError?: 'config-write-failed' | 'config-revert-failed'
  passwordConfigured: boolean
  secretBackend: SecretBackend
}

export const activateDwarfRequestSchema = z
  .object({ dwarfId: dwarfIdSchema, purpose: z.enum(['open-console', 'jump-to-terminal']) })
  .strict()

export const consoleOpenResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('raised'), mode: z.literal('focus-terminal') }).strict(),
  z.object({ outcome: z.literal('opened'), mode: z.enum(['attach', 'log']) }).strict(),
  z
    .object({ outcome: z.literal('failed'), mode: z.enum(['focus-terminal', 'attach', 'log']) })
    .strict()
])

export const openCodeSettingsViewSchema = z
  .object({
    permissions: integrationStateSchema,
    consentOrigin: consentOriginSchema.optional(),
    permissionsError: z.enum(['config-write-failed', 'config-revert-failed']).optional(),
    passwordConfigured: z.boolean(),
    secretBackend: secretBackendSchema
  })
  .strict()
