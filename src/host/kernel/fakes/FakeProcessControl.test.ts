import { describe, expect, it } from 'vitest'
import { runProcessControlContract } from '../testing/processControl.contract'
import { FakeClock } from './FakeClock'
import { FakeProcessControl } from './FakeProcessControl'

const UNREADABLE_PID = 4242
const ABSENT_PID = 999_999

describe('FakeProcessControl', () => {
  runProcessControlContract(() => {
    const control = new FakeProcessControl()
    control.script(UNREADABLE_PID, 'unknown')
    return {
      control,
      unreadablePid: UNREADABLE_PID,
      absentPid: ABSENT_PID,
      echoSpec: (args, env) => ({
        executable: 'echo-target',
        args,
        env,
        cwd: '/work',
        processGroup: 'inherit',
        stdio: 'pipe'
      }),
      received: () => {
        const last = control.spawns.at(-1)
        if (last === undefined) throw new Error('nothing was spawned')
        return Promise.resolve({ args: last.args, env: last.env })
      },
      osAddedEnv: [],
      // The fake has no environment of its own to leak: every child gets exactly the spec's env.
      setParentVariable: () => () => {},
      dispose: () => Promise.resolve()
    }
  })

  it('[ADR-014] a spawned fake process probes as its identity until it exits, then absent', async () => {
    const clock = new FakeClock(1_790_000_000_000)
    const control = new FakeProcessControl({ bootId: 'boot-a', clock, firstPid: 100 })

    const child = control.spawn({
      executable: 'sleeper',
      args: [],
      env: {},
      cwd: '/work',
      processGroup: 'own',
      stdio: 'pipe'
    })
    const identity = await child.identity

    expect(identity).toEqual({ pid: 100, processStartTimeMs: 1_790_000_000_000, bootId: 'boot-a' })
    expect(await control.probe(100)).toEqual(identity)
    expect(child.stdin).not.toBeNull()
    expect(child.stdout).not.toBeNull()

    control.exit(100, { code: null, signal: 'SIGTERM' })

    expect(await child.exited).toEqual({ code: null, signal: 'SIGTERM' })
    expect(await control.probe(100)).toBe('absent')
  })

  it('[INV-59] the recording spawner keeps executable, argv, env, cwd, processGroup and stdio of every spawn', () => {
    const control = new FakeProcessControl()
    const args = ['--flag', 'a & b']
    const env = { ONLY: '1' }

    const child = control.spawn({
      executable: 'tool',
      args,
      env,
      cwd: '/w',
      processGroup: 'inherit',
      stdio: 'ignore'
    })
    args.push('mutated later')

    expect(control.spawns).toEqual([
      {
        executable: 'tool',
        args: ['--flag', 'a & b'],
        env: { ONLY: '1' },
        cwd: '/w',
        processGroup: 'inherit',
        stdio: 'ignore'
      }
    ])
    expect(child.stdin).toBeNull()
    expect(child.stdout).toBeNull()
    expect(child.stderr).toBeNull()
  })
})
