// L3 (17 §1.3): the `SessionTerminator` bridge (05 §4 item 1; 16 §4.2) over the crew application
// on its in-memory doubles, `FakeProcessControl` for the kernel's identity-checked tree kill, a
// scripted read of observation's recorded process identities and a recording `recordEnded`
// (ADR-014 items 1–3, 7; FM-063; NFR-PRIV-03). The real per-OS kill is the L8 case beside it.
import { describe, expect, it } from 'vitest'
import {
  PROCESS_START_TOLERANCE_MS,
  type EndOutcome,
  type ProcessIdentity
} from '../../kernel/domain/processIdentity'
import type { DwarfId, Instant, MineId, ProviderIdentity } from '../../kernel/domain/values'
import { FakeProcessControl } from '../../kernel/fakes/FakeProcessControl'
import type { ProcessControl } from '../../kernel/ports/processControl'
import { rankForDepth } from '../../modules/crew'
import { runSessionTerminatorContract } from '../../modules/crew/testing/sessionTerminator.contract'
import { inMemoryCrew } from '../../modules/crew/testing/inMemoryCrew'
import { createSessionTerminator, OBSERVED_TERM_GRACE_MS } from './sessionTerminator'

const BOOT = 'boot-0079'
const MINE = '00000000-0000-7000-8000-0000000000f1' as MineId
const OTHER_MINE = '00000000-0000-7000-8000-0000000000f2' as MineId

type KillTree = ProcessControl['killTree']

function harness(options: { killTree?: (inner: KillTree) => KillTree } = {}) {
  const crew = inMemoryCrew()
  const control = new FakeProcessControl({ bootId: BOOT })
  const kills: { target: ProcessIdentity; opts: Parameters<KillTree>[1] }[] = []
  const inner: KillTree = (target, opts) => control.killTree(target, opts)
  const killTree = options.killTree?.(inner) ?? inner
  const identities = new Map<DwarfId, ProcessIdentity>()
  const identityReads: DwarfId[] = []
  const recorded: { identity: ProviderIdentity; at: Instant }[] = []
  const terminator = createSessionTerminator({
    crew: crew.queries,
    observed: {
      processIdentityOf: (dwarfId) => {
        identityReads.push(dwarfId)
        return identities.get(dwarfId) ?? null
      }
    },
    processes: {
      killTree: (target, opts) => {
        kills.push({ target: { ...target }, opts: { ...opts } })
        return killTree(target, opts)
      }
    },
    endedLedger: {
      recordEnded: (identity, at) => {
        recorded.push({ identity: { ...identity }, at })
      }
    },
    clock: crew.clock
  })
  let sequence = 0

  /**
   * An observed dwarf in `mineId`: `identity: 'recorded'` gives it a recorded process identity
   * whose live tree (a child and a grandchild) the fake scripts; `'none'` records none.
   */
  function seat(
    input: { mineId?: MineId; customName?: string; identity?: 'recorded' | 'none' } = {}
  ): { dwarfId: DwarfId; providerIdentity: ProviderIdentity; process: ProcessIdentity | null } {
    sequence += 1
    const providerIdentity: ProviderIdentity = {
      providerId: 'claude',
      providerSessionId: `session-${sequence}`
    }
    const dwarfId = crew.commands.arrive({
      mineId: input.mineId ?? MINE,
      identity: providerIdentity,
      rank: rankForDepth(0),
      status: 'idle'
    })
    if (input.customName !== undefined) {
      const stored = crew.repository.byId(dwarfId)
      if (stored === null) throw new Error('the arrived dwarf is not stored')
      const customName = input.customName
      crew.transactionRunner.inTransaction(() => crew.repository.save({ ...stored, customName }))
    }
    if (input.identity === 'none') return { dwarfId, providerIdentity, process: null }
    const process: ProcessIdentity = {
      pid: 4_000 + sequence * 10,
      processStartTimeMs: crew.clock.now() - 60_000,
      bootId: BOOT
    }
    identities.set(dwarfId, process)
    control.scriptTree(process, {
      descendants: [
        { pid: process.pid + 1, processStartTimeMs: process.processStartTimeMs + 10, bootId: BOOT },
        { pid: process.pid + 2, processStartTimeMs: process.processStartTimeMs + 20, bootId: BOOT }
      ]
    })
    return { dwarfId, providerIdentity, process }
  }

  return { crew, control, kills, identityReads, recorded, terminator, seat }
}

describe('SessionTerminator bridge', () => {
  runSessionTerminatorContract(() => {
    const h = harness()
    return {
      terminator: h.terminator,
      seat: ({ mineId, customName }) => h.seat({ mineId, customName }).dwarfId,
      calls: () => [...h.identityReads, ...h.kills, ...h.recorded]
    }
  })

  it('[ADR-014] an observed session with a recorded identity is ended by a tree kill without the process group and answers ended after the exit', async () => {
    const h = harness()
    const { dwarfId, process } = h.seat()
    if (process === null) return expect.fail('the seated dwarf has no process identity')

    const outcome = await h.terminator.end(dwarfId, 'stop-dwarf')

    expect(outcome).toEqual({ kind: 'ended' })
    // The tree was signalled leaves first, and never as a process group (ADR-014 item 3).
    expect(h.control.signals.length).toBeGreaterThan(0)
    expect(h.control.signals.filter((s) => s.scope === 'group')).toEqual([])
    expect(h.kills).toEqual([
      { target: process, opts: { graceMs: OBSERVED_TERM_GRACE_MS, group: 'foreign' } }
    ])
    expect(h.control.signals.map((s) => s.pid)).toEqual([
      process.pid + 2,
      process.pid + 1,
      process.pid
    ])
    // `ended` only after the exit: by the time it answers, root and descendants are gone.
    for (const pid of [process.pid, process.pid + 1, process.pid + 2]) {
      expect({ pid, probed: await h.control.probe(pid) }).toEqual({ pid, probed: 'absent' })
    }
  })

  it('[FM-063] an observed session with no process identity answers failed no-identity and nothing is signalled', async () => {
    const h = harness()
    const unrecorded = h.seat({ identity: 'none' })
    const unreadable = h.seat()
    if (unreadable.process === null) return expect.fail('the seated dwarf has no process identity')
    h.control.script(unreadable.process.pid, 'unknown')

    expect(await h.terminator.end(unrecorded.dwarfId, 'remove-mine')).toEqual({
      kind: 'failed',
      reason: 'no-identity'
    })
    expect(h.kills).toEqual([])
    expect(await h.terminator.end(unreadable.dwarfId, 'remove-mine')).toEqual({
      kind: 'failed',
      reason: 'no-identity'
    })

    expect(h.control.signals).toEqual([])
    expect(h.recorded).toEqual([])
  })

  it('[ADR-014] a mismatching or absent identity answers ended with nothing signalled', async () => {
    const h = harness()
    const absent = h.seat()
    const recycled = h.seat()
    if (absent.process === null || recycled.process === null) {
      return expect.fail('the seated dwarfs have no process identity')
    }
    // The first session's process is gone; the second one's pid now names another process,
    // started later than the recorded one by more than the one tolerance (INV-51).
    h.control.script(absent.process.pid, 'absent')
    const stranger: ProcessIdentity = {
      ...recycled.process,
      processStartTimeMs: recycled.process.processStartTimeMs + PROCESS_START_TOLERANCE_MS + 1
    }
    h.control.scriptTree(stranger)

    expect(await h.terminator.end(absent.dwarfId, 'stop-dwarf')).toEqual({ kind: 'ended' })
    expect(await h.terminator.end(recycled.dwarfId, 'stop-dwarf')).toEqual({ kind: 'ended' })

    // Each recorded identity went to the kernel's check, which proved the process gone.
    expect(h.kills.map((k) => k.target)).toEqual([absent.process, recycled.process])
    expect(h.control.signals).toEqual([])
    expect(await h.control.probe(stranger.pid)).toEqual(stranger)
  })

  it('[ADR-014] an ended identity is recorded in the ended ledger', async () => {
    const h = harness()
    const ended = h.seat()
    const denied = h.seat()
    if (denied.process === null) return expect.fail('the seated dwarf has no process identity')
    h.control.scriptTree(denied.process, { access: 'denied' })
    const at = h.crew.clock.now()

    expect(await h.terminator.end(ended.dwarfId, 'remove-mine')).toEqual({ kind: 'ended' })
    expect(await h.terminator.end(denied.dwarfId, 'remove-mine')).toEqual({
      kind: 'failed',
      reason: 'access-denied'
    })

    // Only the session whose end the OS confirmed joins `ended_agents` (ADR-014 item 7).
    expect(h.recorded).toEqual([{ identity: ended.providerIdentity, at }])
  })

  it('[US-MINES-006.AC06] endAll ends every observed dwarf of the mine in parallel and reports each outcome', async () => {
    const held: (() => void)[] = []
    const h = harness({
      // Each kill waits until the test releases it, so the calls in flight show the parallelism.
      killTree: (inner) => (target, opts) =>
        new Promise<EndOutcome>((resolve) => {
          held.push(() => resolve(inner(target, opts)))
        })
    })
    const killable = h.seat()
    const unidentified = h.seat({ identity: 'none' })
    const denied = h.seat()
    const elsewhere = h.seat({ mineId: OTHER_MINE })
    if (denied.process === null || elsewhere.process === null) {
      return expect.fail('the seated dwarfs have no process identity')
    }
    h.control.scriptTree(denied.process, { access: 'denied' })

    const pending = h.terminator.endAll(MINE)
    await Promise.resolve()

    // Both identified dwarfs are being ended at once, before either kill answered.
    expect(h.kills.map((k) => k.target.pid).sort()).toEqual(
      [killable.process?.pid, denied.process.pid].sort()
    )
    for (const release of held) release()
    const outcomes = await pending

    expect(outcomes).toEqual(
      new Map<DwarfId, EndOutcome>([
        [killable.dwarfId, { kind: 'ended' }],
        [unidentified.dwarfId, { kind: 'failed', reason: 'no-identity' }],
        [denied.dwarfId, { kind: 'failed', reason: 'access-denied' }]
      ])
    )
    // The other mine's dwarf is never signalled.
    expect(h.control.signals.filter((s) => s.pid === elsewhere.process?.pid)).toEqual([])
    expect(await h.control.probe(elsewhere.process.pid)).toEqual(elsewhere.process)
  })

  it('[ADR-014] a dwarf that is not present answers ended and nothing is signalled', async () => {
    const h = harness()
    const departed = h.seat()
    h.crew.commands.sessionClosed(departed.dwarfId, 'closed-elsewhere')

    expect(await h.terminator.end(departed.dwarfId, 'stop-dwarf')).toEqual({ kind: 'ended' })
    expect(
      await h.terminator.end('00000000-0000-7000-8000-00000000dead' as DwarfId, 'stop-dwarf')
    ).toEqual({ kind: 'ended' })

    expect(h.kills).toEqual([])
    expect(h.control.signals).toEqual([])
  })

  it('[ADR-014] an owned dwarf answers failed no-identity with nothing signalled until its suppliers channel is bound', async () => {
    const h = harness()
    const owned = h.seat()
    h.crew.owned.add(owned.dwarfId)

    expect(await h.terminator.end(owned.dwarfId, 'stop-dwarf')).toEqual({
      kind: 'failed',
      reason: 'no-identity'
    })

    expect(h.kills).toEqual([])
    expect(h.control.signals).toEqual([])
    expect(h.recorded).toEqual([])
  })
})
