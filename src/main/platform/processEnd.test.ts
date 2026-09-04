import { describe, expect, it } from 'vitest'
import { buildEndProcessTreeCommand, createProcessEnd, type EndProcessCommand } from './processEnd'

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
})
