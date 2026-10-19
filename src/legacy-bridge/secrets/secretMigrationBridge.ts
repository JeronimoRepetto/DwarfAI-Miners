// `SecretMigrationBridge` (21 §3, steps 3a and 4a; ADR-017 item 8; 18 §5.5 C-23): the one-time move of today's
// `safeStorage`-encrypted secrets into the Host's `SecretStore`. One bridge moves one `LegacySecret`: the Jev key from
// step 3a (ISSUE-217, `LEGACY_JEV_KEY`) and the OpenCode server password from step 4a (ISSUE-231,
// `LEGACY_OPENCODE_PASSWORD`), each composed where the table routes its setter `host` and settled on its own.
//
// Electron main is the only process that can decrypt today's file, so the run lives here, composed only by
// `src/ui-main/index.ts` (05 R16), with `safeStorage` handed in through today's `SafeStorageLike` port (05 R7: the
// bridge never imports `electron`). On every Host attach (the HostClient becoming `connected`) until the file is
// settled:
//
// - no file: nothing (a first start, or a secret the run already moved);
// - a file that holds no ciphertext (today's `clear` writes `{}`): the secret was cleared before its step; the file is
//   deleted and the Host is left with nothing (21 §4 rows "Jev API key", "OpenCode server password");
// - a file that cannot be decrypted (corrupt, not today's shape, or no OS encryption to read it with): the file is
//   deleted and the secret reads "not configured" (ADR-017 item 8; 13 FM-118); `secret.migration` `failed` (warn);
// - a decrypted value: sent once with B-M10 `settings.secret.set {name, origin:'migration'}` (14 §2.3); only
//   once the Host answers `configured: true` is the file deleted, `secret.migration` `ok` (info). A refusal
//   (`backend-unavailable`) or a call that failed keeps the file for the next attempt (the next attach or start),
//   `secret.migration` `skipped` (warn), so the secret is never lost and never stored twice (C-23).
//
// The decrypted value lives only inside one run and goes only into the B-M10 params (14 §3.5 SENSITIVE_METHODS): it is
// never logged; the `secret.migration` record carries `outcome` only (19 §9.5; NFR-SEC-12).
//
// Candidate decision (21 §6): today's `SafeStorageLike` port (`./safeStorageLike.ts`, moved here from
// `src/main/adapters` by ISSUE-340) and its `fakeSafeStorage` double are kept, used only here; today's `jevApiKey.ts` and `openCodeServerPassword.ts` stores are
// not reused (they cannot tell a missing file from an undecryptable one and never delete their file; the password store
// wraps `safeStorage` as the store, 16 §4.12.1), only their file names and format are read.
//
// Deleted with the legacy tree at cut 5 (21 §3).
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SecretName } from '@dwarfai/contracts'
import type { SafeStorageLike } from './safeStorageLike'
import type { HostClient, HostConnection } from '../../ui-main/window/ports/hostClient'
import type { LegacyLog } from '../legacyDiagnostics'

/** Today's Jev-key file under the UI's `userData` (`src/main/shell/jevApiKey.ts` `FILE_NAME`), and its temp sibling. */
export const LEGACY_JEV_KEY_FILE = 'jev-api-key-v1.json'
const TEMP_SUFFIX = '.tmp'
/** Today's OpenCode server password file (`src/main/opencodePermissions/openCodeServerPassword.ts`). */
export const LEGACY_OPENCODE_PASSWORD_FILE = 'opencode-server-password-v1.json'

/** One legacy secret the bridge moves: its Host name, today's file, and whether today's store trimmed it. */
export interface LegacySecret {
  name: SecretName
  file: string
  trim: boolean
}
export const LEGACY_JEV_KEY: LegacySecret = {
  name: 'jev-key',
  file: LEGACY_JEV_KEY_FILE,
  trim: true
}
export const LEGACY_OPENCODE_PASSWORD: LegacySecret = {
  name: 'opencode-password',
  file: LEGACY_OPENCODE_PASSWORD_FILE,
  trim: false
}

/** What one run did with today's file. */
export type LegacySecretMigration =
  | 'none' // no file, or one with no value (cleared before the step): nothing sent
  | 'migrated' // the Host confirmed, the file is gone
  | 'undecryptable' // the file is gone, the secret reads "not configured" (FM-118)
  | 'kept' // the Host did not confirm: the file stays for the next attempt

/** The file operations the run uses. */
export interface SecretMigrationFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>
  rm(path: string, options: { force: true }): Promise<void>
}

/** The HostClient members the run uses: the connection state and the `ui` connection. */
export type MigrationHostClient = Pick<HostClient, 'state' | 'onStateChange' | 'withUiConnection'>

export interface SecretMigrationBridgeDeps {
  /** The UI's `userData` directory, where today's file lives. */
  userDataDir: string
  /** The secret this bridge moves. */
  secret: LegacySecret
  safeStorage: SafeStorageLike
  hostClient: MigrationHostClient
  /** A fresh UUIDv7 `requestId` for B-M10 (14 §1.6). */
  newRequestId(): string
  log: LegacyLog
  fs?: SecretMigrationFs
}

export interface SecretMigrationBridge {
  /** Settles once the run started so far has finished (its secret's rows are served after it). */
  idle(): Promise<void>
  /** Stops listening to the HostClient. */
  dispose(): void
}

/** The secrets' owning module (05 §1.1), as the record's `subsystem` (ADR-026 item 3). */
const SUBSYSTEM = 'preferences'

/** The ciphertext today's file holds (base64), `null` for a file with none (cleared), or `undefined` for corrupt. */
function ciphertextOf(raw: string): string | null | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    if (!('encrypted' in parsed)) return null
    const { encrypted } = parsed as { encrypted: unknown }
    return typeof encrypted === 'string' ? encrypted : undefined
  } catch {
    return undefined
  }
}

/**
 * The decrypted value, or `undefined` when it cannot be read back (no OS encryption, not today's ciphertext, or empty:
 * today's stores never saved an empty value). Trimmed only where today's store trimmed it (the Jev key, never the
 * password, whose spaces are part of it).
 */
function decrypt(safeStorage: SafeStorageLike, encoded: string, trim: boolean): string | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  try {
    const decrypted = safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    const value = trim ? decrypted.trim() : decrypted
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

export function createSecretMigrationBridge(
  deps: SecretMigrationBridgeDeps
): SecretMigrationBridge {
  const { hostClient, safeStorage, log } = deps
  const fs = deps.fs ?? { readFile, rm }
  const { secret } = deps
  const file = join(deps.userDataDir, secret.file)
  let settled = false
  let disposed = false
  let queue: Promise<void> = Promise.resolve()

  const record = (level: 'info' | 'warn', outcome: 'ok' | 'failed' | 'skipped'): void =>
    log.record({ level, event: 'secret.migration', subsystem: SUBSYSTEM, outcome })

  /** Deletes today's file and the temp sibling an interrupted write of today's store may have left. */
  const remove = async (): Promise<void> => {
    await fs.rm(file, { force: true })
    await fs.rm(`${file}${TEMP_SUFFIX}`, { force: true })
  }

  /** Sends the value once; true only when the Host confirmed it is stored. */
  const send = (value: string): Promise<boolean> =>
    hostClient
      .withUiConnection((ui) =>
        ui.call('settings.secret.set', {
          name: secret.name,
          value,
          requestId: deps.newRequestId(),
          origin: 'migration'
        })
      )
      .then(
        (result) => result.ok && result.value.configured,
        () => false
      )

  const run = async (): Promise<LegacySecretMigration> => {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      return 'none'
    }
    const encoded = ciphertextOf(raw)
    if (encoded === null) {
      await remove()
      return 'none'
    }
    const value = encoded === undefined ? undefined : decrypt(safeStorage, encoded, secret.trim)
    if (value === undefined) {
      await remove()
      record('warn', 'failed')
      return 'undecryptable'
    }
    if (!(await send(value))) {
      record('warn', 'skipped')
      return 'kept'
    }
    await remove()
    record('info', 'ok')
    return 'migrated'
  }

  const attempt = (): void => {
    queue = queue
      .then(async () => {
        if (disposed || settled || hostClient.state().state !== 'connected') return
        settled = (await run()) !== 'kept'
      })
      .catch(() => {})
  }

  let wasConnected = hostClient.state().state === 'connected'
  const stop = hostClient.onStateChange((next: HostConnection) => {
    const attached = next.state === 'connected' && !wasConnected
    wasConnected = next.state === 'connected'
    if (attached) attempt()
  })
  if (wasConnected) attempt()

  return {
    idle: () => queue,
    dispose: () => {
      disposed = true
      stop()
    }
  }
}
