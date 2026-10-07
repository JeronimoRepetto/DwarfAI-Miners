// layer: L6
// L6 (17 §1.6): B-M15 `preferences.resetMetrics`, B-M09 `ui.resetPreferences.ack`, B-F26
// `ui.resetPreferences`, B-F27 `reset.progress` and B-F03 `resync-required {metrics-reset}` over the
// real seam-B transport — frame codec, hello-first authentication, roles, the Host dispatcher with
// its requestId de-duplication, the connection registry and its frame delivery — behind in-process
// duplexes, with the Reset saga over a copy of the template database, the real post-commit cleanup,
// a secret store and a config writer with nothing stored (cut 1) and the production event bus (14 §2.3 B-M09, B-M15,
// §2.4 B-F03, B-F26, B-F27, §1.9, §4.3 rule 4, §6.3 "Reset saga progress"; ADR-023; 07 machine 13).
// Every frame is validated against its contract schema (14 §1.4).
//
// TC-212-01.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  evtFrameSchema,
  HOST_FRAME_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema
} from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus, type HandlerFailure } from '../../kernel/InProcessEventBus'
import { createAttentionResetStep } from '../../modules/attention'
import {
  createPreferencesResetStep,
  createResetSaga,
  type ExternalConfigWriter,
  type PreferencesEvent,
  type SecretStore
} from '../../modules/preferences'
import { readResetEpoch } from '../../platform/sqlite/hostEpochLog'
import { SqliteResetCleanup } from '../../platform/sqlite/resetCleanup'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { emptyDrainGate } from '../../wiring/emptyDrainGate'
import { createHostDispatcher } from '../../wiring/hostDispatcher'
import { createModuleResetSteps } from '../../wiring/moduleResetSteps'
import { resetParticipants } from '../../wiring/resetParticipants'
import { HelloThrottle } from '../auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../auth/uiToken'
import { collectCapabilities } from '../capabilities'
import { acceptConnection } from '../connection'
import { ConnectionRegistry } from '../connectionRegistry'
import { TRANSPORT_FRAMES } from '../events/framePublisher'
import { createUpgradeDrain } from '../lifecycle/drain'
import { HostStateHolder } from '../lifecycle/hostState'
import { SectionRegistry } from '../snapshot/sectionRegistry'
import { FrameClient } from '../testing/frameClient'
import { inProcessDuplex } from '../testing/inProcessDuplex'
import { createUpgradeTargetRule } from './hostUpgradeRequest'
import {
  ConnectionResetUiFanout,
  publishResetFrames,
  registerResetMetrics,
  RESET_FRAMES
} from './resetMetrics'

const cleanups: Array<() => void> = []

/** No Host secret is stored (cut 1): every delete completes (ADR-017 item 7). */
const noSecrets: SecretStore = {
  backend: () => Promise.resolve('os-secret-store'),
  get: () => Promise.resolve(null),
  has: () => Promise.resolve(false),
  set: () => Promise.reject(new Error('no secret is set in this case')),
  delete: () => Promise.resolve('deleted')
}

/** No DwarfAI-owned config entry is active (cut 1): every revert completes (lead decision). */
const noOwnedConfig: ExternalConfigWriter = {
  install: () => Promise.reject(new Error('nothing is installed in this case')),
  verify: () => Promise.resolve('absent'),
  revert: () => Promise.resolve({ ok: true, value: undefined }),
  findLegacy: () => Promise.resolve(false)
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0212'
const RID_1 = '01890a5d-ac96-774b-bcce-b302099a8057'
const RID_2 = '01890a5d-ac96-774b-bcce-b302099a8058'

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** One Host transport serving the Reset saga: real connections, dispatcher and database. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-212-reset-'))
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
  const { db, path } = openTemplateCopy()
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
      resetEpoch: () => readResetEpoch(db),
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

  // The saga over the Host database, wired as the composition root wires it.
  const transactions = new SqliteTransactionRunner(db)
  const handlerErrors: HandlerFailure[] = []
  const bus = new InProcessEventBus<PreferencesEvent>({
    transactionScope: transactions,
    onHandlerError: (failure) => handlerErrors.push(failure)
  })
  const fanout = new ConnectionResetUiFanout(connections)
  const participants = resetParticipants({
    preferences: createPreferencesResetStep({ db, clock }),
    // The cut-1 module steps (ISSUE-121), as host/main.ts builds them at boot step 3.
    modules: createModuleResetSteps({
      db,
      scope: transactions,
      clock,
      mapSites: [],
      random: () => 0
    }).steps,
    attention: createAttentionResetStep({ db, scope: transactions }),
    // The ledger's LedgerRepository.setInstallMoment (16 §11) over the same table.
    ledger: {
      setInstallMoment: (at) =>
        db.run(
          `INSERT INTO install_moment (id, at, reason) VALUES (1, ?, 'reset')
           ON CONFLICT (id) DO UPDATE SET at = excluded.at, reason = 'reset',
             backfill_state = 'not-started', backfill_done_at = NULL`,
          [at]
        )
    },
    clock
  })
  const reset = createResetSaga({
    db,
    transactions,
    dbSteps: participants.dbSteps,
    installMoment: participants.installMoment,
    maintenance: new SqliteResetCleanup({ db, path }),
    secrets: noSecrets,
    externalConfig: noOwnedConfig,
    ui: fanout,
    bus,
    clock,
    ids,
    hostEpoch: EPOCH,
    log
  })
  registerResetMetrics(dispatcher, { reset, fanout })
  publishResetFrames(bus, connections, log)

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
          frames: [...TRANSPORT_FRAMES, ...RESET_FRAMES],
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

  return { attach, handlerErrors, db }
}

let nextId = 0

type Res = z.infer<typeof resFrameSchema>

/** Sends one request; returns its id. */
function request(client: FrameClient, method: string, params: unknown): string {
  nextId += 1
  const id = `req-${nextId}`
  client.send({ type: 'req', id, method, params })
  return id
}

/** Waits for the `res` of request `id` and returns it. */
async function response(client: FrameClient, id: string): Promise<Res> {
  await client.until(() => client.frames.some((frame) => isRes(frame, id)))
  return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, id)))
}

function isRes(frame: unknown, id: string): boolean {
  return (
    (frame as { type?: string; id?: string }).type === 'res' && (frame as { id?: string }).id === id
  )
}

/** Each frame a client received after hello, as `evt <name> <data>` or `res`, in order. */
type WireItem = { kind: string; name?: string; data?: unknown; id?: string }

function wire(client: FrameClient): WireItem[] {
  return client.frames.slice(1).flatMap((frame): WireItem[] => {
    const type = (frame as { type?: string }).type
    if (type === 'evt') {
      const evt = evtFrameSchema.parse(frame)
      return [{ kind: 'evt', name: evt.name, data: evt.data }]
    }
    if (type === 'res') return [{ kind: 'res', id: (frame as { id?: string }).id }]
    return []
  })
}

/** Acks every `ui.resetPreferences` the client received so far, as UI main does (14 §4.3 rule 4). */
async function ackResets(client: FrameClient): Promise<void> {
  for (const item of wire(client)) {
    if (item.name !== 'ui.resetPreferences') continue
    const ack = request(client, 'ui.resetPreferences.ack', item.data)
    expect((await response(client, ack)).ok).toBe(true)
  }
}

function hasResetPreferences(client: FrameClient): boolean {
  return wire(client).some((item) => item.name === 'ui.resetPreferences')
}

describe('preferences.resetMetrics over seam B', () => {
  it('[ADR-023] resync-required metrics-reset follows the db commit, then one reset.progress per step, then the result', async () => {
    const { attach, handlerErrors } = await host()
    const ui = await attach('ui')

    const id = request(ui, 'preferences.resetMetrics', { confirmed: 'yes', requestId: RID_1 })
    await ui.until(() => hasResetPreferences(ui))
    await ackResets(ui)
    const res = await response(ui, id)

    expect(res.ok && res.result).toStrictEqual({ outcome: 'reset', epoch: 1 })
    // The saga's frames and the command's own res (the ack's res and B-F26 are left out).
    const resetSide = wire(ui).filter((item) =>
      item.kind === 'res' ? item.id === id : item.name !== 'ui.resetPreferences'
    )
    const steps = ['db', 'secrets', 'external-config', 'ui-prefs', 'install-moment', 'done']
    expect(resetSide.map((item) => item.name ?? 'res')).toStrictEqual([
      'resync-required',
      ...steps.map(() => 'reset.progress'),
      'res'
    ])
    expect(resetSide[0]?.data).toStrictEqual({ reason: 'metrics-reset' })
    expect(resetSide.slice(1, 7).map((item) => item.data)).toStrictEqual(
      steps.map((step) => ({ resetId: expect.any(String), epoch: 1, step }))
    )
    expect(handlerErrors).toStrictEqual([])
  })

  it('[ADR-003] preferences.resetMetrics with confirmed other than yes gets INVALID_PARAMS', async () => {
    const { attach, db } = await host()
    const ui = await attach('ui')
    const notifier = await attach('notifier')

    for (const confirmed of ['YES', 'no', '', true]) {
      const res = await response(
        ui,
        request(ui, 'preferences.resetMetrics', { confirmed, requestId: RID_1 })
      )
      expect(res.ok ? 'ok' : res.error.code, String(confirmed)).toBe('INVALID_PARAMS')
    }
    const forbidden = await response(
      notifier,
      request(notifier, 'preferences.resetMetrics', { confirmed: 'yes', requestId: RID_2 })
    )
    expect(forbidden.ok ? 'ok' : forbidden.error.code).toBe('FORBIDDEN')
    expect(readResetEpoch(db)).toBe(0)
    expect(wire(ui).filter((item) => item.kind === 'evt')).toStrictEqual([])
  })

  it('[S13.04, S13.05] every attached ui connection gets ui.resetPreferences and the saga moves on once each acked or detached', async () => {
    const { attach, db } = await host()
    const runner = await attach('ui')
    const other = await attach('ui')
    const leaving = await attach('ui')
    const notifier = await attach('notifier')
    const moment = () => db.all('SELECT reason FROM install_moment')[0]?.['reason']

    const id = request(runner, 'preferences.resetMetrics', { confirmed: 'yes', requestId: RID_1 })
    await runner.until(
      () =>
        hasResetPreferences(runner) && hasResetPreferences(other) && hasResetPreferences(leaving)
    )
    await ackResets(runner)
    await other.settle()
    // One UI has not acked yet: the saga waits at ui-prefs (no timeout, 07 §24 I-14). The `db`
    // step's ledger step deleted the install moment, and only the install-moment step after
    // ui-prefs writes the new one (09 §7.2; amended with ISSUE-121, which registered that step:
    // the fresh-install moment used to survive until then).
    expect(moment()).toBeUndefined()
    await ackResets(other)
    await runner.settle()
    expect(moment()).toBeUndefined()

    leaving.stream.destroy()
    const res = await response(runner, id)

    expect(res.ok && res.result).toStrictEqual({ outcome: 'reset', epoch: 1 })
    expect(moment()).toBe('reset')
    expect(wire(notifier)).toStrictEqual([])
  })

  it('[S13.09] a UI that attaches after the reset with an applied epoch below resetEpoch is told to reset its files', async () => {
    const { attach } = await host()
    const ui = await attach('ui')
    const id = request(ui, 'preferences.resetMetrics', { confirmed: 'yes', requestId: RID_1 })
    await ui.until(() => hasResetPreferences(ui))
    await ackResets(ui)
    await response(ui, id)

    // A window that was not attached (its resetEpochApplied is still 0) reads meta.resetEpoch.
    const later = await attach('ui')
    const page = await response(later, request(later, 'session.snapshot', { sections: ['meta'] }))
    const chunks = (page.ok ? page.result : { chunks: [] }) as {
      chunks: Array<{ section: string; data: { resetEpoch: number } }>
    }

    expect(chunks.chunks[0]?.data.resetEpoch).toBe(1)
    expect(chunks.chunks[0]?.data.resetEpoch).toBeGreaterThan(0)
  })
})
