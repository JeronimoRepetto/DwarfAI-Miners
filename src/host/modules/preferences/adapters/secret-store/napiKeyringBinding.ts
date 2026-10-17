// The real `KeyringBinding` over `@napi-rs/keyring` 2.1.0 (ADR-017 item 2; SP-16; S-008-1): the one
// module of the codebase that imports the keyring library (R11: only under
// `preferences/adapters/secret-store/**`). `OsKeyringSecretStore` drives it; the wiring composes
// `new OsKeyringSecretStore(new NapiKeyringBinding(SECRET_SERVICE), log)` (later: ISSUE-324).
//
// - Non-blocking: every call goes through the library's `AsyncEntry`, whose OS work runs on the
//   libuv thread pool, never on the event loop (ADR-017 item 1; FM-116).
// - Linux: every entry is pinned to the Secret Service. Unpinned, the library silently falls back
//   to the kernel keyring, which keeps secrets in memory only; ADR-017 wants "unavailable" there
//   (FM-115; SP-16 "Open item for the adapter"). Pinned, the library refuses to open the entry
//   when no Secret Service runs. The option is ignored on macOS and Windows.
// - Unavailable: an entry the library cannot open, or a call that fails with keyring-core's
//   `NoStorageAccess` ("Couldn't access platform storage") or `PlatformFailure` ("Platform
//   failure"), rejects with `KeyringUnavailable`. The library reports every error as
//   `GenericFailure`, so the class is read from the message prefix, pinned with the version.
//   Any other error passes through unchanged; the adapter drops its message.
// - `available()` reads one probe entry that never holds a value, so no secret is read to answer it.
// - Nothing is stored anywhere but the OS secret store: no file, no cache (ADR-017 items 3, 5).
import * as keyring from '@napi-rs/keyring'
import { KeyringUnavailable, type KeyringBinding } from './keyringBinding'

/** The part of the library this binding drives: its non-blocking entry. */
export interface KeyringLibrary {
  AsyncEntry: new (
    service: string,
    username: string,
    options?: keyring.EntryOptions | null
  ) => Pick<keyring.AsyncEntry, 'getPassword' | 'setPassword' | 'deleteCredential'>
}

/** Linux: the Secret Service or nothing (no kernel-keyring fallback). */
const ENTRY_OPTIONS: keyring.EntryOptions = { linux: { store: 'secret-service' } }

/** The account `available()` reads; DwarfAI never writes it. */
export const PROBE_ACCOUNT = 'backend-probe'

/** keyring-core's `NoStorageAccess` and `PlatformFailure` texts, as `@napi-rs/keyring` 2.1.0 words them. */
const UNAVAILABLE_PREFIXES = ["Couldn't access platform storage", 'Platform failure']

function isUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    UNAVAILABLE_PREFIXES.some((prefix) => error.message.startsWith(prefix))
  )
}

export class NapiKeyringBinding implements KeyringBinding {
  /** `probeService`: the service the secrets live under, so the probe asks the same keychain. */
  constructor(
    private readonly probeService: string,
    private readonly library: KeyringLibrary = keyring
  ) {}

  async available(): Promise<boolean> {
    try {
      await this.call(this.probeService, PROBE_ACCOUNT, (entry) => entry.getPassword())
      return true
    } catch (error) {
      if (error instanceof KeyringUnavailable) return false
      throw error
    }
  }

  async read(service: string, account: string): Promise<string | null> {
    return (await this.call(service, account, (entry) => entry.getPassword())) ?? null
  }

  async write(service: string, account: string, value: string): Promise<void> {
    await this.call(service, account, (entry) => entry.setPassword(value))
  }

  async remove(service: string, account: string): Promise<void> {
    await this.call(service, account, (entry) => entry.deleteCredential())
  }

  private async call<T>(
    service: string,
    account: string,
    work: (entry: InstanceType<KeyringLibrary['AsyncEntry']>) => Promise<T>
  ): Promise<T> {
    let entry: InstanceType<KeyringLibrary['AsyncEntry']>
    try {
      entry = new this.library.AsyncEntry(service, account, ENTRY_OPTIONS)
    } catch {
      throw new KeyringUnavailable()
    }
    try {
      return await work(entry)
    } catch (error) {
      if (isUnavailable(error)) throw new KeyringUnavailable()
      throw error
    }
  }
}
