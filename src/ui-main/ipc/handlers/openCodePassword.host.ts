// A-54 `setOpenCodeServerPassword` / `opencode:password:set` and A-55 `clearOpenCodeServerPassword` /
// `opencode:password:clear` served by their `host` handler from step 4a (14 §2.1 CHANGE rows, `host`, owner
// preferences; §3.8 `OpenCodeSettingsView`; 21 §2 cut 4a, §3 `SecretMigrationBridge`, §4 row "OpenCode server password";
// ADR-017 items 3–5; ADR-019 items 7, 8; UC-029, the password half).
//
// - A-54 is **sensitive** (14 §2.1, §3.5): main checks the renderer's value before anything is sent: the registry's
//   request (a string of at most 1024 characters, today's `MAX_OPENCODE_SERVER_PASSWORD_CHARS`) and not empty (today's
//   store refused an empty password). A malformed value answers `IpcResult {ok:false, error: INVALID_PARAMS}` and never
//   crosses to the Host. The value is never trimmed or altered: spaces are part of a password, as in today's store.
// - A valid value is relayed once as B-M10 `settings.secret.set {name:'opencode-password', origin:'settings'}` with a
//   `requestId` main mints (today's payload has none, 14 §1.6); A-55 relays B-M11 `settings.secret.clear
//   {name:'opencode-password'}`. The answer is `IpcResult<OpenCodeSettingsView>` read from the `preferences` section
//   (B-M12 `preferences.get`, the snapshot section's data) with `passwordConfigured` taken from the B-M10 / B-M11
//   answer: a configured flag only, never the password (ADR-017 item 3). `passwordConfigured: true` after a save is the
//   signal the renderer shows "OpenCode password saved" on, `false` after a clear the signal for "OpenCode password
//   cleared" (US-SET-009.AC03, AC04; PO #43).
// - `backend-unavailable` (no usable OS secret service, 13 FM-115; ADR-017 item 5, no plain-text fallback) is an
//   outcome, not an error: the view answers `secretBackend: 'unavailable'` with the password not configured. A Host
//   call error (`HOST_NOT_READY`, …) is the result's error branch, never a throw into the renderer (14 §1.5).
// - A-54/A-55 are routed `host` by the step-4a switch (later: ISSUE-235); the root composes this part only where the
//   table routes them so (22 §5). A call of any other channel is refused, never guessed (14 §1.5).
//
// Nothing here logs: the A-54 payload is the password itself (14 §3.5 SENSITIVE_METHODS).
//
// Candidate decision (21 §6): today's handlers in `src/main/index.ts` / `LegacyRuntimeRoute` save through
// `openCodeServerPassword.ts`, which wraps Electron `safeStorage` as the store (16 §4.12.1 "not transplanted as the
// store") and is a second copy at rest from 4a (C-23); replaced by this relay.
import {
  CHANNELS,
  type ChannelKey,
  type IpcError,
  type IpcResult,
  type OpenCodeSettingsView,
  type PreferencesView,
  type SecretStatusResult
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-54 and A-55 (invoke), by their registry keys. */
export const SET_OPENCODE_PASSWORD = 'opencode:password:set' satisfies ChannelKey
export const CLEAR_OPENCODE_PASSWORD = 'opencode:password:clear' satisfies ChannelKey
/** The invoke rows this target serves. */
export const OPENCODE_PASSWORD_ROWS = [SET_OPENCODE_PASSWORD, CLEAR_OPENCODE_PASSWORD] as const

/** `OpenCodeSettingsView` (14 §3.8) from the `preferences` section: the integration state and the password flag. */
export function openCodeSettingsViewOf(view: PreferencesView): OpenCodeSettingsView {
  const integration = view.integrations.find(({ id }) => id === 'opencode-permissions')
  const password = view.secrets.find(({ name }) => name === 'opencode-password')
  return {
    permissions: integration?.state ?? 'off',
    ...(integration?.consentOrigin === undefined
      ? {}
      : { consentOrigin: integration.consentOrigin }),
    passwordConfigured: password?.configured === true,
    secretBackend: view.secretBackend
  }
}

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the OpenCode password relay failed')
}

export function createOpenCodePasswordRows(deps: {
  client: Pick<HostClient, 'call'>
  mintId: () => string
}): RouteTarget {
  const { client, mintId } = deps
  const request = CHANNELS[SET_OPENCODE_PASSWORD].request

  /** The view after a B-M10 / B-M11 answer; a call error, of either call, is the error branch. */
  const answer = (call: Promise<SecretStatusResult>): Promise<IpcResult<OpenCodeSettingsView>> =>
    call
      .then(async (result): Promise<IpcResult<OpenCodeSettingsView>> => {
        const view = openCodeSettingsViewOf(await client.call('preferences.get', {}))
        return {
          ok: true,
          value: result.ok
            ? { ...view, passwordConfigured: result.value.configured }
            : { ...view, passwordConfigured: false, secretBackend: 'unavailable' }
        }
      })
      .catch((error: unknown) => ({ ok: false, error: ipcErrorOf(error) }))

  return {
    serve(channel, payload): Promise<IpcResult<OpenCodeSettingsView>> {
      if (channel === SET_OPENCODE_PASSWORD) {
        const parsed = request.safeParse(payload)
        if (!parsed.success || parsed.data === '') {
          return Promise.resolve({
            ok: false,
            error: callError('INVALID_PARAMS', 'the params do not match the method schema')
          })
        }
        return answer(
          client.call('settings.secret.set', {
            name: 'opencode-password',
            value: parsed.data,
            requestId: mintId(),
            origin: 'settings'
          })
        )
      }
      if (channel === CLEAR_OPENCODE_PASSWORD) {
        return answer(
          client.call('settings.secret.clear', { name: 'opencode-password', requestId: mintId() })
        )
      }
      return Promise.resolve({
        ok: false,
        error: callError('METHOD_NOT_FOUND', `no route for ${channel}`)
      })
    }
  }
}
