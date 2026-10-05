// layer: L6
// L6 (17 §1.6): the ledger frame of seam B — B-F20 `ledger.changed {mineId, totals}` (14 §2.4,
// §3.5, frozen) — projected from `LedgerTotalsChanged` (08 §0) by frames/ledger.ts. The ledger is
// the real module over its in-memory doubles (its bus refuses a publish inside a transaction,
// 16 §2.3). Every frame is checked against its 14 §3.5 strict() schema (14 §1.4). The coalescing
// case runs the frames through the real connection registry and outbound queue behind an
// in-process duplex whose client stops reading (CH-03), as the board's does.
import { describe, expect, it } from 'vitest'
import { evtFrameSchema, HOST_FRAME_SCHEMAS, type HostFrameData } from '@dwarfai/contracts'
import type { UsageObservation } from '../../kernel/domain/sharedContracts'
import type { DwarfId } from '../../kernel/domain/values'
import { inMemoryLedger } from '../../modules/ledger/testing/inMemoryLedger'
import { ConnectionRegistry } from '../connectionRegistry'
import { Outbound } from '../events/outbound'
import { FaultyDuplex } from '../testing/FaultyDuplex'
import { FrameClient } from '../testing/frameClient'
import { LEDGER_FRAMES, publishLedgerFrames } from './ledger'

const INSTALL = 1_760_000_000_000

let keys = 0

function usage(dwarfId: DwarfId, unitKey: string, inputNet: number): UsageObservation {
  keys += 1
  return {
    sourceKey: `claude:${unitKey}:${keys}`,
    unitKey,
    dwarfId,
    fidelity: 1,
    tokens: { inputNet, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    sealed: true,
    providerTime: INSTALL + 1_000,
    observedAt: INSTALL + 1_100
  }
}

describe('the ledger frame (14 §2.4 B-F20; 08 §0 LedgerTotalsChanged)', () => {
  it("[ADR-006] each credit sends ledger.changed with the mine's six material totals after the commit, coalesced per mine", async () => {
    const w = inMemoryLedger()
    w.setInstallMoment(INSTALL)
    const mineA = w.addMine('copper')
    const mineB = w.addMine('gold')
    const dwarfA = w.addDwarf(mineA, 'transcript')
    const dwarfB = w.addDwarf(mineB, 'transcript')
    const commands = w.ledger.commands

    const connections = new ConnectionRegistry()
    publishLedgerFrames({ events: w.bus, ledger: w.ledger.queries, frames: connections })
    const faults = new FaultyDuplex()
    const outbound = new Outbound(faults.host, { onDrained: () => {} })
    connections.attach({
      role: 'ui',
      clientId: 'ui-1',
      send: (name, data, seq) =>
        outbound.sendEvt({ type: 'evt', seq, epoch: 'epoch-0076', name, data }),
      end: () => Promise.resolve()
    })
    const client = new FrameClient(faults.client)

    // A stored observation (not sealed yet) sends nothing.
    commands.creditUsage({ ...usage(dwarfA, 'u-0', 1), sealed: false }, 'transcript')
    // The first credit goes out at once.
    commands.creditUsage(usage(dwarfA, 'u-1', 30_000), 'transcript')
    // The client stops reading and a frame larger than the socket's high water fills it: the next
    // frames wait in the queue, where a newer ledger.changed of the same mine replaces the waiting
    // one at the highest seq (14 §1.8).
    faults.stallReads()
    const filler = { mine: { name: 'x'.repeat(faults.host.writableHighWaterMark) } }
    connections.publishFrame('mine.changed', filler as unknown as HostFrameData['mine.changed'])
    expect(faults.host.writableNeedDrain).toBe(true)
    commands.creditUsage(usage(dwarfB, 'u-2', 100_000), 'transcript')
    commands.creditUsage(usage(dwarfA, 'u-3', 20_000), 'transcript')
    commands.creditUsage(usage(dwarfA, 'u-4', 25_000), 'transcript')
    faults.resumeReads()
    await client.settle()

    const evts = client.frames.map((frame) => evtFrameSchema.parse(frame))
    expect(evts.map((evt) => `${evt.name}#${evt.seq}`)).toEqual([
      'ledger.changed#1', // mine A after u-1
      'mine.changed#2', // the filler
      'ledger.changed#3', // mine B
      'ledger.changed#5' // mine A: #4 folded into it
    ])
    const ledgerEvts = evts.filter((evt) => evt.name === 'ledger.changed')
    for (const evt of ledgerEvts) HOST_FRAME_SCHEMAS['ledger.changed'].parse(evt.data)
    expect(ledgerEvts[0]?.data).toMatchObject({
      mineId: mineA,
      totals: { copper: { tokens: 30_000 } }
    })
    expect(ledgerEvts[1]?.data).toMatchObject({
      mineId: mineB,
      totals: { gold: { tokens: 100_000 } }
    })
    expect(ledgerEvts[2]?.data).toEqual({
      mineId: mineA,
      totals: {
        coal: { tokens: 0 },
        bronze: { tokens: 0 },
        copper: { tokens: 75_000 },
        silver: { tokens: 0 },
        gold: { tokens: 0 },
        uranium: { tokens: 0 }
      }
    })
    // Every credit produced its frame after its commit (the bus refuses an in-transaction publish).
    expect(w.bus.ofType('LedgerTotalsChanged')).toHaveLength(4)
    expect(w.bus.handlerErrors).toEqual([])
    expect(LEDGER_FRAMES).toEqual(['ledger.changed'])
    faults.close()
  })
})
