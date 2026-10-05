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
import { SequenceIdGenerator } from '../../host/kernel/fakes/SequenceIdGenerator'
import { IPC_CHANNELS } from '../../shared/contracts'
import { createLegacySettingsWriteHub } from './legacySettingsWrites'
import type { MirrorHalf } from './mirrorHalf'
import {
  createNotificationsMirrorHalf,
  reportNotificationsWrites,
  type LegacySettingsRoute
} from './notificationsHalf'
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
  /** The `preferences.set` answers: the stored preferences (16 §4.12). */
  readonly answers: HostPreferences[] = []
  /** The keys whose `HostPreferencesChanged` the Host published (08 §2.9: only on change). */
  readonly changes: HostPreferenceKey[] = []
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
    // 16 §4.12: `set` answers what was stored, and only a changed value publishes `HostPreferencesChanged`.
    if (!Object.is(this.prefs[set.key], set.value)) this.changes.push(set.key)
    this.prefs = { ...this.prefs, [set.key]: set.value }
    this.answers.push({ ...this.prefs })
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

/**
 * Fake legacy settings route: today's A-42 / A-43 handlers (`LegacyRuntimeRoute`, #316) over one stored boolean. Like
 * today's A-43 handler, it stores a boolean payload, keeps the stored value for anything else, and answers what it
 * stored. It counts the A-43 writes it served, so a write the bridge made would show.
 */
class FakeLegacyNotificationsRoute implements LegacySettingsRoute {
  a43Writes = 0

  constructor(public stored: boolean) {}

  serve(channel: string, payload: unknown): Promise<unknown> {
    if (channel === IPC_CHANNELS.getNotificationsEnabled) return Promise.resolve(this.stored)
    if (channel === IPC_CHANNELS.setNotificationsEnabled) {
      this.a43Writes += 1
      if (typeof payload === 'boolean') this.stored = payload
      return Promise.resolve(this.stored)
    }
    return Promise.resolve(undefined)
  }
}

function notificationsSetup(stored: boolean) {
  const host = new RecordingMirrorHost()
  const legacy = new FakeLegacyNotificationsRoute(stored)
  const hub = createLegacySettingsWriteHub()
  // What `src/ui-main/index.ts` composes: the router serves the legacy rows through `route`.
  const route = reportNotificationsWrites(legacy, hub)
  const half = createNotificationsMirrorHalf(route)
  const ids = new SequenceIdGenerator()
  const bridge = createSettingsMirrorBridge({
    hostClient: host,
    legacy: hub,
    halves: [half],
    newRequestId: () => ids.uuidv7()
  })
  return { host, legacy, hub, route, half, bridge }
}

const REQ = (n: number): string => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`

describe('SettingsMirrorBridge notifications half (21 §3; 14 §5; ADR-016 item 5)', () => {
  it('[ADR-018] on attach the bridge sends the legacy systemNotificationsOn value to the Host once', async () => {
    const { host, bridge } = notificationsSetup(false)

    host.attach()
    await bridge.idle()
    host.detach()
    host.attach()
    await bridge.idle()

    expect(host.sets).toEqual([{ key: 'systemNotificationsOn', value: false, requestId: REQ(1) }])
    expect(host.prefs.systemNotificationsOn).toBe(false)
  })

  it('[ADR-018] after the legacy A-43 handler stores a new value the bridge sends preferences.set with that stored value and a new requestId', async () => {
    const { host, route, bridge } = notificationsSetup(true)
    host.attach()
    await bridge.idle()
    expect(host.sets).toEqual([])

    await route.serve(IPC_CHANNELS.setNotificationsEnabled, false)
    await bridge.idle()
    // Today's handler keeps the stored value for a payload that is not a boolean: the stored value is mirrored, not
    // the one the renderer asked for.
    await route.serve(IPC_CHANNELS.setNotificationsEnabled, 'on')
    await bridge.idle()

    expect(host.sets).toEqual([
      { key: 'systemNotificationsOn', value: false, requestId: REQ(1) },
      { key: 'systemNotificationsOn', value: false, requestId: REQ(2) }
    ])
    expect(host.prefs.systemNotificationsOn).toBe(false)
  })

  it('[ADR-018] a legacy write that stores the same value still sends it, and the Host publishes no change for it', async () => {
    const { host, route, bridge } = notificationsSetup(true)
    host.attach()
    await bridge.idle()

    await route.serve(IPC_CHANNELS.setNotificationsEnabled, true)
    await bridge.idle()

    expect(host.sets).toEqual([{ key: 'systemNotificationsOn', value: true, requestId: REQ(1) }])
    expect(host.answers.map((stored) => stored.systemNotificationsOn)).toEqual([true])
    expect(host.changes).toEqual([])
  })

  it('[ADR-016] the notifications half mirrors no secret and no integration gate', async () => {
    const { host, hub, route, half, bridge } = notificationsSetup(false)

    expect(half.keys).toEqual(['systemNotificationsOn'])

    host.attach()
    await bridge.idle()
    // Saves of every other Host-read preference, a secret write and the A-43 write all reach the bridge.
    for (const key of Object.keys(HOST_DEFAULTS) as HostPreferenceKey[]) hub.saved(key)
    hub.saved('defaultModel')
    await route.serve(IPC_CHANNELS.setJevApiKey, 'not-a-real-key')
    await route.serve(IPC_CHANNELS.setNotificationsEnabled, true)
    await bridge.idle()

    expect(new Set(host.sets.map((set) => set.key))).toEqual(new Set(['systemNotificationsOn']))
    expect(host.sets.some((set) => set.value === 'not-a-real-key')).toBe(false)
  })

  it('[ADR-018] while the Host is unreachable the mirror retries at the next attach and never writes the legacy store', async () => {
    const { host, legacy, route, bridge } = notificationsSetup(true)
    host.attach()
    await bridge.idle()
    host.detach()

    await route.serve(IPC_CHANNELS.setNotificationsEnabled, false)
    await bridge.idle()
    expect(host.sets).toEqual([])

    host.attach()
    await bridge.idle()

    expect(host.sets).toEqual([{ key: 'systemNotificationsOn', value: false, requestId: REQ(1) }])
    expect(legacy.a43Writes).toBe(1)
    expect(legacy.stored).toBe(false)
  })
})
