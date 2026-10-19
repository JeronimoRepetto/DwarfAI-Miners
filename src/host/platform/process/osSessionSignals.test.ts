import { describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import {
  osSessionSignals,
  sessionEndSources,
  type SessionEndSignal,
  type SignalEmitter
} from './osSessionSignals'

/** A `process` stand-in: the listeners registered per signal, and a way to raise one. */
class FakeSignals implements SignalEmitter {
  readonly listeners = new Map<SessionEndSignal, Array<() => void>>()

  once(signal: SessionEndSignal, listener: () => void): this {
    this.listeners.set(signal, [...(this.listeners.get(signal) ?? []), listener])
    return this
  }

  raise(signal: SessionEndSignal): void {
    const listeners = this.listeners.get(signal) ?? []
    this.listeners.delete(signal)
    for (const listener of listeners) listener()
  }
}

describe('OS session-end signals (ADR-002 D7, S12.10; R18)', () => {
  it('[S12.10] SIGTERM and SIGHUP are the session-end sources on linux and darwin, SIGHUP on win32, none of them verified yet', () => {
    const signals = (platform: NodeJS.Platform) =>
      sessionEndSources(platform).map((source) => source.signal)

    expect(signals('linux')).toEqual(['SIGTERM', 'SIGHUP'])
    expect(signals('darwin')).toEqual(['SIGTERM', 'SIGHUP'])
    expect(signals('win32')).toEqual(['SIGHUP'])
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(sessionEndSources(platform).every((source) => !source.verified)).toBe(true)
    }
  })

  it('[S12.10] the first session-end signal reports one session end and logs its UNVERIFIED source', () => {
    const emitter = new FakeSignals()
    const log = new RecordingDiagnosticsLog()
    const ends: number[] = []
    const signals = osSessionSignals({ platform: 'linux', emitter, log })
    signals.onSessionEnd(() => ends.push(1))

    expect([...emitter.listeners.keys()]).toEqual(['SIGTERM', 'SIGHUP'])
    expect(log.entries).toEqual([])

    emitter.raise('SIGHUP')
    emitter.raise('SIGTERM')

    expect(ends).toEqual([1])
    expect(log.byEvent('host.os-session-end')).toEqual([
      expect.objectContaining({
        level: 'warn',
        subsystem: 'host',
        causeClass: 'SIGHUP',
        outcome: 'degraded',
        msg: expect.stringContaining('UNVERIFIED') as string
      })
    ])
  })
})
