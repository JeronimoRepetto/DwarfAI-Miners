// layer: L6
// L6 (17 §1.6): B-M22 `crew.rename` and B-M23 `crew.resetName` (14 §2.3, §3.4 `RenameDwarfParams`,
// `RenameDwarfResult`, `ResetDwarfNameParams`, frozen; ADR-019; AMENDMENT-2, SC-AR-05): their strict()
// schemas, and both methods over the real seam-B transport — frame codec, hello-first
// authentication, roles, the Host dispatcher main composes with its requestId de-duplication —
// behind in-process duplexes, over the crew application on its in-memory doubles (its own behaviour
// is the L2 suite, modules/crew/application/rename.test.ts).
//
// TC-172-03 (seam-B half). The seam-A half (A-N08, A-N09) waits for its registry rows.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import {
  HOST_FRAME_SCHEMAS,
  PROTOCOL_VERSION,
  resFrameSchema,
  HOST_METHOD_SCHEMAS,
  type DwarfId,
  type HostMethods,
  type RenameDwarfParams,
  type RenameDwarfResult,
  type ResetDwarfNameParams
} from '@dwarfai/contracts'
import type { DwarfId as HostDwarfId, MineId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingStopAll } from '../../kernel/fakes/RecordingStopAll'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { inMemoryCrew } from '../../modules/crew/testing/inMemoryCrew'
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
import { registerCrewRename } from './crewRename'
import { registerCrewResetName } from './crewResetName'
import { createUpgradeTargetRule } from './hostUpgradeRequest'

const DWARF = '01890a5d-ac96-774b-bcce-b302099a8172'
const REQUEST = '01890a5d-ac96-774b-bcce-b302099a8173'

describe('crew.rename and crew.resetName params and result (14 §3.4, B-M22, B-M23)', () => {
  it('[ADR-019] crew.rename and crew.resetName params are strict', () => {
    expect(Object.keys(HOST_METHOD_SCHEMAS)).toContain('crew.rename')
    expect(Object.keys(HOST_METHOD_SCHEMAS)).toContain('crew.resetName')
    expectTypeOf<RenameDwarfParams>().toEqualTypeOf<{
      dwarfId: DwarfId
      name: string
      requestId: string
    }>()
    expectTypeOf<RenameDwarfResult>().toEqualTypeOf<
      { ok: true; value: { customName: string | null } } | { ok: false; error: 'empty' }
    >()
    expectTypeOf<ResetDwarfNameParams>().toEqualTypeOf<{ dwarfId: DwarfId; requestId: string }>()
    expectTypeOf<HostMethods['crew.rename']['params']>().toEqualTypeOf<RenameDwarfParams>()
    expectTypeOf<HostMethods['crew.rename']['result']>().toEqualTypeOf<RenameDwarfResult>()
    expectTypeOf<HostMethods['crew.resetName']['params']>().toEqualTypeOf<ResetDwarfNameParams>()
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 14 §3.4 spells the empty result as {}
    expectTypeOf<HostMethods['crew.resetName']['result']>().toEqualTypeOf<{}>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['crew.rename']['params']>
    >().toEqualTypeOf<RenameDwarfParams>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['crew.rename']['result']>
    >().toEqualTypeOf<RenameDwarfResult>()
    expectTypeOf<
      z.infer<(typeof HOST_METHOD_SCHEMAS)['crew.resetName']['params']>
    >().toEqualTypeOf<ResetDwarfNameParams>()

    const rename = HOST_METHOD_SCHEMAS['crew.rename']
    const reset = HOST_METHOD_SCHEMAS['crew.resetName']
    // The name is any text: its DwarfName normalization, its 'empty' outcome and its reset rule are
    // the Host's (16 §4.2), never INVALID_PARAMS for an empty or a spaced one.
    for (const name of ['Watcher of seals', '', '   ', 'Borin']) {
      expect(rename.params.safeParse({ dwarfId: DWARF, name, requestId: REQUEST }).success).toBe(
        true
      )
    }
    for (const invalid of [
      { dwarfId: DWARF, name: 'Gimli' },
      { dwarfId: DWARF, requestId: REQUEST },
      { dwarfId: 'dwarf-1', name: 'Gimli', requestId: REQUEST },
      { dwarfId: DWARF, name: 7, requestId: REQUEST },
      { dwarfId: DWARF, name: 'Gimli', requestId: 'req-1' },
      { dwarfId: DWARF, name: 'Gimli', requestId: REQUEST, baseName: 'Borin' }
    ]) {
      expect(rename.params.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false)
    }
    expect(rename.result.safeParse({ ok: true, value: { customName: 'Gimli' } }).success).toBe(true)
    expect(rename.result.safeParse({ ok: true, value: { customName: null } }).success).toBe(true)
    expect(rename.result.safeParse({ ok: false, error: 'empty' }).success).toBe(true)
    expect(rename.result.safeParse({ ok: false, error: 'too-long' }).success).toBe(false)
    expect(rename.result.safeParse({ ok: true, value: {} }).success).toBe(false)

    expect(reset.params.safeParse({ dwarfId: DWARF, requestId: REQUEST }).success).toBe(true)
    for (const invalid of [
      { dwarfId: DWARF },
      { dwarfId: DWARF, requestId: REQUEST, name: '' },
      { dwarfId: 'dwarf-1', requestId: REQUEST }
    ]) {
      expect(reset.params.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false)
    }
    expect(reset.result.safeParse({}).success).toBe(true)
    expect(reset.result.safeParse({ customName: null }).success).toBe(false)
  })
})

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const EPOCH = 'epoch-0172'
const MINE = '00000000-0000-7000-8000-0000000000f1' as MineId
const RID = (n: number): string =>
  `01890a5d-ac96-774b-bcce-${(0x1720 + n).toString(16).padStart(12, '0')}`

function validateFrame(name: string, data: unknown): void {
  const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
  const schema = schemas[name]
  if (schema === undefined) throw new Error(`no contract schema for ${name}`)
  schema.parse(data)
}

/** One Host transport serving B-M22 and B-M23 over the crew application; one present dwarf. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-172-rename-'))
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
      hostVersion: () => '0.17.2',
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

  const crew = inMemoryCrew()
  const dwarfId = crew.commands.arrive({
    mineId: MINE,
    identity: { providerId: 'codex', providerSessionId: 'thread-172' },
    rank: 'foreman',
    status: 'idle'
  })
  /** Every call that reached crew, in order. */
  const reached: string[] = []
  const commands = {
    rename: (id: HostDwarfId, text: string) => {
      reached.push('rename')
      return crew.commands.rename(id, text)
    },
    resetName: (id: HostDwarfId) => {
      reached.push('resetName')
      crew.commands.resetName(id)
    }
  }
  registerCrewRename(dispatcher, { commands, queries: crew.queries })
  registerCrewResetName(dispatcher, { commands, queries: crew.queries })

  const throttle = new HelloThrottle(clock)
  /** Connects with `role` and returns the client once hello.ok arrived. */
  const attach = async (role: 'ui' | 'notifier'): Promise<FrameClient> => {
    const pair = inProcessDuplex()
    acceptConnection(pair.host, {
      token,
      ids,
      identity: { hostVersion: '0.17.2', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
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
      client: { appVersion: '0.17.2', buildId: 'abc1234', pid: 4242 }
    })
    await client.settle()
    expect(client.frames[0]).toMatchObject({ type: 'hello.ok' })
    return client
  }

  return { attach, crew, dwarfId, reached, log }
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

describe('crew.rename and crew.resetName over seam B (B-M22, B-M23)', () => {
  it('[US-MSG-005.AC02, ADR-003] crew.rename stores the name and answers it; a repeated requestId gets the first answer with no second rename', async () => {
    const { attach, crew, dwarfId, reached } = await host()
    const ui = await attach('ui')

    const first = await call(ui, 'crew.rename', {
      dwarfId,
      name: '  Watcher   of seals ',
      requestId: RID(1)
    })
    expect(resultOf(first)).toStrictEqual({ ok: true, value: { customName: 'Watcher of seals' } })
    expect(HOST_METHOD_SCHEMAS['crew.rename'].result.safeParse(resultOf(first)).success).toBe(true)
    expect(crew.queries.get(dwarfId)?.displayName).toBe('Watcher of seals')

    const again = await call(ui, 'crew.rename', { dwarfId, name: 'Ori', requestId: RID(1) })
    expect(resultOf(again)).toStrictEqual(resultOf(first))
    expect(reached).toStrictEqual(['rename'])
    expect(crew.queries.get(dwarfId)?.customName).toBe('Watcher of seals')
  })

  it('[US-MSG-005.AC04] crew.rename answers customName null for the base name and the empty outcome when nothing is left, never a call error', async () => {
    const { attach, crew, dwarfId } = await host()
    const ui = await attach('ui')
    const baseName = crew.queries.get(dwarfId)?.baseName ?? ''
    await call(ui, 'crew.rename', { dwarfId, name: 'Gimli', requestId: RID(1) })

    const toBase = await call(ui, 'crew.rename', {
      dwarfId,
      name: ` ${baseName} `,
      requestId: RID(2)
    })
    expect(resultOf(toBase)).toStrictEqual({ ok: true, value: { customName: null } })
    expect(crew.queries.get(dwarfId)?.customName).toBeNull()

    const empty = await call(ui, 'crew.rename', { dwarfId, name: '  🪓 ', requestId: RID(3) })
    expect(resultOf(empty)).toStrictEqual({ ok: false, error: 'empty' })
    expect(HOST_METHOD_SCHEMAS['crew.rename'].result.safeParse(resultOf(empty)).success).toBe(true)
  })

  it('[US-MSG-006.AC03] crew.resetName clears the custom name and answers {}; a repeated requestId resets once', async () => {
    const { attach, crew, dwarfId, reached } = await host()
    const ui = await attach('ui')
    await call(ui, 'crew.rename', { dwarfId, name: 'Gimli', requestId: RID(1) })

    const reset = await call(ui, 'crew.resetName', { dwarfId, requestId: RID(2) })
    const again = await call(ui, 'crew.resetName', { dwarfId, requestId: RID(2) })

    expect(resultOf(reset)).toStrictEqual({})
    expect(resultOf(again)).toStrictEqual({})
    expect(reached).toStrictEqual(['rename', 'resetName'])
    expect(crew.queries.get(dwarfId)?.displayName).toBe(crew.queries.get(dwarfId)?.baseName)
  })

  it('[ADR-019, INV-29] a notifier gets FORBIDDEN; a name above 24 graphemes, an unknown dwarf, a missing requestId or another key gets INVALID_PARAMS before crew runs', async () => {
    const { attach, dwarfId, reached } = await host()
    const ui = await attach('ui')
    const notifier = await attach('notifier')
    const unknown = RID(99)

    expect(
      codeOf(await call(notifier, 'crew.rename', { dwarfId, name: 'Ori', requestId: RID(1) }))
    ).toBe('FORBIDDEN')
    expect(codeOf(await call(notifier, 'crew.resetName', { dwarfId, requestId: RID(2) }))).toBe(
      'FORBIDDEN'
    )
    for (const params of [
      { dwarfId, name: 'a'.repeat(25), requestId: RID(3) },
      { dwarfId: unknown, name: 'Ori', requestId: RID(4) },
      { dwarfId, name: 'Ori' },
      { dwarfId, name: 'Ori', requestId: RID(5), customName: 'Ori' }
    ]) {
      expect(codeOf(await call(ui, 'crew.rename', params)), JSON.stringify(params)).toBe(
        'INVALID_PARAMS'
      )
    }
    for (const params of [
      { dwarfId: unknown, requestId: RID(6) },
      { dwarfId },
      { dwarfId, requestId: RID(7), name: '' }
    ]) {
      expect(codeOf(await call(ui, 'crew.resetName', params)), JSON.stringify(params)).toBe(
        'INVALID_PARAMS'
      )
    }
    expect(reached).toStrictEqual([])
  })

  it('[INV-29, NFR-SEC-12] the custom name never reaches the diagnostics log', async () => {
    const { attach, dwarfId, log } = await host()
    const ui = await attach('ui')
    const name = 'Secret Seal Keeper'

    await call(ui, 'crew.rename', { dwarfId, name, requestId: RID(1) })
    await call(ui, 'crew.rename', { dwarfId, name, requestId: RID(1) })
    await call(ui, 'crew.rename', { dwarfId, name: `${name} ${'x'.repeat(30)}`, requestId: RID(2) })
    await call(ui, 'crew.resetName', { dwarfId, requestId: RID(3) })

    expect(log.entries.length + log.refused.length).toBeGreaterThan(0)
    expect(JSON.stringify([log.entries, log.refused])).not.toContain('Secret Seal')
  })
})
