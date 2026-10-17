import { describe, expect, it } from 'vitest'
import type { PreviousEpochEnd } from '../../../kernel/domain/bootIdentity'
import type { ProbeResult, ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type { DwarfId, LaunchId } from '../../../kernel/domain/values'
import { reconcileOnBoot, type OwnedRecordFacts } from './reconcileOnBoot'

const DWARF = '00000000-0000-7000-8000-0000000173d1' as DwarfId
const OTHER = '00000000-0000-7000-8000-0000000173d2' as DwarfId
const LAUNCH = '00000000-0000-7000-8000-0000000173a1' as LaunchId
const PROCESS: ProcessIdentity = { pid: 4_242, processStartTimeMs: 1_790_000_000_000, bootId: 'b1' }

const CRASHED: PreviousEpochEnd = { kind: 'crashed', rule: 'none' }

function record(over: Partial<OwnedRecordFacts> = {}): OwnedRecordFacts {
  return {
    dwarfId: DWARF,
    process: PROCESS,
    serverKind: false,
    resumeIntent: true,
    canResume: true,
    canAdopt: false,
    turnActive: false,
    ...over
  }
}

function probes(answer: ProbeResult): Map<number, ProbeResult> {
  return new Map([[PROCESS.pid, answer]])
}

const ALIVE = probes({ ...PROCESS })
const GONE = probes('absent')

describe('reconcileOnBoot (ADR-015 item 4)', () => {
  it('[S4.24, FM-110] a different boot id, a different logon session, or a boot time later than the epoch start ends every owned record with no resume, no report item and no toast', () => {
    const ends: PreviousEpochEnd[] = [
      { kind: 'rebooted', rule: 'boot-id' },
      { kind: 'logged-out', rule: 'logon-session' },
      { kind: 'rebooted', rule: 'boot-time' }
    ]
    for (const boot of ends) {
      const result = reconcileOnBoot({
        boot,
        records: [record(), record({ dwarfId: OTHER, process: undefined })],
        probes: ALIVE,
        inFlight: [{ launchId: LAUNCH, evidence: DWARF }]
      })
      expect(result.records).toEqual([
        { t: 'ended-while-closed', dwarfId: DWARF },
        { t: 'ended-while-closed', dwarfId: OTHER }
      ])
      expect(result.launches).toEqual([{ t: 'lost', launchId: LAUNCH }])
    }
    // A marker `os-session-end` ends a session whose process is gone the same way, and a live one
    // (a cancelled OS shutdown) follows the crash rows.
    const sessionEnd: PreviousEpochEnd = {
      kind: 'clean',
      rule: 'os-session-end',
      cleanReason: 'os-session-end'
    }
    const run = (answer: Map<number, ProbeResult>) =>
      reconcileOnBoot({ boot: sessionEnd, records: [record()], probes: answer, inFlight: [] })
    expect(run(GONE).records).toEqual([{ t: 'ended-while-closed', dwarfId: DWARF }])
    expect(run(ALIVE).records[0]?.t).toBe('end-survivor')
  })

  it('[S4.13, INV-56] an owned stdio session whose process identity is alive is ended before it is resumed', () => {
    const result = reconcileOnBoot({
      boot: CRASHED,
      records: [record()],
      probes: ALIVE,
      inFlight: []
    })
    expect(result.records).toEqual([
      { t: 'end-survivor', dwarfId: DWARF, process: PROCESS, then: 'resume', turnLost: false }
    ])
    const noResume = reconcileOnBoot({
      boot: CRASHED,
      records: [record({ canResume: false })],
      probes: ALIVE,
      inFlight: []
    })
    expect(noResume.records).toEqual([
      { t: 'end-survivor', dwarfId: DWARF, process: PROCESS, then: 'no-resume', turnLost: false }
    ])
  })

  it('[INV-51, CH-10] a process whose start time differs by more than 2 000 ms, or whose probe does not answer, is not the recorded process', () => {
    const answers: ProbeResult[] = [
      { ...PROCESS, processStartTimeMs: PROCESS.processStartTimeMs + 2_001 },
      { ...PROCESS, processStartTimeMs: PROCESS.processStartTimeMs - 2_001 },
      { ...PROCESS, bootId: 'b2' },
      'unknown',
      'absent'
    ]
    for (const answer of answers) {
      const result = reconcileOnBoot({
        boot: CRASHED,
        records: [record()],
        probes: probes(answer),
        inFlight: []
      })
      expect(result.records).toEqual([{ t: 'resume', dwarfId: DWARF, turnLost: false }])
    }
    // At the boundary it is the same process.
    const within = reconcileOnBoot({
      boot: CRASHED,
      records: [record()],
      probes: probes({ ...PROCESS, processStartTimeMs: PROCESS.processStartTimeMs + 2_000 }),
      inFlight: []
    })
    expect(within.records[0]?.t).toBe('end-survivor')
  })

  it('[S4.16] a gone process of the same boot with resume intent is resumed by its stored provider session id', () => {
    for (const boot of [
      CRASHED,
      { kind: 'clean', rule: 'none', cleanReason: 'upgrade' } as PreviousEpochEnd
    ]) {
      const result = reconcileOnBoot({ boot, records: [record()], probes: GONE, inFlight: [] })
      expect(result.records).toEqual([{ t: 'resume', dwarfId: DWARF, turnLost: false }])
    }
    const noIdentity = reconcileOnBoot({
      boot: CRASHED,
      records: [record({ process: undefined, turnActive: true })],
      probes: GONE,
      inFlight: []
    })
    expect(noIdentity.records).toEqual([{ t: 'resume', dwarfId: DWARF, turnLost: true }])
  })

  it('[S4.17, FM-003] a session with resume none is unrecovered with reason no-resume', () => {
    const result = reconcileOnBoot({
      boot: CRASHED,
      records: [record({ canResume: false })],
      probes: GONE,
      inFlight: []
    })
    expect(result.records).toEqual([{ t: 'unrecovered', dwarfId: DWARF, reason: 'no-resume' }])
  })

  it('[S5.22, S5.23, NFR-PERS-05, FM-015] an in-flight launch with session evidence succeeds and without it ends lost', () => {
    const other = '00000000-0000-7000-8000-0000000173a2' as LaunchId
    const result = reconcileOnBoot({
      boot: CRASHED,
      records: [],
      probes: new Map(),
      inFlight: [
        { launchId: LAUNCH, evidence: DWARF },
        { launchId: other, evidence: null }
      ]
    })
    expect(result.launches).toEqual([
      { t: 'succeeded', launchId: LAUNCH, dwarfId: DWARF },
      { t: 'lost', launchId: other }
    ])
  })

  it('[S4.23] a record whose resume intent stop-all cleared is not resumed', () => {
    for (const answer of [GONE, ALIVE]) {
      const result = reconcileOnBoot({
        boot: { kind: 'clean', rule: 'none', cleanReason: 'stop-all' },
        records: [record({ resumeIntent: false })],
        probes: answer,
        inFlight: []
      })
      expect(result.records).toEqual([{ t: 'not-resumed', dwarfId: DWARF }])
    }
  })

  it('[S4.12, FM-079] a server-kind session whose adopt answers null or fails falls back to resume by its provider session id', () => {
    const server = record({ serverKind: true, canAdopt: true, turnActive: true })
    const result = reconcileOnBoot({
      boot: CRASHED,
      records: [server],
      probes: ALIVE,
      inFlight: []
    })
    expect(result.records).toEqual([
      { t: 'adopt', dwarfId: DWARF, process: PROCESS, then: 'resume', turnLost: false }
    ])
    // Without `adopt` (Codex in v1, O-15-11) a live server-kind process is ended, then resumed.
    const noAdopt = reconcileOnBoot({
      boot: CRASHED,
      records: [record({ serverKind: true, canAdopt: false })],
      probes: ALIVE,
      inFlight: []
    })
    expect(noAdopt.records[0]).toMatchObject({ t: 'end-survivor', then: 'resume' })
  })
})
