import {
  STEP_ORDER,
  integrationIdSchema,
  secretNameSchema,
  type HostMethod,
  type HostParams,
  type HostPreferences,
  type HostResult,
  type PreferenceSetParams,
  type SnapshotPage,
  type SnapshotParams,
  type StepId
} from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import type { HostClient, HostConnection } from '../../ui-main/window/ports/hostClient'
import { SequenceIdGenerator } from '../../host/kernel/fakes/SequenceIdGenerator'
import {
  IPC_CHANNELS,
  parseJevPreferences,
  type JevPreferences,
  type JevSettings
} from '../../shared/contracts'
import { JEV_MIRROR_KEYS, createJevMirrorHalf, reportJevWrites } from './jevMirror'
import { createLegacySettingsWriteHub } from './legacySettingsWrites'
import type { LegacySettingsRoute } from './notificationsHalf'
import { createSettingsMirrorBridge, type MirrorHostClient } from './settingsMirrorBridge'
import { reportSettingsMirrorWrites, settingsMirrorHalves } from './settingsMirrorHalves'

// L2 (17 §1.2): the Jev half of `SettingsMirrorBridge` (21 §3, from 3a; 21 §2 seam-B row 3a: B-M13 extended to the Jev
// preferences). Settings still writes the Jev preferences through today's A-51 handler; the half reads them back
// through today's A-47 handler (`LegacyRuntimeRoute`) and the bridge sends `preferences.set` (14 §2.3 B-M13). The
// legacy store stays the source of truth: nothing is ever written to it, and the Jev key is never mirrored.

const CONNECTED: HostConnection = { state: 'connected', hostVersion: '0.0.0-test', compat: false }

const HOST_DEFAULTS: HostPreferences = {
  subagentDelegationOn: false,
  routingProfile: 'balanced',
  systemNotificationsOn: true,
  openCodePermissionsOn: false
}

/** Recording HostClient (16 §2.8): holds the Host's preferences, records each `preferences.set`, reachable only while connected. */
class RecordingJevHost implements MirrorHostClient {
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

/** The default launch today's A-51 handler refuses (as `jevPreferences.ts` refuses a default it cannot launch). */
const UNLAUNCHABLE_MODEL = 'cannot-launch'

/**
 * Fake legacy Jev route: today's A-47 / A-51 handlers and the key handlers (`LegacyRuntimeRoute`) over one stored
 * `JevPreferences` and one stored key. Like today's A-51 handler it stores the parsed preferences, keeps the stored
 * ones for a refused write and answers the stored `JevSettings`. It counts the A-51 writes it served.
 */
class FakeLegacyJevRoute implements LegacySettingsRoute {
  a51Writes = 0
  key: string | undefined = undefined

  constructor(public stored: JevPreferences) {}

  serve(channel: string, payload: unknown): Promise<unknown> {
    if (channel === IPC_CHANNELS.getJevSettings) return Promise.resolve(this.settings())
    if (channel === IPC_CHANNELS.setJevPreferences) {
      this.a51Writes += 1
      const next = parseJevPreferences(payload)
      if (next.default.model === UNLAUNCHABLE_MODEL) {
        return Promise.resolve({ ...this.settings(), preferencesError: 'refused' })
      }
      this.stored = next
      return Promise.resolve(this.settings())
    }
    if (channel === IPC_CHANNELS.setJevApiKey) {
      this.key = String(payload)
      return Promise.resolve(this.settings())
    }
    return Promise.resolve(undefined)
  }

  private settings(): JevSettings {
    return { configured: this.key !== undefined, preferences: structuredClone(this.stored) }
  }
}

const PREMIUM: JevPreferences = {
  profile: 'premium',
  default: { provider: 'codex', model: 'gpt-x', effort: 'high' },
  delegation: true
}

function jevSetup(stored: JevPreferences, release: StepId = 'cut-3a') {
  const host = new RecordingJevHost()
  const legacy = new FakeLegacyJevRoute(stored)
  const hub = createLegacySettingsWriteHub()
  // What `src/ui-main/index.ts` composes: the router serves the legacy rows through `route`.
  const route = reportSettingsMirrorWrites(release, legacy, hub)
  const ids = new SequenceIdGenerator()
  const bridge = createSettingsMirrorBridge({
    hostClient: host,
    legacy: hub,
    halves: settingsMirrorHalves(release, route),
    newRequestId: () => ids.uuidv7()
  })
  return { host, legacy, hub, route, bridge }
}

const REQ = (n: number): string => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`

/** The Host values that equal `PREMIUM`, so a test starts with nothing to mirror. */
const HOST_PREMIUM: Partial<HostPreferences> = {
  routingProfile: 'premium',
  defaultProvider: 'codex',
  defaultModel: 'gpt-x',
  defaultEffort: 'high',
  subagentDelegationOn: true
}

describe('SettingsMirrorBridge Jev half (21 §3, from 3a; 14 §2.3 B-M13; ADR-016 item 5)', () => {
  it('[ADR-001] at start the mirror sends one preferences.set per Jev key whose Host value differs from the legacy one', async () => {
    const { host, bridge } = jevSetup(PREMIUM)
    // The Host already holds the same default model: that key is not sent.
    host.prefs = { ...host.prefs, defaultModel: 'gpt-x' }

    host.attach()
    await bridge.idle()
    host.detach()
    host.attach()
    await bridge.idle()

    expect(host.sets).toEqual([
      { key: 'routingProfile', value: 'premium', requestId: REQ(1) },
      { key: 'defaultProvider', value: 'codex', requestId: REQ(2) },
      { key: 'defaultEffort', value: 'high', requestId: REQ(3) },
      { key: 'subagentDelegationOn', value: true, requestId: REQ(4) }
    ])
    expect(host.prefs).toEqual({ ...HOST_DEFAULTS, ...HOST_PREMIUM })
  })

  it('[ADR-001] a legacy write of the routing profile, a default or the delegation toggle is mirrored once with a new requestId', async () => {
    const { host, route, bridge } = jevSetup(PREMIUM)
    host.prefs = { ...host.prefs, ...HOST_PREMIUM }
    host.attach()
    await bridge.idle()
    expect(host.sets).toEqual([])

    await route.serve(IPC_CHANNELS.setJevPreferences, { ...PREMIUM, profile: 'economy' })
    await bridge.idle()
    await route.serve(IPC_CHANNELS.setJevPreferences, {
      profile: 'economy',
      default: { provider: 'codex', effort: 'low' },
      delegation: true
    })
    await bridge.idle()
    await route.serve(IPC_CHANNELS.setJevPreferences, {
      profile: 'economy',
      default: { provider: 'codex', effort: 'low' },
      delegation: false
    })
    await bridge.idle()
    // A write today's handler refuses stores nothing, and a write of the stored values changes nothing: neither sends.
    await route.serve(IPC_CHANNELS.setJevPreferences, {
      profile: 'premium',
      default: { model: UNLAUNCHABLE_MODEL },
      delegation: true
    })
    await bridge.idle()
    await route.serve(IPC_CHANNELS.setJevPreferences, {
      profile: 'economy',
      default: { provider: 'codex', effort: 'low' },
      delegation: false
    })
    await bridge.idle()

    expect(host.sets).toEqual([
      { key: 'routingProfile', value: 'economy', requestId: REQ(1) },
      // Clearing the default model ("None") sends the absent value; the effort changed in the same write.
      { key: 'defaultModel', value: undefined, requestId: REQ(2) },
      { key: 'defaultEffort', value: 'low', requestId: REQ(3) },
      { key: 'subagentDelegationOn', value: false, requestId: REQ(4) }
    ])
    expect(host.prefs).toEqual({
      ...HOST_DEFAULTS,
      routingProfile: 'economy',
      defaultProvider: 'codex',
      defaultModel: undefined,
      defaultEffort: 'low',
      subagentDelegationOn: false
    })
  })

  it('[ADR-016, C-21] the mirror never sends a secret or an integration gate', async () => {
    const half = createJevMirrorHalf(new FakeLegacyJevRoute(PREMIUM))
    expect(half.keys).toEqual(JEV_MIRROR_KEYS)
    expect([...JEV_MIRROR_KEYS].sort()).toEqual(
      [
        'defaultEffort',
        'defaultModel',
        'defaultProvider',
        'routingProfile',
        'subagentDelegationOn'
      ].sort()
    )
    const secretNames: readonly string[] = secretNameSchema.options
    const integrationIds: readonly string[] = integrationIdSchema.options
    // Every key the mirror can send, as a table: none is a secret name (ADR-017 item 3) nor an integration id.
    for (const key of JEV_MIRROR_KEYS) {
      expect({ key, secret: secretNames.includes(key) }).toEqual({ key, secret: false })
      expect({ key, gate: integrationIds.includes(key) }).toEqual({ key, gate: false })
    }

    const { host, route, bridge } = jevSetup(PREMIUM)
    host.attach()
    await bridge.idle()
    // A key write, then a preferences write: the key is never on the wire, and only Jev keys are sent.
    await route.serve(IPC_CHANNELS.setJevApiKey, 'not-a-real-key')
    await route.serve(IPC_CHANNELS.setJevPreferences, { ...PREMIUM, profile: 'balanced' })
    await bridge.idle()

    expect(host.sets.length).toBeGreaterThan(0)
    for (const set of host.sets) {
      expect([...JEV_MIRROR_KEYS, 'systemNotificationsOn']).toContain(set.key)
      expect(JSON.stringify(set)).not.toContain('not-a-real-key')
    }
  })

  it('[ADR-001] with the Host detached the mirror retries the pending keys at the next attach and never writes the legacy store', async () => {
    const { host, legacy, route, bridge } = jevSetup(PREMIUM)
    host.prefs = { ...host.prefs, ...HOST_PREMIUM }
    host.attach()
    await bridge.idle()
    host.detach()

    await route.serve(IPC_CHANNELS.setJevPreferences, { ...PREMIUM, delegation: false })
    await bridge.idle()
    expect(host.sets).toEqual([])

    host.attach()
    await bridge.idle()
    host.attach()
    await bridge.idle()

    expect(host.sets).toEqual([{ key: 'subagentDelegationOn', value: false, requestId: REQ(1) }])
    expect(legacy.a51Writes).toBe(1)
    expect(legacy.stored).toEqual({ ...PREMIUM, delegation: false })
  })

  it('[ADR-001] the Jev half is registered from 3a until the bridge ends after 3e, never before', async () => {
    for (const release of STEP_ORDER) {
      const { host, route, bridge } = jevSetup(PREMIUM, release)
      host.attach()
      await bridge.idle()
      await route.serve(IPC_CHANNELS.setJevPreferences, { ...PREMIUM, profile: 'economy' })
      await bridge.idle()

      const jev = STEP_ORDER.slice(STEP_ORDER.indexOf('cut-3a'), STEP_ORDER.indexOf('cut-3e') + 1)
      const sent = host.sets.some((set) => set.key === 'routingProfile')
      expect({ release, sent }).toEqual({ release, sent: jev.includes(release) })
    }
  })
})

describe('Jev half write reporting (21 §3)', () => {
  it('[ADR-001] only an A-51 save is reported, once per Jev key it changed', async () => {
    const legacy = new FakeLegacyJevRoute(PREMIUM)
    const saved: string[] = []
    const route = reportJevWrites(legacy, { saved: (key) => saved.push(key) })

    await route.serve(IPC_CHANNELS.getJevSettings, undefined)
    await route.serve(IPC_CHANNELS.setJevApiKey, 'not-a-real-key')
    await route.serve(IPC_CHANNELS.setJevPreferences, { ...PREMIUM, default: {} })

    expect(saved).toEqual(['defaultProvider', 'defaultModel', 'defaultEffort'])
  })
})
