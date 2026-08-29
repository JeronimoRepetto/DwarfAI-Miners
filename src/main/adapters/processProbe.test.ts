import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_PROBE_SCRIPT,
  buildCodexProbeCommand,
  createProcessProbe,
  parseCodexProbeOutput,
  type ProbeCommand
} from './processProbe'

describe('buildCodexProbeCommand', () => {
  it('runs the WQL script through powershell on Windows', () => {
    const probe = buildCodexProbeCommand('win32')
    expect(probe.command).toBe('powershell.exe')
    expect(probe.args).toEqual(['-NoProfile', '-Command', CODEX_PROBE_SCRIPT])
  })

  it('runs pgrep against full command lines on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const probe = buildCodexProbeCommand(platform)
      expect(probe.command).toBe('pgrep')
      // -f matches the whole command line, which is what finds a `codex`
      // started through a wrapper or an interpreter.
      expect(probe.args).toEqual(['-f', 'codex'])
    }
  })
})

describe('parseCodexProbeOutput', () => {
  it('reports a codex process when a foreign pid comes back', () => {
    expect(parseCodexProbeOutput('4321\n', 999)).toBe(true)
  })

  it('reports nothing running for empty output', () => {
    // pgrep exits 1 and prints nothing when no process matches.
    expect(parseCodexProbeOutput('', 999)).toBe(false)
    expect(parseCodexProbeOutput('   \n\n', 999)).toBe(false)
  })

  it('excludes this process, which pgrep -f can match through its own arguments', () => {
    // Same self-match class as the Windows probe (whose powershell host's
    // CommandLine contains the query text, and therefore "codex"): a
    // command line mentioning codex matches the pattern that looks for it.
    expect(parseCodexProbeOutput('999\n', 999)).toBe(false)
  })

  it('still reports running when a foreign pid accompanies this process', () => {
    expect(parseCodexProbeOutput('999\n4321\n', 999)).toBe(true)
  })

  it('ignores non-numeric noise', () => {
    expect(parseCodexProbeOutput('pgrep: illegal option\n', 999)).toBe(false)
  })
})

describe('createProcessProbe', () => {
  function record(stdout: string): {
    run: (c: ProbeCommand) => Promise<string>
    seen: ProbeCommand[]
  } {
    const seen: ProbeCommand[] = []
    return {
      seen,
      run: async (command) => {
        seen.push(command)
        return stdout
      }
    }
  }

  it('runs the platform command and reports its verdict', async () => {
    const { run, seen } = record('4321\n')
    const probe = createProcessProbe({ platform: 'linux', run, selfPid: 999 })
    expect(await probe.isCodexProcessRunning()).toBe(true)
    expect(seen).toEqual([{ command: 'pgrep', args: ['-f', 'codex'] }])
  })

  it('reports not running when the probe itself fails', async () => {
    // A missing pgrep, a denied WQL query or a timeout are all "unknown", and
    // unknown must never block a poll tick or throw out of it.
    const probe = createProcessProbe({
      platform: 'darwin',
      run: () => Promise.reject(new Error('ENOENT')),
      selfPid: 999
    })
    expect(await probe.isCodexProcessRunning()).toBe(false)
  })

  it('does not run anything until asked', async () => {
    const run = vi.fn(async () => '')
    createProcessProbe({ platform: 'win32', run, selfPid: 1 })
    expect(run).not.toHaveBeenCalled()
  })
})
