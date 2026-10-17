// A-48 `setJevApiKey` / `jev:apiKey:set` and A-49 `clearJevApiKey` / `jev:apiKey:clear` served by their `host` handler
// from step 3a (14 §2.1 KEEP rows, `host`, owner preferences; 21 §2 cut 3a, §3 `SecretMigrationBridge`, §4 row "Jev API
// key"; ADR-017 items 3–5; ADR-019 items 7, 8; UC-029, the Jev key half).
//
// - A-48 is **sensitive** (14 §2.1, §3.5): main checks the renderer's value before anything is sent, as today's
//   boundary does (`parseJevApiKeyInput`, carried here because this tree may not import it, 05 R16): a string, trimmed,
//   not empty, at most 512 characters (`LEGACY_JEV_API_KEY_MAX_CHARS`), one unbroken printable-ASCII token. A malformed
//   value is refused with the legacy failure shape, the `JevSettings` in force unchanged, and never crosses to the Host.
//   The router's seam A gate refuses the registry schema's misses the same way (validate.ts `unchanged`); this check
//   keeps the handler safe on its own and covers what the registry schema leaves to today's parser.
// - A valid value is relayed once as B-M10 `settings.secret.set {name:'jev-key', origin:'settings'}` with a `requestId`
//   main mints (today's payload has none, 14 §1.6); A-49 relays B-M11 `settings.secret.clear {name:'jev-key'}`. The
//   answer is today's `JevSettings`, built from the Host's result by `JevSettingsShapeAdapter` (21 §3.1): the configured
//   flag only, never the key and never a validity flag (US-SET-007.AC07). `configured: true` after a save is the signal
//   the renderer shows "Jev key saved" on, `configured: false` after a clear the signal for "Jev key cleared"
//   (US-SET-007.AC02, AC03; PO #43).
// - Today's rows have no error branch: a Host call error answers the `JevSettings` in force (as today's handler answers
//   what its store holds after a failed write); when that read fails too, the call rejects and the preload's
//   `invokeOrReject` carries it (14 §1.4).
// - A-48/A-49 are KEEP rows: the step-3a switch (ISSUE-001) routes them `host`, and the root composes this part only
//   where the table routes them so (22 §5); a call of any other channel is refused, never guessed (14 §1.5).
//
// Nothing here logs: the A-48 payload is the key itself (14 §3.5 SENSITIVE_METHODS).
//
// Candidate decision (21 §6): today's handlers in `src/main/index.ts` write today's `safeStorage` file, a second copy at
// rest from 3a (C-23); replaced by this relay. Today's input rule is kept as it is.
import type { z } from 'zod'
import { CHANNELS, type ChannelKey, type SecretStatusResult } from '@dwarfai/contracts'
import type { HostClient } from '../../window/ports/hostClient'
import type { RouteTarget } from '../router'

/** A-48 and A-49 (invoke), by their registry keys. */
export const SET_JEV_API_KEY = 'jev:apiKey:set' satisfies ChannelKey
export const CLEAR_JEV_API_KEY = 'jev:apiKey:clear' satisfies ChannelKey
/** The invoke rows this target serves. */
export const JEV_API_KEY_ROWS = [SET_JEV_API_KEY, CLEAR_JEV_API_KEY] as const

/** Today's `JevSettings`, the answer of A-47…A-49. */
export type JevSettingsAnswer = z.output<(typeof CHANNELS)['jev:settings:get']['response']>

/** `JevSettingsShapeAdapter` as these rows use it (handed in by the composition root, 05 R16). */
export interface JevSettingsSource {
  /** The `JevSettings` in force now. */
  read(): Promise<JevSettingsAnswer>
  /** The `JevSettings` after a B-M10 / B-M11 answer. */
  fromStatus(result: SecretStatusResult): Promise<JevSettingsAnswer>
}

/** Today's `MAX_JEV_API_KEY_CHARS` (A-48 "over the length cap", 14 §2.1). */
const MAX_KEY_CHARS = 512
/** One unbroken token of printable, non-whitespace ASCII: today's rule for a key (`parseJevApiKeyInput`). */
const KEY_TOKEN = /^[!-~]+$/

/** The key to send, trimmed, or `undefined` for a value today's boundary refuses. */
function keyOf(payload: unknown): string | undefined {
  if (typeof payload !== 'string') return undefined
  const key = payload.trim()
  return key !== '' && key.length <= MAX_KEY_CHARS && KEY_TOKEN.test(key) ? key : undefined
}

export function createJevApiKeyRows(deps: {
  client: Pick<HostClient, 'call'>
  settings: JevSettingsSource
  mintId: () => string
}): RouteTarget {
  const { client, settings, mintId } = deps

  /** The Host's answer as `JevSettings`; a call error answers the state in force (today's rows have no error branch). */
  const answer = (call: Promise<SecretStatusResult>): Promise<JevSettingsAnswer> =>
    call.then(
      (result) => settings.fromStatus(result),
      () => settings.read()
    )

  return {
    serve(channel, payload): Promise<unknown> {
      if (channel === SET_JEV_API_KEY) {
        const value = keyOf(payload)
        if (value === undefined) return settings.read()
        return answer(
          client.call('settings.secret.set', {
            name: 'jev-key',
            value,
            requestId: mintId(),
            origin: 'settings'
          })
        )
      }
      if (channel === CLEAR_JEV_API_KEY) {
        return answer(
          client.call('settings.secret.clear', { name: 'jev-key', requestId: mintId() })
        )
      }
      return Promise.resolve({
        ok: false,
        error: { code: 'METHOD_NOT_FOUND', message: `no route for ${channel}`, retryable: false }
      })
    }
  }
}
