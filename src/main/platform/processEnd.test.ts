import { describe, expect, it } from 'vitest'
import {
  buildEndProcessTreeCommand,
  buildKillProcessCommand,
  buildTerminateProcessCommand,
  createProcessEnd,
  type EndProcessCommand
} from './processEnd'

describe('buildEndProcessTreeCommand', () => {
  /*
   * Windows kills by TREE rather than by the one pid, and the reason is
   * measured rather than assumed: the launch shape is panel -> intermediary ->
   * the real program, and the program goes on to spawn its own tool processes.
   * taskkill walks the live parent/child rows at kill time, so it reaches the
   * ones no job object holds.
   */
  it('kills the whole tree on Windows, forced', () => {
    expect(buildEndProcessTreeCommand('win32', 4242)).toEqual({
      command: 'taskkill',
      args: ['/PID', '4242', '/T', '/F']
    })
  })

  /*
   * A negative pid is a PROCESS GROUP on POSIX, and the launch is detached —
   * which makes the process this panel started a group leader whose children
   * inherit that group. Signalling the group is the only way to reach the real
   * program behind the intermediary, which a plain `kill <pid>` would orphan
   * rather than end.
   */
  it('signals the process group on Linux and macOS, not the one pid', () => {
    expect(buildEndProcessTreeCommand('linux', 4242)).toEqual({
      command: 'kill',
      args: ['-TERM', '-4242']
    })
    expect(buildEndProcessTreeCommand('darwin', 77)).toEqual({
      command: 'kill',
      args: ['-TERM', '-77']
    })
  })

  /*
   * `kill -TERM -1` signals EVERY process the user owns, and 0 is "this
   * process's own group" — the panel itself. Neither may ever be built, so a
   * pid that is not a real positive one produces no command at all.
   */
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'builds no command at all for the unusable pid %s',
    (pid) => {
      expect(buildEndProcessTreeCommand('win32', pid)).toBeNull()
      expect(buildEndProcessTreeCommand('linux', pid)).toBeNull()
    }
  )
})

/**
 * The DIRECT-pid signals, beside the group form above and never replacing it
 * (#366).
 *
 * Kick's terminal tier ends a session somebody else started in their own
 * terminal. That pid leads no group of ours — it is one process inside the
 * terminal's own group — so the negative pid the launched tier signals would
 * reach a group this panel never created, or none at all. The two builders
 * therefore differ by one character and by everything: `-<pid>` is a group,
 * `<pid>` is a process.
 *
 * Windows has its own end tier (`taskkill /T`, above) and no `kill`, so both
 * answer null there rather than inventing an argv that is not true of the
 * platform — the same null a pid no command may be built for gets.
 */
describe('buildTerminateProcessCommand / buildKillProcessCommand', () => {
  it('signals the pid itself on Linux and macOS, never its group', () => {
    expect(buildTerminateProcessCommand('linux', 4242)).toEqual({
      command: 'kill',
      args: ['-TERM', '4242']
    })
    expect(buildTerminateProcessCommand('darwin', 77)).toEqual({
      command: 'kill',
      args: ['-TERM', '77']
    })
  })

  /*
   * The escalation behind a SIGTERM the CLI never acted on. Same shape, same
   * direct pid: a KILL to a group would be the group mistake twice over.
   */
  it('escalates to KILL on the same pid, on both POSIX platforms', () => {
    expect(buildKillProcessCommand('linux', 4242)).toEqual({
      command: 'kill',
      args: ['-KILL', '4242']
    })
    expect(buildKillProcessCommand('darwin', 77)).toEqual({
      command: 'kill',
      args: ['-KILL', '77']
    })
  })

  it('builds no direct signal on Windows, which ends a tree instead', () => {
    expect(buildTerminateProcessCommand('win32', 4242)).toBeNull()
    expect(buildKillProcessCommand('win32', 4242)).toBeNull()
  })

  /*
   * The same guard the group form has, and for a reason that survives losing
   * the minus sign: `kill -TERM 0` signals every process in the panel's OWN
   * group, and a negative one that slipped through would signal a group.
   */
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'builds no command at all for the unusable pid %s',
    (pid) => {
      expect(buildTerminateProcessCommand('linux', pid)).toBeNull()
      expect(buildTerminateProcessCommand('darwin', pid)).toBeNull()
      expect(buildKillProcessCommand('linux', pid)).toBeNull()
      expect(buildKillProcessCommand('darwin', pid)).toBeNull()
    }
  )

  /* The group form is what the launched tier still uses, and it is untouched. */
  it('leaves the launched tier on the process group', () => {
    expect(buildEndProcessTreeCommand('linux', 4242)).toEqual({
      command: 'kill',
      args: ['-TERM', '-4242']
    })
  })
})

describe('createProcessEnd', () => {
  function recording(outcome: 'ok' | 'fail' = 'ok') {
    const calls: EndProcessCommand[] = []
    const run = async (command: EndProcessCommand): Promise<void> => {
      calls.push(command)
      if (outcome === 'fail') throw new Error('ERROR: the process was not found.')
    }
    return { run, calls }
  }

  it('runs the platform command and reports that the tree is gone', async () => {
    const { run, calls } = recording()
    const port = createProcessEnd({ platform: 'win32', run })

    await expect(port.endProcessTree(4242)).resolves.toBe(true)
    expect(calls).toEqual([{ command: 'taskkill', args: ['/PID', '4242', '/T', '/F'] }])
  })

  /*
   * taskkill answers a pid it cannot find with exit 128, and the runner turns
   * a non-zero exit into a rejection. "It failed" is the honest verdict: the
   * caller says so rather than reporting a session ended that may still run.
   */
  it('reports a failure rather than claiming the tree is gone', async () => {
    const { run } = recording('fail')
    await expect(createProcessEnd({ platform: 'linux', run }).endProcessTree(9)).resolves.toBe(
      false
    )
  })

  it('runs nothing at all for a pid no command may be built for', async () => {
    const { run, calls } = recording()
    await expect(createProcessEnd({ platform: 'linux', run }).endProcessTree(0)).resolves.toBe(
      false
    )
    expect(calls).toEqual([])
  })

  /* The direct signals of #366, on the same runner and the same discipline. */
  it('signals one pid and reports the signal delivered', async () => {
    const { run, calls } = recording()
    const port = createProcessEnd({ platform: 'darwin', run })

    await expect(port.terminateProcess(4242)).resolves.toBe(true)
    await expect(port.killProcess(4242)).resolves.toBe(true)
    expect(calls).toEqual([
      { command: 'kill', args: ['-TERM', '4242'] },
      { command: 'kill', args: ['-KILL', '4242'] }
    ])
  })

  /*
   * `kill` exits non-zero for a pid it cannot find or may not signal, and the
   * runner turns that into a rejection. False is the honest verdict: nothing
   * was signalled, so nothing may be reported as ended.
   */
  it('reports a failure rather than claiming a signal was delivered', async () => {
    const { run } = recording('fail')
    const port = createProcessEnd({ platform: 'linux', run })
    await expect(port.terminateProcess(9)).resolves.toBe(false)
    await expect(port.killProcess(9)).resolves.toBe(false)
  })

  /*
   * Windows builds no direct signal at all, so the port answers false there
   * without running anything — an absent per-OS act stated as a verdict rather
   * than as a `kill` that does not exist.
   */
  it('signals nothing on Windows, where the end tier is the tree kill', async () => {
    const { run, calls } = recording()
    const port = createProcessEnd({ platform: 'win32', run })
    await expect(port.terminateProcess(4242)).resolves.toBe(false)
    await expect(port.killProcess(4242)).resolves.toBe(false)
    expect(calls).toEqual([])
  })
})
