// layer: L2
// Launch parity for Codex (21 §2 cut 3b "Parity / exit"; ADR-020 D1, D4; ISSUE-002): for each Codex launch failure, the
// legacy reason today's Codex launch gives maps to the ADR-020 cause the Host reports, as
// `docs/strangler/parity-cut-3b.md` lists it. Any pair the table below does not list fails parity; the table is the
// launch-cause mapping the parity file copies, with each row's `Decided by`.
//
// The two sides meet the same situation:
// - Today's side (`src/main`, only `src/legacy-bridge/**` may import it, R16): today's Codex launch is the detached
//   one-shot `codex exec` (`launchClaudeSession` over `runLaunchProcess`, deleted by ISSUE-185 after the soak). Its
//   legacy reason is the `cause` of a refused verdict, the early failure its `EarlyFailureWatch` latches (a non-zero
//   exit inside today's 3 s window, `exited-at-once`), or none (`launched`: today reports no failure). The spawn is a
//   double that starts, refuses or exits where the situation says; today's window runs on a fake clock.
// - The Host's side: the launching module's pure five-cause table (`classifyLaunchOutcome`, read directly as its own
//   tests read it) over the same events. The Codex drivers report those events (L4 conformance C-03, C-04 of
//   `CodexAppServerDriver` and `CodexAcpDriver`).
//
// Recorded Codex fixtures: the S-015-1 / SP-12 recordings (`fixtures/codex/app-server-rpc/0.153.4/`) hold no launch
// failure, so every row is a situation both sides are driven through; `parity-cut-3b.md` records that gap.
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  classifyLaunchOutcome,
  HANDSHAKE_TIMEOUT_MS,
  type LaunchOutcomeEvent
} from '../../host/modules/launching/domain/classifyLaunchOutcome'
import type { Instant } from '../../host/kernel/domain/values'
import { FakeFs } from '../../main/adapters/fakeFs'
import { createCliDetector } from '../../main/platform/cliDetection'
import {
  launchClaudeSession,
  runLaunchProcess,
  type LaunchChild,
  type SpawnLaunch,
  type StderrFile,
  type StdoutFile
} from '../../main/sessionLaunch/launchRunner'

const HOME = '/home/j'
const CODEX = '/home/j/.local/bin/codex'
const MINE = '/home/j/code/anvil'
const T0 = 1_700_000_000_000

/** ADR-020 D1: the five causes, and no others. */
type Adr020Cause =
  | 'not-installed'
  | 'exited-at-once'
  | 'could-not-start'
  | 'jev-unreachable'
  | 'jev-could-not-choose'

/** Today's reason: the cause today's launch names, or `launched` when it reports no failure at all. */
type LegacyReason = 'not-installed' | 'could-not-start' | 'exited-at-once' | 'launched'

/** How the situation unfolds after the launch call, on both sides. */
type Situation =
  | { kind: 'cli-absent' }
  | { kind: 'never-spawned'; code: string }
  | { kind: 'ends'; afterMs: number; code: number }
  | { kind: 'never-ready' }

/**
 * The launch-cause mapping of 3b (`docs/strangler/parity-cut-3b.md`): each Codex launch failure, today's reason, the
 * Host's ADR-020 cause, and what decides the pair. A row whose two sides differ is an intended difference.
 */
const LAUNCH_CAUSE_PARITY: ReadonlyArray<{
  failure: string
  legacy: LegacyReason
  host: Adr020Cause
  decidedBy: string
}> = [
  {
    failure: 'cli-absent',
    legacy: 'not-installed',
    host: 'not-installed',
    decidedBy: 'ADR-020 D1 cause 1'
  },
  {
    failure: 'never-spawned-eacces',
    legacy: 'could-not-start',
    host: 'could-not-start',
    decidedBy: 'ADR-020 item 3'
  },
  // Intended difference: today answers `could-not-start` whatever the errno (#635); the Host reads `ENOENT` at spawn as
  // the CLI not being there (07 machine 5B S5.16).
  {
    failure: 'never-spawned-enoent',
    legacy: 'could-not-start',
    host: 'not-installed',
    decidedBy: 'ADR-020 item 4; 07 S5.16'
  },
  {
    failure: 'exits-failing-inside-window',
    legacy: 'exited-at-once',
    host: 'exited-at-once',
    decidedBy: 'ADR-020 D4'
  },
  // Intended difference: today's `codex exec` is one-shot, so a clean exit is its turn finishing; the Host's
  // `codex app-server` is a held server, and any end before it is ready inside the window is the launch failing.
  {
    failure: 'exits-cleanly-inside-window',
    legacy: 'launched',
    host: 'exited-at-once',
    decidedBy: 'ADR-020 D4; 15 §4.4'
  },
  // Intended difference: today's window has passed, so it reports nothing; the Host's handshake never completed.
  {
    failure: 'exits-after-window',
    legacy: 'launched',
    host: 'could-not-start',
    decidedBy: 'ADR-020 item 4; 07 S5.20'
  },
  // Intended difference: today has no readiness handshake and reports nothing for a session that never answers; the
  // Host fails a launch whose handshake does not complete in time (07 machine 5B S5.19).
  {
    failure: 'never-ready',
    legacy: 'launched',
    host: 'could-not-start',
    decidedBy: 'ADR-020 item 4'
  }
]

const SITUATIONS: ReadonlyArray<{ failure: string; situation: Situation }> = [
  { failure: 'cli-absent', situation: { kind: 'cli-absent' } },
  { failure: 'never-spawned-eacces', situation: { kind: 'never-spawned', code: 'EACCES' } },
  { failure: 'never-spawned-enoent', situation: { kind: 'never-spawned', code: 'ENOENT' } },
  { failure: 'exits-failing-inside-window', situation: { kind: 'ends', afterMs: 400, code: 1 } },
  { failure: 'exits-cleanly-inside-window', situation: { kind: 'ends', afterMs: 400, code: 0 } },
  { failure: 'exits-after-window', situation: { kind: 'ends', afterMs: 5_000, code: 1 } },
  { failure: 'never-ready', situation: { kind: 'never-ready' } }
]

/** Today's capture files, kept in memory (the runner only opens, reads and removes them). */
function memoryFile(): StderrFile & StdoutFile {
  let next = 0
  return {
    path: () => `/tmp/dwarfai-launch-${++next}.log`,
    openForWrite: () => 3,
    close: () => {},
    readTail: () => '',
    remove: () => {}
  }
}

/** A spawned child as today's runner meets it: it starts, or refuses with `code`. */
function spawnDouble(situation: Situation): { spawn: SpawnLaunch; child: () => EventEmitter } {
  let last = new EventEmitter()
  const spawn: SpawnLaunch = () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdin: { on: () => {}, end: () => {} },
      unref: () => {}
    })
    last = child
    queueMicrotask(() => {
      if (situation.kind === 'never-spawned') {
        child.emit(
          'error',
          Object.assign(new Error(`spawn ${situation.code}`), { code: situation.code })
        )
      } else {
        child.emit('spawn')
      }
    })
    return child as unknown as LaunchChild
  }
  return { spawn, child: () => last }
}

/** Today's reason for `situation`: today's detached Codex launch over a spawn double. */
async function legacyReason(situation: Situation): Promise<LegacyReason> {
  const fs = new FakeFs()
  if (situation.kind !== 'cli-absent') fs.addFile(CODEX, '#!/bin/sh\n')
  const detector = createCliDetector({ home: HOME, platform: 'linux', fs, env: {} })
  const double = spawnDouble(situation)
  const files = memoryFile()
  const verdict = await launchClaudeSession({
    provider: 'codex',
    minePath: MINE,
    prompt: 'Reply with the single word hello and nothing else. Do not use any tool.',
    detector,
    env: {},
    platform: 'linux',
    fs,
    run: (invocation) => runLaunchProcess(invocation, double.spawn, files, files, () => T0),
    codexOutputPath: () => '/tmp/dwarfai-launch-codex-output.log'
  })
  if (!verdict.launched) return verdict.cause ?? 'launched'
  const failures: LegacyReason[] = []
  verdict.retained?.onEarlyFailure?.(() => void failures.push('exited-at-once'))
  if (situation.kind === 'ends') {
    vi.advanceTimersByTime(situation.afterMs)
    double.child().emit('exit', situation.code, null)
  }
  if (situation.kind === 'never-ready') vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS)
  return failures[0] ?? 'launched'
}

/** The Host's cause for `situation`: the launching module's five-cause table over the same events. */
function hostCause(situation: Situation): Adr020Cause | 'succeeded' | 'pending' {
  const t0 = T0 as Instant
  const at = (ms: number) => (T0 + ms) as Instant
  const events: LaunchOutcomeEvent[] = []
  let spawnedAt: Instant | null = t0
  let now = t0
  if (situation.kind === 'cli-absent') {
    events.push({ kind: 'detect-negative' })
    spawnedAt = null
  }
  if (situation.kind === 'never-spawned') {
    events.push({ kind: 'spawn-error', code: situation.code })
    spawnedAt = null
  }
  if (situation.kind === 'ends') {
    events.push({ kind: 'ended', at: at(situation.afterMs), how: 'exit' })
    now = at(situation.afterMs)
  }
  if (situation.kind === 'never-ready') now = at(HANDSHAKE_TIMEOUT_MS)
  const outcome = classifyLaunchOutcome(events, spawnedAt, now)
  return outcome.kind === 'failed' ? outcome.cause : outcome.kind
}

describe('launch-cause parity, step 3b (21 §2 cut 3b; parity-cut-3b.md)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('[ADR-020] each recorded Codex launch failure maps from its legacy reason to the ADR-020 cause listed in parity-cut-3b.md', async () => {
    const observed: Array<{ failure: string; legacy: LegacyReason; host: string }> = []
    for (const { failure, situation } of SITUATIONS) {
      observed.push({ failure, legacy: await legacyReason(situation), host: hostCause(situation) })
    }

    const listed = new Map(LAUNCH_CAUSE_PARITY.map((row) => [row.failure, row]))
    for (const pair of observed) {
      const row = listed.get(pair.failure)
      expect(row, `${pair.failure} is not in the parity table`).toBeDefined()
      expect({ failure: pair.failure, legacy: pair.legacy, host: pair.host }).toEqual({
        failure: row?.failure,
        legacy: row?.legacy,
        host: row?.host
      })
    }
    // Every listed row was observed, and every row names what decides it.
    expect(new Set(observed.map((pair) => pair.failure))).toEqual(new Set(listed.keys()))
    for (const row of LAUNCH_CAUSE_PARITY) expect(row.decidedBy).not.toBe('')
  })
})
