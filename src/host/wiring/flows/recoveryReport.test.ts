// layer: L2
// L2 flow (17 §1.2; UC-025; ADR-015 item 5; 07 machine 16, S2.10…S2.13, S2.19, S4.20…S4.22; 05 §4
// routes of HostRecovered, RecoveryRetried, RecoveryRetryFailed, RecoveryDismissed): what a Host
// restart could not recover reaches the person as one grouped message, and the person's Retry or
// Dismiss settles it. Over the ISSUE-173 world (testing/hostRecoveryWorld.ts): a restarted Host's
// recovery pass, its report routes (`routeRecovery`) into a recording frame publisher, the snapshot
// `recovery` section, and crew's rows.
//
// TC-174-01 (machine 16 per Host epoch, INV-58) and TC-174-02 (no PO #62 toast for a listed dwarf).
import { describe, expect, it } from 'vitest'
import type { HostRecoveryReportView } from '@dwarfai/contracts'
import type { DwarfId, HostEpoch, MessageId } from '../../kernel/domain/values'
import { RESUME_SPACING_MS } from '../../modules/launching'
import { recoverySection } from '../../transport/snapshot/recoverySection'
import {
  EPOCH_B,
  hostRecoveryWorld,
  MINE,
  type Owned,
  type PublishedFrame
} from './testing/hostRecoveryWorld'

const EPOCH_C = 'epoch-174-c' as HostEpoch
const REQUEST = '01890a5d-ac96-774b-bcce-b30209917401'
const LOST = '00000000-0000-7000-8000-0000000174e1' as MessageId

const types = (published: readonly { type: string }[]) => published.map((e) => e.type)
const reportFrames = (published: readonly PublishedFrame[]) =>
  published
    .filter((f) => f.name === 'host.recovered')
    .map((f) => f.data as { report: HostRecoveryReportView })

/** A world whose restarted Host could not resume the given dwarfs; the report is offered. */
async function unrecoveredAfterRestart(
  answers: Array<'stale-ref' | 'resume-error' | 'same-id'>,
  opts: { ui?: boolean; working?: number[] } = {}
) {
  const w = hostRecoveryWorld()
  const owned: Owned[] = answers.map((_, n) =>
    w.launched(n + 1, opts.working?.includes(n + 1) === true ? 'working' : 'idle')
  )
  const host = w.restart({ ui: opts.ui ?? true })
  for (const answer of answers) {
    host.resumable.arrange(
      answer === 'same-id' ? { kind: 'same-id' } : { kind: 'rejects', reason: answer }
    )
  }
  const run = host.recovery.start()
  await run.classified
  await w.drain()
  await run.settled
  return { w, host, owned }
}

describe('Host recovery report', () => {
  it('[US-RES-009.AC03, S16.02, INV-58] unrecovered sessions produce exactly one host.recovered covering all of them and no stopped-unexpectedly toast', async () => {
    const { host, owned } = await unrecoveredAfterRestart(['stale-ref', 'resume-error'])
    const [first, second] = owned as [Owned, Owned]
    // The old processes' exits arrive after the restart: covered by this recovery, no PO #62 toast.
    for (const { dwarfId } of owned) {
      expect(
        host.launching.commands.sessionExited({ dwarfId, pendingEnd: null, present: true })
      ).toMatchObject({ crashed: false })
    }

    expect(types(host.bus.published)).toEqual(['HostRecovered'])
    expect(host.frames.published.map((f) => f.name)).toEqual(['host.recovered'])
    const [frame] = reportFrames(host.frames.published)
    expect(frame?.report).toMatchObject({
      hostEpoch: EPOCH_B,
      state: 'pending-display',
      unrecovered: [
        { dwarfId: first.dwarfId, reason: 'stale-ref' },
        { dwarfId: second.dwarfId, reason: 'resume-error' }
      ]
    })
    expect(host.frames.published.some((f) => f.name === 'toast')).toBe(false)
    // Written to the first ui connection: marked shown once (14 §4.3 rule 5; S16.04).
    expect(host.recovery.report()).toMatchObject({ state: 'shown', shownAt: expect.any(Number) })
  })

  it('[US-RES-009.AC04, INV-26] a listed dwarf stays present, idle then asleep, and does not walk out while the message shows', async () => {
    const { w, host, owned } = await unrecoveredAfterRestart(['stale-ref'])
    const [listed] = owned as [Owned]
    const departures = () => w.crew.bus.ofType('DwarfDeparted')

    expect(host.recovery.report()?.state).toBe('shown')
    expect(w.crew.queries.crewOf(MINE).map((d) => d.id)).toEqual([listed.dwarfId])
    expect(w.crew.queries.get(listed.dwarfId)).toMatchObject({
      processState: 'unrecovered',
      status: 'idle'
    })
    w.crew.clock.advance(60_001)
    expect(w.crew.queries.get(listed.dwarfId)?.status).toBe('asleep')
    // A window that closes and attaches again changes nothing for the dwarf (S16.08).
    expect(recoverySection({ recovery: host.recovery })()).toMatchObject({ state: 'shown' })
    expect(departures()).toEqual([])
    expect(w.crew.queries.crewOf(MINE).map((d) => d.id)).toEqual([listed.dwarfId])
  })

  it('[US-RES-009.AC05, S16.05, S16.06, S4.20, S4.21, FM-004] retry re-attempts the same provider session of each still-listed dwarf; a resumed one stays silently and a failed one walks out recovery-failed', async () => {
    const { w, host, owned } = await unrecoveredAfterRestart(['stale-ref', 'resume-error'])
    const [resumes, fails] = owned as [Owned, Owned]
    host.resumable.arrange({ kind: 'same-id' })
    host.resumable.arrange({ kind: 'rejects', reason: 'resume-error' })
    const callsBefore = host.resumable.calls.length
    const framesBefore = host.frames.published.length

    const answer = host.routed.retryRecovery(EPOCH_B, REQUEST)
    await w.drain()
    const result = await answer

    // The SAME provider sessions, spaced one per 500 ms, and never a new launch (S4.20).
    const retried = host.resumable.calls.slice(callsBefore)
    expect(retried.map((c) => [c.op, c.providerSessionId])).toEqual([
      ['resume', 'session-1'],
      ['resume', 'session-2']
    ])
    expect(retried[1]!.at - retried[0]!.at).toBe(RESUME_SPACING_MS)
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        hostEpoch: EPOCH_B,
        state: 'settled',
        settledAt: expect.any(Number),
        unrecovered: [],
        retryOutcomes: [
          { dwarfId: resumes.dwarfId, outcome: 'resumed' },
          { dwarfId: fails.dwarfId, outcome: 'failed' }
        ]
      })
    })
    expect(types(host.bus.published)).toEqual([
      'HostRecovered',
      'RecoveryRetried',
      'RecoveryRetryFailed'
    ])
    expect(host.bus.ofType('RecoveryRetried')[0]?.payload).toEqual({
      hostEpoch: EPOCH_B,
      requestId: REQUEST,
      dwarfIds: [resumes.dwarfId, fails.dwarfId]
    })
    // The resumed one carries on in its dwarf, silently; the failed one walks out, no toast.
    expect(host.bound.at(-1)).toEqual({
      ref: expect.objectContaining({ providerSessionId: 'session-1' }),
      dwarfId: resumes.dwarfId
    })
    expect(w.crew.bus.ofType('DwarfDeparted').map((e) => e.payload)).toEqual([
      { dwarfId: fails.dwarfId, mineId: MINE, cause: 'recovery-failed' }
    ])
    expect(w.crew.queries.crewOf(MINE).map((d) => d.id)).toEqual([resumes.dwarfId])
    expect(w.db.records.live().map((r) => r.dwarfId)).toEqual([resumes.dwarfId])
    const after = host.frames.published.slice(framesBefore)
    expect(after.some((f) => f.name === 'toast')).toBe(false)
    expect(reportFrames(after).map((f) => f.report.state)).toEqual([
      'retrying',
      'retrying',
      'settled'
    ])
    expect(w.reports.pending()).toBeNull()
    expect(host.recovery.report()).toBeNull()
  })

  it('[US-RES-009.AC06, S16.07, S4.22] dismiss walks out every dwarf still unrecovered as recovery-dismissed and keeps a dwarf whose session is running', async () => {
    // The second dwarf was mid-turn: its session resumed and it is listed turn-lost, informational.
    const { w, host, owned } = await unrecoveredAfterRestart(['stale-ref', 'same-id'], {
      working: [2]
    })
    const [stuck, running] = owned as [Owned, Owned]
    expect(host.recovery.report()?.unrecovered.map((i) => [i.dwarfId, i.reason])).toEqual([
      [stuck.dwarfId, 'stale-ref'],
      [running.dwarfId, 'turn-lost']
    ])
    const framesBefore = host.frames.published.length

    expect(host.recovery.dismissRecovery(EPOCH_B, REQUEST)).toEqual({ ok: true, value: undefined })

    expect(w.crew.bus.ofType('DwarfDeparted').map((e) => e.payload)).toEqual([
      { dwarfId: stuck.dwarfId, mineId: MINE, cause: 'recovery-dismissed' }
    ])
    expect(w.crew.queries.crewOf(MINE).map((d) => d.id)).toEqual([running.dwarfId])
    expect(w.crew.queries.get(running.dwarfId)?.processState).toBe('running')
    // The running session is never ended; the dismissed dwarf is never resumed by a later boot.
    expect(w.db.records.live().map((r) => r.dwarfId)).toEqual([running.dwarfId])
    expect(types(host.bus.published)).toEqual(['HostRecovered', 'RecoveryDismissed'])
    const after = host.frames.published.slice(framesBefore)
    expect(after.some((f) => f.name === 'toast')).toBe(false)
    expect(reportFrames(after).map((f) => f.report.state)).toEqual(['settled'])
    expect(w.reports.pending()).toBeNull()
    expect(host.recovery.report()).toBeNull()
    // A second dismissal, or one for another epoch, finds no unsettled report.
    expect(host.recovery.dismissRecovery(EPOCH_B, REQUEST)).toEqual({
      ok: false,
      error: 'no-report'
    })
  })

  it('[FM-023, S16.08] a report not acted on before the window closes is shown again at the next ui attach', async () => {
    const { host, owned } = await unrecoveredAfterRestart(['stale-ref'], { ui: false })
    const [listed] = owned as [Owned]
    // No ui was attached when the report was ready: no frame, it waits in the snapshot.
    expect(host.frames.published).toEqual([])
    const section = recoverySection({ recovery: host.recovery })

    const first = section()
    expect(first).toMatchObject({
      state: 'pending-display',
      unrecovered: [{ dwarfId: listed.dwarfId, reason: 'stale-ref' }]
    })
    // That snapshot was written to the ui connection: shown, with the instant of its first display.
    const shown = host.recovery.report()
    expect(shown).toMatchObject({ state: 'shown', shownAt: expect.any(Number) })

    // The window closes before the person acts; the next attach's snapshot carries it again.
    const again = section()
    expect(again).toMatchObject({
      state: 'shown',
      shownAt: shown?.shownAt,
      unrecovered: [{ dwarfId: listed.dwarfId, reason: 'stale-ref' }]
    })
  })

  it("[FM-023, S16.09] another Host crash before settling carries the unsettled items into the next boot's report", async () => {
    const w = hostRecoveryWorld()
    const listed = w.launched(1)
    const hostB = w.restart({
      ui: true,
      deliveries: async (dwarfIds) => new Map(dwarfIds.map((id) => [id, [LOST]]))
    })
    hostB.resumable.arrange({ kind: 'rejects', reason: 'stale-ref' })
    const runB = hostB.recovery.start()
    await runB.classified
    await w.drain()
    await runB.settled
    expect(w.reports.pending()).toMatchObject({ hostEpoch: EPOCH_B })

    // Host B crashes before the person acts; Host C boots over the same rows.
    const hostC = w.restart({ epoch: EPOCH_C, ui: true })
    hostC.resumable.arrange({ kind: 'rejects', reason: 'stale-ref' })
    const runC = hostC.recovery.start()
    await runC.classified
    await w.drain()
    const report = await runC.settled

    expect(report.unrecovered).toEqual([
      { dwarfId: listed.dwarfId, reason: 'stale-ref', messageIds: [LOST] }
    ])
    // One report per epoch, and only the newest is offered: Host B's is superseded.
    expect(w.reports.pending()).toEqual(report)
    expect(reportFrames(hostC.frames.published).map((f) => f.report.hostEpoch)).toEqual([EPOCH_C])
    await expect(hostC.routed.retryRecovery(EPOCH_B, REQUEST)).resolves.toEqual({
      ok: false,
      error: 'no-report'
    })
    expect(w.crew.queries.crewOf(MINE).map((d) => d.id)).toEqual([listed.dwarfId])
  })

  it('[ADR-015] a turn-lost item whose session resumed is informational and retry does not act on it', async () => {
    const { w, host, owned } = await unrecoveredAfterRestart(['resume-error', 'same-id'], {
      working: [2]
    })
    const [stuck, informational] = owned as [Owned, Owned]
    host.resumable.arrange({ kind: 'same-id' })
    const callsBefore = host.resumable.calls.length

    const answer = host.routed.retryRecovery(EPOCH_B, REQUEST)
    await w.drain()
    const result = await answer

    expect(host.resumable.calls.slice(callsBefore).map((c) => c.providerSessionId)).toEqual([
      'session-1'
    ])
    expect(host.bus.ofType('RecoveryRetried')[0]?.payload.dwarfIds).toEqual([stuck.dwarfId])
    expect(result).toMatchObject({
      ok: true,
      value: { state: 'settled', retryOutcomes: [{ dwarfId: stuck.dwarfId, outcome: 'resumed' }] }
    })
    expect(w.crew.bus.ofType('DwarfDeparted')).toEqual([])
    expect(w.crew.queries.get(informational.dwarfId)?.processState).toBe('running')
    expect(
      w.crew.queries
        .crewOf(MINE)
        .map((d) => d.id)
        .sort()
    ).toEqual([stuck.dwarfId, informational.dwarfId].sort() as DwarfId[])
  })
})
