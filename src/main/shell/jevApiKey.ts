import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_JEV_SETTINGS, type JevSettings } from '../domain/types'
import { electronSafeStorage, type SafeStorageLike } from '../adapters/safeStorageLike'

/**
 * The encrypted store behind Settings' Jev API-key control (#509): a
 * user-entered TypeSafe key that can be entered, replaced and cleared — this
 * app never ships or generates one.
 *
 * Storage mirrors the pin, edge, audio and notification preferences
 * (src/main/shell/audioPreference.ts and its siblings): one tiny JSON
 * document under userData, rewritten atomically through a sibling temp file
 * plus a rename, with an injected fs so the tests need no real disk. What
 * makes this one different from every preference beside it is that the
 * document may never hold the key itself — only ciphertext — which is why
 * `safeStorage` is injected too, exactly like `fs`, behind the same
 * `SafeStorageLike` port whose real implementation lives in
 * `adapters/safeStorageLike.ts`.
 *
 * `load`/`save`/`clear` answer only the WIRE-SAFE shape (`JevSettings`):
 * whether a key is configured, and why it might not be settable at all. The
 * decrypted key itself lives only in this closure's `cachedKey`, reachable
 * solely through the synchronous `readKey()` — main-only, and never wired to
 * an IPC channel. The launch router (#509) reads it there, in the same process,
 * because the constraint this feature was built under is absolute: the key
 * never crosses the boundary this module sits on, in either direction.
 *
 * No plaintext fallback, ever. When `safeStorage.isEncryptionAvailable()` is
 * false — this machine's OS offers no encryption, or (see
 * `adapters/safeStorageLike.ts`) a Linux keyring that went away — `save`
 * refuses with a typed reason and `load` reports the same reason rather than
 * "not configured", so the option can say WHY instead of just being missing.
 * A corrupt or undecryptable file is the other, unrelated failure: a SHAPE
 * error indistinguishable from a file that was never written, so it degrades
 * to "not configured" and warns by name rather than blocking startup — the
 * same asymmetry the `config-layering` skill names for every preference here.
 */

/** The one file this store owns, under userData. */
const FILE_NAME = 'jev-api-key-v1.json'
/** Sibling suffix for the atomic write; same directory keeps rename on one volume. */
const TEMP_SUFFIX = '.tmp'

export interface JevApiKeyFsLike {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

const realFs: JevApiKeyFsLike = { readFile, writeFile, rename }

/** Why `save` refused to persist anything. */
export type JevApiKeySaveRefusalReason = 'empty' | 'encryption-unavailable'

export type JevApiKeySaveResult =
  { saved: true } | { saved: false; reason: JevApiKeySaveRefusalReason }

export interface JevApiKeyStore {
  /** The wire-safe verdict: configured or not, and why it might never be. */
  load: () => Promise<JevSettings>
  /** Trims and persists; refuses empty or an unencryptable machine with a typed reason. */
  save: (key: string) => Promise<JevApiKeySaveResult>
  /** Forgets the key, on disk and in memory. A no-op when none was ever saved. */
  clear: () => Promise<void>
  /**
   * The decrypted key, for the launch router (#509) — main-only, and this function's
   * whole reason for existing is that nothing else here may ever answer it.
   */
  readKey: () => string | undefined
}

export interface JevApiKeyStoreOptions {
  /** userData directory; this store owns joining its own filename onto it. */
  userDataDir: string
  /** Injected for tests; defaults to the real filesystem. */
  fs?: JevApiKeyFsLike
  /** Injected for tests; defaults to Electron's own module. */
  safeStorage?: SafeStorageLike
}

/** Reads the stored ciphertext (base64), or undefined for "nothing readable is there". */
async function readEncrypted(fs: JevApiKeyFsLike, filePath: string): Promise<string | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    // Missing file is the common first-run case; any other read failure
    // (permissions, transient IO) is treated the same way because this
    // preference is never worth failing startup over.
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const encrypted = (parsed as Record<string, unknown>).encrypted
    return typeof encrypted === 'string' ? encrypted : undefined
  } catch {
    // Unparseable bytes are corruption, indistinguishable from a file that
    // was never written — the shape half of the config-layering rule.
    return undefined
  }
}

export function createJevApiKeyStore(options: JevApiKeyStoreOptions): JevApiKeyStore {
  const fs = options.fs ?? realFs
  const safeStorage = options.safeStorage ?? electronSafeStorage
  const filePath = join(options.userDataDir, FILE_NAME)

  /**
   * The decrypted key, and the ONLY place it lives outside a session's own
   * memory of what was just typed. Never read back out of this module except
   * through `readKey()`.
   */
  let cachedKey: string | undefined

  /** Rewrites the document atomically. `encrypted` absent means "cleared". */
  async function persist(encrypted: string | undefined): Promise<void> {
    const tempPath = `${filePath}${TEMP_SUFFIX}`
    const document = encrypted === undefined ? {} : { encrypted }
    await fs.writeFile(tempPath, `${JSON.stringify(document)}\n`, 'utf8')
    await fs.rename(tempPath, filePath)
  }

  async function load(): Promise<JevSettings> {
    if (!safeStorage.isEncryptionAvailable()) {
      // Whatever the file says, none of it can be read without encryption —
      // and the honest answer is WHY, not "not configured", because a key
      // saved on a machine that could once encrypt must not read as never set.
      cachedKey = undefined
      return { configured: false, unavailableReason: 'encryption-unavailable' }
    }
    const encoded = await readEncrypted(fs, filePath)
    if (encoded === undefined) {
      cachedKey = undefined
      return { ...DEFAULT_JEV_SETTINGS }
    }
    try {
      cachedKey = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      return { configured: true }
    } catch (error) {
      // Undecryptable ciphertext is corruption, indistinguishable from a file
      // that was never written — degrade rather than block startup, and warn
      // by name so the loss is not silent (config-layering skill).
      console.warn('[jev] Stored API key could not be decrypted; treating it as unset:', error)
      cachedKey = undefined
      return { ...DEFAULT_JEV_SETTINGS }
    }
  }

  async function save(rawKey: string): Promise<JevApiKeySaveResult> {
    // Checked before encryption availability: a blank field is never "this
    // machine cannot encrypt", whatever the OS reports, and the refusal
    // reason must name what is actually wrong.
    const trimmed = rawKey.trim()
    if (trimmed === '') return { saved: false, reason: 'empty' }
    if (!safeStorage.isEncryptionAvailable()) {
      return { saved: false, reason: 'encryption-unavailable' }
    }
    const encrypted = safeStorage.encryptString(trimmed)
    await persist(encrypted.toString('base64'))
    cachedKey = trimmed
    return { saved: true }
  }

  async function clear(): Promise<void> {
    await persist(undefined)
    cachedKey = undefined
  }

  function readKey(): string | undefined {
    return cachedKey
  }

  return { load, save, clear, readKey }
}
