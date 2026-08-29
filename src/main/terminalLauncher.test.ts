import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildFallbackArgs,
  buildWtArgs,
  launchTranscriptViewer,
  resolveViewerScriptPath,
  type SpawnFn,
  type SpawnedProcess
} from './terminalLauncher'

describe('resolveViewerScriptPath', () => {
  it('resolves inside process.resourcesPath once packaged', () => {
    const result = resolveViewerScriptPath({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\DwarfAI-Miners\\resources',
      appPath: 'C:\\Program Files\\DwarfAI-Miners\\resources\\app.asar'
    })
    expect(result).toBe(
      join('C:\\Program Files\\DwarfAI-Miners\\resources', 'dwarf-feed-viewer.ps1')
    )
  })

  it('resolves next to the project resources dir in dev', () => {
    const result = resolveViewerScriptPath({
      isPackaged: false,
      resourcesPath: '',
      appPath: 'C:\\Users\\jeron\\Desktop\\AI-Tools\\agent-name'
    })
    expect(result).toBe(
      join('C:\\Users\\jeron\\Desktop\\AI-Tools\\agent-name', 'resources', 'dwarf-feed-viewer.ps1')
    )
  })
})

describe('buildWtArgs', () => {
  it('opens a titled new tab running the viewer script against the transcript', () => {
    const args = buildWtArgs(
      'Foreman',
      'C:\\app\\resources\\dwarf-feed-viewer.ps1',
      'C:\\logs\\session.jsonl'
    )
    expect(args).toEqual([
      '-w',
      '-1',
      'new-tab',
      '--title',
      'Foreman',
      'powershell',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\app\\resources\\dwarf-feed-viewer.ps1',
      '-Path',
      'C:\\logs\\session.jsonl',
      '-Title',
      'Foreman'
    ])
  })
})

describe('buildFallbackArgs', () => {
  it('runs the viewer script directly for a standalone PowerShell window', () => {
    const args = buildFallbackArgs(
      'Foreman',
      'C:\\app\\resources\\dwarf-feed-viewer.ps1',
      'C:\\logs\\session.jsonl'
    )
    expect(args).toEqual([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\app\\resources\\dwarf-feed-viewer.ps1',
      '-Path',
      'C:\\logs\\session.jsonl',
      '-Title',
      'Foreman'
    ])
  })
})

/** A fake child process the test controls: no real process is ever spawned. */
function fakeChild(): {
  proc: SpawnedProcess
  emit: (event: 'error' | 'spawn', error?: Error) => void
} {
  const listeners = new Map<string, (error?: Error) => void>()
  return {
    proc: {
      once: (event, listener) => {
        listeners.set(event, listener)
      },
      unref: () => {}
    },
    emit: (event, error) => listeners.get(event)?.(error)
  }
}

describe('launchTranscriptViewer', () => {
  it('returns true once wt.exe actually spawns, and never tries the fallback', async () => {
    const commands: string[] = []
    const spawn: SpawnFn = (command) => {
      commands.push(command)
      const fake = fakeChild()
      queueMicrotask(() => fake.emit('spawn'))
      return fake.proc
    }

    const ok = await launchTranscriptViewer({
      dwarfName: 'Foreman',
      transcriptPath: 'C:\\log.jsonl',
      viewerScriptPath: 'C:\\view.ps1',
      spawn
    })

    expect(ok).toBe(true)
    expect(commands).toEqual(['wt.exe'])
  })

  it('falls back to a standalone PowerShell window when wt.exe is missing', async () => {
    const commands: string[] = []
    const spawn: SpawnFn = (command) => {
      commands.push(command)
      const fake = fakeChild()
      if (command === 'wt.exe') {
        queueMicrotask(() => fake.emit('error', new Error('ENOENT')))
      } else {
        queueMicrotask(() => fake.emit('spawn'))
      }
      return fake.proc
    }

    const ok = await launchTranscriptViewer({
      dwarfName: 'Foreman',
      transcriptPath: 'C:\\log.jsonl',
      viewerScriptPath: 'C:\\view.ps1',
      spawn
    })

    expect(ok).toBe(true)
    expect(commands).toEqual(['wt.exe', 'powershell.exe'])
  })

  it('returns false when both wt.exe and the PowerShell fallback fail to spawn', async () => {
    const spawn: SpawnFn = () => {
      const fake = fakeChild()
      queueMicrotask(() => fake.emit('error', new Error('nope')))
      return fake.proc
    }

    const ok = await launchTranscriptViewer({
      dwarfName: 'Foreman',
      transcriptPath: 'C:\\log.jsonl',
      viewerScriptPath: 'C:\\view.ps1',
      spawn
    })

    expect(ok).toBe(false)
  })
})
