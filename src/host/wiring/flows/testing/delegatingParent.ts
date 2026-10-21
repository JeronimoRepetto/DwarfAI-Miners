// A gated delegating parent on the wired cut-3a Host (ISSUE-209; flows/testing/cut3aHost.ts): a
// Claude launch made with "Let Jev choose" while "Subagent delegation" is on (the gates of UC-009,
// INV-80), running the person's own Claude CLI through the stream-json driver over the recorded
// Claude Code 2.1.301 SP-08 session (`fixtures/claude/stream-json/2.1.x/sp08-allow`), replayed by
// the conformance harness's `RecordingSpawn`. The recording waits on its stdin, so the parent stays
// alive until it is stopped. The worker is the development build's SimulatedDriver (15 §4.12),
// which Jev picks through the capability table below. Never imported by production code (R14).
//
// cut3aHost.test.ts keeps its own copy of the Claude recording helpers (an existing test file is
// edit-only, 17 §2.6).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import type { DwarfId, LaunchId, MineId } from '../../../kernel/domain/values'
import type { FakeClock } from '../../../kernel/fakes/FakeClock'
import type { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import type { JevDeps } from '../../../modules/jev'
import { readFixtureSet, type FixtureProcess } from '../../../modules/suppliers/testing/fixtureSet'
import { FixtureTransport } from '../../../modules/suppliers/testing/fixtureTransport'
import { RecordingSpawn } from '../../../modules/suppliers/testing/recordingSpawn'
import type { Host } from './cut3aHost'
import { nextSessionSpawn, notifySessionSpawn, settleClaudeLaunch } from './sessionSpawns'

const CLAUDE_FIXTURES = new URL('../../../../../fixtures/claude/stream-json/', import.meta.url)

/** The recorded SP-08 Claude session (one launch) and the recorded `claude --help`. */
export function claudeRecording(): { help: string; allow: FixtureProcess; prompt: string } {
  const set = readFixtureSet(fileURLToPath(new URL('2.1.x/', CLAUDE_FIXTURES)))
  const allow = set.cases.find((c) => c.name === 'sp08-allow')
  const variant = allow?.variants[0]
  const prompt = (allow?.expected.script[0] as { prompt?: string } | undefined)?.prompt
  if (variant === undefined || prompt === undefined)
    throw new Error('the SP-08 recording is missing')
  return {
    help: readFileSync(
      new URL('2.1.x/probe-help-without-prompt-tool.jsonl', CLAUDE_FIXTURES),
      'utf8'
    ),
    allow: { received: variant.received, gates: [...(variant.gates ?? [])] },
    prompt
  }
}

/**
 * `claude --help` answers the recorded help; every `claude -p` replays `recorded` and is reported to
 * the waiting launch helper (testing/sessionSpawns.ts).
 */
export function claudeSpawn(
  clock: FakeClock,
  scheduler: FakeScheduler,
  recorded: FixtureProcess,
  help: string
): RecordingSpawn {
  return new RecordingSpawn({
    clock,
    scheduler,
    decide: (spec) => {
      if (spec.args.includes('--help')) return { kind: 'exit', afterMs: 0, code: 0, stdout: help }
      if (spec.args.includes('-p')) {
        notifySessionSpawn(clock)
        return {
          kind: 'fixture',
          transport: new FixtureTransport({
            received: recorded.received,
            format: 'jsonl',
            gates: recorded.gates
          })
        }
      }
      return { kind: 'exit', afterMs: 0, code: 1, stdout: '' }
    }
  })
}

/** The simulated worker's one launch target, and Claude's for the parent's "Let Jev choose". */
export const DELEGATION_CAPABILITIES: NonNullable<JevDeps['capabilities']> = {
  claude: {
    sonnet: {
      tier: 'balanced',
      what: 'Everyday multi-step coding work.',
      notFor: 'Trivial lookups.',
      examples: ['Add a field to this form.', 'Extract this helper.'],
      launchTarget: true,
      effortLevels: 'all',
      relativeCost: 'medium',
      sources: ['test fixture'],
      verifiedOn: '2026-10-17'
    }
  },
  simulated: {
    'sim-balanced': {
      tier: 'balanced',
      what: 'Everyday multi-step coding work on a small repository.',
      notFor: 'Very long documents or the hardest research problems.',
      examples: ['Rename a field across three files', 'Write a unit test for a parser'],
      launchTarget: true,
      effortLevels: 'all',
      relativeCost: 'unverified',
      sources: ['test double: the simulated supplier'],
      verifiedOn: '2026-10-17'
    }
  }
}

/** Jev's first-request answers (16 §6.3), picking `provider` at the balanced tier. */
export function jevPicks(provider: string) {
  return {
    kind: 'answers' as const,
    provider: { choice: provider, confidence: 0.91 },
    tier: { choice: 'balanced' as const, confidence: 0.88 },
    trivial: { probability: 0.05 },
    largeContext: { probability: 0.05 },
    effort: { score: 1.5 },
    usage: { inputTokens: 42 }
  }
}

/** "Subagent delegation" turned on through B-M preferences.set, as the person turns it on. */
export async function turnDelegationOn(h: Host, ui: Parameters<Host['settle']>[0]): Promise<void> {
  const set = await h.call(ui, 'preferences.set', {
    key: 'subagentDelegationOn',
    value: true,
    requestId: h.rid()
  })
  expect(set).toMatchObject({ ok: true })
}

/**
 * A Claude launch into `mineId`, settled: its launch and the dwarf it produced. With "Let Jev
 * choose" (the default) Jev's next queued answer picks Claude; without it Claude is picked by hand.
 */
export async function launchClaudeWithJev(
  h: Host,
  ui: Parameters<Host['settle']>[0],
  mineId: MineId,
  prompt: string,
  letJevChoose = true
): Promise<{ launchId: LaunchId; dwarfId: DwarfId }> {
  if (letJevChoose) h.router.queue(jevPicks('claude'))
  const spawned = nextSessionSpawn(h.clock)
  const answered = await h.call(ui, 'launching.launch', {
    mineId,
    way: letJevChoose ? { kind: 'jev' } : { kind: 'supplier', providerId: 'claude' },
    prompt,
    jevOn: letJevChoose,
    jevAutoAccept: false,
    requestId: h.rid()
  })
  expect(answered).toMatchObject({ ok: true })
  const launchId = (answered as { result?: { launchId?: LaunchId } }).result?.launchId
  if (launchId === undefined) throw new Error('the launch was answered with no launch id')
  return settleClaudeLaunch(h, ui, launchId, spawned)
}
