// layer: L2
import { describe, expect, it } from 'vitest'
import type { HostIdentityRecord } from '@dwarfai/contracts'
import { endHungHost, type HostSignal, type HungHostPorts, type SignalResult } from './hungHost'
import type { StartRead } from './processStart'

// L2 (17 §1.2): the identity-checked end of a hung Host (ADR-002 D9 steps 2 and 4; ADR-014 item 2; 07 S12.B13,
// S12.B14) over a scripted OS. TC-052-04.

const BOOT = '7'
const IDENTITY: HostIdentityRecord = {
  pid: 4242,
  processStartTimeMs: 1_790_000_000_000,
  bootId: BOOT,
  epoch: 'epoch-1'
}

/** A scripted OS: one process, its start time, how it reacts to each signal; every signal sent is recorded. */
class ScriptedOs {
  now = 0
  alive = true
  identity: HostIdentityRecord | null = IDENTITY
  bootId: string | null = BOOT
  start: StartRead = { kind: 'started', ms: IDENTITY.processStartTimeMs }
  /** What each signal does: exits the process at once, after `ms`, or never; or is refused. */
  onSignal: Partial<Record<HostSignal, { exitAfterMs: number } | 'never' | 'access-denied'>> = {
    SIGTERM: { exitAfterMs: 0 }
  }
  readonly signals: Array<{ pid: number; signal: HostSignal }> = []
  private exitAt: number | null = null

  ports(platform: HungHostPorts['platform'] = 'linux'): HungHostPorts {
    return {
      platform,
      readIdentity: () => Promise.resolve(this.identity),
      currentBootId: () => Promise.resolve(this.bootId),
      readStart: () => Promise.resolve(this.alive ? this.start : { kind: 'gone' }),
      signal: (pid, signal): SignalResult => {
        this.signals.push({ pid, signal })
        if (!this.alive) return 'gone'
        const reaction = this.onSignal[signal] ?? 'never'
        if (reaction === 'access-denied') return 'access-denied'
        if (reaction !== 'never') {
          const at = this.now + reaction.exitAfterMs
          this.exitAt = this.exitAt === null ? at : Math.min(this.exitAt, at)
        }
        this.tick()
        return 'sent'
      },
      isAlive: () => {
        this.tick()
        return this.alive
      },
      clock: { now: () => this.now },
      sleep: (ms) => {
        this.now += ms
        this.tick()
        return Promise.resolve()
      }
    }
  }

  private tick(): void {
    if (this.exitAt !== null && this.now >= this.exitAt) this.alive = false
  }
}

describe('endHungHost (ADR-002 D9 steps 2 and 4)', () => {
  it('[ADR-002, ADR-014] a Host whose identity file matches pid, start time within 2 000 ms and boot is ended with SIGTERM, that one pid only, and its exit is observed', async () => {
    const os = new ScriptedOs()
    os.start = { kind: 'started', ms: IDENTITY.processStartTimeMs + 2_000 }
    os.onSignal = { SIGTERM: { exitAfterMs: 300 } }

    expect(await endHungHost(os.ports())).toEqual({ outcome: 'ended' })
    expect(os.signals).toEqual([{ pid: 4242, signal: 'SIGTERM' }])
    expect(os.alive).toBe(false)
  })

  it('[ADR-002, ADR-014] a POSIX Host still alive 2 s after SIGTERM gets SIGKILL, re-checked first, and is ended once its exit is observed', async () => {
    const os = new ScriptedOs()
    os.onSignal = { SIGTERM: 'never', SIGKILL: { exitAfterMs: 100 } }

    expect(await endHungHost(os.ports('darwin'))).toEqual({ outcome: 'ended' })
    expect(os.signals).toEqual([
      { pid: 4242, signal: 'SIGTERM' },
      { pid: 4242, signal: 'SIGKILL' }
    ])
  })

  it('[ADR-002, ADR-014] on Windows the one TerminateProcess is the whole end: no second signal', async () => {
    const os = new ScriptedOs()
    os.onSignal = { SIGTERM: { exitAfterMs: 2_500 } }

    expect(await endHungHost(os.ports('win32'))).toEqual({ outcome: 'ended' })
    expect(os.signals).toEqual([{ pid: 4242, signal: 'SIGTERM' }])
  })

  it('[ADR-002, S12.B14] a missing identity file, another boot, a start time off by more than 2 000 ms, a gone pid or an unknown read signal nothing', async () => {
    const cases: Array<[string, (os: ScriptedOs) => void, string]> = [
      ['no identity file', (os) => (os.identity = null), 'identity-missing'],
      ['another boot', (os) => (os.bootId = '8'), 'identity-mismatch'],
      ['boot unknown now', (os) => (os.bootId = null), 'identity-mismatch'],
      [
        "'unknown' boot recorded",
        (os) => (os.identity = { ...IDENTITY, bootId: 'unknown' }),
        'identity-mismatch'
      ],
      [
        'start time 2 001 ms off (pid reused)',
        (os) => (os.start = { kind: 'started', ms: IDENTITY.processStartTimeMs - 2_001 }),
        'identity-mismatch'
      ],
      ['pid gone', (os) => (os.start = { kind: 'gone' }), 'identity-mismatch'],
      ['start time unknown', (os) => (os.start = { kind: 'unknown' }), 'identity-mismatch']
    ]
    for (const [name, arrange, outcome] of cases) {
      const os = new ScriptedOs()
      arrange(os)
      expect(await endHungHost(os.ports()), name).toEqual({ outcome })
      expect(os.signals, name).toEqual([])
      expect(os.alive, name).toBe(true)
    }
  })

  it('[ADR-002, S12.B14] an end the OS refuses, or a Host still alive after 5 s, is end-failed', async () => {
    const denied = new ScriptedOs()
    denied.onSignal = { SIGTERM: 'access-denied' }
    expect(await endHungHost(denied.ports())).toEqual({
      outcome: 'end-failed',
      errCode: 'access-denied'
    })

    const stubborn = new ScriptedOs()
    stubborn.onSignal = { SIGTERM: 'never', SIGKILL: 'never' }
    expect(await endHungHost(stubborn.ports())).toEqual({
      outcome: 'end-failed',
      errCode: 'still-alive'
    })
    expect(stubborn.now).toBeLessThanOrEqual(5_000 + 100)
  })
})
