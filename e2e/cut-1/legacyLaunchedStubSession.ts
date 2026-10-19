import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { IsolatedProfile } from '../_harness/launchApp.ts'
import { processStartTimeMs } from '../_harness/processStart.ts'
import { STUB_BIN } from '../_harness/stubs.ts'
import { seedClaudeStubSession, STUB_SESSION_ID, type ClaudeStubWorld } from './claudeStubWorld.ts'

/**
 * A legacy-launched Claude session of the cut-1 world (ISSUE-123 L9; ISSUE-090): the
 * claude stub's replayed transcript (`claudeStubWorld.ts`), a stub process standing for the session's CLI
 * (`fixtures/bin/sleeper`, never a provider CLI, 17 §1.8) named by Claude Code's own session registry
 * (`sessions/<pid>.json`, with the process's creation time as a Windows FILETIME). So the Host observes a present
 * dwarf whose process identity it can watch. AMENDED for ISSUE-249, the cut-5 close (was: also the same process written
 * down in the profile's `projects-v1.db` `launched_sessions` as a launch today's runtime made): today's runtime and every
 * reader of that file left the tree (ISSUE-243, ISSUE-244; 21 §5.3), so no code touches the file. AMENDED for ISSUE-241, the end of cut 4 (was: also today's runtime owning
 * its identity-checked end, joined to the Host dwarf by `LegacyDwarfIdBridge` through `LegacyEndFirstAdapter`): both
 * bridges left the tree.
 */
export interface LegacyLaunchedStubSession extends ClaudeStubWorld {
  readonly pid: number
  alive(): boolean
  exitedAt(): number | null
  dispose(): void
}

const SLEEPER = path.join(STUB_BIN, 'sleeper', 'sleeper.mjs')

/** 100 ns ticks between 1601-01-01 and 1970-01-01. */
const FILETIME_EPOCH_OFFSET = 116_444_736_000_000_000n

export async function seedLegacyLaunchedStubSession(
  profile: IsolatedProfile,
  maxMs = 180_000
): Promise<LegacyLaunchedStubSession> {
  const world = seedClaudeStubSession(profile)
  // Detached on POSIX, as today's runtime spawns a launch: its end signals the process group there.
  const child: ChildProcess = spawn(process.execPath, [SLEEPER, 'sleep', String(maxMs)], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  })
  let exitedAt: number | null = null
  child.once('exit', () => (exitedAt = Date.now()))
  const pid = child.pid
  if (pid === undefined) throw new Error('the fixture session did not start')
  const started = await processStartTimeMs(pid)
  if (started === null) {
    child.kill()
    throw new Error('the fixture session has no creation time to write down')
  }
  const sessions = path.join(profile.claudeConfigDir, 'sessions')
  mkdirSync(sessions, { recursive: true })
  writeFileSync(
    path.join(sessions, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: STUB_SESSION_ID,
      cwd: world.minePath,
      // Claude Code's own lifecycle field: a working session (today's provider lists an idle one only at an open
      // prompt, which a stub process has none of).
      status: 'busy',
      procStart: String(BigInt(Math.round(started)) * 10_000n + FILETIME_EPOCH_OFFSET)
    })
  )
  return {
    ...world,
    pid,
    alive: () => exitedAt === null,
    exitedAt: () => exitedAt,
    dispose: () => {
      if (exitedAt === null) child.kill()
    }
  }
}
