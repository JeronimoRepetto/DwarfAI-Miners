// The SecretStore double (16 §4.12.1 `FakeSecretStore`: an in-memory map with a switchable
// `'unavailable'` backend). Never imported by production code (R14). ISSUE-215 runs it through
// `runSecretStoreContract` beside the OS adapter.
//
// - `setBackend('unavailable')`: `get`/`has` read "not configured", `set` throws, and `delete`
//   resolves `'unavailable'` without throwing (ADR-017 items 1, 5; AMENDMENT-2 AR-13-04).
// - `failDeletes(error)`: every later `delete` rejects with `error` (a locked or unreachable
//   secret store, 07 S13.07), until `failDeletes(null)`.
import type { SecretBackend, SecretDeleteOutcome, SecretName, SecretStore } from '../secretStore'

export class FakeSecretStore implements SecretStore {
  private readonly entries = new Map<SecretName, string>()
  private currentBackend: SecretBackend = 'os-secret-store'
  private deleteFailure: Error | null = null
  /** Every `delete` call, in order, whatever its outcome. */
  readonly deleted: SecretName[] = []

  setBackend(backend: SecretBackend): void {
    this.currentBackend = backend
  }

  failDeletes(error: Error | null): void {
    this.deleteFailure = error
  }

  backend(): Promise<SecretBackend> {
    return Promise.resolve(this.currentBackend)
  }

  get(name: SecretName): Promise<string | null> {
    if (this.currentBackend === 'unavailable') return Promise.resolve(null)
    return Promise.resolve(this.entries.get(name) ?? null)
  }

  has(name: SecretName): Promise<boolean> {
    return this.get(name).then((value) => value !== null)
  }

  set(name: SecretName, value: string): Promise<void> {
    if (this.currentBackend === 'unavailable') {
      return Promise.reject(new Error('SecretStoreUnavailable'))
    }
    this.entries.set(name, value)
    return Promise.resolve()
  }

  delete(name: SecretName): Promise<SecretDeleteOutcome> {
    this.deleted.push(name)
    if (this.deleteFailure !== null) return Promise.reject(this.deleteFailure)
    if (this.currentBackend === 'unavailable') return Promise.resolve('unavailable')
    this.entries.delete(name)
    return Promise.resolve('deleted')
  }
}
