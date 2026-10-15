// `runSessionStarterContract` (16 §4.5 `SessionStarter`, §2.8; 17 §1.3): the one suite the double
// (`FakeSessionStarter`) and the real bridge (wiring/bridges/sessionStarter.ts over the suppliers
// registry) both pass, so a test that composes the double proves what the bridge does. The
// boundary test of 05 §3.5: the five-cause mapping uses ADR-020's names only — a start settles
// `ok` or with one of the three causes a launch's own process can end with, never a Jev cause and
// never a sixth literal (launchFailureCause.type.test.ts holds the type half). Never imported by
// production code (R14).
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type { LaunchFailure } from '../../../kernel/domain/sharedContracts'
import type { FolderPath, LaunchId, ProviderId } from '../../../kernel/domain/values'
import type { FakeClock } from '../../../kernel/fakes/FakeClock'
import type { DriverLaunchRequest, DriverSession, InstalledProvider } from '../../suppliers'
import { EARLY_FAILURE_WINDOW_MS } from '../domain/classifyLaunchOutcome'
import { TOOL_OUTPUT_TAIL_MAX_CHARS } from '../domain/launchFailure'
import type { SessionStarter, StartResult } from '../ports/sessionStarter'

/** What the next `start` meets, as the subject arranges it. */
export type StartScript =
  | { kind: 'ready' } // handshake ready; the session outlives the early window
  | { kind: 'not-installed' } // detection says not installed: nothing is spawned
  | {
      kind: 'rejects' // the driver spawned, then rejected with a DriverLaunchError
      cause: 'could-not-start' | 'exited-at-once'
      toolOutputTail?: string
    }
  | { kind: 'exits-in-window' } // handshake ready, then the process exits before t0 + 3 s

export interface SessionStarterSubject {
  starter: SessionStarter
  /** Drives the subject's scheduler. */
  clock: FakeClock
  /** The provider the subject arranged. */
  providerId: ProviderId
  /** Arranges what the next `start` of `providerId` meets. */
  arrange(script: StartScript): void
}

export const CONTRACT_LAUNCH = '00000000-0000-7000-8000-0000000162c1' as LaunchId
const INSTALL: InstalledProvider = {
  providerId: 'contract' as ProviderId,
  binaryPath: '/opt/contract/bin/tool',
  version: '1.0.0',
  resolvedVia: 'path',
  statMtimeMs: 0
}

/** Lets the promise jobs queued so far run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

/**
 * Moves the subject's clock by `ms` in 10 ms steps, letting promise jobs run between steps, the way
 * real time interleaves timers and promise continuations.
 */
async function advance(subject: SessionStarterSubject, ms: number): Promise<void> {
  let left = ms
  while (left > 0) {
    const step = Math.min(10, left)
    subject.clock.advance(step)
    left -= step
    await settle()
  }
}

function request(spawned: ProcessIdentity[], launchId: LaunchId): DriverLaunchRequest {
  return {
    launchId,
    install: INSTALL,
    cwd: '/work/mine-one' as FolderPath,
    prompt: 'Survey the north seam',
    permissionMode: null,
    delegation: null,
    spawnTag: `v1:install-162:${launchId}:epoch-162`,
    onSpawned: async (identity) => {
      spawned.push(identity)
    }
  }
}

interface Started {
  result: () => StartResult | undefined
  spawned: ProcessIdentity[]
}

function startOne(subject: SessionStarterSubject, launchId = CONTRACT_LAUNCH): Started {
  const spawned: ProcessIdentity[] = []
  let result: StartResult | undefined
  void subject.starter
    .start(subject.providerId, request(spawned, launchId), { launchedWithLetJevChoose: false })
    .then((value) => {
      result = value
    })
  return { result: () => result, spawned }
}

export function runSessionStarterContract(name: string, make: () => SessionStarterSubject): void {
  describe(`SessionStarter contract: ${name}`, () => {
    it('[16 §4.5, S5.18, S5.21, S4.01] a ready session resolves ok only once the 3-second early window after the spawn has passed, and onSpawned ran once before', async () => {
      const subject = make()
      subject.arrange({ kind: 'ready' })
      const started = startOne(subject)
      await settle()
      expect(started.spawned).toHaveLength(1)
      await advance(subject, EARLY_FAILURE_WINDOW_MS - 1)
      expect(started.result()).toBeUndefined()
      await advance(subject, 1)
      const result = started.result()
      expect(result?.ok).toBe(true)
      expect(started.spawned).toHaveLength(1)
    })

    it('[ADR-020, S5.16] a provider that is not installed settles not-installed and spawns nothing', async () => {
      const subject = make()
      subject.arrange({ kind: 'not-installed' })
      const started = startOne(subject)
      await advance(subject, EARLY_FAILURE_WINDOW_MS)
      expect(started.spawned).toEqual([])
      expect(started.result()).toMatchObject({ ok: false, error: { cause: 'not-installed' } })
    })

    it('[ADR-020, INV-52, INV-55] a driver rejection settles as exactly its cause, with its tool-output tail cut to the last 400 characters', async () => {
      const subject = make()
      const tail = `${'x'.repeat(100)}${'y'.repeat(TOOL_OUTPUT_TAIL_MAX_CHARS)}`
      subject.arrange({ kind: 'rejects', cause: 'could-not-start', toolOutputTail: tail })
      const started = startOne(subject)
      await settle()
      const result = started.result()
      expect(result).toMatchObject({ ok: false, error: { cause: 'could-not-start' } })
      if (result === undefined || result.ok) throw new Error('expected a failure')
      expect(result.error.toolOutputTail).toBe('y'.repeat(TOOL_OUTPUT_TAIL_MAX_CHARS))
      expect(result.error.actions).toEqual(['retry'])
    })

    it('[ADR-020, S5.20, NFR-TIM-06] a session whose process exits inside the early window settles exited-at-once', async () => {
      const subject = make()
      subject.arrange({ kind: 'exits-in-window' })
      const started = startOne(subject)
      await advance(subject, EARLY_FAILURE_WINDOW_MS)
      expect(started.result()).toMatchObject({ ok: false, error: { cause: 'exited-at-once' } })
    })

    it('[05 §3.5, INV-52] a start settles with ADR-020 LaunchFailure only', () => {
      expectTypeOf<Awaited<ReturnType<SessionStarter['start']>>>().toEqualTypeOf<
        { ok: true; value: DriverSession } | { ok: false; error: LaunchFailure }
      >()
    })
  })
}
