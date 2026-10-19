// layer: L2
// The stable ingress port (ADR-016 item 3; 07 S14.10; 13 FM-038; 19 §9.2 `ingress.port`): chosen
// once, persisted in `app_meta.ingress_port`, reused at every boot; a taken port is replaced by a
// new one, persisted, logged, and reported so the owned entries are rewritten through the config
// writer. The listener is a double here; the real bind is the L6 and L8 suites'.
import { describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { openIngressPort, type ListenOutcome } from './ingressPort'
import { InMemoryIngressPortRecord } from './testing/ingressHarness'

/** A listener double: the ports in `taken` are in use; port 0 gets the next free port. */
function fakeListener(taken: number[], free: number[]) {
  const attempts: number[] = []
  return {
    attempts,
    listen(port: number): Promise<ListenOutcome> {
      attempts.push(port)
      if (port === 0) return Promise.resolve({ bound: free.shift() ?? 0 })
      return Promise.resolve(taken.includes(port) ? 'taken' : { bound: port })
    }
  }
}

function setUp(persisted: number | null, taken: number[], free: number[]) {
  const record = new InMemoryIngressPortRecord(persisted)
  const log = new RecordingDiagnosticsLog()
  const listener = fakeListener(taken, free)
  const changed: number[] = []
  const open = () =>
    openIngressPort({
      record,
      log,
      listen: (port) => listener.listen(port),
      onPortChanged: (port) => void changed.push(port)
    })
  return { record, log, listener, changed, open }
}

describe('the ingress port (ADR-016 item 3)', () => {
  it('[ADR-016] the ingress port is persisted and reused at the next boot; a taken port is replaced and logged', async () => {
    // First enable: no port yet; the OS picks one and it is persisted.
    const first = setUp(null, [], [49_200])
    expect(await first.open()).toBe(49_200)
    expect(first.listener.attempts).toStrictEqual([0])
    expect(first.record.writes).toStrictEqual([49_200])
    expect(first.changed).toStrictEqual([])
    expect(first.log.entries).toStrictEqual([
      { level: 'info', event: 'ingress.port', subsystem: 'transport', outcome: 'ok' }
    ])

    // Next boot: the persisted port is reused as is; nothing is written, rewritten or logged.
    const next = setUp(49_200, [], [50_000])
    expect(await next.open()).toBe(49_200)
    expect(next.listener.attempts).toStrictEqual([49_200])
    expect(next.record.writes).toStrictEqual([])
    expect(next.changed).toStrictEqual([])
    expect(next.log.entries).toStrictEqual([])

    // A boot that finds it taken: a new port, persisted, logged, and the owned entries rewritten.
    const taken = setUp(49_200, [49_200], [50_111])
    expect(await taken.open()).toBe(50_111)
    expect(taken.listener.attempts).toStrictEqual([49_200, 0])
    expect(taken.record.writes).toStrictEqual([50_111])
    expect(taken.changed).toStrictEqual([50_111])
    expect(taken.log.entries).toStrictEqual([
      {
        level: 'info',
        event: 'ingress.port',
        subsystem: 'transport',
        outcome: 'degraded',
        causeClass: 'port-taken'
      }
    ])
  })

  it('[ADR-016] a persisted value outside 1024–65535 is never bound and is replaced', async () => {
    for (const persisted of [0, 80, 1023, 65_536, 1.5]) {
      const boot = setUp(persisted, [], [51_000])
      expect(await boot.open(), String(persisted)).toBe(51_000)
      expect(boot.listener.attempts).toStrictEqual([0])
      expect(boot.record.writes).toStrictEqual([51_000])
    }
  })
})
