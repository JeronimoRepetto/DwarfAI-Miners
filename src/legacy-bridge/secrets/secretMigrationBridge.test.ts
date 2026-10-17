// layer: L2
// L2 (17 §1.2): `SecretMigrationBridge`'s Jev-key run (21 §3 step 3a; ADR-017 item 8; 18 C-23) over a temp legacy
// `userData`, today's `fakeSafeStorage` double, a recording HostClient over an in-memory secret store (the Host's B-M10
// semantics: a configured flag back, never the value) and a recording UI log.
//
// TC-217-01, TC-217-02; the OpenCode password run of step 4a (ISSUE-231): TC-231-01, TC-231-03.
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  HostMethod,
  HostParams,
  HostResult,
  SecretName,
  SecretSetParams,
  SecretStatusResult
} from '@dwarfai/contracts'
import { fakeSafeStorage } from '../../main/adapters/fakeSafeStorage'
import type { HostClient, HostConnection } from '../../ui-main/window/ports/hostClient'
import type { LegacyLogEntry } from '../legacyDiagnostics'
import {
  createSecretMigrationBridge,
  LEGACY_JEV_KEY,
  LEGACY_JEV_KEY_FILE,
  LEGACY_OPENCODE_PASSWORD,
  LEGACY_OPENCODE_PASSWORD_FILE,
  type LegacySecret,
  type MigrationHostClient
} from './secretMigrationBridge'

const KEY = 'ts-live-0123456789abcdef'
const CONNECTED: HostConnection = { state: 'connected', hostVersion: '0.0.0-test', compat: false }
const REQUEST = '01920000-0000-7000-a000-000000000217'

type Ui = Pick<HostClient, 'call' | 'snapshot'>

/**
 * Recording HostClient (16 §2.8) over an in-memory secret store: `settings.secret.set` stores the value and answers the
 * configured flag; with no usable backend it answers `backend-unavailable`; a refusal throws as a call error would.
 */
class RecordingSecretHost implements MigrationHostClient {
  readonly stored = new Map<SecretName, string>()
  readonly sets: SecretSetParams[] = []
  backend: 'os-secret-store' | 'unavailable' = 'os-secret-store'
  callError: Error | null = null
  /** Checked when the Host answers: whether today's file was still on disk at that moment. */
  onSet: () => Promise<void> = () => Promise.resolve()
  private connection: HostConnection = { state: 'connecting' }
  private readonly listeners = new Set<(s: HostConnection) => void>()

  state(): HostConnection {
    return this.connection
  }
  onStateChange(h: (s: HostConnection) => void): () => void {
    this.listeners.add(h)
    return () => this.listeners.delete(h)
  }
  connect(): void {
    this.connection = CONNECTED
    for (const h of this.listeners) h(CONNECTED)
  }
  disconnect(): void {
    this.connection = { state: 'reconnecting', since: 0 }
    for (const h of this.listeners) h(this.connection)
  }
  withUiConnection<T>(work: (c: Ui) => Promise<T>): Promise<T> {
    const ui: Ui = {
      call: <M extends HostMethod>(method: M, params: HostParams[M]): Promise<HostResult[M]> =>
        this.answer(method, params) as Promise<HostResult[M]>,
      snapshot: () => Promise.reject(new Error('no snapshot here'))
    }
    return work(ui)
  }
  private async answer(method: string, params: unknown): Promise<SecretStatusResult> {
    if (method !== 'settings.secret.set') throw new Error(`unexpected ${method}`)
    const set = params as SecretSetParams
    this.sets.push(set)
    await this.onSet()
    if (this.callError !== null) throw this.callError
    if (this.backend === 'unavailable') return { ok: false, error: 'backend-unavailable' }
    this.stored.set(set.name, set.value)
    return { ok: true, value: { name: set.name, configured: true } }
  }
  status(name: SecretName): boolean {
    return this.stored.has(name)
  }
}

let userData: string
const safeStorage = fakeSafeStorage()
const log: LegacyLogEntry[] = []

/** Today's file as `jevApiKey.ts` writes it: `{ encrypted: base64(ciphertext) }`. */
async function seed(key: string = KEY): Promise<void> {
  const encrypted = safeStorage.encryptString(key).toString('base64')
  await writeFile(join(userData, LEGACY_JEV_KEY_FILE), `${JSON.stringify({ encrypted })}\n`)
}

const onDisk = (): Promise<string[]> => readdir(userData)

function bridgeOver(host: RecordingSecretHost, secret: LegacySecret = LEGACY_JEV_KEY) {
  return createSecretMigrationBridge({
    userDataDir: userData,
    secret,
    safeStorage,
    hostClient: host,
    newRequestId: () => REQUEST,
    log: { record: (entry) => log.push(entry) }
  })
}

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'dwarfai-217-'))
  log.length = 0
})
afterEach(async () => {
  await rm(userData, { recursive: true, force: true })
})

describe('SecretMigrationBridge, the Jev key (ADR-017 item 8; 21 §3 step 3a)', () => {
  it('[ADR-017, C-23] a seeded legacy Jev-key file ends with the Host status configured and the file gone', async () => {
    await seed()
    const host = new RecordingSecretHost()
    const bridge = bridgeOver(host)

    host.connect()
    await bridge.idle()

    expect(host.status('jev-key')).toBe(true)
    expect(host.sets).toEqual([
      { name: 'jev-key', value: KEY, requestId: REQUEST, origin: 'migration' }
    ])
    expect(await onDisk()).toEqual([])
    expect(log).toEqual([
      { level: 'info', event: 'secret.migration', subsystem: 'preferences', outcome: 'ok' }
    ])

    // Once per file: a later attach finds nothing and sends nothing.
    host.disconnect()
    host.connect()
    await bridge.idle()
    expect(host.sets).toHaveLength(1)
    bridge.dispose()
  })

  it('[ADR-017] the legacy file is deleted only after the Host confirms; a Host refusal keeps it for the next start', async () => {
    await seed()
    const host = new RecordingSecretHost()
    const seenAtAnswer: string[][] = []
    host.onSet = async () => {
      seenAtAnswer.push(await onDisk())
    }
    host.backend = 'unavailable'
    const first = bridgeOver(host)
    host.connect()
    await first.idle()
    first.dispose()

    expect(host.status('jev-key')).toBe(false)
    expect(await onDisk()).toEqual([LEGACY_JEV_KEY_FILE])
    expect(log).toEqual([
      { level: 'warn', event: 'secret.migration', subsystem: 'preferences', outcome: 'skipped' }
    ])

    // A call that failed keeps it too.
    host.backend = 'os-secret-store'
    host.callError = new Error('HOST_NOT_READY')
    const second = bridgeOver(host)
    await second.idle()
    second.dispose()
    expect(await onDisk()).toEqual([LEGACY_JEV_KEY_FILE])

    // The next start moves it, and the file was still on disk when the Host answered.
    host.callError = null
    const third = bridgeOver(host)
    await third.idle()
    third.dispose()
    expect(host.status('jev-key')).toBe(true)
    expect(await onDisk()).toEqual([])
    expect(seenAtAnswer).toEqual([
      [LEGACY_JEV_KEY_FILE],
      [LEGACY_JEV_KEY_FILE],
      [LEGACY_JEV_KEY_FILE]
    ])
  })

  it('[FM-118] an undecryptable file is deleted and the key reads not configured', async () => {
    for (const content of [
      `${JSON.stringify({ encrypted: Buffer.from('not ciphertext').toString('base64') })}\n`,
      '{ not json',
      `${JSON.stringify({ encrypted: 42 })}\n`
    ]) {
      await writeFile(join(userData, LEGACY_JEV_KEY_FILE), content)
      await writeFile(join(userData, `${LEGACY_JEV_KEY_FILE}.tmp`), content)
      log.length = 0
      const host = new RecordingSecretHost()
      const bridge = bridgeOver(host)
      host.connect()
      await bridge.idle()
      bridge.dispose()

      expect(host.sets).toEqual([])
      expect(host.status('jev-key')).toBe(false)
      expect(await onDisk()).toEqual([])
      expect(log).toEqual([
        { level: 'warn', event: 'secret.migration', subsystem: 'preferences', outcome: 'failed' }
      ])
    }

    // No OS encryption to read it with: undecryptable too.
    await seed()
    const host = new RecordingSecretHost()
    const bridge = createSecretMigrationBridge({
      userDataDir: userData,
      secret: LEGACY_JEV_KEY,
      safeStorage: fakeSafeStorage({ available: false }),
      hostClient: host,
      newRequestId: () => REQUEST,
      log: { record: () => {} }
    })
    host.connect()
    await bridge.idle()
    bridge.dispose()
    expect(host.sets).toEqual([])
    expect(await onDisk()).toEqual([])
  })

  it('[ADR-017] a key cleared before 3a leaves the Host with nothing', async () => {
    // Today's `clear` rewrites the file as `{}`.
    await writeFile(join(userData, LEGACY_JEV_KEY_FILE), '{}\n')
    const host = new RecordingSecretHost()
    const bridge = bridgeOver(host)
    host.connect()
    await bridge.idle()

    expect(host.sets).toEqual([])
    expect(host.status('jev-key')).toBe(false)
    expect(await onDisk()).toEqual([])

    // No file at all: nothing sent, nothing logged.
    host.disconnect()
    host.connect()
    await bridge.idle()
    bridge.dispose()
    expect(host.sets).toEqual([])
    expect(log).toEqual([])
  })

  it('[NFR-SEC-12] the migrated value never reaches a log line', async () => {
    for (const backend of ['os-secret-store', 'unavailable'] as const) {
      await seed()
      const host = new RecordingSecretHost()
      host.backend = backend
      const bridge = bridgeOver(host)
      host.connect()
      await bridge.idle()
      bridge.dispose()
    }
    await seed('ts-other-key')
    const host = new RecordingSecretHost()
    host.callError = new Error(`refused ${KEY}`)
    const bridge = bridgeOver(host)
    host.connect()
    await bridge.idle()
    bridge.dispose()

    expect(log.length).toBeGreaterThan(0)
    for (const entry of log) {
      expect(Object.keys(entry).sort()).toEqual(['event', 'level', 'outcome', 'subsystem'])
      expect(JSON.stringify(entry)).not.toContain(KEY)
      expect(JSON.stringify(entry)).not.toContain('ts-other-key')
    }
  })
})

// ADDED for ISSUE-231: the OpenCode server password run of step 4a (21 §3 `SecretMigrationBridge`, §4 row "OpenCode
// server password"; ADR-017 item 8). Same rules as the Jev key; today's store never trimmed the password, so neither
// does the run (spaces are part of it).
describe('SecretMigrationBridge, the OpenCode server password (ADR-017 item 8; 21 §3 step 4a)', () => {
  const PASSWORD = ' pw with spaces 0123 '

  /** Today's file as `openCodeServerPassword.ts` writes it: `{ encrypted: base64(ciphertext) }`. */
  async function seedPassword(password: string = PASSWORD): Promise<void> {
    const encrypted = safeStorage.encryptString(password).toString('base64')
    await writeFile(
      join(userData, LEGACY_OPENCODE_PASSWORD_FILE),
      `${JSON.stringify({ encrypted })}
`
    )
  }

  it('[ADR-017, C-23] a seeded legacy password file ends with passwordConfigured true in the Host and the file gone', async () => {
    // TC-231-01
    await seedPassword()
    // The Jev-key file is another run's: this one leaves it alone.
    await seed()
    const host = new RecordingSecretHost()
    const seenAtAnswer: string[][] = []
    host.onSet = async () => {
      seenAtAnswer.push(await onDisk())
    }
    const bridge = bridgeOver(host, LEGACY_OPENCODE_PASSWORD)

    host.connect()
    await bridge.idle()

    expect(host.status('opencode-password')).toBe(true)
    expect(host.stored.get('opencode-password')).toBe(PASSWORD)
    expect(host.sets).toEqual([
      { name: 'opencode-password', value: PASSWORD, requestId: REQUEST, origin: 'migration' }
    ])
    // Deleted only after the Host confirmed: the file was still there when it answered.
    expect(seenAtAnswer).toEqual([[LEGACY_JEV_KEY_FILE, LEGACY_OPENCODE_PASSWORD_FILE].sort()])
    expect(await onDisk()).toEqual([LEGACY_JEV_KEY_FILE])
    expect(log).toEqual([
      { level: 'info', event: 'secret.migration', subsystem: 'preferences', outcome: 'ok' }
    ])

    // Once per file.
    host.disconnect()
    host.connect()
    await bridge.idle()
    bridge.dispose()
    expect(host.sets).toHaveLength(1)
  })

  it('[ADR-017] the legacy password file is kept when the Host does not confirm, and moved by the next start', async () => {
    await seedPassword()
    const host = new RecordingSecretHost()
    host.backend = 'unavailable'
    const first = bridgeOver(host, LEGACY_OPENCODE_PASSWORD)
    host.connect()
    await first.idle()
    first.dispose()
    expect(host.status('opencode-password')).toBe(false)
    expect(await onDisk()).toEqual([LEGACY_OPENCODE_PASSWORD_FILE])

    host.backend = 'os-secret-store'
    const next = bridgeOver(host, LEGACY_OPENCODE_PASSWORD)
    await next.idle()
    next.dispose()
    expect(host.stored.get('opencode-password')).toBe(PASSWORD)
    expect(await onDisk()).toEqual([])
  })

  it('[FM-118] an undecryptable password file is deleted and the password reads not stored', async () => {
    // TC-231-03
    for (const content of [
      `${JSON.stringify({ encrypted: Buffer.from('not ciphertext').toString('base64') })}
`,
      '{ not json',
      `${JSON.stringify({ encrypted: safeStorage.encryptString('').toString('base64') })}
`
    ]) {
      await writeFile(join(userData, LEGACY_OPENCODE_PASSWORD_FILE), content)
      await writeFile(join(userData, `${LEGACY_OPENCODE_PASSWORD_FILE}.tmp`), content)
      log.length = 0
      const host = new RecordingSecretHost()
      const bridge = bridgeOver(host, LEGACY_OPENCODE_PASSWORD)
      host.connect()
      await bridge.idle()
      bridge.dispose()

      expect(host.sets).toEqual([])
      expect(host.status('opencode-password')).toBe(false)
      expect(await onDisk()).toEqual([])
      expect(log).toEqual([
        { level: 'warn', event: 'secret.migration', subsystem: 'preferences', outcome: 'failed' }
      ])
    }
  })

  it('[ADR-017] a password cleared before 4a leaves the Host with nothing', async () => {
    // TC-231-03: today's `clear` rewrites the file as `{}`.
    await writeFile(join(userData, LEGACY_OPENCODE_PASSWORD_FILE), '{}\n')
    const host = new RecordingSecretHost()
    const bridge = bridgeOver(host, LEGACY_OPENCODE_PASSWORD)
    host.connect()
    await bridge.idle()
    bridge.dispose()

    expect(host.sets).toEqual([])
    expect(host.status('opencode-password')).toBe(false)
    expect(await onDisk()).toEqual([])
    expect(log).toEqual([])
  })
})
