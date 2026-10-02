// layer: L6
// L6 (17 §1.6): B-M19 `mines.list` (14 §2.3, §3.4 `MineListParams`, `MineListResult`,
// `MineSummaryWire`, §8 I-10) over the real seam-B transport — frame codec, hello-first
// authentication, roles, the Host dispatcher main composes — behind in-process duplexes, with the
// mines module over a copy of the template database (schema v1). The fixture world holds four
// listed mines, one removed mine, their dwarfs and their ore. Every answer is validated against its
// contract schema (14 §1.4).
//
// TC-063-02 and TC-063-03.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  CHANNELS,
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
import { createMines } from '../../modules/mines'
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
import { registerMines } from './mines'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0063'
const T0 = 1_790_000_000_000
const KB = 1024

const id = (n: number): string => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
const ALPHA = id(0xa1)
const BRAVO = id(0xb2)
const CHARLIE = id(0xc3)
const DELTA = id(0xd4)
const ECHO = id(0xe5)

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** One Host transport serving B-M19 over the mines module and the Host database. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-063-mines-'))
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
      minesEverKnown: () => true
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

  // The Mines page world, written as the Host database holds it (09 §4.2, §4.7):
  //   alpha    copper 400 KB, last used T0+3, gold 10, two present dwarfs and one departed
  //   Bravo    silver 2000 KB, last used T0+1, uranium 1
  //   charlie  never measured, last used T0+4
  //   delta    copper 500 KB, last used T0+2, gold 10 + coal 5, one present dwarf
  //   echo     removed
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  transactions.inTransaction(() => {
    const mine = (
      mineId: string,
      name: string,
      lastUsedAt: number,
      measured: { tier: string; kb: number } | null,
      removedAt: number | null = null
    ) =>
      db.run(
        `INSERT INTO mines (id, canonical_path, name, name_norm, state, tier, source_weight_bytes,
           has_been_measured, measured_at, removed_at, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          mineId,
          `/work/${name}`,
          name,
          name.toLowerCase(),
          removedAt !== null ? 'removed' : measured === null ? 'measuring' : 'active',
          measured?.tier ?? null,
          measured === null ? null : measured.kb * KB,
          measured === null ? 0 : 1,
          measured === null ? null : T0,
          removedAt,
          T0,
          lastUsedAt
        ]
      )
    mine(ALPHA, 'alpha', T0 + 3, { tier: 'copper', kb: 400 })
    mine(BRAVO, 'Bravo', T0 + 1, { tier: 'silver', kb: 2_000 })
    mine(CHARLIE, 'charlie', T0 + 4, null)
    mine(DELTA, 'delta', T0 + 2, { tier: 'copper', kb: 500 })
    mine(ECHO, 'echo', T0 + 9, { tier: 'gold', kb: 20_000 }, T0 + 10)
    let credits = 0
    const credit = (mineId: string, material: string, tokens: number) => {
      credits += 1
      db.run(
        `INSERT INTO ledger_entries (id, unit_key, mine_id, material, tokens, units, kind, credited_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, 0)`,
        [
          id(0x100 + credits),
          `unit-${credits}`,
          mineId,
          material,
          tokens,
          material === 'coal' ? 'coal-backfill' : 'live'
        ]
      )
    }
    credit(ALPHA, 'gold', 10)
    credit(BRAVO, 'uranium', 1)
    credit(DELTA, 'gold', 10)
    credit(DELTA, 'coal', 5)
    credit(ECHO, 'uranium', 99)
    let dwarfs = 0
    const seat = (mineId: string, present: boolean) => {
      dwarfs += 1
      db.run(
        `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
           process_state, turn_state, arrived_at, last_activity_at, departed_at, departure_cause)
         VALUES (?, ?, 'claude', ?, 'Dwarf', 'foreman', ?, 'none-yet', 0, 0, ?, ?)`,
        [
          id(0x200 + dwarfs),
          mineId,
          `session-${dwarfs}`,
          present ? 'running' : 'closed',
          present ? null : 1,
          present ? null : 'stopped'
        ]
      )
    }
    seat(ALPHA, true)
    seat(ALPHA, true)
    seat(ALPHA, false)
    seat(DELTA, true)
  })
  const mines = createMines({ db, transactions, mapSites: [], random: () => 0 })
  registerMines(dispatcher, { mines: mines.queries })

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
        collectCapabilities({ methods: dispatcher.methods(), frames: [], sections: [] }),
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

  return { attach, dispatcher }
}

let nextId = 0

type Res = z.infer<typeof resFrameSchema>

/** Sends one request and returns its `res` frame. */
async function call(client: FrameClient, method: string, params: unknown): Promise<Res> {
  nextId += 1
  const requestId = `req-${nextId}`
  client.send({ type: 'req', id: requestId, method, params })
  await client.until(() => client.frames.some((frame) => isRes(frame, requestId)))
  return resFrameSchema.parse(client.frames.find((frame) => isRes(frame, requestId)))
}

function isRes(frame: unknown, requestId: string): boolean {
  return (frame as { type?: string }).type === 'res' && (frame as { id?: string }).id === requestId
}

function resultOf(res: Res): unknown {
  if (!res.ok) throw new Error(`refused: ${res.error.code}`)
  return HOST_METHOD_SCHEMAS['mines.list'].result.parse(res.result)
}

function codeOf(res: Res): string | undefined {
  return res.ok ? undefined : res.error.code
}

const namesOf = (result: unknown) =>
  (result as { mines: { name: string }[] }).mines.map((m) => m.name)

describe('mines.list over seam B (B-M19)', () => {
  it("[ADR-019] mines.list validates MineListParams strictly and answers MineListResult with today's ProjectQuery field names", async () => {
    const { attach } = await host()
    const ui = await attach('ui')

    // Today's ProjectQuery field names, kept (14 §3.4, §8 I-10), so A-34 can relay the request.
    const today = CHANNELS['projects:query'].request as z.AnyZodObject
    const target = HOST_METHOD_SCHEMAS['mines.list'].params as unknown as z.AnyZodObject
    expect(Object.keys(target.shape).sort()).toEqual(Object.keys(today.shape).sort())

    const copper = await call(ui, 'mines.list', {
      tier: 'copper',
      sortBy: 'name',
      direction: 'asc'
    })
    expect(resultOf(copper)).toStrictEqual({
      mines: [
        {
          mineId: ALPHA,
          name: 'alpha',
          path: '/work/alpha',
          tier: 'copper',
          lastUsedAt: T0 + 3,
          presentDwarfs: 2,
          removed: false
        },
        {
          mineId: DELTA,
          name: 'delta',
          path: '/work/delta',
          tier: 'copper',
          lastUsedAt: T0 + 2,
          presentDwarfs: 1,
          removed: false
        }
      ],
      total: 2
    })

    // A page and the total the browse matches; the removed mine is never listed.
    const page = resultOf(
      await call(ui, 'mines.list', { sortBy: 'ore', direction: 'desc', limit: 2, offset: 1 })
    )
    expect(namesOf(page)).toEqual(['delta', 'alpha'])
    expect((page as { total: number }).total).toBe(4)
    expect(
      namesOf(
        resultOf(
          await call(ui, 'mines.list', { sortBy: 'tier', direction: 'desc', nameContains: 'A' })
        )
      )
    ).toEqual(['Bravo', 'delta', 'alpha', 'charlie'])

    // Strict params: an unknown key, today's sort keys, a bad direction or page bound → INVALID_PARAMS.
    for (const params of [
      { sortBy: 'name', direction: 'asc', includeRemoved: true },
      { sortBy: 'addedAt', direction: 'asc' },
      { sortBy: 'name', direction: 'up' },
      { sortBy: 'name', direction: 'asc', tier: 'coal' },
      { sortBy: 'name', direction: 'asc', limit: 0 },
      { sortBy: 'name', direction: 'asc', limit: 501 },
      { sortBy: 'name', direction: 'asc', offset: -1 },
      { sortBy: 'name', direction: 'asc', offset: 1.5 },
      { sortBy: 'name', direction: 'asc', nameContains: 'x'.repeat(257) },
      { direction: 'asc' }
    ]) {
      expect(
        codeOf(await call(ui, 'mines.list', params)),
        JSON.stringify(params).slice(0, 80)
      ).toBe('INVALID_PARAMS')
    }
  })

  it('[ADR-003] mines.list on a notifier connection is FORBIDDEN', async () => {
    const { attach, dispatcher } = await host()
    const notifier = await attach('notifier')

    expect(codeOf(await call(notifier, 'mines.list', { sortBy: 'name', direction: 'asc' }))).toBe(
      'FORBIDDEN'
    )
    // A viewer cannot authenticate before its per-view token issuer exists (hello.ts), so its
    // scope is checked at the dispatcher, as for session.snapshot.
    const viewer = await dispatcher.dispatch(
      { id: 'v1', method: 'mines.list', params: { sortBy: 'name', direction: 'asc' } },
      { role: 'viewer', clientId: 'viewer-1' }
    )
    expect(viewer).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})
