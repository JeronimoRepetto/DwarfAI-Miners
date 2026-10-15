// A scripted `KeyringBinding` (an in-memory OS secret store) for the `OsKeyringSecretStore` tests:
// entries keyed by (service, account), a switchable "no secret service", and scripted failures.
// Never imported by production code (R14). Several store instances may share one binding, as
// several Host starts share the person's keychain.
import { KeyringUnavailable, type KeyringBinding } from '../keyringBinding'

type Failure = 'unavailable' | Error

export class ScriptedKeyringBinding implements KeyringBinding {
  private readonly entries = new Map<string, string>()
  private serviceUp: boolean
  private failure: Failure | null = null
  /** How many times `available()` was asked. */
  probes = 0
  /** Every call that reached the keyring, in order, without values. */
  readonly calls: string[] = []

  constructor(options: { available?: boolean } = {}) {
    this.serviceUp = options.available ?? true
  }

  /** Every stored entry as `service/account` → value. */
  snapshot(): ReadonlyMap<string, string> {
    return new Map(this.entries)
  }

  /** From now on every read, write and remove rejects: unavailable, or with `error`. */
  failWith(failure: Failure | null): void {
    this.failure = failure
  }

  available(): Promise<boolean> {
    this.probes += 1
    return Promise.resolve(this.serviceUp)
  }

  read(service: string, account: string): Promise<string | null> {
    return this.call(
      `read ${service}/${account}`,
      () => this.entries.get(key(service, account)) ?? null
    )
  }

  write(service: string, account: string, value: string): Promise<void> {
    return this.call(`write ${service}/${account}`, () => {
      this.entries.set(key(service, account), value)
    })
  }

  remove(service: string, account: string): Promise<void> {
    return this.call(`remove ${service}/${account}`, () => {
      this.entries.delete(key(service, account))
    })
  }

  private call<T>(label: string, work: () => T): Promise<T> {
    this.calls.push(label)
    if (!this.serviceUp || this.failure === 'unavailable') {
      return Promise.reject(new KeyringUnavailable())
    }
    if (this.failure !== null) return Promise.reject(this.failure)
    return Promise.resolve(work())
  }
}

const key = (service: string, account: string): string => `${service}/${account}`
