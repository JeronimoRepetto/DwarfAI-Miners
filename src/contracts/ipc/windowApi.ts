// Seam A types of the changed members (14 §3.8 `contracts/ipc/window-api.ts`), with their strict() schemas.
// The NEW members of `DwarfAiMinersApiDelta` and their types land with the issues that build their handlers.
import { z } from 'zod'
import { requestIdSchema } from '../host-protocol/requestId'
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

// A-N30 `reportRendererDiagnostic` (14 §3.8; AMENDMENT-2, AR-13-03): allowlisted, no free text (14 §1.10).
export interface RendererDiagnostic {
  event: 'renderer.error' | 'renderer.unhandled-rejection' | 'renderer.store-error' // allowlist; any other value is dropped by main
  errCode?: string // /^[A-Za-z0-9_.-]{1,64}$/: an error class or code name (e.g. 'TypeError'), never a message
  count?: number // integer 1..10 000: repeats the renderer folded since its last report
}

/** 14 §3.8 `RendererDiagnostic.errCode`: an error class or code name, never a message. */
export const RENDERER_ERR_CODE = /^[A-Za-z0-9_.-]{1,64}$/

export const rendererDiagnosticSchema = z
  .object({
    event: z.enum(['renderer.error', 'renderer.unhandled-rejection', 'renderer.store-error']),
    errCode: z.string().regex(RENDERER_ERR_CODE).optional(),
    count: z.number().int().min(1).max(10_000).optional()
  })
  .strict()

// A-N25…A-N27 Stop everything and quit (14 §2.2, §3.8; ADR-002 D7 steps 1–3). The `confirmationId` is issued by UI
// main for each confirmation it asks for (a UUID); A-N26 carries the renderer's `requestId` for `host.shutdown`
// (14 §1.6: a UUIDv7, the seam-B rule of every mutating request).
export const stopEverythingRequestedSchema = z
  .object({ confirmationId: z.string().uuid() })
  .strict()

export const confirmStopEverythingSchema = z
  .object({ confirmationId: z.string().uuid(), requestId: requestIdSchema })
  .strict()

export const cancelStopEverythingSchema = z.object({ confirmationId: z.string().uuid() }).strict()
