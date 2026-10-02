// layer: L6
// L6 (17 §1.6): B-M12 `preferences.get`, B-M13 `preferences.set`, B-F24 `preferences.changed` and the
// snapshot's `preferences` section over the real seam-B transport — frame codec, hello-first
// authentication, roles, the Host dispatcher main composes with its requestId de-duplication, the
// connection registry and its frame delivery — behind in-process duplexes, with the preferences
// module over a copy of the template database (schema v1, migration 1 seeded) and the production
// event bus (14 §2.3 B-M12, B-M13, §2.4 B-F24, §1.6, §1.7, §3.4, §3.6, §4.1; ADR-024 D9; INV-105;
// ADR-003 items 6, 12). Every frame is validated against its contract schema (14 §1.4).
//
// TC-210-01, TC-210-02 and TC-210-04.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  evtFrameSchema,
  HOST_FRAME_SCHEMAS,
  HOST_METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema
} from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus, type HandlerFailure } from '../../kernel/InProcessEventBus'
import { createPreferences, type PreferencesEvent } from '../../modules/preferences'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
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
import {
  PREFERENCES_FRAMES,
  preferencesSection,
  publishPreferencesChanged,
  registerPreferences
} from './preferences'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0210'
const RID_1 = '01890a5d-ac96-774b-bcce-b302099a8057'
const RID_2 = '01890a5d-ac96-774b-bcce-b302099a8058'
const RID_3 = '01890a5d-ac96-774b-bcce-b302099a8059'

/** Migration 1's seed row (09 §4.9) as `HostPreferences`. */
const DEFAULTS = {
  subagentDelegationOn: false,
  routingProfile: 'balanced',
  systemNotificationsOn: true,
  openCodePermissionsOn: false
}

/** The cut-1 view (ISSUE-210 lead decision): the sources of the other members come later. */
const view = (preferences: object) => ({
  preferences,
  secrets: [],
  secretBackend: 'unavailable',
  integrations: [],
  welcome: { due: false, legacyFound: [], offered: [] }
})

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** One Host transport serving the preferences methods: real connections, dispatcher and database. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-210-preferences-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  const clock = new FakeClock(1_000)
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

  // The preferences module over the Host database, wired as the composition root wires it.
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const handlerErrors: HandlerFailure[] = []
  const bus = new InProcessEventBus<PreferencesEvent>({
    transactionScope: transactions,
    onHandlerError: (failure) => handlerErrors.push(failure)
  })
  const preferences = createPreferences({
    db,
    transactions,
    bus,
    clock,
    ids,
    hostEpoch: EPOCH
  })
  registerPreferences(dispatcher, { preferences })
  sections.registerSection('preferences', ['ui'], preferencesSection(preferences))
  publishPreferencesChanged(bus, connections)

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
          frames: PREFERENCES_FRAMES,
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

  return { attach, handlerErrors, log }
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

/** The `preferences.changed` frames a client received, in order. */
function changedFrames(client: FrameClient): unknown[] {
  return client.frames
    .filter((frame) => (frame as { type?: string }).type === 'evt')
    .map((frame) => evtFrameSchema.parse(frame))
    .filter((evt) => evt.name === 'preferences.changed')
    .map((evt) => evt.data)
}

function resultOf(res: Res): unknown {
  if (!res.ok) throw new Error(`refused: ${res.error.code}`)
  return res.result
}

function codeOf(res: Res): string | undefined {
  return res.ok ? undefined : res.error.code
}

describe('preferences.get, preferences.set and preferences.changed over seam B', () => {
  it('[US-DLG-001.AC01] preferences.get on a fresh database reads the migration-1 defaults', async () => {
    const { attach } = await host()
    const ui = await attach('ui')

    const read = resultOf(await call(ui, 'preferences.get', {}))

    expect(read).toStrictEqual(view(DEFAULTS))
    expect(HOST_METHOD_SCHEMAS['preferences.get'].result.safeParse(read).success).toBe(true)
  })

  it('[ADR-024] preferences.set answers the stored HostPreferences after the preferences.changed frame reached every ui connection', async () => {
    const { attach, handlerErrors } = await host()
    const writer = await attach('ui')
    const other = await attach('ui')
    const notifier = await attach('notifier')

    const res = await call(writer, 'preferences.set', {
      key: 'routingProfile',
      value: 'premium',
      requestId: RID_1
    })
    await other.settle()

    const stored = { ...DEFAULTS, routingProfile: 'premium' }
    expect(resultOf(res)).toStrictEqual(stored)
    expect(HOST_METHOD_SCHEMAS['preferences.set'].result.safeParse(resultOf(res)).success).toBe(
      true
    )
    // Effects before response (14 §1.7): the frame precedes the writer's own `res`.
    const changedAt = writer.frames.findIndex(
      (frame) => (frame as { name?: string }).name === 'preferences.changed'
    )
    const resAt = writer.frames.findIndex((frame) => (frame as { type?: string }).type === 'res')
    expect(changedAt).toBeGreaterThan(0)
    expect(changedAt).toBeLessThan(resAt)
    expect(changedFrames(writer)).toStrictEqual([view(stored)])
    expect(changedFrames(other)).toStrictEqual([view(stored)])
    expect(changedFrames(notifier)).toStrictEqual([])
    expect(resultOf(await call(other, 'preferences.get', {}))).toStrictEqual(view(stored))

    // A write that stores nothing new publishes nothing: the same value, and a model without a
    // provider, which the stored row does not keep (INV-105, 09 §4.8).
    const same = await call(writer, 'preferences.set', {
      key: 'routingProfile',
      value: 'premium',
      requestId: RID_2
    })
    const modelOnly = await call(writer, 'preferences.set', {
      key: 'defaultModel',
      value: 'opus',
      requestId: RID_3
    })
    await other.settle()
    expect(resultOf(same)).toStrictEqual(stored)
    expect(resultOf(modelOnly)).toStrictEqual(stored)
    expect(changedFrames(writer)).toHaveLength(1)
    expect(changedFrames(other)).toHaveLength(1)
    expect(handlerErrors).toStrictEqual([])
  })

  it('[ADR-003] a notifier calling preferences.set gets FORBIDDEN; an unknown key, Other as a default provider or extra fields get INVALID_PARAMS', async () => {
    const { attach } = await host()
    const ui = await attach('ui')
    const notifier = await attach('notifier')

    expect(
      codeOf(
        await call(notifier, 'preferences.set', {
          key: 'routingProfile',
          value: 'economy',
          requestId: RID_1
        })
      )
    ).toBe('FORBIDDEN')
    expect(codeOf(await call(notifier, 'preferences.get', {}))).toBe('FORBIDDEN')

    const refused = [
      { key: 'notificationSoundsOn', value: true, requestId: RID_1 },
      { key: 'openCodePermissionsOn', value: true, requestId: RID_1 },
      { key: 'defaultProvider', value: 'other', requestId: RID_1 },
      { key: 'defaultProvider', value: null, requestId: RID_1 },
      { key: 'routingProfile', value: 'economy', requestId: RID_1, origin: 'settings' },
      { key: 'routingProfile', value: 'fast', requestId: RID_1 },
      { key: 'routingProfile', value: 'economy' },
      { key: 'routingProfile', value: 'economy', requestId: 'not-a-uuid' }
    ]
    for (const params of refused) {
      expect(codeOf(await call(ui, 'preferences.set', params)), JSON.stringify(params)).toBe(
        'INVALID_PARAMS'
      )
    }
    expect(codeOf(await call(ui, 'preferences.get', { keys: ['routingProfile'] }))).toBe(
      'INVALID_PARAMS'
    )

    expect(resultOf(await call(ui, 'preferences.get', {}))).toStrictEqual(view(DEFAULTS))
    expect(changedFrames(ui)).toStrictEqual([])
  })

  it('[ADR-003] the same requestId twice stores once and answers the same result', async () => {
    const { attach } = await host()
    const ui = await attach('ui')

    const first = await call(ui, 'preferences.set', {
      key: 'subagentDelegationOn',
      value: true,
      requestId: RID_1
    })
    const later = await call(ui, 'preferences.set', {
      key: 'subagentDelegationOn',
      value: false,
      requestId: RID_2
    })
    const repeat = await call(ui, 'preferences.set', {
      key: 'subagentDelegationOn',
      value: true,
      requestId: RID_1
    })

    const on = { ...DEFAULTS, subagentDelegationOn: true }
    expect(resultOf(first)).toStrictEqual(on)
    expect(resultOf(later)).toStrictEqual(DEFAULTS)
    expect(resultOf(repeat)).toStrictEqual(on)
    // The repeat had no second effect: the later write still stands, and no third frame was sent.
    expect(resultOf(await call(ui, 'preferences.get', {}))).toStrictEqual(view(DEFAULTS))
    expect(changedFrames(ui)).toStrictEqual([view(on), view(DEFAULTS)])
  })

  it('[ADR-024] the snapshot preferences section equals preferences.get', async () => {
    const { attach } = await host()
    const ui = await attach('ui')
    resultOf(
      await call(ui, 'preferences.set', {
        key: 'defaultProvider',
        value: 'claude',
        requestId: RID_1
      })
    )
    resultOf(
      await call(ui, 'preferences.set', { key: 'defaultEffort', value: 'high', requestId: RID_2 })
    )

    const read = resultOf(await call(ui, 'preferences.get', {}))
    const page = resultOf(await call(ui, 'session.snapshot', { sections: ['preferences'] })) as {
      chunks: Array<{ section: string; data: unknown }>
    }

    expect(read).toStrictEqual(
      view({ ...DEFAULTS, defaultProvider: 'claude', defaultEffort: 'high' })
    )
    expect(page.chunks).toStrictEqual([{ section: 'preferences', data: read }])
  })
})
