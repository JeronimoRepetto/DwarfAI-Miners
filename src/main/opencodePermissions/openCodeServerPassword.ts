import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { electronSafeStorage, type SafeStorageLike } from '../adapters/safeStorageLike'
import type { OpenCodePasswordUnavailableReason } from '../domain/types'

/**
 * The encrypted store behind Settings' optional OpenCode server password
 * (#588 T6, F1).
 *
 * A secret, not a setting — the `config-layering` skill's own distinction —
 * so it never enters the three configuration layers and is never read from
 * this app's environment (the maintainer rejected that source: the password
 * lives in the terminal that started OpenCode, not here). It is stored
 * exactly the way `jevApiKey.ts` stores the only other secret this app holds,
 * and for the same reasons:
 *
 * - One tiny JSON document under userData holding ciphertext only, behind the
 *   injected `SafeStorageLike` port, rewritten through a temp file + rename.
 * - No plaintext fallback, ever. Where `safeStorage.isEncryptionAvailable()`
 *   is false, `save` refuses with a typed reason and `load` reports it, so
 *   Settings can say why the field cannot be set.
 * - Corrupt or undecryptable ciphertext is a shape error: it degrades to
 *   "not configured" and warns by name — never by content — rather than
 *   blocking startup.
 * - The decrypted value lives only in this closure, reachable through the
 *   synchronous `readPassword()`, which main hands to the OpenCode answer port
 *   and never to an IPC channel. The renderer is only ever told whether one
 *   is configured.
 *
 * Unlike the Jev key, the value is NOT trimmed: a password is whatever the
 * person set `OPENCODE_SERVER_PASSWORD` to, spaces included, and quietly
 * altering it would turn into a 401 nobody could explain.
 */

/** The one file this store owns, under userData. */
export const OPENCODE_PASSWORD_FILE = 'opencode-server-password-v1.json'
const TEMP_SUFFIX = '.tmp'

export interface OpenCodePasswordFsLike {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

const realFs: OpenCodePasswordFsLike = {
  readFile,
  // Owner-only (#588 T6 security fix): this port only ever writes the
  // password ciphertext, so every write through it holds a secret -- a bare
  // `writeFile` would otherwise leave it at whatever mode the process umask
  // allows (0644 under the common 022 default), readable by every local
  // account. See `hookFs.ts`'s `writeSecretText` for the platform note:
  // Windows maps `mode` to the read-only attribute only, a harmless no-op
  // there, since a user-profile directory is already per-user ACL'd.
  writeFile: (path, data) => writeFile(path, data, { encoding: 'utf8', mode: 0o600 }),
  rename
}

export type OpenCodePasswordSaveResult =
  { saved: true } | { saved: false; reason: 'empty' | OpenCodePasswordUnavailableReason }

/** This store's own verdict; main merges it into the wire `OpenCodeSettings`. */
export interface OpenCodePasswordVerdict {
  configured: boolean
  unavailableReason?: OpenCodePasswordUnavailableReason
}

export interface OpenCodeServerPasswordStore {
  load: () => Promise<OpenCodePasswordVerdict>
  save: (password: string) => Promise<OpenCodePasswordSaveResult>
  clear: () => Promise<void>
  /** The decrypted password, main-only: the OpenCode answer port's one source. */
  readPassword: () => string | undefined
}

export interface OpenCodeServerPasswordStoreOptions {
  userDataDir: string
  fs?: OpenCodePasswordFsLike
  safeStorage?: SafeStorageLike
}

async function readEncrypted(
  fs: OpenCodePasswordFsLike,
  filePath: string
): Promise<string | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    // A missing file is the common first-run case; no read failure here is
    // worth failing startup over.
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const encrypted = (parsed as Record<string, unknown>).encrypted
    return typeof encrypted === 'string' ? encrypted : undefined
  } catch {
    return undefined
  }
}

export function createOpenCodeServerPasswordStore(
  options: OpenCodeServerPasswordStoreOptions
): OpenCodeServerPasswordStore {
  const fs = options.fs ?? realFs
  const safeStorage = options.safeStorage ?? electronSafeStorage
  const filePath = join(options.userDataDir, OPENCODE_PASSWORD_FILE)
  let cachedPassword: string | undefined

  async function persist(encrypted: string | undefined): Promise<void> {
    const tempPath = `${filePath}${TEMP_SUFFIX}`
    const document = encrypted === undefined ? {} : { encrypted }
    await fs.writeFile(tempPath, `${JSON.stringify(document)}\n`, 'utf8')
    await fs.rename(tempPath, filePath)
  }

  async function load(): Promise<OpenCodePasswordVerdict> {
    if (!safeStorage.isEncryptionAvailable()) {
      cachedPassword = undefined
      return { configured: false, unavailableReason: 'encryption-unavailable' }
    }
    const encoded = await readEncrypted(fs, filePath)
    if (encoded === undefined) {
      cachedPassword = undefined
      return { configured: false }
    }
    try {
      cachedPassword = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      return { configured: true }
    } catch {
      // Named, never shown: the error object from a failed decrypt can carry
      // the bytes it choked on, and those are the secret's ciphertext.
      console.warn(
        '[opencode] Stored OpenCode server password could not be decrypted; treating it as unset'
      )
      cachedPassword = undefined
      return { configured: false }
    }
  }

  async function save(password: string): Promise<OpenCodePasswordSaveResult> {
    if (password === '') return { saved: false, reason: 'empty' }
    if (!safeStorage.isEncryptionAvailable()) {
      return { saved: false, reason: 'encryption-unavailable' }
    }
    await persist(safeStorage.encryptString(password).toString('base64'))
    cachedPassword = password
    return { saved: true }
  }

  async function clear(): Promise<void> {
    await persist(undefined)
    cachedPassword = undefined
  }

  return { load, save, clear, readPassword: () => cachedPassword }
}
