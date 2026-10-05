// layer: L6
// L6 (17 §1.6): B-M16 `mines.declare`, B-M17 `mines.adoptMainProject` and B-M20
// `mines.resolveFile` (14 §2.3, §3.4 `DeclareMineResult`, `AdoptMainProjectResult`,
// `ResolveFileResult`, §1.6, §1.10) over the real seam-B transport — frame codec, hello-first
// authentication, roles, request de-duplication — behind in-process duplexes, with the mines module
// over a copy of the template database (schema v1) and folders made in a temporary directory on the
// running OS: a plain folder, a main working tree and one linked worktree. Every answer is
// validated against its contract schema (14 §1.4).
//
// TC-066-01, TC-066-03.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  HOST_FRAME_SCHEMAS,
  HOST_METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema
} from '@dwarfai/contracts'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { createMines, type MinesEvent } from '../../modules/mines'
import { NodeFs } from '../../platform/fs/NodeFs'
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

const EPOCH = 'epoch-0066'
const T0 = 1_790_000_000_000

const uuid = (n: number): string => `01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, '0')}`

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** The folders: a plain one with a file, a main working tree and its linked worktree `feat`. */
function folders() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-066-declare-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'plain', 'src'), { recursive: true })
  writeFileSync(join(root, 'plain', 'src', 'a.ts'), 'export {}')
  writeFileSync(join(root, 'outside.txt'), 'outside')
  mkdirSync(join(root, 'repo', '.git', 'worktrees', 'feat'), { recursive: true })
  writeFileSync(join(root, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(root, 'repo', '.git', 'worktrees', 'feat', 'commondir'), '../..\n')
  writeFileSync(join(root, 'repo', '.git', 'worktrees', 'feat', 'HEAD'), 'ref: refs/heads/feat\n')
  mkdirSync(join(root, 'feat'))
  writeFileSync(
    join(root, 'feat', '.git'),
    `gitdir: ${join(root, 'repo', '.git', 'worktrees', 'feat')}\n`
  )
  return root
}

/** One Host transport serving B-M16, B-M17 and B-M20 over the mines module. */
async function host() {
  const runDir = mkdtempSync(join(tmpdir(), 'dwarfai-066-run-'))
  cleanups.push(() => rmSync(runDir, { recursive: true, force: true }))
  const token = new UiToken()
  await token.issue(runDir)
  const secret = readFileSync(join(runDir, UI_TOKEN_FILE), 'utf8')
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  const log = new RecordingDiagnosticsLog()
  const connections = new ConnectionRegistry({ validateFrame })
  const state = new HostStateHolder(connections)
  state.report({ state: 'ready', jobStatus: 'none' })
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
    sections: new SectionRegistry(),
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

  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const bus = new RecordingEventBus<MinesEvent>({ transactionScope: transactions })
  const remeasured: string[] = []
  const mines = createMines({
    db,
    transactions,
    mapSites: [{ xPct: 10, yPct: 20 }],
    random: () => 0,
    fs: new NodeFs(),
    clock,
    ids,
    bus,
    hostEpoch: EPOCH,
    remeasure: (mineId) => remeasured.push(mineId)
  })
  registerMines(dispatcher, { mines: mines.queries, commands: mines.commands })

  const throttle = new HelloThrottle(clock)
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
  const ui = new FrameClient(pair.client)
  cleanups.push(() => void pair.client.destroy())
  ui.send({
    type: 'hello',
    endpointGeneration: 1,
    protocolVersion: PROTOCOL_VERSION,
    role: 'ui',
    token: secret,
    client: { appVersion: '0.21.0', buildId: 'abc1234', pid: 4242 }
  })
  await ui.settle()
  expect(ui.frames[0]).toMatchObject({ type: 'hello.ok' })
  return { ui, bus, remeasured }
}

let nextId = 0

type Res = z.infer<typeof resFrameSchema>

async function call(client: FrameClient, method: string, params: unknown): Promise<Res> {
  nextId += 1
  const id = `req-${nextId}`
  client.send({ type: 'req', id, method, params })
  const isRes = (frame: unknown) =>
    (frame as { type?: string }).type === 'res' && (frame as { id?: string }).id === id
  await client.until(() => client.frames.some(isRes))
  return resFrameSchema.parse(client.frames.find(isRes))
}

type Method = 'mines.declare' | 'mines.adoptMainProject' | 'mines.resolveFile'

/** The contract result of an answered call, validated by its schema. */
function resultOf(method: Method, res: Res): unknown {
  expect(res.ok ? undefined : res.error.code, method).toBeUndefined()
  return res.ok ? HOST_METHOD_SCHEMAS[method].result.parse(res.result) : undefined
}

const codeOf = (res: Res): string | undefined => (res.ok ? undefined : res.error.code)

describe('mines.declare, mines.adoptMainProject and mines.resolveFile over seam B', () => {
  it('[ADR-019] mines.declare, mines.adoptMainProject and mines.resolveFile validate strictly, and a repeated requestId returns the first result with one effect', async () => {
    const root = folders()
    const { ui, bus, remeasured } = await host()

    // B-M16: a plain folder becomes a mine; the answer is DeclareMineResult.
    const first = resultOf(
      'mines.declare',
      await call(ui, 'mines.declare', { path: join(root, 'plain'), requestId: uuid(1) })
    )
    expect(first).toEqual({ ok: true, value: { mineId: expect.any(String) } })
    const mineId = (first as { value: { mineId: string } }).value.mineId

    // B-M20: a mine-relative target resolves inside the mine, or is refused (TC-066-03).
    expect(
      resultOf(
        'mines.resolveFile',
        await call(ui, 'mines.resolveFile', { mineId, target: join('src', 'a.ts') })
      )
    ).toEqual({ ok: true, value: { path: join(root, 'plain', 'src', 'a.ts') } })
    expect(
      resultOf(
        'mines.resolveFile',
        await call(ui, 'mines.resolveFile', {
          mineId,
          dwarfId: uuid(9),
          target: join('..', 'outside.txt')
        })
      )
    ).toEqual({ ok: false, error: 'escapes-mine' })
    expect(
      resultOf('mines.resolveFile', await call(ui, 'mines.resolveFile', { mineId, target: 'gone' }))
    ).toEqual({ ok: false, error: 'missing' })

    // A repeated requestId gets the first answer with no second effect, even once the folder is
    // gone: the de-duplication answers it, not the Host's re-validation (16 §2.4).
    rmSync(join(root, 'plain'), { recursive: true, force: true })
    expect(
      resultOf(
        'mines.declare',
        await call(ui, 'mines.declare', { path: join(root, 'plain'), requestId: uuid(1) })
      )
    ).toEqual(first)
    expect(bus.ofType('MineCreated')).toHaveLength(1)
    expect(remeasured).toEqual([mineId])
    // A new requestId re-validates: the folder is gone.
    expect(
      resultOf(
        'mines.declare',
        await call(ui, 'mines.declare', { path: join(root, 'plain'), requestId: uuid(2) })
      )
    ).toEqual({ ok: false, error: 'not-a-folder' })

    // B-M16 for a linked worktree, then B-M17: the main working tree's mine (TC-066-01).
    const asked = resultOf(
      'mines.declare',
      await call(ui, 'mines.declare', { path: join(root, 'feat'), requestId: uuid(3) })
    )
    expect(asked).toEqual({ ok: true, value: { worktreeOf: expect.any(String) } })
    expect(bus.ofType('MineCreated')).toHaveLength(1)
    const adopted = resultOf(
      'mines.adoptMainProject',
      await call(ui, 'mines.adoptMainProject', {
        worktreePath: join(root, 'feat'),
        requestId: uuid(4)
      })
    )
    expect(adopted).toEqual({ ok: true, value: { mineId: expect.any(String) } })
    // The path is the mine key, case-folded where the folder folds case (ADR-030 item 1, S-030-1).
    expect(bus.ofType('MineCreated').at(-1)?.payload).toMatchObject({
      name: 'repo',
      origin: 'worktree-fold'
    })
    expect(
      resultOf(
        'mines.adoptMainProject',
        await call(ui, 'mines.adoptMainProject', {
          worktreePath: join(root, 'repo'),
          requestId: uuid(5)
        })
      )
    ).toEqual({ ok: false, error: 'no-main-project' })

    // Strict params (ADR-019): an unknown key, a missing or malformed requestId, a non-string
    // path, an empty target → INVALID_PARAMS before any handler runs.
    for (const [method, params] of [
      ['mines.declare', { path: root, requestId: uuid(6), name: 'x' }],
      ['mines.declare', { path: root }],
      ['mines.declare', { path: root, requestId: 'not-a-uuid' }],
      ['mines.declare', { path: 7, requestId: uuid(7) }],
      ['mines.adoptMainProject', { path: root, requestId: uuid(8) }],
      ['mines.adoptMainProject', { worktreePath: root }],
      ['mines.resolveFile', { mineId, target: '' }],
      ['mines.resolveFile', { mineId, target: 'a', requestId: uuid(10) }],
      ['mines.resolveFile', { target: 'a' }],
      ['mines.resolveFile', { mineId: 'mine-1', target: 'a' }]
    ] as const) {
      expect(codeOf(await call(ui, method, params)), `${method} ${JSON.stringify(params)}`).toBe(
        'INVALID_PARAMS'
      )
    }
    expect(bus.ofType('MineCreated')).toHaveLength(2)
  })
})
