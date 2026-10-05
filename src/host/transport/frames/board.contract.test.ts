// layer: L6
// L6 (17 §1.6): the board frames of seam B — B-F06 `mine.changed`, B-F08 `dwarf.arrived`, B-F09
// `dwarf.changed`, B-F10 `dwarf.departed` (14 §2.4, §3.5, §3.6, §1.8, frozen) — projected from the
// mines and crew events (08 §2.1, §2.2) by frames/board.ts. The crew is the real crew application
// over its in-memory doubles (its bus refuses a publish inside a transaction, 16 §2.3); the mines
// reads are faked. Every frame is checked against its 14 §3.5 strict() schema (14 §1.4). The
// coalescing case runs the frames through the real connection registry and outbound queue behind
// an in-process duplex whose client stops reading (CH-03).
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  evtFrameSchema,
  HOST_FRAME_SCHEMAS,
  type HostFrameData,
  type HostFrameName
} from '@dwarfai/contracts'
import type { DomainEvent } from '../../kernel/domain/domainEvent'
import type { DwarfId, EventId, MineId, ProviderIdentity } from '../../kernel/domain/values'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import type { CrewEvent } from '../../modules/crew'
import { inMemoryCrew, CREW_EPOCH } from '../../modules/crew/testing/inMemoryCrew'
import type { MinePath, MineName, MinesEvent } from '../../modules/mines'
import { ConnectionRegistry } from '../connectionRegistry'
import type { FrameAudience } from '../events/framePublisher'
import { Outbound } from '../events/outbound'
import { NO_LEDGER_TOTALS, toMineWire } from '../mappers/wire'
import { FaultyDuplex } from '../testing/FaultyDuplex'
import { FrameClient } from '../testing/frameClient'
import { BOARD_FRAMES, publishBoardFrames } from './board'
import { dwarfView, FakeCrewQueries, FakeMinesQueries, mineView } from './testing/fakeBoard'

const MINE_A = '01920000-0000-7000-8000-00000000000a' as MineId
const MINE_B = '01920000-0000-7000-8000-00000000000b' as MineId
const DWARF_A = '01920000-0000-7000-9000-00000000000a' as DwarfId
const DWARF_B = '01920000-0000-7000-9000-00000000000b' as DwarfId

interface Sent {
  name: string
  data: unknown
  audience?: FrameAudience
}

/** Records every frame the projection publishes, each checked against its 14 §3.5 schema. */
class RecordingFrames {
  readonly sent: Sent[] = []

  publishFrame<F extends HostFrameName>(
    name: F,
    data: HostFrameData[F],
    audience?: FrameAudience
  ): void {
    this.sent.push(audience === undefined ? { name, data } : { name, data, audience })
    const schemas: Readonly<Record<string, z.ZodTypeAny | undefined>> = HOST_FRAME_SCHEMAS
    schemas[name]?.parse(data)
  }

  names(): string[] {
    return this.sent.map((frame) => frame.name)
  }
}

let nextEvent = 0

function event<E extends DomainEvent<string, unknown>>(type: E['type'], payload: E['payload']): E {
  nextEvent += 1
  return {
    type,
    v: 1,
    id: `event-${nextEvent}` as EventId,
    at: 1,
    hostEpoch: CREW_EPOCH,
    payload
  } as E
}

function identity(session: string): ProviderIdentity {
  return { providerId: 'claude', providerSessionId: session }
}

/** The board over the real crew (in-memory doubles) and faked mines reads. */
function board(beforeFrames: (crew: ReturnType<typeof inMemoryCrew>) => void = () => {}) {
  const crew = inMemoryCrew()
  beforeFrames(crew)
  const mines = new FakeMinesQueries()
  let open = false
  const minesBus = new RecordingEventBus<MinesEvent>({
    transactionScope: { isInTransaction: () => open }
  })
  const frames = new RecordingFrames()
  publishBoardFrames({
    events: { mines: minesBus, crew: crew.bus },
    mines,
    crew: crew.queries,
    ledger: NO_LEDGER_TOTALS,
    frames
  })
  /** A mines command: writes the mine inside its transaction, publishes after the commit. */
  const commitMine = (view: ReturnType<typeof mineView>, published: MinesEvent): void => {
    open = true
    mines.put(view)
    expect(() => minesBus.publish(published)).toThrow(/inside a transaction/)
    open = false
    minesBus.publish(published)
  }
  const created = (mineId: MineId, name: string): MinesEvent =>
    event('MineCreated', {
      mineId,
      path: `/work/${name}` as MinePath,
      name: name as MineName,
      origin: 'observed'
    })
  return { crew, mines, minesBus, frames, commitMine, created }
}

/** Lets the current macrotask's queued microtasks run: the next Host turn. */
async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('the board frames (14 §2.4 B-F06, B-F08, B-F09, B-F10; 08 §2.1, §2.2)', () => {
  it('[US-RES-001.AC01, S2.06] an observed dwarf whose process dies on its own gets dwarf.departed closed-elsewhere and no toast frame', async () => {
    const b = board()
    b.mines.put(mineView(MINE_A, 'alpha'))
    const dwarfId = b.crew.commands.arrive({
      mineId: MINE_A,
      identity: identity('s-1'),
      rank: 'foreman',
      status: 'idle'
    })
    await nextTurn()
    const before = b.frames.sent.length

    // SessionClosedObserved with no pending end → crew `sessionClosed('closed-elsewhere')` (08 §2.3).
    b.crew.commands.sessionClosed(dwarfId, 'closed-elsewhere')

    const after = b.frames.sent.slice(before)
    expect(after).toEqual([
      {
        name: 'dwarf.departed',
        data: { dwarfId, mineId: MINE_A, cause: 'closed-elsewhere' },
        audience: { dwarfId }
      }
    ])
    // The same as any other outside closure (US-OBS-005): it walks out, and nothing is toasted.
    expect(b.frames.names()).not.toContain('toast')
    expect(b.crew.bus.handlerErrors).toEqual([])
  })

  it('[ADR-003] each board event produces its frame after the commit and dwarf.changed is coalesced to the latest per dwarf', async () => {
    const b = board()
    b.mines.put(mineView(MINE_A, 'alpha'))

    // Each frame is published by the event's handler, so before the command returns (14 §1.7
    // "effects before response"), and the crew bus publishes only after its commit (16 §2.3).
    const dwarfId = b.crew.commands.arrive({
      mineId: MINE_A,
      identity: identity('s-1'),
      rank: 'foreman',
      status: 'idle'
    })
    expect(b.frames.names()).toEqual(['dwarf.arrived'])
    expect(b.crew.transactions()).toBe(1)

    // S1.05: 60 s idle → asleep (DwarfStatusChanged).
    b.crew.clock.advance(60_000)
    expect(b.frames.names()).toEqual(['dwarf.arrived', 'dwarf.changed'])
    expect(b.frames.sent[1]?.data).toMatchObject({ dwarf: { id: dwarfId, status: 'asleep' } })

    // DwarfPresenceChanged → dwarf.changed with the dwarf as it is now.
    b.crew.bus.publish(event<CrewEvent>('DwarfPresenceChanged', { dwarfId, presence: 'present' }))
    expect(b.frames.names()).toEqual(['dwarf.arrived', 'dwarf.changed', 'dwarf.changed'])

    // DwarfRebound has no frame (08 §2.2; 14 §2.4 "No frame exists for").
    b.crew.commands.rebind(dwarfId, identity('s-1-resumed'))
    expect(b.crew.bus.ofType('DwarfRebound')).toHaveLength(1)
    expect(b.frames.names()).toHaveLength(3)

    b.crew.commands.sessionClosed(dwarfId, 'stopped')
    expect(b.frames.names()).toEqual([
      'dwarf.arrived',
      'dwarf.changed',
      'dwarf.changed',
      'dwarf.departed'
    ])
    // A departed dwarf's later change sends nothing: dwarf.departed was its last frame.
    b.crew.bus.publish(
      event<CrewEvent>('DwarfPresenceChanged', { dwarfId, presence: 'walking-out' })
    )
    expect(b.frames.names()).toHaveLength(4)
    expect(b.crew.bus.handlerErrors).toEqual([])

    // 14 §1.8: within one Host tick the outbound queue keeps only the latest dwarf.changed per
    // dwarf, at the highest seq; the projection sends each one in full, so the latest is the
    // dwarf as it is after the last change.
    const crew = new FakeCrewQueries()
    const crewBus = new RecordingEventBus<CrewEvent>()
    const connections = new ConnectionRegistry()
    publishBoardFrames({
      events: { mines: new RecordingEventBus<MinesEvent>(), crew: crewBus },
      mines: new FakeMinesQueries(),
      crew,
      ledger: NO_LEDGER_TOTALS,
      frames: connections
    })
    const faults = new FaultyDuplex()
    const outbound = new Outbound(faults.host, { onDrained: () => {} })
    connections.attach({
      role: 'ui',
      clientId: 'ui-1',
      send: (name, data, seq) =>
        outbound.sendEvt({ type: 'evt', seq, epoch: 'epoch-0082', name, data }),
      end: () => Promise.resolve()
    })
    const client = new FrameClient(faults.client)
    faults.stallReads()
    // A first frame larger than the socket's high water: the next ones wait in the queue.
    crew.put(
      dwarfView(DWARF_B, MINE_B, { customName: 'x'.repeat(faults.host.writableHighWaterMark) })
    )
    crewBus.publish(
      event<CrewEvent>('DwarfArrived', {
        dwarfId: DWARF_B,
        mineId: MINE_B,
        identity: identity('s-b'),
        rank: 'foreman',
        parentDwarfId: null,
        delegated: false,
        status: 'idle',
        baseName: 'Borin'
      })
    )
    expect(faults.host.writableNeedDrain).toBe(true)
    crew.put(dwarfView(DWARF_A, MINE_A, { status: 'working' }))
    crewBus.publish(
      event<CrewEvent>('DwarfStatusChanged', { dwarfId: DWARF_A, from: 'idle', to: 'working' })
    )
    crewBus.publish(
      event<CrewEvent>('DwarfPresenceChanged', { dwarfId: DWARF_B, presence: 'present' })
    )
    crew.put(dwarfView(DWARF_A, MINE_A, { status: 'idle' }))
    crewBus.publish(
      event<CrewEvent>('DwarfStatusChanged', { dwarfId: DWARF_A, from: 'working', to: 'idle' })
    )
    faults.resumeReads()
    await client.settle()

    const evts = client.frames.map((frame) => evtFrameSchema.parse(frame))
    for (const evt of evts) HOST_FRAME_SCHEMAS[evt.name as 'dwarf.changed'].parse(evt.data)
    expect(evts.map((evt) => `${evt.name}#${evt.seq}`)).toEqual([
      'dwarf.arrived#1',
      'dwarf.changed#3', // dwarf B
      'dwarf.changed#4' // dwarf A: #2 folded into it
    ])
    expect(evts[2]?.data).toMatchObject({ dwarf: { id: DWARF_A, status: 'idle' } })
    expect(crewBus.handlerErrors).toEqual([])
    faults.close()
  })

  it('[ADR-003] dwarf.arrived announce is true for an observed arrival in a known mine and false otherwise', async () => {
    const b = board()
    b.mines.put(mineView(MINE_A, 'alpha'))
    const announced = (): boolean[] =>
      b.frames.sent
        .filter((frame) => frame.name === 'dwarf.arrived')
        .map((frame) => (frame.data as HostFrameData['dwarf.arrived']).announce)

    // An observed session in a mine already on the board (US-OBS-002.AC07).
    b.crew.commands.arrive({
      mineId: MINE_A,
      identity: identity('s-1'),
      rank: 'foreman',
      status: 'idle'
    })
    expect(announced()).toEqual([true])
    await nextTurn()

    // An observed session in a folder that was not a mine: the mine and the dwarf appear in the
    // same Host turn (US-OBS-001; US-OBS-002.AC08), so the arrival is not announced.
    b.commitMine(mineView(MINE_B, 'beta'), b.created(MINE_B, 'beta'))
    b.crew.commands.arrive({
      mineId: MINE_B,
      identity: identity('s-2'),
      rank: 'foreman',
      status: 'working'
    })
    expect(announced()).toEqual([true, false])

    // A later observed arrival there: the mine is known by then.
    await nextTurn()
    b.crew.commands.arrive({
      mineId: MINE_B,
      identity: identity('s-3'),
      rank: 'foreman',
      status: 'idle'
    })
    expect(announced()).toEqual([true, false, true])

    expect(b.crew.bus.handlerErrors).toEqual([])

    // A dwarf DwarfAI launched (a live LaunchRecord: `owned`) is not an observed arrival, even in
    // a known mine. Launching's record exists before the arrival's frame is built.
    const launched = board((crew) =>
      crew.bus.subscribe('DwarfArrived', (arrived) => crew.owned.add(arrived.payload.dwarfId))
    )
    launched.mines.put(mineView(MINE_A, 'alpha'))
    launched.crew.commands.arrive({
      mineId: MINE_A,
      identity: identity('s-4'),
      rank: 'foreman',
      status: 'working'
    })
    expect(launched.frames.sent).toEqual([
      {
        name: 'dwarf.arrived',
        data: { dwarf: expect.objectContaining({ owned: true }), announce: false }
      }
    ])
  })

  it('[ADR-003] MineCreated and MineReattached each send mine.changed with the full MineWire after the commit', () => {
    const b = board()

    b.commitMine(mineView(MINE_A, 'alpha'), b.created(MINE_A, 'alpha'))
    const reattached = mineView(MINE_B, 'beta', {
      state: 'active',
      tier: 'gold',
      hasBeenMeasured: true,
      measuredAt: 5,
      lastUsedAt: 9
    })
    b.commitMine(
      reattached,
      event<MinesEvent>('MineReattached', { mineId: MINE_B, via: 'rediscovery' })
    )

    expect(b.frames.sent).toEqual([
      {
        name: 'mine.changed',
        data: { mine: toMineWire(mineView(MINE_A, 'alpha'), NO_LEDGER_TOTALS.totalsOf(MINE_A)) }
      },
      {
        name: 'mine.changed',
        data: { mine: toMineWire(reattached, NO_LEDGER_TOTALS.totalsOf(MINE_B)) }
      }
    ])
    expect(b.frames.sent[1]?.data).toMatchObject({
      mine: { id: MINE_B, state: 'active', tier: 'gold', hasBeenMeasured: true, lastUsedAt: 9 }
    })
    // A mine removed before its event was handled has no MineWire: nothing is sent for it.
    b.mines.put(mineView(MINE_A, 'alpha', { state: 'removed', removedAt: 10 }))
    b.minesBus.publish(event<MinesEvent>('MineReattached', { mineId: MINE_A, via: 'manual-add' }))
    expect(b.frames.sent).toHaveLength(2)
    expect(b.minesBus.handlerErrors).toEqual([])
    // 14 §1.3: the frames this projection publishes, advertised as frame:<name>.
    expect(BOARD_FRAMES).toEqual([
      'mine.changed',
      'dwarf.arrived',
      'dwarf.changed',
      'dwarf.departed'
    ])
  })
})
