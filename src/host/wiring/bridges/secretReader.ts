// The kernel `SecretReader` bridge (16 §3 row `SecretReader`; 05 §4 "kernel SecretReader →
// preferences"; ADR-017 item 1): the one way a Host consumer reads a secret value, never on the
// wire. Its target is the preferences `SecretStore`, read with SECRET_READ_TIMEOUT_MS.
//
// Cut 1 (ISSUE-226): the OS secret store is not wired yet (`OsKeyringSecretStore` and the Jev key,
// later: ISSUE-324, its only later writer), so this is the fail-closed reader: every allowlisted
// name answers "not set" (`null`) and nothing is read from anywhere — no store, no file, no
// environment. A name outside the allowlist is refused, as by every binding (a wiring defect).
import { HostInvariantError } from '../../kernel/domain/errors'
import { SECRET_NAMES, type SecretReader } from '../../kernel/ports/secretReader'

export const failClosedSecretReader: SecretReader = {
  read: (name) =>
    SECRET_NAMES.includes(name)
      ? Promise.resolve(null)
      : Promise.reject(new HostInvariantError('a secret outside the allowlist was read'))
}
