import { describe, expect, it } from 'vitest'
import {
  runProcessControlContract,
  type KillWorld,
  type ListingWorld
} from '../testing/processControl.contract'
import { FakeClock } from './FakeClock'
import { FakeProcessControl } from './FakeProcessControl'

const UNREADABLE_PID = 4242
const ABSENT_PID = 999_999
const OWN_PID = 777

describe('FakeProcessControl', () => {
  runProcessControlContract(() => {
    const control = new FakeProcessControl()
    control.script(UNREADABLE_PID, 'unknown')
    control.script(OWN_PID, { pid: OWN_PID, processStartTimeMs: 1_000, bootId: 'fake-boot' })
    let nextTreePid = 50_000
    const kill: KillWorld = {
      liveTree: ({ rootEndsOn, access }) => {
        const root = {
          pid: nextTreePid,
          processStartTimeMs: 1_790_000_000_000,
          bootId: 'fake-boot'
        }
        const child = {
          ...root,
          pid: nextTreePid + 1,
          processStartTimeMs: root.processStartTimeMs + 5
        }
        nextTreePid += 2
        control.scriptTree(root, {
          endsOn: rootEndsOn,
          ...(access === undefined ? {} : { access }),
          descendants: [child]
        })
        return Promise.resolve({ root, child })
      },
      signals: () => control.signals,
      isRunning: async (pid) => (await control.probe(pid)) !== 'absent'
    }
    let nextFolder = 0
    const listing: ListingWorld = {
      stem: 'stubcli',
      folder: () => Promise.resolve(`/work/folder-${nextFolder++}`),
      start: (cwd, kind) => {
        control.scriptProcess({ stem: kind === 'stem' ? 'stubcli' : 'other-program', cwd })
        return Promise.resolve()
      },
      sameFolder: (listed, folder) => listed === folder,
      unreadable: () => {
        const failing = new FakeProcessControl()
        failing.scriptListing('unreadable')
        return failing
      }
    }
    return {
      control,
      listing,
      ownPid: OWN_PID,
      unreadablePid: UNREADABLE_PID,
      absentPid: ABSENT_PID,
      kill,
      failingBootIdentity: () => new FakeProcessControl({ bootReads: 'failing' }),
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
