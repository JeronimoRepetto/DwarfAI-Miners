// `OsKeyringSecretStore` (ADR-017 item 2; 16 §4.12.1): the `SecretStore` adapter over the OS secret
// store — macOS Keychain, Windows Credential Manager, Linux Secret Service — through a
// `KeyringBinding` (keyringBinding.ts, where the real library binding is plugged in).
//
// - One entry per `SecretName`: service `DwarfAI-Miners`, account = the name (item 2).
// - `backend()` probes the secret service once; a probe that fails counts as `'unavailable'`.
// - No plain-text fallback (item 5): with no usable secret service — at the probe or at call time —
//   `set` throws `SecretStoreUnavailable` and writes nothing anywhere, `get`/`has` answer "not
//   configured", and `delete` resolves `'unavailable'` without throwing (AMENDMENT-2, AR-13-04).
// - Any other keyring failure rejects with `SecretStoreFailure`, which names the operation and the
//   secret only: the library's error and message are dropped, so a value it echoes never reaches a
//   caller or a log (item 3; NFR-SEC-12). A failed `delete` fails the Reset step, which resumes at
//   the next start (item 7).
// - `set` and `delete` record `secret.op` (19 §9.5): the name and the operation, the outcome and
//   `backend-unavailable` as cause; never the value.
import type { DiagnosticsLog } from '../../../../kernel/ports/diagnosticsLog'
import type {
  SecretBackend,
  SecretDeleteOutcome,
  SecretName,
  SecretStore
} from '../../ports/secretStore'
import { KeyringUnavailable, type KeyringBinding } from './keyringBinding'

/** ADR-017 item 2: the service every DwarfAI entry is stored under. */
export const SECRET_SERVICE = 'DwarfAI-Miners'

/** `set` on a system with no usable secret service (ADR-017 item 5; FM-115). */
export class SecretStoreUnavailable extends Error {
  constructor() {
    super('SecretStoreUnavailable: no usable OS secret service')
    this.name = 'SecretStoreUnavailable'
  }
}

/** The OS secret store failed on an available backend; carries no library detail. */
export class SecretStoreFailure extends Error {
  constructor(operation: 'get' | 'set' | 'delete', name: SecretName) {
    super(`SecretStore ${operation} of ${name} failed`)
    this.name = 'SecretStoreFailure'
  }
}

const BACKEND_UNAVAILABLE = 'backend-unavailable'

export class OsKeyringSecretStore implements SecretStore {
  private probed: Promise<SecretBackend> | null = null

  constructor(
    private readonly binding: KeyringBinding,
    private readonly log: DiagnosticsLog
  ) {}

  backend(): Promise<SecretBackend> {
    this.probed ??= this.binding.available().then(
      (available): SecretBackend => (available ? 'os-secret-store' : 'unavailable'),
      (): SecretBackend => 'unavailable'
    )
    return this.probed
  }

  async get(name: SecretName): Promise<string | null> {
    if ((await this.backend()) === 'unavailable') return null
    try {
      return await this.binding.read(SECRET_SERVICE, name)
    } catch (error) {
      if (error instanceof KeyringUnavailable) return null
      throw new SecretStoreFailure('get', name)
    }
  }

  async has(name: SecretName): Promise<boolean> {
    return (await this.get(name)) !== null
  }

  async set(name: SecretName, value: string): Promise<void> {
    if ((await this.backend()) === 'unavailable') return this.refuseSet(name)
    try {
      await this.binding.write(SECRET_SERVICE, name, value)
    } catch (error) {
      if (error instanceof KeyringUnavailable) return this.refuseSet(name)
      this.record('warn', name, 'set', 'failed')
      throw new SecretStoreFailure('set', name)
    }
    this.record('info', name, 'set', 'ok')
  }

  async delete(name: SecretName): Promise<SecretDeleteOutcome> {
    if ((await this.backend()) === 'unavailable') return this.skipDelete(name)
    try {
      await this.binding.remove(SECRET_SERVICE, name)
    } catch (error) {
      if (error instanceof KeyringUnavailable) return this.skipDelete(name)
      this.record('warn', name, 'delete', 'failed')
      throw new SecretStoreFailure('delete', name)
    }
    this.record('info', name, 'delete', 'ok')
    return 'deleted'
  }

  private refuseSet(name: SecretName): never {
    this.record('warn', name, 'set', 'failed', BACKEND_UNAVAILABLE)
    throw new SecretStoreUnavailable()
  }

  private skipDelete(name: SecretName): 'unavailable' {
    this.record('info', name, 'delete', 'skipped', BACKEND_UNAVAILABLE)
    return 'unavailable'
  }

  private record(
    level: 'info' | 'warn',
    name: SecretName,
    operation: 'set' | 'delete',
    outcome: 'ok' | 'failed' | 'skipped',
    causeClass?: string
  ): void {
    this.log.record({
      level,
      event: 'secret.op',
      subsystem: 'preferences',
      msg: `${name} ${operation}`,
      outcome,
      ...(causeClass === undefined ? {} : { causeClass })
    })
  }
}
