// layer: L4
// L4 (17 §1.4): a provider whose format changed under an observed dwarf (13 FM-068; ISSUE-084),
// through the real Claude and Antigravity adapters and the real observation loop, over the
// `format-changed` fixtures of `fixtures/claude/observer/2.1.x` and
// `fixtures/antigravity/observer/1.1.26` (synthetic, scrubbed; their LF and CRLF variants). The
// first record of each fixture is in the format the adapter reads; every later one is in the
// changed format. The provider is laid out in a per-test temp folder in its real spelling
// (17 §5.3) holding the readable record, then writes one changed record per poll, as a session
// that goes on after a CLI upgrade does.
//
// TC-084-02 (the adapter half): nothing throws (INV-38), each changed record is a drift record
// carrying nothing the provider wrote, and once the drift passes the threshold the dwarf's provider
// error is published once, as the `unreadable` cause (US-RES-004.AC04).
import { realpathSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { FolderPath, ProviderIdentity } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import { NodeFs } from '../../../platform/fs/NodeFs'
import { openReadOnlySnapshot } from '../../../platform/sqlite/readOnlySnapshot'
import type { ObservationEvent, ProviderErrorObserved } from '../application/events'
import { OBSERVATION_POLL_MS, ObservationLoop } from '../application/observationLoop'
import { DRIFT_SURFACE_THRESHOLD } from '../domain/providerError'
import { InMemoryCursorStore } from '../ports/fakes/InMemoryCursorStore'
import { InMemoryObservedSessionStore } from '../ports/fakes/InMemoryObservedSessionStore'
import { RecordingObservedBatchSink } from '../ports/fakes/RecordingObservedBatchSink'
import type { ObservationAdapter } from '../ports/observationAdapter'
import { InMemoryBoundDwarfs } from '../testing/inMemoryBoundDwarfs'
import { InMemoryTransactions } from '../testing/inMemoryTransactions'
import { AntigravityObservationAdapter } from './antigravity/AntigravityObservationAdapter'
import { ClaudeObservationAdapter } from './claude/ClaudeObservationAdapter'

const T0 = 1_790_800_000_000
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../../fixtures')
const CLAUDE = join(FIXTURES, 'claude/observer/2.1.x')
const ANTIGRAVITY = join(FIXTURES, 'antigravity/observer/1.1.26')

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'dwarfai-084-')))
  temps.push(dir)
  return dir
}

/** A fixture's records, each with the line ending it was written with. */
async function recordsOf(folder: string, file: string): Promise<string[]> {
  const text = await readFile(join(folder, file), 'utf8')
  return text.match(/[^\r\n]*\r?\n/g) ?? []
}

/** One provider laid out with the fixture's readable record, and how it writes the next one. */
interface Provider {
  adapter: ObservationAdapter
  identity: ProviderIdentity
  cwd: FolderPath
  /** Where the session's records go. */
  transcript: string
}

async function claudeWith(first: string, clock: FakeClock): Promise<Provider> {
  const configDir = await tempDir()
  const record = JSON.parse(first) as { sessionId: string; cwd: string }
  const project = join(configDir, 'projects', record.cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  await mkdir(project, { recursive: true })
  const transcript = join(project, `${record.sessionId}.jsonl`)
  await writeFile(transcript, first)
  return {
    adapter: new ClaudeObservationAdapter({
      providerId: 'claude',
      configDir,
      claimedRoots: [],
      fs: new NodeFs(),
      clock
    }),
    identity: { providerId: 'claude', providerSessionId: record.sessionId },
    cwd: record.cwd as FolderPath,
    transcript
  }
}

async function antigravityWith(first: string, clock: FakeClock): Promise<Provider> {
  const gemini = await tempDir()
  const cid = '11111111-1111-4111-8111-111111111111'
  const tree = join(gemini, 'antigravity-cli')
  const transcript = join(tree, 'brain', cid, '.system_generated', 'logs', 'transcript.jsonl')
  await mkdir(dirname(transcript), { recursive: true })
  await writeFile(transcript, first)
  await writeFile(join(tree, 'history.jsonl'), await readFile(join(ANTIGRAVITY, 'history.jsonl')))
  // The presence lock: the conversation is live.
  await mkdir(join(tree, 'presence'), { recursive: true })
  await writeFile(join(tree, 'presence', `${cid}.lock`), '')
  return {
    adapter: new AntigravityObservationAdapter({
      providerId: 'antigravity',
      geminiDir: gemini,
      claimedRoots: [],
      fs: new NodeFs(),
      clock,
      openSnapshot: openReadOnlySnapshot
    }),
    identity: { providerId: 'antigravity', providerSessionId: cid },
    cwd: 'C:\\Users\\j\\Desktop\\Sample-Project' as FolderPath,
    transcript
  }
}

const CASES = [
  { name: 'claude', folder: CLAUDE, build: claudeWith },
  { name: 'antigravity', folder: ANTIGRAVITY, build: antigravityWith }
] as const

describe('provider errors through the real adapters (fixtures/*/observer/*/format-changed)', () => {
  it('[INV-38] an unreadable format produces a provider error and never throws', async () => {
    for (const { name, folder, build } of CASES) {
      for (const file of ['format-changed.jsonl', 'format-changed-crlf.jsonl']) {
        const label = `${name} ${file}`
        const [first, ...changed] = await recordsOf(folder, file)
        expect(changed.length, label).toBeGreaterThanOrEqual(DRIFT_SURFACE_THRESHOLD)

        const clock = new FakeClock(T0)
        const provider = await build(first!, clock)
        const transactions = new InMemoryTransactions()
        const dwarfs = new InMemoryBoundDwarfs()
        const dwarfId = dwarfs.bind(provider.identity, provider.cwd, T0)
        const cursors = new InMemoryCursorStore(transactions)
        const sessions = new InMemoryObservedSessionStore(transactions, dwarfs)
        const sink = new RecordingObservedBatchSink(transactions)
        for (const p of [cursors, sessions, sink]) transactions.enlist(p)
        const bus = new RecordingEventBus<ObservationEvent>({ transactionScope: transactions })
        const log = new RecordingDiagnosticsLog()
        const loop = new ObservationLoop({
          adapters: [provider.adapter],
          fs: new NodeFs(),
          cursors,
          sessions,
          sink,
          transactions,
          bus,
          clock,
          scheduler: new FakeScheduler(clock),
          ids: new SequenceIdGenerator(),
          hostEpoch: 'epoch-0084',
          log
        })
        const errors = () =>
          bus.published.filter(
            (e): e is ProviderErrorObserved => e.type === 'ProviderErrorObserved'
          )

        // The readable record: written to the dwarf, nothing to report.
        loop.start()
        await loop.whenIdle()
        expect(
          sink.applied.flatMap((b) => b.entries).map((e) => e.text),
          label
        ).toEqual(['Is the build green?'])
        expect(errors(), label).toEqual([])

        // The provider goes on writing in its changed format, one record per poll.
        for (const [n, record] of changed.entries()) {
          await appendFile(provider.transcript, record)
          clock.advance(OBSERVATION_POLL_MS)
          await loop.whenIdle()
          const expected =
            n + 1 < DRIFT_SURFACE_THRESHOLD
              ? []
              : [{ providerId: provider.adapter.providerId, cause: 'unreadable', dwarfId }]
          expect(
            errors().map((e) => e.payload),
            `${label} after ${n + 1}`
          ).toEqual(expected)
        }
        loop.stop()

        // Every changed record is one drift record, and none carries what the provider wrote.
        expect(log.byEvent('observation.drift'), label).toHaveLength(changed.length)
        const written = JSON.stringify([log.entries, log.refused, bus.published])
        for (const text of ['renamed', 'Still drift', 'new format', 'sample-project']) {
          expect(written.includes(text), `${label}: ${text}`).toBe(false)
        }
        // Nothing but the readable record was written to the dwarf.
        expect(
          sink.applied.flatMap((b) => b.entries),
          label
        ).toHaveLength(1)
      }
    }
  })
})
