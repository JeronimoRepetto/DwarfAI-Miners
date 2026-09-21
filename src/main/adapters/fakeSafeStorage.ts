import type { SafeStorageLike } from './safeStorageLike'

/**
 * Hand-written stand-in for Electron's `safeStorage` (#509), the same
 * discipline `FakeFs` holds for the filesystem: an in-memory "encryption"
 * simple enough to assert against, never real cryptography. What a unit test
 * here exists to prove is this app's OWN decisions around the port — refuse
 * without a key, degrade a document the fake cannot read back — not whether
 * Electron's or the OS's own encryption works.
 *
 * `available` defaults to true because most tests exercise the configured
 * path; a test about the unavailable one sets it to false explicitly rather
 * than the fake guessing which case it is in.
 */
export interface FakeSafeStorageOptions {
  available?: boolean
}

/** Marks a buffer this fake produced, so decryptString can tell its own bytes from anything else. */
const PREFIX = 'fake-encrypted:'

export function fakeSafeStorage(options: FakeSafeStorageOptions = {}): SafeStorageLike {
  const available = options.available ?? true

  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string): Buffer => {
      if (!available) {
        throw new Error('Error while encrypting: encryption is not available.')
      }
      return Buffer.from(`${PREFIX}${plainText}`, 'utf8')
    },
    decryptString: (encrypted: Buffer): string => {
      if (!available) {
        throw new Error('Error while decrypting: decryption is not available.')
      }
      const raw = encrypted.toString('utf8')
      // The real Electron module refuses a buffer whose prefix it does not
      // recognise (see the v10/v11 check in its own source) rather than
      // returning garbage; this fake draws the same line so a test can prove
      // a corrupt file is treated as undecryptable rather than silently read.
      if (!raw.startsWith(PREFIX)) {
        throw new Error('Ciphertext does not appear to be encrypted.')
      }
      return raw.slice(PREFIX.length)
    }
  }
}
