// The SecretReader double (16 §3 row `SecretReader`: `FakeSecretReader`, switchable delay; 16 §2.8):
// it answers the values a test configured, refuses a name outside the allowlist like every
// binding, and, switched to `blocking`, waits on the injected Scheduler and answers `'timeout'`
// after SECRET_READ_TIMEOUT_MS, as a blocking keychain does (16 §2.6). Passes
// runSecretReaderContract. Never imported by production code (R14).
import { HostInvariantError } from '../domain/errors'
import type { Scheduler } from '../ports/scheduler'
import {
  SECRET_NAMES,
  SECRET_READ_TIMEOUT_MS,
  type SecretName,
  type SecretReader,
  type SecretValue
} from '../ports/secretReader'

export interface FakeSecretReaderOptions {
  /** The configured secrets; a name left out is not configured. */
  values?: Partial<Record<SecretName, SecretValue>>
  /** Where a blocking read waits for its timeout. */
  scheduler: Scheduler
}

export class FakeSecretReader implements SecretReader {
  /** While true, every read waits SECRET_READ_TIMEOUT_MS and answers `'timeout'`. */
  blocking = false
  /** Every allowlisted name read, in order. */
  readonly reads: SecretName[] = []

  constructor(private readonly options: FakeSecretReaderOptions) {}

  read(name: SecretName): Promise<SecretValue | null | 'timeout'> {
    if (!SECRET_NAMES.includes(name)) {
      return Promise.reject(new HostInvariantError('a secret outside the allowlist was read'))
    }
    this.reads.push(name)
    if (this.blocking) {
      return new Promise((resolve) =>
        this.options.scheduler.after(SECRET_READ_TIMEOUT_MS, () => resolve('timeout'))
      )
    }
    return Promise.resolve(this.options.values?.[name] ?? null)
  }
}
