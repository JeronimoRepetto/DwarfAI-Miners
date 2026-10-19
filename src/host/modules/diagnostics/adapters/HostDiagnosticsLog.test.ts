import { describe, expect, it } from 'vitest'
import { LOG_CAP_BYTES, LOG_SEGMENT_BYTES } from '../../../../contracts/logging'
import type { Result } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import type { DiagnosticEntry } from '../../../kernel/ports/diagnosticsLog'
import type { FsError } from '../../../kernel/ports/fileSystem'
import { FakeLogDirectory } from '../ports/fakes/FakeLogDirectory'
import { FsSegmentWriter } from './FsSegmentWriter'
import { HostDiagnosticsLog, logLevelFromEnv, type HostLogLevel } from './HostDiagnosticsLog'
import { runDiagnosticsLogContract } from '../../../kernel/testing/diagnosticsLog.contract'

const LOGS = '/userData/logs'
const START = Date.parse('2026-10-02T09:00:00.000Z')
/** Past the 60 s fold window, so consecutive identical records are all written (ADR-026 item 6). */
const PAST_FOLD_WINDOW = 60_001

/** A FakeFs that remembers the largest `logs/` total it ever held, measured after every append. */
class MeteredFs extends FakeFs {
  maxTotal = 0
  override async appendFile(
    path: string,
    data: Uint8Array | string
  ): Promise<Result<void, FsError>> {
    const result = await super.appendFile(path, data)
    this.maxTotal = Math.max(this.maxTotal, totalOf(this))
    return result
  }
}

function totalOf(fs: FakeFs): number {
  return (fs.entriesNow(LOGS) ?? []).reduce((sum, entry) => sum + entry.size, 0)
}

function setup(level: HostLogLevel = 'info', fs: FakeFs = new FakeFs()) {
  const clock = new FakeClock(START)
  const directory = new FakeLogDirectory(fs, LOGS)
  const log = new HostDiagnosticsLog({
    fs,
    directory,
    logDir: LOGS,
    clock,
    appVersion: '0.20.0',
    level,
    pid: 4242
  })
  return { fs, clock, directory, log }
}

function segmentNames(fs: FakeFs): string[] {
  return (fs.entriesNow(LOGS) ?? []).map((entry) => entry.name).sort()
}

async function linesOf(fs: FakeFs, name: string): Promise<Record<string, unknown>[]> {
  const read = await fs.readFile(`${LOGS}/${name}`)
  if (!read.ok) return []
  return new TextDecoder()
    .decode(read.value)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function allLines(fs: FakeFs): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = []
  for (const name of segmentNames(fs)) lines.push(...(await linesOf(fs, name)))
  return lines
}

/** About 1 KB per line: ten DwarfAI frames, each kept by the bounded `stack` (ADR-026 item 5). */
const BULKY_STACK = Array.from(
  { length: 10 },
  (_, i) =>
    `    at launchStep${i}_padding_padding (out/host/modules/launching/application/step${i}.js:1${i}:7)`
).join('\n')

const bulky = (i: number): DiagnosticEntry => ({
  level: 'error',
  event: 'uncaught',
  subsystem: 'launching',
  errCode: `E${i}`,
  stack: `Error: boom\n${BULKY_STACK}`
})

/** A segment of `bytes` bytes whose first record carries `firstTs`, as another writer left it. */
function seededSegment(firstTs: string, bytes: number): string {
  const head = `{"ts":"${firstTs}","level":"info","proc":"ui","pid":1,"appVersion":"0.20.0","event":"ui.start","subsystem":"window"}\n`
  return head + 'x'.repeat(bytes - head.length - 1) + '\n'
}

describe('HostDiagnosticsLog over FakeFs (ADR-026, 16 §3 DiagnosticsLog)', () => {
  it('[ADR-026] a segment closes at 5 000 000 bytes and the next one continues the host- sequence', async () => {
    const { fs, clock, log } = setup()
    fs.addFile(`${LOGS}/host-000007.jsonl`, seededSegment('2026-10-01T00:00:00.000Z', 2_000))
    fs.addFile(`${LOGS}/ui-000031.jsonl`, seededSegment('2026-10-01T00:00:01.000Z', 2_000))

    let i = 0
    while (!segmentNames(fs).includes('host-000009.jsonl') && i < 20_000) {
      log.record(bulky(i++))
      clock.advance(PAST_FOLD_WINDOW)
      if (i % 500 === 0) await log.flush()
    }
    await log.flush()

    const sizes = new Map((fs.entriesNow(LOGS) ?? []).map((e) => [e.name, e.size]))
    expect(sizes.get('host-000009.jsonl') ?? 0).toBeGreaterThan(0)
    const closed = sizes.get('host-000008.jsonl') ?? 0
    // The largest line of the new segment: the line that no longer fitted is one of them.
    const lineBytes = Math.max(
      ...(await linesOf(fs, 'host-000009.jsonl')).map(
        (line) => Buffer.byteLength(JSON.stringify(line)) + 1
      )
    )
    expect(closed).toBeLessThanOrEqual(LOG_SEGMENT_BYTES)
    expect(closed + lineBytes).toBeGreaterThan(LOG_SEGMENT_BYTES)
    expect(sizes.get('host-000007.jsonl')).toBe(2_000)
    expect(segmentNames(fs).filter((n) => n.startsWith('ui-'))).toEqual(['ui-000031.jsonl'])
    for (const [name, size] of sizes) expect(size, name).toBeLessThanOrEqual(LOG_SEGMENT_BYTES)
  })

  it('[ADR-026] two writers (host- and ui- segments) over one fake folder keep the total at or below 100 000 000 bytes and delete oldest first', async () => {
    const fs = new MeteredFs()
    // Twenty old segments of both prefixes, interleaved by first-record time: 99 800 000 bytes.
    const oldestFirst: string[] = []
    for (let k = 0; k < 20; k += 1) {
      const name =
        k % 2 === 0
          ? `ui-${String(k + 1).padStart(6, '0')}.jsonl`
          : `host-${String(k + 1).padStart(6, '0')}.jsonl`
      const ts = new Date(Date.parse('2026-09-01T00:00:00.000Z') + k * 3_600_000).toISOString()
      fs.addFile(`${LOGS}/${name}`, seededSegment(ts, 4_990_000))
      oldestFirst.push(name)
    }
    const { clock, log } = setup('info', fs)
    const ui = new FsSegmentWriter({
      fs,
      directory: new FakeLogDirectory(fs, LOGS),
      dir: LOGS,
      prefix: 'ui-'
    })
    const uiLine = `${JSON.stringify({ ts: '2026-10-02T09:00:00.000Z', pad: 'u'.repeat(65_000) })}\n`

    let i = 0
    for (let round = 0; round < 40; round += 1) {
      for (let r = 0; r < 300; r += 1) {
        log.record(bulky(i++))
        clock.advance(PAST_FOLD_WINDOW)
      }
      await log.flush()
      for (let u = 0; u < 5; u += 1) expect((await ui.append(uiLine)).ok).toBe(true)
    }

    expect(fs.maxTotal).toBeLessThanOrEqual(LOG_CAP_BYTES)
    const remaining = new Set(segmentNames(fs))
    const deleted = oldestFirst.filter((name) => !remaining.has(name))
    expect(deleted).toEqual(oldestFirst.slice(0, deleted.length))
    expect(deleted.some((n) => n.startsWith('host-'))).toBe(true)
    expect(deleted.some((n) => n.startsWith('ui-'))).toBe(true)
    expect(log.counters().failed).toBe(0)
  })

  it('[FM-108, CH-06] a write failure drops the record, counts it, never throws, and log.dropped is written at the next successful write', async () => {
    const { fs, clock, log } = setup()
    log.record({ level: 'info', event: 'host.start', subsystem: 'host', outcome: 'ok' })
    await log.flush()
    const segment = `${LOGS}/host-000001.jsonl`
    fs.scriptFault(segment, 'ENOSPC')

    clock.advance(1)
    expect(() =>
      log.record({
        level: 'warn',
        event: 'launch.failed',
        subsystem: 'launching',
        causeClass: 'exited-at-once'
      })
    ).not.toThrow()
    await expect(log.flush()).resolves.toBeUndefined()
    expect(log.counters()).toMatchObject({ written: 1, failed: 1 })

    fs.clearFault(segment)
    clock.advance(1)
    log.record({ level: 'info', event: 'host.ready', subsystem: 'host' })
    await log.flush()

    const lines = await allLines(fs)
    expect(lines.map((l) => l.event)).toEqual(['host.start', 'host.ready', 'log.dropped'])
    expect(lines[2]).toMatchObject({
      level: 'warn',
      proc: 'host',
      subsystem: 'diagnostics',
      causeClass: 'write-failed',
      count: 1
    })
    expect(lines.some((l) => l.event === 'launch.failed')).toBe(false)

    // A FileSystem that throws instead of returning a typed failure is contained the same way.
    const thrower = new FakeFs()
    const { log: guarded } = setup('info', thrower)
    thrower.appendFile = () => {
      throw new Error('adapter defect')
    }
    expect(() =>
      guarded.record({ level: 'info', event: 'host.start', subsystem: 'host' })
    ).not.toThrow()
    await expect(guarded.flush()).resolves.toBeUndefined()
    expect(guarded.counters()).toMatchObject({ written: 0, failed: 1 })
  })

  it('[FM-108] a deleted logs folder is recreated when the next segment opens', async () => {
    const { fs, clock, log } = setup()
    log.record({ level: 'info', event: 'host.start', subsystem: 'host' })
    await log.flush()
    expect(segmentNames(fs)).toEqual(['host-000001.jsonl'])

    fs.removeDir(LOGS)
    await expect(fs.exists(LOGS)).resolves.toBe(false)

    clock.advance(1)
    log.record({ level: 'info', event: 'host.ready', subsystem: 'host' })
    await log.flush()

    await expect(fs.stat(LOGS)).resolves.toMatchObject({ isDirectory: true })
    expect(segmentNames(fs)).toEqual(['host-000002.jsonl'])
    expect((await linesOf(fs, 'host-000002.jsonl')).map((l) => l.event)).toEqual(['host.ready'])
  })

  it('[ADR-026] a debug record is written only when DWARFAI_LOG=debug', async () => {
    const debugEntry: DiagnosticEntry = {
      level: 'debug',
      event: 'attention.decision',
      subsystem: 'attention'
    }
    const infoEntry: DiagnosticEntry = { level: 'info', event: 'host.start', subsystem: 'host' }

    expect(logLevelFromEnv({})).toBe('info')
    expect(logLevelFromEnv({ DWARFAI_LOG: 'info' })).toBe('info')
    expect(logLevelFromEnv({ DWARFAI_LOG: 'debug' })).toBe('debug')

    const quiet = setup(logLevelFromEnv({}))
    quiet.log.record(debugEntry)
    quiet.log.record(infoEntry)
    await quiet.log.flush()
    expect((await allLines(quiet.fs)).map((l) => l.event)).toEqual(['host.start'])

    const verbose = setup(logLevelFromEnv({ DWARFAI_LOG: 'debug' }))
    verbose.log.record(debugEntry)
    verbose.log.record(infoEntry)
    await verbose.log.flush()
    expect((await allLines(verbose.fs)).map((l) => l.event)).toEqual([
      'attention.decision',
      'host.start'
    ])
  })

  it('[ADR-026, NFR-SEC-12] a record holding a forbidden field or a sensitive value is not written, is counted, and the caller sees no error', async () => {
    const { fs, log } = setup()
    const refused: unknown[] = [
      { level: 'warn', event: 'launch.failed', subsystem: 'launching', prompt: 'hello' },
      {
        level: 'warn',
        event: 'launch.failed',
        subsystem: 'launching',
        ts: '2026-01-01T00:00:00.000Z'
      },
      { level: 'warn', event: 'launch.failed', subsystem: 'launching', proc: 'ui' },
      { level: 'warn', event: 'launch.failed', subsystem: 'launching', dwarfId: 'Thorin' },
      {
        level: 'warn',
        event: 'launch.failed',
        subsystem: 'launching',
        causeClass: 'provider said: no'
      },
      { level: 'warn', event: 'launch.failed', subsystem: 'launching', msg: 'line one\nline two' },
      { level: 'warn', event: 'launch.failed', subsystem: 'launching', data: { text: 'x' } }
    ]
    for (const entry of refused) {
      expect(() => log.record(entry as DiagnosticEntry)).not.toThrow()
    }
    await log.flush()
    expect(log.counters()).toMatchObject({ written: 0, refused: refused.length })
    expect(await allLines(fs)).toEqual([])

    log.record({ level: 'info', event: 'host.ready', subsystem: 'host' })
    await log.flush()
    const lines = await allLines(fs)
    expect(lines[0]).toMatchObject({
      event: 'host.ready',
      proc: 'host',
      pid: 4242,
      appVersion: '0.20.0'
    })
    expect(
      lines
        .slice(1)
        .map((l) => [l.event, l.causeClass])
        .sort()
    ).toEqual([
      ['log.dropped', 'field-not-allowed'],
      ['log.dropped', 'sensitive']
    ])
    expect(lines.slice(1).reduce((sum, l) => sum + (l.count as number), 0)).toBe(refused.length)
  })
})

runDiagnosticsLogContract(() => {
  const { fs, log } = setup()
  return {
    log,
    async kept() {
      await log.flush()
      return (await allLines(fs)).map(({ level, event, subsystem }) => ({
        level,
        event,
        subsystem
      }))
    }
  }
})
