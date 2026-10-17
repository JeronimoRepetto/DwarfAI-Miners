// layer: L6
// L6 (17 §1.6): B-M10 `settings.secret.set` and B-M11 `settings.secret.clear` over the real seam-B
// transport — frame codec, hello-first authentication, roles, the Host dispatcher main composes with
// its requestId de-duplication and its diagnostics log, the connection registry — behind in-process
// duplexes (14 §2.3 B-M10, B-M11, §1.6, §1.10, §3.4, §3.5 SENSITIVE_METHODS, §6.5 "Security";
// ADR-017 items 4, 5; ADR-003 item 11; 18 C-22; 06 INV-107; UC-029). The module side is the real
// `SecretStatusService` over the `FakeSecretStore` double (its own behaviour is the L2 suite,
// modules/preferences/application/secrets.test.ts).
//
// TC-216-01, TC-216-02, TC-216-03, TC-216-04 (the Host's log; the UI's log is its flow, ISSUE-217).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  HOST_FRAME_SCHEMAS,
  HOST_METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema
} from '@dwarfai/contracts'
import { toLogLine } from '../../../contracts/logging'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { createSecrets, type PreferencesEvent, type SecretName } from '../../modules/preferences'
import { FakeSecretStore } from '../../modules/preferences/testing/fakeSecretStore'
import { emptyDrainGate } from '../../wiring/emptyDrainGate'
import { createHostDispatcher } from '../../wiring/hostDispatcher'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { collectCapabilities } from '../capabilities'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { createUpgradeDrain } from '../lifecycle/drain'
import { HostStateHolder } from '../lifecycle/hostState'
import { SectionRegistry } from '../snapshot/sectionRegistry'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { createUpgradeTargetRule } from './hostUpgradeRequest'
import { registerSettingsSecret } from './settingsSecret'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0216'
const RID_1 = '01890a5d-ac96-774b-bcce-b302099a8161'
const RID_2 = '01890a5d-ac96-774b-bcce-b302099a8162'
const RID_3 = '01890a5d-ac96-774b-bcce-b302099a8163'
const RID_4 = '01890a5d-ac96-774b-bcce-b302099a8164'
const T0 = 1_000
/** A seeded value (14 §6.5 "Security"): anything that carries it out of the store is a leak. */
const SEEDED = 'sk-seeded-216-c22-7d41e09b'

/** The double, counting every `set` (the de-duplication case). */
class CountingSecretStore extends FakeSecretStore {
  sets = 0
  override set(name: SecretName, value: string): Promise<void> {
    this.sets += 1
    return super.set(name, value)
  }
}

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** One Host transport serving B-M10 and B-M11: real connections, dispatcher and diagnostics log. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-216-secrets-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'none' })
  const sections = new SectionRegistry()
  const ids = new SequenceIdGenerator()
  const lifecycle = { closeCleanly: () => Promise.resolve() }
  const dispatcher = createHostDispatcher({
    log,
    clock,
    scheduler,
    state: () => state.current().state,
    stopAll: new RecordingStopAll(),
    lifecycle,
    connections,
    epoch: EPOCH,
    ids,
    sections,
    snapshotMeta: {
      hostVersion: () => '0.21.0',
      state: () => state.current().state,
      resetEpoch: () => 0,
      snapshotTail: () => 20,
      minesEverKnown: () => false
    },
    drain: createUpgradeDrain({ gate: emptyDrainGate, state, scheduler, lifecycle, log }),
    upgradeTarget: createUpgradeTargetRule({
      platform: 'linux',
      root: null,
      realpath: () => {
        throw new Error('no copy root in this case')
      }
    })
  })

  const store = new CountingSecretStore()
  const bus = new RecordingEventBus<PreferencesEvent>()
  const secrets = createSecrets({ secrets: store, bus, clock, ids, hostEpoch: EPOCH })
  registerSettingsSecret(dispatcher, { commands: secrets })

  const throttle = new HelloThrottle(clock)
  /** Connects with `role` and returns the client once hello.ok arrived. */
  const attach = async (role: 'ui' | 'notifier'): Promise<FrameClient> => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: { hostVersion: '0.21.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
      epoch: EPOCH,
      state: () => state.current(),
      capabilities: () =>
        collectCapabilities({
          methods: dispatcher.methods(),
          frames: [],
          sections: sections.names()
        }),
      scheduler,
      clock,
      log,
      dispatcher,
      connections,
      throttle
    })
    const client = new FrameClient(pair.client)
    cleanups.push(() => void pair.client.destroy())
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role,
      token: secret,
      client: { appVersion: '0.21.0', buildId: 'abc1234', pid: 4242 }
    })
    await client.settle()
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    return client
  }

  return { attach, store, bus, log, secrets }
}

let nextId = 0

type Res = z.infer<typeof resFrameSchema>

/** Sends one request and returns its `res` frame. */
async function call(client: FrameClient, method: string, params: unknown): Promise<Res> {
  nextId += 1
  const id = `req-${nextId}`
  client.send({ type: 'req', id, method, params })
  await client.until(() => client.frames.some((frame) => isRes(frame, id)))
  return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, id)))
}

function isRes(frame: unknown, id: string): boolean {
  return (
    (frame as { type?: string; id?: string }).type === 'res' && (frame as { id?: string }).id === id
  )
}

function resultOf(res: Res): unknown {
  if (!res.ok) throw new Error(`refused: ${res.error.code}`)
  return res.result
}

function codeOf(res: Res): string | undefined {
  return res.ok ? undefined : res.error.code
}

/** Every log line the Host would write, serialized as the real log writes it (ADR-026). */
function logText(log: RecordingDiagnosticsLog): string {
  const lines = log.entries.map((entry) =>
    toLogLine({
      ts: '2026-01-01T00:00:00.000Z',
      proc: 'host',
      pid: 1,
      appVersion: '0.0.0',
      ...entry
    })
  )
  return JSON.stringify([lines, log.entries, log.refused])
}

const setParams = (requestId: string, name: SecretName = 'jev-key', value = SEEDED) => ({
  name,
  value,
  requestId,
  origin: 'settings'
})

describe('settings.secret.set and settings.secret.clear over seam B (B-M10, B-M11)', () => {
  it('[ADR-017, C-22, INV-107] settings.secret.set answers configured true and no field of the answer, frame or snapshot holds the value', async () => {
    const { attach, store, bus } = await host()
    const caller = await attach('ui')
    const other = await attach('ui')

    const set = await call(caller, 'settings.secret.set', setParams(RID_1))
    const snapshot = await call(caller, 'session.snapshot', { sections: ['meta'] })
    await other.settle()

    expect(resultOf(set)).toStrictEqual({
      ok: true,
      value: { name: 'jev-key', configured: true }
    })
    expect(HOST_METHOD_SCHEMAS['settings.secret.set'].result.safeParse(resultOf(set)).success).toBe(
      true
    )
    expect(await store.get('jev-key')).toBe(SEEDED)
    // No answer, frame or snapshot carries the value back (ADR-017 item 4; 14 §1.10).
    expect(JSON.stringify(caller.frames)).not.toContain(SEEDED)
    expect(JSON.stringify(other.frames)).not.toContain(SEEDED)
    expect(JSON.stringify(resultOf(snapshot))).not.toContain(SEEDED)
    expect(JSON.stringify(bus.published)).not.toContain(SEEDED)
  })

  it('[ADR-017, FM-115] with an unavailable backend settings.secret.set answers backend-unavailable and nothing is stored', async () => {
    const { attach, store } = await host()
    const caller = await attach('ui')
    store.setBackend('unavailable')

    const set = await call(caller, 'settings.secret.set', setParams(RID_1))

    expect(resultOf(set)).toStrictEqual({ ok: false, error: 'backend-unavailable' })
    expect(HOST_METHOD_SCHEMAS['settings.secret.set'].result.safeParse(resultOf(set)).success).toBe(
      true
    )
    // No plain-text fallback (ADR-017 item 5): the store was never asked to write.
    expect(store.sets).toBe(0)
    store.setBackend('os-secret-store')
    expect(await store.get('jev-key')).toBeNull()
    expect(JSON.stringify(caller.frames)).not.toContain(SEEDED)
  })

  it('[ADR-017] settings.secret.clear answers configured false and a second clear succeeds', async () => {
    const { attach, store } = await host()
    const caller = await attach('ui')
    await call(caller, 'settings.secret.set', setParams(RID_1, 'opencode-password'))

    const first = await call(caller, 'settings.secret.clear', {
      name: 'opencode-password',
      requestId: RID_2
    })
    const second = await call(caller, 'settings.secret.clear', {
      name: 'opencode-password',
      requestId: RID_3
    })

    const cleared = { ok: true, value: { name: 'opencode-password', configured: false } }
    expect(resultOf(first)).toStrictEqual(cleared)
    expect(resultOf(second)).toStrictEqual(cleared)
    expect(
      HOST_METHOD_SCHEMAS['settings.secret.clear'].result.safeParse(resultOf(second)).success
    ).toBe(true)
    expect(await store.get('opencode-password')).toBeNull()
    expect(store.deleted).toStrictEqual(['opencode-password', 'opencode-password'])
  })

  it('[ADR-003] a notifier calling either method gets FORBIDDEN; an unknown name or extra fields get INVALID_PARAMS', async () => {
    const { attach, store } = await host()
    const ui = await attach('ui')
    const notifier = await attach('notifier')

    expect(codeOf(await call(notifier, 'settings.secret.set', setParams(RID_1)))).toBe('FORBIDDEN')
    expect(
      codeOf(await call(notifier, 'settings.secret.clear', { name: 'jev-key', requestId: RID_2 }))
    ).toBe('FORBIDDEN')
    const invalid: Array<[string, unknown]> = [
      ['settings.secret.set', { ...setParams(RID_1), name: 'anthropic-api-key' }],
      ['settings.secret.set', { ...setParams(RID_1), echo: true }],
      ['settings.secret.set', { ...setParams(RID_1), origin: 'first-run' }],
      ['settings.secret.set', setParams(RID_1, 'jev-key', '')],
      ['settings.secret.set', setParams(RID_1, 'jev-key', 'x'.repeat(1025))],
      ['settings.secret.set', { name: 'jev-key', value: SEEDED, origin: 'settings' }],
      ['settings.secret.clear', { name: 'anthropic-api-key', requestId: RID_2 }],
      ['settings.secret.clear', { name: 'jev-key', requestId: RID_2, value: SEEDED }]
    ]
    for (const [method, params] of invalid) {
      expect(codeOf(await call(ui, method, params)), JSON.stringify(params)).toBe('INVALID_PARAMS')
    }
    // The longest value the Host takes is stored (params/preferences.ts SECRET_VALUE_MAX_CHARS).
    expect(
      resultOf(await call(ui, 'settings.secret.set', setParams(RID_3, 'jev-key', 'x'.repeat(1024))))
    ).toStrictEqual({ ok: true, value: { name: 'jev-key', configured: true } })
    expect(store.sets).toBe(1)
    expect(store.deleted).toStrictEqual([])
    // A refused call's error never echoes the params either.
    expect(JSON.stringify(ui.frames)).not.toContain(SEEDED)
  })

  it('[ADR-003] the same requestId twice stores once', async () => {
    const { attach, store } = await host()
    const caller = await attach('ui')

    const first = await call(caller, 'settings.secret.set', setParams(RID_1))
    const again = await call(caller, 'settings.secret.set', setParams(RID_1))
    const clear = await call(caller, 'settings.secret.clear', { name: 'jev-key', requestId: RID_4 })
    const clearAgain = await call(caller, 'settings.secret.clear', {
      name: 'jev-key',
      requestId: RID_4
    })

    expect(resultOf(again)).toStrictEqual(resultOf(first))
    expect(store.sets).toBe(1)
    expect(resultOf(clearAgain)).toStrictEqual(resultOf(clear))
    expect(store.deleted).toStrictEqual(['jev-key'])
  })

  it('[NFR-SEC-12] a seeded secret value never reaches a Host log line through either member', async () => {
    const { attach, store, log } = await host()
    const ui = await attach('ui')
    const notifier = await attach('notifier')

    await call(ui, 'settings.secret.set', setParams(RID_1))
    await call(ui, 'settings.secret.set', setParams(RID_1))
    await call(ui, 'settings.secret.clear', { name: 'jev-key', requestId: RID_2 })
    await call(ui, 'settings.secret.set', { ...setParams(RID_3), extra: SEEDED })
    await call(notifier, 'settings.secret.set', setParams(RID_4))
    store.setBackend('unavailable')
    await call(ui, 'settings.secret.set', setParams('01890a5d-ac96-774b-bcce-b302099a8165'))

    // The calls were logged (method, outcome, code), so the scan below reads real lines.
    expect(log.entries.filter((entry) => entry.method === 'settings.secret.set')).not.toHaveLength(
      0
    )
    expect(logText(log)).not.toContain(SEEDED)
  })
})
