// The SecretStore conformance suite `runSecretStoreContract` (16 §4.12.1; ADR-017 items 1, 3, 5, 7;
// 17 §1.3): run on the `FakeSecretStore` double and on `OsKeyringSecretStore` (over a scripted
// keyring binding here; over the real OS keyring in the OS lane once SP-16 records the library).
//
// - `set` then `has` is true and `get` returns the value; `delete` then `get` is null; `delete`
//   twice succeeds and resolves `'deleted'` both times (ADR-017 item 1, Verification; item 7).
// - With no usable secret service `set` throws `SecretStoreUnavailable` and nothing is written
//   anywhere; `get`/`has` answer "not configured"; `delete` resolves `'unavailable'` and never
//   throws (item 5; AMENDMENT-2, AR-13-04; FM-115).
// - A stored value never reaches a log record, a file under the data directories or an error
//   message (item 3; NFR-SEC-12).
//
// Never imported by production code (R14). Values are drawn at run time, so no secret-shaped value
// is ever written into the repository.
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SecretBackend, SecretName, SecretStore } from '../ports/secretStore'

export interface SecretStoreSubject {
  store: SecretStore
  /** Every log record the store wrote, serialized; `''` for a store that has no log. */
  logText(): string
  /** The directories the Host writes to (its data directory, the UI's `userData`). */
  dataDirs: readonly string[]
  dispose(): void | Promise<void>
}

/** Makes a subject whose secret service is usable (`'os-secret-store'`) or not (`'unavailable'`). */
export type SecretStoreSubjectFactory = (
  backend: SecretBackend
) => SecretStoreSubject | Promise<SecretStoreSubject>

const drawValue = (): string => randomBytes(24).toString('base64url')

/** Every file under `dir`, with its text. */
function filesUnder(dir: string): Array<{ path: string; text: string }> {
  const found: Array<{ path: string; text: string }> = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...filesUnder(path))
    else found.push({ path, text: readFileSync(path, 'latin1') })
  }
  return found
}

/** Everything an error carries that a caller could print or log. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return [error.name, error.message, error.stack ?? '', JSON.stringify(error)].join('\n')
}

export function runSecretStoreContract(makeSubject: SecretStoreSubjectFactory): void {
  describe('SecretStore contract', () => {
    const subjects: SecretStoreSubject[] = []

    afterEach(async () => {
      for (const subject of subjects.splice(0)) await subject.dispose()
    })

    const setUp = async (backend: SecretBackend): Promise<SecretStoreSubject> => {
      const subject = await makeSubject(backend)
      subjects.push(subject)
      return subject
    }

    it('[ADR-017] set then has is true and get returns the value; delete then get is null; delete twice succeeds', async () => {
      const { store } = await setUp('os-secret-store')
      const jevKey = drawValue()
      const password = drawValue()

      expect(await store.backend()).toBe('os-secret-store')
      expect(await store.has('jev-key')).toBe(false)
      expect(await store.get('jev-key')).toBeNull()

      await store.set('jev-key', jevKey)
      await store.set('opencode-password', password)
      expect(await store.has('jev-key')).toBe(true)
      expect(await store.get('jev-key')).toBe(jevKey)
      expect(await store.get('opencode-password')).toBe(password)

      const replaced = drawValue()
      await store.set('jev-key', replaced)
      expect(await store.get('jev-key')).toBe(replaced)

      expect(await store.delete('jev-key')).toBe('deleted')
      expect(await store.get('jev-key')).toBeNull()
      expect(await store.has('jev-key')).toBe(false)
      expect(await store.delete('jev-key')).toBe('deleted')
      expect(await store.get('opencode-password')).toBe(password)

      expect(await store.delete('opencode-password')).toBe('deleted')
      expect(await store.has('opencode-password')).toBe(false)
    })

    it('[ADR-017, FM-115] with an unavailable backend set throws SecretStoreUnavailable and writes nothing; get and has answer not configured; delete resolves unavailable', async () => {
      const subject = await setUp('unavailable')
      const { store } = subject
      const value = drawValue()

      expect(await store.backend()).toBe('unavailable')
      for (const name of ['jev-key', 'opencode-password'] as const satisfies SecretName[]) {
        await expect(store.set(name, value)).rejects.toThrow(/SecretStoreUnavailable/)
        expect(await store.get(name)).toBeNull()
        expect(await store.has(name)).toBe(false)
        expect(await store.delete(name)).toBe('unavailable')
        expect(await store.delete(name)).toBe('unavailable')
      }
      for (const dir of subject.dataDirs) expect(filesUnder(dir)).toStrictEqual([])
    })

    it('[ADR-017, NFR-SEC-12] no stored value reaches a log record, a file under the data directories or an error message', async () => {
      const available = await setUp('os-secret-store')
      const unavailable = await setUp('unavailable')
      const values = { 'jev-key': drawValue(), 'opencode-password': drawValue() }
      const errors: unknown[] = []

      for (const name of ['jev-key', 'opencode-password'] as const) {
        await available.store.set(name, values[name])
        expect(await available.store.get(name)).toBe(values[name])
        await available.store.has(name)
        await unavailable.store
          .set(name, values[name])
          .catch((error: unknown) => errors.push(error))
        await unavailable.store.get(name)
        await unavailable.store.delete(name)
        await available.store.delete(name)
      }

      expect(errors).toHaveLength(2)
      const seen = [
        available.logText(),
        unavailable.logText(),
        ...errors.map(errorText),
        ...[...available.dataDirs, ...unavailable.dataDirs].flatMap((dir) =>
          filesUnder(dir).map((file) => `${file.path}\n${file.text}`)
        )
      ].join('\n')
      for (const value of Object.values(values)) expect(seen).not.toContain(value)
    })
  })
}
