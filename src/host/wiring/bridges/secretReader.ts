// The kernel `SecretReader` bridge (16 §3 row `SecretReader`; 05 §4 "kernel SecretReader →
// preferences"; ADR-017 item 1): the one way a Host consumer reads a secret value, never on the
// wire. Its target is the preferences `SecretStore`, read with SECRET_READ_TIMEOUT_MS.
//
// - `storeSecretReader` (step 3a, ISSUE-324): reads through the `SecretStore` the composition root
//   built (`OsKeyringSecretStore`, host/main.ts). A read the store has not answered after
//   SECRET_READ_TIMEOUT_MS answers `'timeout'` (16 §2.6; FM-116), so a blocked keychain never
//   hangs a caller, which fails closed (`jev-unreachable`, `refused: 'channel-unavailable'`); the
//   store's late answer is dropped. A store failure rejects as the store rejected it (its error
//   names the operation and the secret only, never the value). The bridge logs nothing and keeps
//   nothing: the value goes to the caller only (ADR-017 item 3; 16 §2.7).
// - `failClosedSecretReader` (cut 1, ISSUE-226): the reader of a wiring with no secret store to
//   read; every allowlisted name answers "not set" (`null`) and nothing is read from anywhere.
//
// Both refuse a name outside the allowlist before anything is read (a wiring defect).
import { HostInvariantError } from '../../kernel/domain/errors'
import type { Scheduler } from '../../kernel/ports/scheduler'
import {
  SECRET_NAMES,
  SECRET_READ_TIMEOUT_MS,
  type SecretReader,
  type SecretValue
} from '../../kernel/ports/secretReader'
import type { SecretStore } from '../../modules/preferences'

const outsideAllowlist = (): Promise<never> =>
  Promise.reject(new HostInvariantError('a secret outside the allowlist was read'))

export const failClosedSecretReader: SecretReader = {
  read: (name) => (SECRET_NAMES.includes(name) ? Promise.resolve(null) : outsideAllowlist())
}

export interface StoreSecretReaderDeps {
  /** The preferences `SecretStore` (ADR-017 item 1), read only here. */
  store: Pick<SecretStore, 'get'>
  /** Where the SECRET_READ_TIMEOUT_MS deadline of each read waits (16 §2.6). */
  scheduler: Scheduler
}

export function storeSecretReader(deps: StoreSecretReaderDeps): SecretReader {
  return {
    read: (name) => {
      if (!SECRET_NAMES.includes(name)) return outsideAllowlist()
      return new Promise<SecretValue | null | 'timeout'>((resolve, reject) => {
        const deadline = deps.scheduler.after(SECRET_READ_TIMEOUT_MS, () => resolve('timeout'))
        deps.store.get(name).then(
          (value) => {
            deadline.cancel()
            resolve(value)
          },
          (error: unknown) => {
            deadline.cancel()
            reject(error)
          }
        )
      })
    }
  }
}
