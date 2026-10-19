// A-52 `getOpenCodeSettings` / `opencode:settings:get` and A-53 `setOpenCodePluginEnabled` / `opencode:plugin:set`
// served by their `host` handler (14 §2.1 CHANGE rows, `host`, owner preferences; §3.4 `SetOpenCodePermissionsParams`,
// `SetOpenCodePermissionsResult`; §3.8 `OpenCodeSettingsView`; ADR-011 item 7; ADR-016 items 5–7; ADR-019 items 7, 8;
// UC-028): Settings → Integrations "OpenCode · permission requests" and the Add panel's notice action.
//
// - A-52 relays B-M12 `preferences.get` (14 §2.3: B-M12 serves #52) and builds `OpenCodeSettingsView` from its
//   `PreferencesView`: `permissions` is the stored state of `opencode-permissions` (`off` on a fresh install, INV-106),
//   `consentOrigin` only while it is on, `passwordConfigured` the `opencode-password` secret's flag (never the value,
//   ADR-017) and `secretBackend` as the Host reports it. `permissionsError` is a failed A-53's, which the caller holds
//   from that answer; a read never carries one.
// - A-53 validates the renderer's payload — `{ on, origin, requestId }`, the registry's request, the same object as
//   B-M14's params (14 §1.2) — before anything is sent: an invalid payload, `origin: 'first-run'` included (only B-M40
//   consents for the first-run step, AMENDMENT-7), answers `IpcResult {ok:false, error: INVALID_PARAMS}` and never
//   reaches the Host (ADR-019). A valid payload is relayed unchanged as `preferences.setOpenCodePermissions` through
//   `HostClient.call`, the renderer's `requestId` and origin (`settings` or `add-panel`) included: main mints nothing.
//   The stored state comes back after the write and read-back settled (14 §1.7), so the Add panel's launch is sent
//   only after it (ADR-011 item 7); `config-write-failed` and `config-revert-failed` are outcomes of that result (a
//   locked turn-off keeps the option on, 16 §7.4), never call errors.
// - A Host call error (`FORBIDDEN`, `HOST_NOT_READY`, `TIMEOUT`, …) is the result's error branch, never a throw into
//   the renderer (14 §1.5). A call of any other channel is refused, never guessed.
// - Both rows switch to `host` in step 4a (ISSUE-235, 22 §5); the root composes this part only where the table routes
//   them so (`composeOpenCodeSettingsRows`, src/ui-main/index.ts).
//
// Nothing here logs: the payloads are a boolean, an origin and a requestId, and no token or password crosses seam A.
//
// Candidate decision (21 §6): today's handlers in `src/main/index.ts` drive the legacy plugin installer; replaced by
// this relay (no candidate conforms: the Host is the one writer from the switch, 21 §1 item 4).
import {
  CHANNELS,
  type ChannelKey,
  type IpcError,
  type IpcResult,
  type OpenCodeSettingsView,
  type PreferencesView,
  type SetOpenCodePermissionsResult
} from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-52 and A-53 (invoke), by their registry keys. */
export const GET_OPENCODE_SETTINGS = 'opencode:settings:get' satisfies ChannelKey
export const SET_OPENCODE_PLUGIN = 'opencode:plugin:set' satisfies ChannelKey
/** The invoke rows this target serves. */
export const OPENCODE_SETTINGS_ROWS = [GET_OPENCODE_SETTINGS, SET_OPENCODE_PLUGIN] as const

const INTEGRATION = 'opencode-permissions'
const PASSWORD = 'opencode-password'

function callError(code: IpcError['code'], message: string): IpcError {
  return { code, message, retryable: false }
}

/** A HostClient call error carries its seam-B error (14 §3.3); anything else is INTERNAL. */
function ipcErrorOf(error: unknown): IpcError {
  const carried = (error as { error?: Partial<IpcError> } | null)?.error
  return typeof carried?.code === 'string'
    ? (carried as IpcError)
    : callError('INTERNAL', 'the OpenCode settings relay failed')
}

/** 14 §3.8 `OpenCodeSettingsView` from the Host's `PreferencesView`. */
export function openCodeSettingsViewOf(view: PreferencesView): OpenCodeSettingsView {
  const setting = view.integrations.find((candidate) => candidate.id === INTEGRATION)
  const permissions = setting?.state ?? 'off'
  const consentOrigin = permissions === 'off' ? undefined : setting?.consentOrigin
  return {
    permissions,
    ...(consentOrigin === undefined ? {} : { consentOrigin }),
    passwordConfigured: view.secrets.some(
      (secret) => secret.name === PASSWORD && secret.configured
    ),
    secretBackend: view.secretBackend
  }
}

export function createOpenCodeSettingsRows(client: Pick<HostClient, 'call'>): RouteTarget {
  const request = CHANNELS[SET_OPENCODE_PLUGIN].request
  return {
    serve(
      channel,
      payload
    ): Promise<IpcResult<OpenCodeSettingsView | SetOpenCodePermissionsResult>> {
      if (channel === GET_OPENCODE_SETTINGS) {
        return client.call('preferences.get', {}).then(
          (view): IpcResult<OpenCodeSettingsView> => ({
            ok: true,
            value: openCodeSettingsViewOf(view)
          }),
          (error: unknown): IpcResult<OpenCodeSettingsView> => ({
            ok: false,
            error: ipcErrorOf(error)
          })
        )
      }
      if (channel !== SET_OPENCODE_PLUGIN) {
        return Promise.resolve({
          ok: false,
          error: callError('METHOD_NOT_FOUND', `no route for ${channel}`)
        })
      }
      const parsed = request.safeParse(payload)
      if (!parsed.success) {
        return Promise.resolve({
          ok: false,
          error: callError('INVALID_PARAMS', 'the params do not match the method schema')
        })
      }
      return client.call('preferences.setOpenCodePermissions', parsed.data).then(
        (result): IpcResult<SetOpenCodePermissionsResult> => ({ ok: true, value: result }),
        (error: unknown): IpcResult<SetOpenCodePermissionsResult> => ({
          ok: false,
          error: ipcErrorOf(error)
        })
      )
    }
  }
}
