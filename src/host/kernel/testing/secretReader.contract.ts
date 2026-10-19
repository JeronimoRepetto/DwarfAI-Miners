// The SecretReader conformance suite (16 §3 row `SecretReader`, §2.8; 17 §1.3): run against
// FakeSecretReader and every production binding — the fail-closed bridge of cut 1
// (host/wiring/bridges/secretReader.ts) and, later, the bridge over the OS secret store (ISSUE-324).
// The `'timeout'` outcome needs a store that blocks, so it is proven where one can be scripted
// (FakeSecretReader's own suite; the store bridge's, later).
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../domain/errors'
import { SECRET_NAMES, type SecretName, type SecretReader } from '../ports/secretReader'

export interface SecretReaderSubject {
  reader: SecretReader
  /** The values the subject holds; a name left out is not configured. */
  configured: Partial<Record<SecretName, string>>
}

export function runSecretReaderContract(makeSubject: () => SecretReaderSubject): void {
  describe('SecretReader contract', () => {
    it('[ADR-017] each allowlisted name reads its configured value, or null when it is not set', async () => {
      const { reader, configured } = makeSubject()

      const read = await Promise.all(SECRET_NAMES.map((name) => reader.read(name)))

      expect(read).toEqual(SECRET_NAMES.map((name) => configured[name] ?? null))
    })

    it('[ADR-017] a name outside the allowlist is refused, never read', async () => {
      const { reader } = makeSubject()

      await expect(reader.read('anthropic-api-key' as SecretName)).rejects.toBeInstanceOf(
        HostInvariantError
      )
    })
  })
}
