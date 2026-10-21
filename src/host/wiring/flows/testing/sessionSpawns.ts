// Waiting for a Claude session's spawn on the wired cut-3a Host (flows/testing/cut3aHost.ts), shared
// by `launchClaude` (cut3aHost.test.ts) and `launchClaudeWithJev` (testing/delegatingParent.ts).
//
// Before `claude -p` is spawned, the launch writes two real files: the relay's credential and its
// `--mcp-config`. They answer on the event loop, never on fake time, and the handshake budget starts
// only at the spawn (S5.19). So a launch helper waits for the spawn itself with the fake clock
// frozen: no count of fake-time steps bounds the disk (Windows CI runs 39581750212, 39667176491:
// "claude did not launch: []"), and no budget moves while the disk works.
//
// The spawn doubles report each session spawn here (`notifySessionSpawn`), per fake clock. A slow
// disk is stood in by `slowMcpConfigFiles`, in event-loop turns, never in real time.
// Never imported by production code (R14).
import { onTestFinished } from 'vitest'
import type { DwarfId, LaunchId } from '../../../kernel/domain/values'
import type { FakeClock } from '../../../kernel/fakes/FakeClock'
import { EARLY_FAILURE_WINDOW_MS, HANDSHAKE_TIMEOUT_MS } from '../../../modules/launching'
import type { McpConfigFiles } from '../../../modules/suppliers/adapters/drivers/claude-stream-json/mcpConfigFile'
import { evts, type Host } from './cut3aHost'

/**
 * How many settle rounds a helper waits, the clock frozen, for a spawn that never comes: about 1.5 s
 * on a developer machine (2026-10-21), against the few rounds the two files take there, so it covers
 * the multi-second disk stalls of the Windows CI runner, and it stays inside the per-test timeout
 * (5 s, 30 s on that runner, vitest.config.ts), so a missing spawn fails with its own message.
 */
export const SPAWN_WAIT_SETTLES = 40_000

/** Who waits for the next `claude -p` session the spawn double over each clock starts. */
const waiters = new WeakMap<FakeClock, Array<() => void>>()

/** Called by a spawn double when it starts a `claude -p` session (a launch or a resume). */
export function notifySessionSpawn(clock: FakeClock): void {
  for (const notify of waiters.get(clock)?.splice(0) ?? []) notify()
}

/** Resolves when the spawn double over `clock` starts its next `claude -p` session. */
export function nextSessionSpawn(clock: FakeClock): Promise<void> {
  return new Promise((resolve) => {
    const waiting = waiters.get(clock) ?? []
    waiting.push(resolve)
    waiters.set(clock, waiting)
  })
}

export interface SpawnWait {
  /** True once the wait is moot: the launch failed, or the session is gone. */
  givenUp: () => boolean
  /** What the failure message reports when no spawn came. */
  state: () => string
}

/**
 * Settles `ui` with the fake clock frozen until `spawned` resolved or `wait.givenUp()` answers true;
 * after `SPAWN_WAIT_SETTLES` rounds with neither, fails with `claude did not spawn: <state>`.
 */
export async function untilSpawned(
  h: Pick<Host, 'settle'>,
  ui: Parameters<Host['settle']>[0],
  spawned: Promise<void>,
  wait: SpawnWait
): Promise<void> {
  let done = false
  void spawned.then(() => (done = true))
  for (let round = 0; !done && !wait.givenUp(); round += 1) {
    if (round >= SPAWN_WAIT_SETTLES) throw new Error(`claude did not spawn: ${wait.state()}`)
    await h.settle(ui)
  }
}

/**
 * Settles a Claude launch `ui` was answered for, whose next session spawn is `spawned` (taken before
 * the request): the launch's continuation runs on the scheduler, then the wait for the spawn with
 * the clock frozen (`untilSpawned`), then fake time through the handshake budget and the 3 s
 * early-failure window (ADR-020 D4), which is part of the success. Answers the launch and its dwarf.
 */
export async function settleClaudeLaunch(
  h: Pick<Host, 'settle' | 'run'>,
  ui: Parameters<Host['settle']>[0],
  launchId: LaunchId,
  spawned: Promise<void>
): Promise<{ launchId: LaunchId; dwarfId: DwarfId }> {
  const frames = () =>
    evts<{ launch: { launchId: LaunchId; state: string; dwarfId?: DwarfId } }>(
      ui,
      'launch.changed'
    ).filter((frame) => frame.launch.launchId === launchId)
  const failed = () => evts(ui, 'launch.failed').length > 0
  const settled = () => frames().find((frame) => frame.launch.state === 'succeeded')?.launch
  await h.run(50, ui)
  await untilSpawned(h, ui, spawned, {
    givenUp: failed,
    state: () => JSON.stringify({ states: frames().map((f) => f.launch.state) })
  })
  const budget = HANDSHAKE_TIMEOUT_MS + EARLY_FAILURE_WINDOW_MS
  for (let waited = 0; waited < budget && settled() === undefined && !failed(); waited += 50) {
    await h.run(50, ui)
  }
  const launch = settled()
  if (launch?.dwarfId === undefined) {
    throw new Error(`claude did not launch: ${JSON.stringify(evts(ui, 'launch.failed'))}`)
  }
  return { launchId, dwarfId: launch.dwarfId }
}

/**
 * A slow disk under the real `--mcp-config` store: each write answers once `turns` event-loop turns
 * passed with the fake clock still where it was when the write began. A helper that moves the clock
 * across the disk work therefore never sees the write answer (a disk slower than the time it let
 * pass); `never` holds every write until the test ends. A write still held then is refused.
 */
export function slowMcpConfigFiles(
  real: McpConfigFiles,
  clock: FakeClock,
  turns: number | 'never'
): McpConfigFiles {
  let ended = false
  onTestFinished(() => {
    ended = true
  })
  return {
    write: async (path, text) => {
      const start = clock.now()
      for (let counted = 0; turns === 'never' || counted < turns;) {
        await new Promise((resolve) => setImmediate(resolve))
        if (ended) throw new Error('the test ended before the write answered')
        if (clock.now() === start) counted += 1
      }
      await real.write(path, text)
    },
    remove: (path) => real.remove(path)
  }
}
