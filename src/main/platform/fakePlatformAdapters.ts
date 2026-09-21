import { vi } from 'vitest'
import type { PlatformAdapters } from './platformAdapters'

/**
 * A stub `PlatformAdapters`, alongside `fakeFs.ts` and `fakeHookFs.ts` as one
 * of this repository's named fakes — moved out of `runtime.test.ts` (#477,
 * originally #470) so `registry.test.ts` can share it too, without importing
 * a `.test.ts` file: vitest re-runs every `describe`/`it` a test file's
 * module graph reaches, so importing one test file from another duplicates
 * its whole suite under the importer rather than sharing one function.
 *
 * `platformAdapters` on `RuntimeOptions` has no default any more (see
 * runtime.ts): every `AgentRuntime` construction in a test names its platform
 * through this stub rather than reaching the real one. `win32` in particular,
 * because every fixture cwd these suites use is Windows-shaped
 * ('C:\Code\Anvil...'), and the worktree fold walk any of them can trigger
 * must run against THAT platform, never the host running the suite (see
 * platform-ports) — a POSIX host's `posix.dirname` does not recognise '\\' as
 * a separator, so it degenerates a Windows-shaped path straight to '.', and a
 * real `.git` a few folders up the actual worktree the suite runs from
 * silently answers for it. An explicit `fs: new FakeFs()` alongside every
 * call site is the other half of the same fix: with no default, an omitted
 * `fs` used to reach `NodeFs`, the real disk.
 */
export function worktreePlatformAdapters(): PlatformAdapters {
  return {
    platform: 'win32',
    focusPid: vi.fn().mockResolvedValue(false),
    launchTranscriptViewer: vi.fn().mockResolvedValue(false),
    viewerScriptPath: 'C:\\viewer.mjs',
    textDelivery: {
      sendToConsole: vi.fn().mockResolvedValue({ delivered: true }),
      relayToClaudeSession: vi.fn().mockResolvedValue({ delivered: true }),
      sendInterrupt: vi.fn().mockResolvedValue({ delivered: true })
    },
    processProbe: {
      isCodexProcessRunning: vi.fn().mockResolvedValue(false),
      processStartTimeMs: vi.fn().mockResolvedValue(null)
    },
    processEnd: {
      endProcessTree: vi.fn().mockResolvedValue(false),
      terminateProcess: vi.fn().mockResolvedValue(false),
      killProcess: vi.fn().mockResolvedValue(false)
    },
    cliDetector: {
      detect: vi.fn().mockResolvedValue({ cli: 'claude', installed: false }),
      peek: vi.fn().mockReturnValue('unprobed')
    }
  }
}
