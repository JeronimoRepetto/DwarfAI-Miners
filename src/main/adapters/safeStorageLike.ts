import { safeStorage } from 'electron'

/**
 * Tiny port over Electron's `safeStorage` (#509), the same "real disk/OS
 * behind an interface" discipline `FsLike` holds for the filesystem —
 * narrowed to the three synchronous members `jevApiKey.ts` uses.
 *
 * Kept SYNCHRONOUS on purpose, matching Electron's own `isEncryptionAvailable`
 * / `encryptString` / `decryptString` trio rather than their `...Async`
 * siblings: those three are soft-deprecated ahead of removal in Electron 46
 * (this app ships 44), but the store around this port is already async
 * because of its OWN file I/O, and the crypto call itself never was — a
 * migration to the async trio is a follow-up when this build moves to 46, not
 * a reason to complicate this one.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/**
 * Real Electron implementation used by the running app.
 *
 * Electron's own `safeStorage` is already a plain object shaped like this
 * port, so this is that module typed down to what this app uses rather than
 * a wrapper class. Deliberately never calls `safeStorage.setUsePlainTextEncryption`:
 * that call is what makes Linux's `isEncryptionAvailable()` answer true over
 * its unencrypted 'basic_text' backend when no real keyring (GNOME libsecret,
 * KWallet) is present — exactly the plaintext fallback this feature's
 * constraint forbids. Leaving it uncalled is what makes a Linux box with no
 * real keyring correctly read as unavailable rather than quietly obfuscated.
 */
export const electronSafeStorage: SafeStorageLike = safeStorage
