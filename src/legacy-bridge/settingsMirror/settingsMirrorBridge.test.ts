import {
  integrationIdSchema,
  secretNameSchema,
  type HostMethod,
  type HostParams,
  type HostPreferenceKey,
  type HostPreferences,
  type HostResult,
  type PreferenceSetParams,
  type SnapshotPage,
  type SnapshotParams
} from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import type { HostClient, HostConnection } from '../../ui-main/window/ports/hostClient'
import type { MirrorHalf } from './mirrorHalf'
import {
  createSettingsMirrorBridge,
  type LegacySettingsWrites,
  type MirrorHostClient
} from './settingsMirrorBridge'

// L2 (17 §1.2): the core of `SettingsMirrorBridge` (21 §3, cuts 1–3e) over a recording HostClient, a fake legacy
// store with write notifications and a test half with two keys. The legacy store stays the source of truth: the
// bridge reads it and sends `preferences.set` (14 §2.3 B-M13); it never writes it.

const CONNECTED: HostConnection = { state: 'connected', hostVersion: '0.0.0-test', compat: false }

const HOST_DEFAULTS: HostPreferences = {
  subagentDelegationOn: false,
  routingProfile: 'balanced',
  systemNotificationsOn: true,
  openCodePermissionsOn: false
}

/**
 * Recording HostClient (16 §2.8): holds the Host's preferences, answers the `preferences` snapshot section from them,
 * applies and records each `preferences.set`, and reaches the Host only while connected.
 */
class RecordingMirrorHost implements MirrorHostClient {
  readonly sets: PreferenceSetParams[] = []
  prefs: HostPreferences = { ...HOST_DEFAULTS }
  private connection: HostConnection = { state: 'connecting' }
  private readonly listeners = new Set<(s: HostConnection) => void>()

  state(): HostConnection {
    return this.connection
  }

  onStateChange(h: (s: HostConnection) => void): () => void {
    this.listeners.add(h)
    return () => this.listeners.delete(h)
  }

  async withUiConnection<T>(
    work: (c: Pick<HostClient, 'call' | 'snapshot'>) => Promise<T>
  ): Promise<T> {
    if (this.connection.state !== 'connected') throw new Error('no ui connection')
    return work({
      call: <M extends HostMethod>(method: M, params: HostParams[M]) =>
        this.call(method, params) as Promise<HostResult[M]>,
      snapshot: (p: SnapshotParams) => this.snapshot(p)
    })
  }

  attach(): void {
    this.move(CONNECTED)
  }

  detach(): void {
    this.move({ state: 'reconnecting', since: 0 })
  }

  private move(next: HostConnection): void {
    this.connection = next
    for (const h of [...this.listeners]) h(next)
  }

  private call(method: string, params: unknown): Promise<unknown> {
    if (this.connection.state !== 'connected') return Promise.reject(new Error('detached'))
    if (method !== 'preferences.set') return Promise.reject(new Error(`unexpected ${method}`))
    const set = params as PreferenceSetParams
    this.sets.push(set)
    this.prefs = { ...this.prefs, [set.key]: set.value }
    return Promise.resolve({ ...this.prefs })
  }

  private snapshot(p: SnapshotParams): Promise<SnapshotPage> {
    expect(p.sections).toEqual(['preferences'])
    return Promise.resolve({
      snapshotId: 'snap-1',
      seq: 1,
      epoch: 'epoch-1' as SnapshotPage['epoch'],
      chunks: [
        {
          section: 'preferences',
          data: {
            preferences: { ...this.prefs },
            secrets: [],
            secretBackend: 'os-keyring' as never,
            integrations: [],
            welcome: { due: false } as never
          }
        }
      ]
    })
  }
}

/** Fake legacy settings store: today's values, and a write notification after each save. */
class FakeLegacyStore implements LegacySettingsWrites {
  writes = 0
  readonly values: Partial<HostPreferences>
  private readonly listeners = new Set<(key: HostPreferenceKey) => void>()

  constructor(values: Partial<HostPreferences>) {
    this.values = { ...values }
  }

  onWrite(listener: (key: HostPreferenceKey) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Today's settings handler saved `key` (only the test calls this). */
  write<K extends HostPreferenceKey>(key: K, value: HostPreferences[K]): void {
    this.writes += 1
    this.values[key] = value
    for (const l of [...this.listeners]) l(key)
  }
}

function testHalf(legacy: FakeLegacyStore): MirrorHalf<'systemNotificationsOn' | 'routingProfile'> {
  return {
    keys: ['systemNotificationsOn', 'routingProfile'],
    readLegacy: (key) => Promise.resolve(legacy.values[key] as never)
  }
}

function setup(values: Partial<HostPreferences>) {
  const host = new RecordingMirrorHost()
  const legacy = new FakeLegacyStore(values)
  let n = 0
  const bridge = createSettingsMirrorBridge({
    hostClient: host,
    legacy,
    halves: [testHalf(legacy)],
    newRequestId: () => `req-${++n}`
  })
  return { host, legacy, bridge }
}

describe('SettingsMirrorBridge core (21 §3; 14 §5; ADR-016 item 5)', () => {
  it('[ADR-001] on attach the bridge sends one preferences.set per listed key whose Host value differs', async () => {
    const { host, bridge } = setup({ systemNotificationsOn: false, routingProfile: 'balanced' })

    host.attach()
    await bridge.idle()

    // routingProfile already equals the Host's value; only systemNotificationsOn differs.
    expect(host.sets).toEqual([{ key: 'systemNotificationsOn', value: false, requestId: 'req-1' }])
    expect(host.prefs.systemNotificationsOn).toBe(false)
  })

  it('[ADR-001] a legacy write of a listed key is mirrored once with a fresh requestId; an unlisted key is not', async () => {
    const { host, legacy, bridge } = setup({
      systemNotificationsOn: true,
      routingProfile: 'balanced'
    })
    host.attach()
    await bridge.idle()
    expect(host.sets).toEqual([])

    legacy.write('routingProfile', 'premium')
    await bridge.idle()
    legacy.write('routingProfile', 'premium')
    await bridge.idle()
    legacy.write('defaultModel', 'unlisted-model')
    await bridge.idle()

    expect(host.sets).toEqual([
      { key: 'routingProfile', value: 'premium', requestId: 'req-1' },
      { key: 'routingProfile', value: 'premium', requestId: 'req-2' }
    ])
    expect(host.prefs.defaultModel).toBeUndefined()
  })

  it('[ADR-016, C-21] the key list cannot hold a secret name or an integration id', () => {
    const legacy = new FakeLegacyStore({})
    const readLegacy = () => Promise.resolve(false)
    // @ts-expect-error a secret name is not a HostPreferenceKey (ADR-017 item 3)
    const secretHalf: MirrorHalf = { keys: ['jev-key'], readLegacy }
    // @ts-expect-error an integration id is not a HostPreferenceKey (ADR-016 item 5)
    const gateHalf: MirrorHalf = { keys: ['claude-hooks'], readLegacy }
    // @ts-expect-error the derived integration state is not a writable key (14 §3.4)
    const derivedHalf: MirrorHalf = { keys: ['openCodePermissionsOn'], readLegacy }
    expect([secretHalf, gateHalf, derivedHalf]).toHaveLength(3)

    const refused = [
      ...secretNameSchema.options,
      ...integrationIdSchema.options,
      'openCodePermissionsOn'
    ]
    for (const key of refused) {
      const half = {
        keys: [key],
        readLegacy: () => Promise.resolve(false)
      } as unknown as MirrorHalf
      expect(() =>
        createSettingsMirrorBridge({
          hostClient: new RecordingMirrorHost(),
          legacy,
          halves: [half],
          newRequestId: () => 'req'
        })
      ).toThrow(/not a mirrorable preference/)
    }
  })

  it('[ADR-001] with the Host detached, pending keys are sent at the next attach and the legacy store is never written', async () => {
    const { host, legacy, bridge } = setup({
      systemNotificationsOn: true,
      routingProfile: 'balanced'
    })
    host.attach()
    await bridge.idle()
    host.detach()

    legacy.write('routingProfile', 'economy')
    await bridge.idle()
    expect(host.sets).toEqual([])

    // The Host got the same value some other way meanwhile: the pending key is still sent once.
    host.prefs = { ...host.prefs, routingProfile: 'economy' }
    host.attach()
    await bridge.idle()
    host.attach()
    await bridge.idle()

    expect(host.sets).toEqual([{ key: 'routingProfile', value: 'economy', requestId: 'req-1' }])
    expect(legacy.writes).toBe(1)
  })
})
