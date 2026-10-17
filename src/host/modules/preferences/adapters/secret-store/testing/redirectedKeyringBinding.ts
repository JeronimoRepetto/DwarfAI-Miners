// The real keyring binding for the OS-lane tests, with service `DwarfAI-Miners` mapped to a service
// unique to the test run, so a test never reads, overwrites or deletes the person's own entries.
// A call for any other service throws, so a store asking for the wrong service fails its test.
// Never imported by production code (R14).
import { randomBytes } from 'node:crypto'
import type { KeyringBinding } from '../keyringBinding'
import { NapiKeyringBinding } from '../napiKeyringBinding'
import { SECRET_SERVICE } from '../OsKeyringSecretStore'

/** A service name of its own for one test run, under the DwarfAI prefix. */
export const drawRunService = (): string =>
  `${SECRET_SERVICE}.os-test-${randomBytes(6).toString('hex')}`

export function redirectedKeyringBinding(runService: string): KeyringBinding {
  const real = new NapiKeyringBinding(runService)
  const to = (service: string): string => {
    if (service !== SECRET_SERVICE) throw new Error(`unexpected keyring service ${service}`)
    return runService
  }
  return {
    available: () => real.available(),
    read: (service, account) => real.read(to(service), account),
    write: (service, account, value) => real.write(to(service), account, value),
    remove: (service, account) => real.remove(to(service), account)
  }
}
