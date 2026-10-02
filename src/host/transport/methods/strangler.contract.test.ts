// layer: L6
// L6 (17 §1.6): B-M41 `strangler.dwarfIdentities` (14 §2.3, §3.4 `StranglerDwarfIdentity`, §1.10
// "Strangler-only read", §6.5 AMENDMENT-8; OQ-69) over the real seam-B transport — frame codec,
// hello-first authentication, roles, the Host dispatcher main composes — behind in-process
// duplexes, with the crew module over a copy of the template database (schema v1). The fixture
// world holds an observed Claude session and a Claude subagent sharing it (ADR-015 item 7,
// INV-21). The registry check walks every seam-A row (14 §2.1, the today shapes included) and
// every seam-B frame: none carries a `StranglerDwarfIdentity`, and no renderer or preload source
// names the method (14 §1.10; ADR-019). B-M41 is deleted with LegacyDwarfIdBridge at the end of
// cut 4 (later: ISSUE-241).
//
// TC-083-01, TC-083-02 and TC-083-03.
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  CHANNELS,
  HOST_FRAME_SCHEMAS,
  HOST_METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema,
  stranglerDwarfIdentitySchema,
  TODAY_SHAPES
} from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { MineId, ProviderIdentity } from '../../kernel/domain/values'
import { createCrew, rankForDepth, type CrewEvent } from '../../modules/crew'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
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
import { registerStranglerDwarfIdentities } from './strangler'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0083'
const T0 = 1_790_000_000_000
const MINE = '00000000-0000-7000-8000-0000000000f1' as MineId

const SESSION: ProviderIdentity = { providerId: 'claude', providerSessionId: 'session-1' }
const SUBAGENT: ProviderIdentity = { ...SESSION, providerAgentId: 'agent-1' }

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** One Host transport serving B-M41 over the crew module and the Host database. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-083-strangler-'))
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

  // The crew module over the Host database, with one mine; every session is observed (not owned).
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  transactions.inTransaction(() =>
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/mine', 'mine', 'mine', 'active', ?, ?)`,
      [MINE, T0, T0]
    )
  )
  const crew = createCrew({
    db,
    transactions,
    lifecycleFacts: new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock }),
    bus: new RecordingEventBus<CrewEvent>({ transactionScope: transactions }),
    clock,
    scheduler,
    ids,
    hostEpoch: EPOCH,
    links: { owned: () => false, hasDeliveryRoute: () => false }
  })
  registerStranglerDwarfIdentities(dispatcher, { crew: crew.queries })

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

  return { attach, crew, dispatcher }
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
  return (frame as { type?: string }).type === 'res' && (frame as { id?: string }).id === id
}

function resultOf(res: Res): unknown {
  if (!res.ok) throw new Error(`refused: ${res.error.code}`)
  return res.result
}

function codeOf(res: Res): string | undefined {
  return res.ok ? undefined : res.error.code
}

/** Whether `schema` is `target` or holds it anywhere in its definition (shapes, items, options). */
function carries(schema: unknown, target: z.ZodTypeAny, seen = new Set<unknown>()): boolean {
  if (schema === target) return true
  if (typeof schema !== 'object' || schema === null || seen.has(schema)) return false
  seen.add(schema)
  if (schema instanceof z.ZodObject) {
    if (Object.values(schema.shape as object).some((child) => carries(child, target, seen))) {
      return true
    }
  }
  if (schema instanceof z.ZodLazy && carries(schema.schema, target, seen)) return true
  const children =
    schema instanceof z.ZodType
      ? Object.values(schema._def as object)
      : schema instanceof Map
        ? [...schema.values()]
        : Array.isArray(schema)
          ? schema
          : []
  return children.some((child) => carries(child, target, seen))
}

/** Every source file under `dir`, recursively. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(ts|vue|js|mjs)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
}

describe('strangler.dwarfIdentities over seam B (B-M41, strangler-only)', () => {
  it('[ADR-015] strangler.dwarfIdentities on ui returns two records with distinct providerAgentId', async () => {
    const { attach, crew } = await host()
    const parent = crew.commands.arrive({
      mineId: MINE,
      identity: SESSION,
      rank: rankForDepth(0),
      status: 'working'
    })
    const subagent = crew.commands.arrive({
      mineId: MINE,
      identity: SUBAGENT,
      parent,
      rank: rankForDepth(1),
      status: 'working'
    })
    const ui = await attach('ui')

    const res = await call(ui, 'strangler.dwarfIdentities', {})

    expect(codeOf(res)).toBeUndefined()
    const records = resultOf(res)
    expect(records).toStrictEqual([
      { dwarfId: parent, providerId: 'claude', identity: SESSION },
      { dwarfId: subagent, providerId: 'claude', identity: SUBAGENT }
    ])
    expect(z.array(stranglerDwarfIdentitySchema).safeParse(records).success).toBe(true)
    // The params are the contract's `{}`, strict (14 §1.4).
    expect(codeOf(await call(ui, 'strangler.dwarfIdentities', { mineId: MINE }))).toBe(
      'INVALID_PARAMS'
    )
  })

  it('[ADR-003] strangler.dwarfIdentities on notifier or viewer is FORBIDDEN', async () => {
    const { attach, crew, dispatcher } = await host()
    crew.commands.arrive({ mineId: MINE, identity: SESSION, rank: rankForDepth(0), status: 'idle' })
    const notifier = await attach('notifier')

    expect(codeOf(await call(notifier, 'strangler.dwarfIdentities', {}))).toBe('FORBIDDEN')
    // A viewer cannot authenticate before its per-view token issuer exists (hello.ts), so its
    // scope is checked at the dispatcher, as for session.snapshot.
    const viewer = await dispatcher.dispatch(
      { id: 'v1', method: 'strangler.dwarfIdentities', params: {} },
      { role: 'viewer', clientId: 'viewer-1' }
    )
    expect(viewer).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('[ADR-019] no seam-A member or push carries a StranglerDwarfIdentity', () => {
    const methods: Readonly<Record<string, { result: z.ZodTypeAny } | undefined>> =
      HOST_METHOD_SCHEMAS
    // The walk finds it where it is: B-M41's own result.
    expect(
      carries(methods['strangler.dwarfIdentities']?.result, stranglerDwarfIdentitySchema)
    ).toBe(true)

    // Seam A (14 §2.1): no channel, target or today shape, carries it, and none is named for it.
    const seamA = [...Object.entries(CHANNELS), ...Object.entries(TODAY_SHAPES)]
    for (const [key, row] of seamA) {
      expect(carries(row.request, stranglerDwarfIdentitySchema), `${key} request`).toBe(false)
      expect(carries(row.response, stranglerDwarfIdentitySchema), `${key} response`).toBe(false)
    }
    for (const [key, spec] of Object.entries(CHANNELS)) {
      expect(`${key} ${spec.name}`).not.toMatch(/strangler|dwarfIdentities/i)
    }
    // Seam B pushes (14 §2.4): no frame carries it, so nothing reaches a renderer store.
    for (const [name, schema] of Object.entries(HOST_FRAME_SCHEMAS)) {
      expect(carries(schema, stranglerDwarfIdentitySchema), name).toBe(false)
    }
    // No preload member and no renderer source names the method or its record.
    const sources = [...sourcesUnder('src/preload'), ...sourcesUnder('src/renderer')]
    expect(sources.length).toBeGreaterThan(0)
    for (const file of sources) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(
        /strangler\.dwarfIdentities|StranglerDwarfIdentity|presentIdentities/
      )
    }
  })
})
