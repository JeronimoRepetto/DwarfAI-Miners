// layer: L2
// L2 flow (17 §1.2): the attention module wired into the Host (05 §3.11, §4; 16 §4.11, §8.2) through
// host/wiring/routes/attentionTransport.ts, as host/main.ts wires it: B-M07 `presence` and B-M08
// `attention.clicked` served before the boot binds the endpoint and the attention frames advertised
// (14 §1.3; ADR-003 item 12), preferences wired at boot step 3 and attention constructed at step 4
// over the `AttentionSettings` bridge to preferences, the `SqliteAttentionLedger`, the
// `TransportLevel3Sink` and the `AppBackgroundNotifierLauncher`, with the connection registry's
// attach and detach events fed to the presence union and the notifier supervisor (machine 12C).
// The real boot step list, the Host dispatcher and connection registry behind in-process duplexes,
// one copy of the template database, a FakeClock and FakeScheduler, and FakeProcessControl in place
// of the OS (no app is ever started, no OS notification is ever drawn). Facts are injected into
// `AttentionInputs.onFact`: the routes from asks, turn ends and departures are ISSUE-120's.
//
// TC-119-01, TC-119-02, TC-119-03.
import { readFileSync, realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import type { z } from 'zod'
import {
  evtFrameSchema,
  frameCapability,
  HOST_FRAME_SCHEMAS,
  methodCapability,
  PROTOCOL_VERSION,
  resFrameSchema
} from '@dwarfai/contracts'
import type { DwarfId, HostEpoch, MineId } from '../../kernel/domain/values'
import { FakeAppPaths } from '../../kernel/fakes/FakeAppPaths'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { InProcessEventBus } from '../../kernel/InProcessEventBus'
import type { AttentionFact } from '../../modules/attention'
import { AppBackgroundNotifierLauncher } from '../../modules/attention/adapters/AppBackgroundNotifierLauncher'
import { SqliteAttentionLedger } from '../../modules/attention/adapters/SqliteAttentionLedger'
import { SqliteLedgerRepository } from '../../modules/ledger/adapters/SqliteLedgerRepository'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { TransportLevel3Sink } from '../../transport/attention/TransportLevel3Sink'
import { HelloThrottle } from '../../transport/auth/throttle'
import { UI_TOKEN_FILE, UiToken } from '../../transport/auth/uiToken'
import { collectCapabilities } from '../../transport/capabilities'
import { acceptConnection } from '../../transport/connection'
import { ConnectionRegistry } from '../../transport/connectionRegistry'
import { createUpgradeDrain } from '../../transport/lifecycle/drain'
import { HostStateHolder } from '../../transport/lifecycle/hostState'
import { createUpgradeTargetRule } from '../../transport/methods/hostUpgradeRequest'
import { PREFERENCES_FRAMES } from '../../transport/methods/preferences'
import { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { FrameClient } from '../../transport/testing/frameClient'
import { inProcessDuplex } from '../../transport/testing/inProcessDuplex'
import { runBoot, type BootOutcome } from '../boot'
import { createBootSteps, mintBootEpoch } from '../bootSteps'
import { emptyDrainGate } from '../emptyDrainGate'
import { createHostDispatcher } from '../hostDispatcher'
import {
  noOwnedConfigWriter,
  servePreferences,
  unavailableSecretStore,
  type WiredPreferences
} from '../preferencesWiring'
import { createModuleResetSteps } from '../moduleResetSteps'
import {
  ATTENTION_FRAMES,
  onNotifierAttach,
  serveAttention,
  type AttentionRouteEvent,
  type WiredAttention
} from '../routes/attentionTransport'

const T0 = 1_790_000_000_000
const EXEC = 'fake-install/DwarfAI-Miners'
const RID = '01890a5d-ac96-774b-bcce-b30209911901'
const MINE_A = '00000000-0000-7000-8000-0000000119a1' as MineId
const MINE_B = '00000000-0000-7000-8000-0000000119b1' as MineId
const DWARF = '00000000-0000-7000-8000-0000000119d1' as DwarfId
const DWARF_B = '00000000-0000-7000-8000-0000000119d2' as DwarfId
const NAMES = { displayName: 'Gimli', mineName: 'Moria' }

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** One Host start: the real boot steps, preferences at step 3 and attention at step 4. */
async function bootHost() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-119-attention-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const log = new RecordingDiagnosticsLog()
  const processControl = new FakeProcessControl({ clock })
  const epoch = mintBootEpoch(ids)
  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  const sections = new SectionRegistry()
  const lifecycle = { closeCleanly: () => Promise.resolve() }
  const dispatcher = createHostDispatcher({
    log,
    clock,
    scheduler,
    state: () => state.current().state,
    stopAll: new RecordingStopAll(),
    lifecycle,
    connections,
    epoch,
    ids,
    sections,
    snapshotMeta: {
      hostVersion: () => '0.0.0-test',
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
  // What host/main.ts does before the boot: the members are served before the modules exist.
  const servedPreferences = servePreferences({ dispatcher, sections, connections })
  const servedAttention = serveAttention({ dispatcher, connections })

  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  // Two mines and one present dwarf, whose attention keys the ledger records.
  transactions.inTransaction(() => {
    for (const [id, name] of [
      [MINE_A, 'moria'],
      [MINE_B, 'erebor']
    ] as const) {
      db.run(
        `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
        [id, `/work/${name}`, name, name, T0, T0]
      )
    }
    for (const [dwarfId, mineId, session] of [
      [DWARF, MINE_A, 'session-a'],
      [DWARF_B, MINE_B, 'session-b']
    ] as const) {
      db.run(
        `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
           process_state, turn_state, arrived_at, last_activity_at)
         VALUES (?, ?, 'claude', ?, 'Gimli', 'foreman', 'running', 'none-yet', ?, ?)`,
        [dwarfId, mineId, session, T0, T0]
      )
    }
  })
  let asks = 0
  /** An open question of the dwarf in `mineId`: its ask row, and the fact attention is given. */
  const question = (mineId: MineId): AttentionFact => {
    asks += 1
    const askId = `00000000-0000-7000-8000-${asks.toString(16).padStart(12, '0')}`
    const dwarfId = mineId === MINE_A ? DWARF : DWARF_B
    transactions.inTransaction(() =>
      db.run(
        `INSERT INTO asks (id, dwarf_id, kind, channel, provider_request_id, payload_json, state,
           opened_at)
         VALUES (?, ?, 'question', 'driver', ?, '{}', 'open', ?)`,
        [askId, dwarfId, `request-${askId}`, clock.now()]
      )
    )
    return {
      key: `${dwarfId}:question:${askId}`,
      kind: 'question',
      dwarfId,
      mineId,
      at: clock.now(),
      reannounce: true
    }
  }
  const bus = new InProcessEventBus<AttentionRouteEvent>({
    transactionScope: transactions,
    onHandlerError: (failure) => {
      throw failure.error
    }
  })
  const host: { preferences?: WiredPreferences; attention?: WiredAttention } = {}
  const boot: Promise<BootOutcome> = runBoot(
    (paths) =>
      createBootSteps({
        paths,
        clock,
        scheduler,
        ids,
        fs: new FakeFs(),
        processControl,
        log,
        endpoint: { bind: () => Promise.resolve('bound'), close: () => Promise.resolve() },
        database: { open: () => Promise.resolve() },
        resumeResetSaga: () => {
          const preferences = servedPreferences.wire({
            db,
            transactions,
            bus,
            clock,
            ids,
            hostEpoch: epoch as HostEpoch,
            log,
            // Both flags off, their defaults (06 §14.2).
            featureFlags: { read: () => ({ guildAreasEnabled: false, boostEnabled: false }) },
            maintenance: {
              deleteBackups: () => undefined,
              truncateWal: () => undefined,
              vacuum: () => undefined
            },
            // The ledger's install-moment writer and the cut-1 module steps, as host/main.ts binds them.
            ledger: new SqliteLedgerRepository({ db, scope: transactions, ids, clock }),
            moduleSteps: createModuleResetSteps({
              db,
              scope: transactions,
              clock,
              mapSites: [],
              random: () => 0
            }).steps,
            secrets: unavailableSecretStore,
            externalConfig: noOwnedConfigWriter,
            ready: () => state.current().state === 'ready'
          })
          host.preferences = preferences
          return preferences.resumeOnBoot()
        },
        // What host/main.ts does at step 4, with this machine's adapters.
        constructModules: () => {
          if (host.preferences === undefined) throw new Error('step 4 runs after step 3')
          host.attention = servedAttention.wire({
            ledger: new SqliteAttentionLedger({
              db,
              scope: transactions,
              clock,
              hostEpoch: epoch as HostEpoch
            }),
            sink: new TransportLevel3Sink(connections),
            launcher: new AppBackgroundNotifierLauncher({
              processes: processControl,
              paths: new FakeAppPaths({ execPath: EXEC }),
              env: {},
              scheduler,
              onNotifierAttach: onNotifierAttach(connections)
            }),
            preferences: host.preferences.preferences.queries,
            transactions,
            bus,
            clock,
            scheduler,
            ids,
            hostEpoch: epoch as HostEpoch,
            log
          })
        }
      }),
    {
      log,
      clock,
      state,
      privilege: () =>
        Promise.resolve({ elevated: { ok: true, value: false }, inJob: 'not-applicable' }),
      paths: { ok: true, value: new FakeAppPaths({ userDataDir: root }) },
      runtime: { os: 'win32', arch: 'x64', node: '24.18.1' },
      exit: () => undefined
    }
  )
  let outcome: BootOutcome | undefined
  void boot.then((settled) => (outcome = settled))
  for (let i = 0; i < 200 && outcome === undefined; i += 1) await tick()
  expect(state.current().state).toBe('ready')
  const { preferences, attention } = host
  if (preferences === undefined || attention === undefined) {
    throw new Error('boot steps 3 and 4 wired no attention')
  }

  const token = new UiToken()
  await token.issue(join(root, 'run'))
  const secret = readFileSync(join(root, 'run', UI_TOKEN_FILE), 'utf8')
  /** A client of `role` attached over its own in-process duplex, its hello.ok received. */
  const attach = async (role: 'ui' | 'notifier') => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: {
        hostVersion: '0.0.0-test',
        buildId: 'abc1234',
        protocolVersion: PROTOCOL_VERSION
      },
      epoch,
      state: () => state.current(),
      capabilities: () =>
        collectCapabilities({
          methods: dispatcher.methods(),
          frames: [...PREFERENCES_FRAMES, ...ATTENTION_FRAMES],
          sections: sections.names()
        }),
      scheduler,
      clock,
      log,
      dispatcher,
      connections,
      throttle: new HelloThrottle(clock)
    })
    const client = new FrameClient(pair.client)
    // Closed, and its detach handled, before the database copy closes (hooks run as a stack).
    onTestFinished(async () => {
      pair.client.destroy()
      await client.settle()
    })
    client.send({
      type: 'hello',
      endpointGeneration: 1,
      protocolVersion: PROTOCOL_VERSION,
      role,
      token: secret,
      client: { appVersion: '0.0.0-test', buildId: 'abc1234', pid: 4242 }
    })
    await client.until(() => client.frames.length > 0)
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    return client
  }
  let nextId = 0
  /** `client`'s answer to `method`, validated by the contract. */
  const call = async (client: FrameClient, method: string, params: unknown) => {
    nextId += 1
    const id = `req-${nextId}`
    client.send({ type: 'req', id, method, params })
    await client.until(() => client.frames.some((frame) => isRes(frame, id)))
    return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, id)))
  }
  /** The `name` frames `client` received. */
  const evts = (client: FrameClient, name: string) =>
    client.frames.flatMap((frame) => {
      if ((frame as { type?: string }).type !== 'evt') return []
      const evt = evtFrameSchema.parse(frame)
      return evt.name === name ? [evt.data] : []
    })
  /** Pending stream events and promise chains run. */
  const settle = async (...clients: FrameClient[]) => {
    for (const client of clients) await client.settle()
    for (let i = 0; i < 5; i += 1) await tick()
  }
  return {
    clock,
    db,
    log,
    processControl,
    preferences,
    attention,
    question,
    attach,
    call,
    evts,
    settle
  }
}

function isRes(frame: unknown, id: string): boolean {
  return (
    (frame as { type?: string; id?: string }).type === 'res' && (frame as { id?: string }).id === id
  )
}

/** Lets pending promise chains run (no timer). */
async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('the attention module wired into the Host (ISSUE-119)', () => {
  it("[ADR-003] a notifier client's hello.ok advertises the attention frames and attention.clicked, and a ui client's advertises presence", async () => {
    const h = await bootHost()

    const notifier = await h.attach('notifier')
    const ui = await h.attach('ui')

    const capabilities = (client: FrameClient) =>
      (client.frames[0] as { capabilities: readonly string[] }).capabilities
    expect(capabilities(notifier)).toEqual(
      expect.arrayContaining([
        frameCapability('attention.notify'),
        frameCapability('attention.withdraw'),
        methodCapability('attention.clicked')
      ])
    )
    expect(capabilities(ui)).toEqual(expect.arrayContaining([methodCapability('presence')]))
  })

  it('[ADR-018] with system notifications on and nothing on screen, an attention fact reaches the notifier as one attention.notify', async () => {
    const h = await bootHost()
    const notifier = await h.attach('notifier')
    const ui = await h.attach('ui')

    const fact = h.question(MINE_A)
    h.attention.attention.inputs.onFact(fact, NAMES)
    await h.settle(notifier, ui)

    expect(h.evts(notifier, 'attention.notify')).toStrictEqual([
      {
        key: fact.key,
        kind: 'question',
        title: 'Gimli has a question',
        body: 'Moria',
        mineId: MINE_A,
        dwarfId: DWARF,
        sensitive: true
      }
    ])
    // The notifier role only (ADR-003 item 12).
    expect(h.evts(ui, 'attention.notify')).toStrictEqual([])
  })

  it("[INV-101] a ui client reporting the fact's mine on screen prevents the notification", async () => {
    const h = await bootHost()
    const notifier = await h.attach('notifier')
    const ui = await h.attach('ui')
    const reported = await h.call(ui, 'presence', {
      onScreenMineIds: [MINE_A],
      anyWindowVisible: true,
      seq: 1
    })
    expect(reported).toMatchObject({ ok: true })

    h.attention.attention.inputs.onFact(h.question(MINE_A), NAMES)
    const elsewhere = h.question(MINE_B)
    h.attention.attention.inputs.onFact(elsewhere, NAMES)
    await h.settle(notifier, ui)

    // Only the fact of the mine not on screen is announced.
    expect(h.evts(notifier, 'attention.notify')).toMatchObject([{ key: elsewhere.key }])
  })

  it('[S12.C03] a notifier attaching after a notification was emitted receives it once', async () => {
    const h = await bootHost()
    const fact = h.question(MINE_A)
    // No notifier is attached: the notification stands until one is (14 §2.3).
    h.attention.attention.inputs.onFact(fact, NAMES)
    await h.settle()

    const notifier = await h.attach('notifier')
    await h.settle(notifier)

    expect(h.evts(notifier, 'attention.notify')).toMatchObject([{ key: fact.key }])
  })

  it('[ADR-018] the notifier connection closing with no ui client left starts the background app after 2 s', async () => {
    const h = await bootHost()
    const notifier = await h.attach('notifier')

    notifier.stream.destroy()
    await h.settle(notifier)
    h.clock.advance(1_999)
    await h.settle()
    expect(h.processControl.spawns).toStrictEqual([])

    h.clock.advance(1)
    await h.settle()
    expect(h.processControl.spawns.map((spawn) => [spawn.executable, spawn.args])).toStrictEqual([
      [EXEC, ['--background']]
    ])
  })

  it('[ADR-018] turning systemNotificationsOn off through preferences.set stops the next notification', async () => {
    const h = await bootHost()
    const notifier = await h.attach('notifier')
    const ui = await h.attach('ui')
    const first = h.question(MINE_A)
    h.attention.attention.inputs.onFact(first, NAMES)
    await h.settle(notifier, ui)
    expect(h.evts(notifier, 'attention.notify')).toMatchObject([{ key: first.key }])

    const set = await h.call(ui, 'preferences.set', {
      key: 'systemNotificationsOn',
      value: false,
      requestId: RID
    })
    expect(set).toMatchObject({ ok: true })
    h.attention.attention.inputs.onFact(h.question(MINE_A), NAMES)
    await h.settle(notifier, ui)

    expect(h.evts(notifier, 'attention.notify')).toMatchObject([{ key: first.key }])
  })

  it("[ADR-023] the attention step runs in the Reset saga's db transaction", async () => {
    const h = await bootHost()
    const turnKey = `${DWARF}:turn-finished:turn-1`
    h.db.run(
      `INSERT INTO attention_keys (key, dwarf_id, kind, ask_id, host_epoch, emitted_at)
       VALUES (?, ?, 'turn-finished', NULL, 'epoch-0', ?)`,
      [turnKey, DWARF, T0]
    )
    const keys = () =>
      h.db.all('SELECT key FROM attention_keys ORDER BY key').map((row) => String(row['key']))
    const epoch = () => h.db.all('SELECT reset_epoch FROM app_meta')[0]?.['reset_epoch']
    const before = epoch()

    // A failure inside the attention step: the whole db transaction rolls back with it.
    h.db.run(`CREATE TRIGGER attention_reset_fails BEFORE DELETE ON attention_keys
      BEGIN SELECT RAISE(ABORT, 'the attention step failed'); END`)
    const failed = await h.preferences.preferences.commands.resetMetrics({ confirmed: 'yes' })
    expect(failed).toMatchObject({ outcome: 'failed', reason: 'db-transaction-failed' })
    expect(keys()).toStrictEqual([turnKey])
    expect(epoch()).toBe(before)

    h.db.run('DROP TRIGGER attention_reset_fails')
    const reset = await h.preferences.preferences.commands.resetMetrics({ confirmed: 'yes' })
    expect(reset).toMatchObject({ outcome: 'reset' })
    expect(keys()).toStrictEqual([])
  })
})
