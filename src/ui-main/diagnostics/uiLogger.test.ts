import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOG_CAP_BYTES, LOG_SEGMENT_BYTES, parseSegmentName } from '@dwarfai/contracts'
import { FakeClock } from './ports/fakes/FakeClock'
import { FakeLogFiles } from './ports/fakes/FakeLogFiles'
import { createUiLogger, type UiLogEntry } from './uiLogger'

const LOG_DIR = join('/', 'user-data', 'logs')
const START = Date.parse('2026-10-01T09:00:00.000Z')
/** A fixed developer sentence near the 300-character cut, so a segment fills with few records. */
const FILLER = 'the panel window finished one layout pass and stored its bounds '.repeat(4).trim()

function setup(): {
  files: FakeLogFiles
  clock: FakeClock
  log: ReturnType<typeof createUiLogger>
} {
  const files = new FakeLogFiles()
  const clock = new FakeClock(START)
  const log = createUiLogger({
    files,
    logDir: LOG_DIR,
    clock,
    appVersion: '0.20.0',
    pid: 4242,
    level: 'info'
  })
  return { files, clock, log }
}

/** Records `n` filler records, each in its own fold window so none is folded away (ADR-026 item 6). */
function fill(log: { record(e: UiLogEntry): void }, clock: FakeClock, n: number): void {
  for (let i = 0; i < n; i += 1) {
    clock.advance(60_001)
    log.record({ level: 'info', event: 'window.layout', subsystem: 'window', msg: FILLER })
  }
}

const iso = (ms: number): string => new Date(ms).toISOString()

describe('UI logger and segment writer (ADR-026 items 1–2, 6; 19 §2, §4)', () => {
  it('[ADR-026] a UI segment closes at 5 000 000 bytes and the next continues the ui- sequence', async () => {
    const { files, clock, log } = setup()
    // A segment from an earlier run of the UI: the sequence continues after it, never reuses it.
    files.seed(join(LOG_DIR, 'ui-000007.jsonl'), 1_000, iso(START - 86_400_000))
    fill(log, clock, 1)
    await log.flush()
    const first = files.textOf(join(LOG_DIR, 'ui-000008.jsonl')) ?? ''
    const lineBytes = Buffer.byteLength(first, 'utf8')
    expect(lineBytes).toBeGreaterThan(300)
    expect(JSON.parse(first)).toMatchObject({ proc: 'ui', pid: 4242, appVersion: '0.20.0' })

    fill(log, clock, Math.ceil(LOG_SEGMENT_BYTES / lineBytes) + 10)
    await log.flush()

    expect(files.names(LOG_DIR)).toEqual(['ui-000007.jsonl', 'ui-000008.jsonl', 'ui-000009.jsonl'])
    const closed = files.sizeOf(join(LOG_DIR, 'ui-000008.jsonl')) ?? 0
    expect(closed).toBeLessThanOrEqual(LOG_SEGMENT_BYTES)
    expect(closed).toBeGreaterThan(LOG_SEGMENT_BYTES - lineBytes)
    expect(files.sizeOf(join(LOG_DIR, 'ui-000009.jsonl'))).toBeGreaterThan(0)
    // Whole lines only: a record is never split across two segments.
    expect(files.textOf(join(LOG_DIR, 'ui-000008.jsonl'))?.endsWith('\n')).toBe(true)
    expect(log.counters()).toMatchObject({ failed: 0, refused: 0 })
  })

  it('[ADR-026] UI and Host segments in one folder stay at or below 100 000 000 bytes, oldest deleted first', async () => {
    const { files, clock, log } = setup()
    // The Host's closed segments, a day old and an hour apart, 95 000 000 bytes in all; one older UI segment
    // among them; and the Host's freshly opened segment, which has no first record yet.
    const seeded: { name: string; firstTs: number }[] = []
    for (let seq = 1; seq <= 19; seq += 1) {
      const name = `host-${String(seq).padStart(6, '0')}.jsonl`
      const firstTs = START - 86_400_000 + seq * 3_600_000
      files.seed(join(LOG_DIR, name), LOG_SEGMENT_BYTES, iso(firstTs))
      seeded.push({ name, firstTs })
    }
    const olderUi = { name: 'ui-000003.jsonl', firstTs: START - 86_400_000 + 5.5 * 3_600_000 }
    files.seed(join(LOG_DIR, olderUi.name), 1_000_000, iso(olderUi.firstTs))
    seeded.push(olderUi)
    files.seed(join(LOG_DIR, 'host-000020.jsonl'), 0, '')
    const oldestFirst = seeded.sort((a, b) => a.firstTs - b.firstTs).map((s) => s.name)
    expect(files.totalBytes(LOG_DIR)).toBe(96_000_000)

    // The UI writes about 12 000 000 bytes: two full segments and part of a third.
    fill(log, clock, 30_000)
    await log.flush()

    expect(files.peakBytes(LOG_DIR)).toBeLessThanOrEqual(LOG_CAP_BYTES)
    expect(files.totalBytes(LOG_DIR)).toBeLessThanOrEqual(LOG_CAP_BYTES)
    const deleted = files.deleted.map((path) => path.slice(LOG_DIR.length + 1))
    expect(deleted.length).toBeGreaterThanOrEqual(3)
    expect(deleted).toEqual(oldestFirst.slice(0, deleted.length))
    const prefixes = new Set(files.names(LOG_DIR).map((name) => parseSegmentName(name)?.prefix))
    expect(prefixes).toEqual(new Set(['host-', 'ui-']))
    expect(files.names(LOG_DIR)).toContain('host-000020.jsonl')
  })

  it('[ADR-026] a write failure drops the record, counts it and never throws', async () => {
    const { files, clock, log } = setup()
    files.failNextAppends('failed', 'throw')
    expect(() => fill(log, clock, 2)).not.toThrow()
    // Neither is a valid record: refused and counted, never thrown.
    expect(() => log.record(null as unknown as UiLogEntry)).not.toThrow()
    expect(() =>
      log.record({
        level: 'info',
        event: 'window.layout',
        subsystem: 'window',
        ts: 'x'
      } as UiLogEntry)
    ).not.toThrow()
    await log.flush()
    expect(log.counters()).toMatchObject({ written: 0, failed: 2, refused: 2 })

    clock.advance(60_001)
    log.record({ level: 'info', event: 'tray.state', subsystem: 'window', outcome: 'ok' })
    await log.flush()
    const lines = (files.textOf(join(LOG_DIR, 'ui-000001.jsonl')) ?? '')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines[0]).toMatchObject({ event: 'tray.state', proc: 'ui' })
    // 19 §9.6 `log.dropped`: written at the next successful write, one record per cause.
    const dropped = Object.fromEntries(
      lines.slice(1).map((line) => [line.causeClass, { event: line.event, count: line.count }])
    )
    expect(dropped).toEqual({
      'write-failed': { event: 'log.dropped', count: 2 },
      sensitive: { event: 'log.dropped', count: 1 },
      'field-not-allowed': { event: 'log.dropped', count: 1 }
    })
  })
})
