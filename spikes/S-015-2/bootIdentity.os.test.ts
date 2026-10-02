import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  compileWindowsHelper,
  parseLoginwindowStart,
  parseWhoConsoleLogin,
  rebootVerdict,
  snapshot,
  type BootIdentity,
  type Reading,
  type Snapshot
} from './bootIdentity.ts'

/**
 * Spike S-015-2, L8 per OS (testing strategy `17` §4; ADR-015 item 4; spike register S-015-2).
 *
 * The scripted half of the spike: on each OS leg it reads every candidate source of the boot and logon identity
 * several times, asserts the sources ADR-015 item 4 names are readable without elevation and do not move within one
 * boot, and records each read's latency against the 2 000 ms bound of `16` §2.6. The transitions (restart, logout,
 * update reboot, Windows Fast Startup shutdown) cannot be scripted from inside the session they end; they are the
 * manual half in `bootIdentity.md`, using the same reader. Kept afterwards as the real half of
 * `runProcessControlContract` for `currentBootIdentity()` (later: ISSUE-019).
 *
 * Set `S0152_REPORT=<file>` to write the snapshots as JSON (the spike record's raw output).
 */

const ROUNDS = 5

/** The source per ADR-015 item 4 field that the table names for this OS (the row under test). */
const TABLE_SOURCES: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  win32: [
    'CIM Win32_OperatingSystem.LastBootUpTime (powershell)',
    'now - os.uptime() (Node, in process)',
    'token TokenStatistics.AuthenticationId (logon LUID, helper)'
  ],
  linux: ['/proc/sys/kernel/random/boot_id', 'now - os.uptime() (Node, in process)'],
  darwin: ['sysctl kern.bootsessionuuid', 'sysctl kern.boottime']
}

/** Faster candidates measured by the spike (no new dependency, no elevation). */
const CANDIDATE_SOURCES: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  win32: ['registry PrefetchParameters\\BootId (reg.exe)', 'whoami /logonid (logon SID)'],
  linux: ['/proc/stat btime'],
  // P2 found no environment or ps session source that changes at logout; these two belong to the GUI login itself.
  darwin: [
    'who console login (utmpx, to the minute)',
    'loginwindow start time (ps lstart, to the second)'
  ]
}

function readingsOf(shots: readonly Snapshot[], source: string): Reading[] {
  return shots.flatMap((shot) => shot.readings.filter((reading) => reading.source === source))
}

const shots: Snapshot[] = []
let workDir: string | null = null
let helperExe: string | null = null

describe('S-015-2: boot and logon identity sources (ADR-015 item 4)', () => {
  beforeAll(() => {
    if (process.platform === 'win32') {
      workDir = mkdtempSync(path.join(tmpdir(), 'dwarfai-s0152-'))
      helperExe = compileWindowsHelper(workDir)
    }
    for (let round = 0; round < ROUNDS; round += 1) {
      shots.push(snapshot(`os-lane round ${round + 1}`, helperExe))
    }
  }, 120000)

  afterAll(async () => {
    const reportFile = process.env['S0152_REPORT']
    if (reportFile) writeFileSync(reportFile, `${JSON.stringify(shots, null, 2)}\n`)
    // The helper image may stay locked for a moment after its process exits.
    for (let attempt = 0; attempt < 10 && workDir; attempt += 1) {
      try {
        rmSync(workDir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
  })

  it('[S-015-2, ADR-015] the item 4 boot identity sources of this OS are readable without elevation and stable within one boot', () => {
    const sources = [
      ...(TABLE_SOURCES[process.platform] ?? []),
      ...(CANDIDATE_SOURCES[process.platform] ?? [])
    ]
    expect(sources.length, `a source list exists for ${process.platform}`).toBeGreaterThan(0)
    for (const source of sources) {
      const readings = readingsOf(shots, source)
      expect(readings.length, `${source} was read ${ROUNDS} times`).toBe(ROUNDS)
      for (const reading of readings) {
        expect(reading.error, `${source} reads without error`).toBeNull()
        expect(reading.value, `${source} gives a value`).not.toBeNull()
      }
      if (readings[0]?.field === 'bootTimeMs') {
        // A boot instant derived from `now − uptime` is rounded to the second, so two reads a few milliseconds
        // apart may land on either side of a rounding edge: stable means within one second.
        const values = readings.map((reading) => Number(reading.value))
        expect(
          Math.max(...values) - Math.min(...values),
          `${source} is stable`
        ).toBeLessThanOrEqual(1000)
      } else {
        expect(new Set(readings.map((reading) => reading.value)).size, `${source} is stable`).toBe(
          1
        )
      }
    }
    if (process.platform === 'win32') {
      // `os.uptime()` is GetTickCount64 on Windows: both boot instants agree to the second.
      const uptime = readingsOf(shots, 'now - os.uptime() (Node, in process)')[0]?.value
      const ticks = readingsOf(shots, 'now - GetTickCount64(), to the second (helper)')[0]?.value
      expect(
        Math.abs(Number(uptime) - Number(ticks)),
        'os.uptime() is the tick count'
      ).toBeLessThanOrEqual(1000)
    }
  })

  it('[S-015-2] each source read latency is recorded against the 2 000 ms bound of 16 §2.6', () => {
    const sources = new Set(shots.flatMap((shot) => shot.readings.map((reading) => reading.source)))
    for (const source of sources) {
      const readings = readingsOf(shots, source)
      for (const reading of readings) {
        expect(Number.isFinite(reading.latencyMs), `${source} has a latency`).toBe(true)
      }
    }
    // The in-process read is the one that can never approach the bound.
    const inProcess = readingsOf(shots, 'now - os.uptime() (Node, in process)')
    expect(Math.max(...inProcess.map((reading) => reading.latencyMs))).toBeLessThan(2000)
  })

  it('[S-015-2, ADR-015] rules 1-4 of item 4 name the rule that catches each transition kind', () => {
    const epochStart = 1_000_000_000
    const base: BootIdentity = { bootId: 'a', bootTimeMs: epochStart - 5000, logonSessionId: 'x' }
    // Restart: a new boot id.
    expect(
      rebootVerdict(base, { ...base, bootId: 'b', bootTimeMs: epochStart + 120_000 }, epochStart)
    ).toBe('rebooted (rule 1: bootId)')
    // Sign-out and sign-in, or a Fast Startup shutdown that keeps the boot: a new logon session only.
    expect(rebootVerdict(base, { ...base, logonSessionId: 'y' }, epochStart)).toBe(
      'logged out (rule 2: logonSessionId)'
    )
    // No boot id on either side: the boot time decides, with the 60 s margin.
    const noBootId: BootIdentity = { ...base, bootId: 'unknown', logonSessionId: 'unknown' }
    expect(
      rebootVerdict(noBootId, { ...noBootId, bootTimeMs: epochStart + 61_000 }, epochStart)
    ).toBe('rebooted (rule 3: bootTimeMs after the epoch start)')
    expect(
      rebootVerdict(noBootId, { ...noBootId, bootTimeMs: epochStart + 60_000 }, epochStart)
    ).toBe('same boot (rule 4)')
    // 'unknown' never compares equal, and never counts as a change either.
    expect(rebootVerdict(base, { ...base, logonSessionId: 'unknown' }, epochStart)).toBe(
      'same boot (rule 4)'
    )
    // A Host crash while the machine kept running.
    expect(rebootVerdict(base, base, epochStart)).toBe('same boot (rule 4)')
  })
})

// The macOS logon readers' parsers are pure, so they run on every OS leg. The lines have the shape macOS 26.6.2
// printed in P2b (2026-10-02) under `LC_ALL=C` and `TZ=UTC0`, with the synthetic account `j` (uid 501).
describe('S-015-2: macOS logon source parsers (ADR-015 item 4)', () => {
  const who = [
    'k        console      Oct  2 08:02',
    'j        ttys000      Oct  2 19:21',
    'j        console      Oct  2 19:20',
    ''
  ].join('\n')

  const loginwindow = '/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow'
  const ps = [
    `    0 Fri Oct  2 19:18:20 2026     /sbin/launchd`,
    `  502 Fri Oct  2 08:02:11 2026     ${loginwindow}`,
    `  501 Fri Oct  2 19:20:51 2026     /usr/libexec/loginwindowhelper`,
    `  501 Fri Oct  2 19:20:51 2026     ${loginwindow}`,
    `  501 Fri Oct  2 19:21:03 2026     /bin/zsh`,
    ''
  ].join('\n')

  it('[S-015-2] the who console line of this user gives its login minute, and no console line gives null', () => {
    expect(parseWhoConsoleLogin(who, 'j')).toBe('Oct  2 19:20')
    expect(parseWhoConsoleLogin(who, 'k')).toBe('Oct  2 08:02')
    expect(parseWhoConsoleLogin('j        ttys000      Oct  2 19:21\n', 'j')).toBeNull()
  })

  it('[S-015-2] the loginwindow start of this uid parses as a UTC instant to the second', () => {
    expect(parseLoginwindowStart(ps, 501)).toBe(Date.UTC(2026, 9, 2, 19, 20, 51))
    expect(parseLoginwindowStart(ps, 502)).toBe(Date.UTC(2026, 9, 2, 8, 2, 11))
    expect(parseLoginwindowStart(ps, 503)).toBeNull()
  })

  it('[S-015-2] a start time printed outside the C locale is unreadable, never misparsed', () => {
    // What `ps` prints for the same instant when LC_ALL is not forced to C (es_ES here).
    expect(
      parseLoginwindowStart(`  501 vie  2 oct 19:20:51 2026     ${loginwindow}\n`, 501)
    ).toBeNull()
    expect(
      parseLoginwindowStart(`  501 Fri Oct 32 19:20:51 2026     ${loginwindow}\n`, 501)
    ).toBeNull()
  })
})
