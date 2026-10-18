// layer: L2
// Launch parity for Claude (21 §2 cut 3a "Parity / exit", `21-migration-plan.md:216`; ADR-020 D1, D4; ISSUE-001): for each
// Claude launch failure, the legacy reason today's Claude launch gives maps to the ADR-020 cause the Host reports, as
// `docs/strangler/parity-cut-3a.md` lists it. Any pair the table below does not list fails parity; the table is the
// launch-cause mapping the parity file copies, with each row's `Decided by`.
//
// The two sides meet the same situation:
// - Today's side (`src/main`, only `src/legacy-bridge/**` may import it, R16): today's Claude launch is the held session
//   (`HeldSessionRegistry` over the Agent SDK engine, deleted by ISSUE-184 after the soak). Its legacy reason is the
//   `cause` of a refused verdict, the cause `onEarlyEnd` names, or none (`launched`: today reports no failure). The
//   engine is a double that ends the session where the situation says; the registry's clock is driven by hand.
// - The Host's side: the launching module's pure five-cause table (`classifyLaunchOutcome`, read directly as its own
//   tests read it; the module's index does not export it) over the same events, and, for the recorded fixture, the cause
//   the fixture's expected outcome holds, which the Claude driver conformance proves the driver reports (C-04).
//
// Recorded Claude launch failures: `fixtures/claude/stream-json/2.1.x/s0201-early-exit` (S-020-1, Claude Code 2.1.301),
// each timing variant (`-timing`, `-timing-crlf`, `-timing-with-extra`): an error result 0.4 s after the spawn, before
// any `system/init`, and the exit about 3.1 s after the spawn. Today's engine reports a session's end when its stream
// closes (`sdkHeldSession.ts`, the `for await` loop over the session), which is the exit.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyLaunchOutcome,
  HANDSHAKE_TIMEOUT_MS,
  type LaunchOutcomeEvent
} from '../../host/modules/launching/domain/classifyLaunchOutcome'
import type { Instant } from '../../host/kernel/domain/values'
import { FakeFs } from '../../main/adapters/fakeFs'
import { createCliDetector, type CliDetector } from '../../main/platform/cliDetection'
import type { HeldSessionPort, HeldSessionStartRequest } from '../../main/sessionLaunch/heldSession'
import { HeldSessionRegistry } from '../../main/sessionLaunch/heldSessionRegistry'

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures/claude/stream-json/2.1.x')
const HOME = '/home/j'
const CLAUDE = '/home/j/.local/bin/claude'
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
  | { kind: 'ends'; afterMs: number }
  | { kind: 'never-ready' }

/**
 * The launch-cause mapping of 3a (`docs/strangler/parity-cut-3a.md`): each Claude launch failure, today's reason, the
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
    failure: 'never-spawned',
    legacy: 'could-not-start',
    host: 'could-not-start',
    decidedBy: 'ADR-020 item 3'
  },
  {
    failure: 'ends-inside-window',
    legacy: 'exited-at-once',
    host: 'exited-at-once',
    decidedBy: 'ADR-020 D4'
  },
  // Intended difference: today waits for the stream to close, which the recording places past the 3 s window, and
  // reports nothing; the Host reads the error result before `system/init` as the launch failing (S-020-1 measured rule).
  {
    failure: 's0201-early-exit',
    legacy: 'launched',
    host: 'exited-at-once',
    decidedBy: 'ADR-020 D4; S-020-1'
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

function detector(installed: boolean): CliDetector {
  const fs = new FakeFs()
  if (installed) fs.addFile(CLAUDE, '#!/bin/sh\n')
  return createCliDetector({ home: HOME, platform: 'linux', fs, env: {} })
}

/** Today's reason for `situation`: today's held-session registry over an engine double. */
async function legacyReason(situation: Situation): Promise<LegacyReason> {
  const clock = { now: T0 }
  const started: HeldSessionStartRequest[] = []
  const engine: HeldSessionPort = (request) => {
    started.push(request)
    return Promise.resolve({ close: () => {}, send: () => true })
  }
  const registry = new HeldSessionRegistry({
    detector: detector(situation.kind !== 'cli-absent'),
    start: { claude: engine },
    now: () => clock.now,
    log: () => {}
  })
  const earlyEnds: LegacyReason[] = []
  const verdict = await registry.launch({
    mineId: 'mine-1',
    provider: 'claude',
    minePath: MINE,
    prompt: 'Reply with the single word hello and nothing else. Do not use any tool.',
    onEarlyEnd: (cause) => void earlyEnds.push(cause)
  })
  if (!verdict.launched) return verdict.cause ?? 'launched'
  const session = started[0]
  if (situation.kind === 'never-spawned') session?.onEnd(`spawn ${situation.code}`, true)
  if (situation.kind === 'ends') {
    clock.now += situation.afterMs
    session?.onEnd('the session stream ended')
  }
  if (situation.kind === 'never-ready') clock.now += HANDSHAKE_TIMEOUT_MS
  return earlyEnds[0] ?? 'launched'
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

/** One recorded timing variant: when the CLI was spawned and when it exited, in ms after the spawn. */
function recordedExitAfterMs(file: string): number {
  const entries = readFileSync(resolve(FIXTURES, file), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { at?: number; event?: string })
  const spawned = entries.find((entry) => entry.event === 'spawned')?.at
  const exited = entries.find((entry) => entry.event === 'exit')?.at
  if (spawned === undefined || exited === undefined) throw new Error(`${file} has no spawn or exit`)
  return exited - spawned
}

/** The cause the recorded fixture's expected outcome holds for the Host's Claude driver (C-04). */
function recordedHostCause(base: string): Adr020Cause {
  const expected = JSON.parse(readFileSync(resolve(FIXTURES, `${base}.expected.json`), 'utf8')) as {
    outcomes: Array<{ rejected?: { cause: Adr020Cause } }>
  }
  const cause = expected.outcomes[0]?.rejected?.cause
  if (cause === undefined) throw new Error(`${base} records no rejected launch`)
  return cause
}

const SITUATIONS: ReadonlyArray<{ failure: string; situation: Situation }> = [
  { failure: 'cli-absent', situation: { kind: 'cli-absent' } },
  { failure: 'never-spawned', situation: { kind: 'never-spawned', code: 'EACCES' } },
  { failure: 'ends-inside-window', situation: { kind: 'ends', afterMs: 400 } },
  { failure: 'never-ready', situation: { kind: 'never-ready' } }
]

const RECORDED_TIMINGS = [
  's0201-early-exit-timing.jsonl',
  's0201-early-exit-timing-crlf.jsonl',
  's0201-early-exit-timing-with-extra.jsonl'
]

describe('launch-cause parity, step 3a (21 §2 cut 3a; parity-cut-3a.md)', () => {
  it('[ADR-020] each recorded Claude launch failure maps from its legacy reason to the ADR-020 cause listed in parity-cut-3a.md', async () => {
    const observed: Array<{ failure: string; legacy: LegacyReason; host: string }> = []
    for (const { failure, situation } of SITUATIONS) {
      observed.push({ failure, legacy: await legacyReason(situation), host: hostCause(situation) })
    }
    for (const timing of RECORDED_TIMINGS) {
      const legacy = await legacyReason({ kind: 'ends', afterMs: recordedExitAfterMs(timing) })
      observed.push({
        failure: 's0201-early-exit',
        legacy,
        host: recordedHostCause('s0201-early-exit')
      })
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
