// L1: the console rule of ADR-031 item 1 (v1 values) and the use case over the ConsoleResolver port.
import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type { DwarfId } from '../../../kernel/domain/values'
import type { ConsoleResolver, ConsoleTarget } from '../ports/consoleResolver'
import { consolePlan, consoleSessionOf, createResolveConsole } from './resolveConsole'

const DWARF = '01920000-0000-7000-9000-0000000000d1' as DwarfId
const PROCESS: ProcessIdentity = {
  pid: 4242,
  processStartTimeMs: 1_700_000_000_000,
  bootId: 'boot-1'
}

describe('consolePlan', () => {
  it('[ADR-031, S-031-1, S-031-3] a launched dwarf plans the log view, also with a process identity', () => {
    expect(consolePlan({ owned: true, process: null })).toEqual({ mode: 'log' })
    expect(consolePlan({ owned: true, process: PROCESS })).toEqual({ mode: 'log' })
  })

  it('[ADR-031] an observed dwarf with a recorded process identity plans focus first', () => {
    expect(consolePlan({ owned: false, process: PROCESS })).toEqual({
      mode: 'focus-terminal',
      focus: PROCESS
    })
  })

  it('[ADR-031] an observed dwarf with no process identity plans the log view', () => {
    expect(consolePlan({ owned: false, process: null })).toEqual({ mode: 'log' })
  })

  it('[ADR-031] a dwarf the Host does not know still plans the log view, never no console', () => {
    expect(consolePlan(null)).toEqual({ mode: 'log' })
  })
})

describe('consoleSessionOf', () => {
  it('[ADR-031] a dwarf with a live launch record or bound through a driver is launched, and observation is not asked', () => {
    let asked = 0
    const observed = () => {
      asked += 1
      return PROCESS
    }

    expect(consoleSessionOf({ owned: true, usagePath: 'transcript' }, observed)).toEqual({
      owned: true,
      process: null
    })
    expect(consoleSessionOf({ owned: false, usagePath: 'driver' }, observed)).toEqual({
      owned: true,
      process: null
    })
    expect(asked).toBe(0)
  })

  it('[ADR-031, ADR-014] an observed dwarf carries the process identity observation recorded', () => {
    expect(consoleSessionOf({ owned: false, usagePath: 'transcript' }, () => PROCESS)).toEqual({
      owned: false,
      process: PROCESS
    })
    expect(consoleSessionOf({ owned: false, usagePath: 'transcript' }, () => null)).toEqual({
      owned: false,
      process: null
    })
  })

  it('[ADR-031] a dwarf crew does not know has no session', () => {
    expect(consoleSessionOf(null, () => PROCESS)).toBeNull()
  })
})

describe('resolveConsole', () => {
  it('[ADR-031] resolveConsole answers the target the ConsoleResolver resolved for that dwarf', async () => {
    const asked: DwarfId[] = []
    const target: ConsoleTarget = {
      mode: 'log',
      command: {
        program: '/app/dwarfai',
        args: ['/app/viewer.js', '/data/run/viewers/v.token'],
        cwd: '/data'
      },
      credentialFile: '/data/run/viewers/v.token'
    }
    const resolver: ConsoleResolver = {
      targetFor: (dwarfId) => {
        asked.push(dwarfId)
        return Promise.resolve(target)
      }
    }

    expect(await createResolveConsole({ resolver }).resolveConsole(DWARF)).toEqual(target)
    expect(asked).toEqual([DWARF])
  })
})
