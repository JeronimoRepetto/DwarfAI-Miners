// Moved here from `src/main/adapters/safeStorageLike.ts` by ISSUE-340 (21 §6 row Adapters: `safeStorageLike` only
// inside `SecretMigrationBridge`); deleted with this folder by ISSUE-247. The running app passes Electron's own
// `safeStorage` (composed in `src/ui-main/index.ts`), so the legacy `electronSafeStorage` constant, which nothing
// imported, did not move (R7: `electron` only in `src/ui-main` and `src/preload`).
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
