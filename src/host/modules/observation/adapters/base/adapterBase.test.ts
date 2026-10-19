// layer: L2
// L2 (17 §1.2) over fixture files in a per-test temp dir (17 §5.3): the shared observation adapter
// base (15 §5; 05 §3.3 "shared ← providers/feedWindow.ts, firstPrompt.ts, provider.ts"): bounded
// tail reads from a byte-offset cursor (FM-088), a write picked up by polling and a trailing line
// parsed once writes settle (FM-089), root dedupe by file identity and dispatch by the longest
// root prefix (FM-093), and `TranscriptReader.entries` as a bounded window read (ADR-007).
//
// Candidate decision (21 §6): `src/main/providers/feedWindow.ts`, `firstPrompt.ts`, `provider.ts`
// and `src/main/runtime/poller.ts` are replaced. Their 78 tests pass unchanged at the branch point,
// but they are written against today's snapshot `Provider.scan()` and `FsLike`/`FeedMessage`, not
// the cursor-based `ObservationAdapter` and `ObservationControl` of 16 §4.3, and only
// src/legacy-bridge may import them (R16). Their ideas are reimplemented here: the widening window
// steps (#215, #188), the first-person-message rule, and the poller's one-cycle-at-a-time and
// coalesced nudges (#196).
import { appendFile, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId, FolderPath, ProviderIdentity } from '../../../../kernel/domain/values'
import type { FileSystem } from '../../../../kernel/ports/fileSystem'
import { NodeFs } from '../../../../platform/fs/NodeFs'
import type { ObservationEvent } from '../../application/events'
import { OBSERVATION_POLL_MS, ObservationLoop } from '../../application/observationLoop'
import { InMemoryCursorStore } from '../../ports/fakes/InMemoryCursorStore'
import { InMemoryObservedSessionStore } from '../../ports/fakes/InMemoryObservedSessionStore'
import { RecordingObservedBatchSink } from '../../ports/fakes/RecordingObservedBatchSink'
import type { ObservedEvent } from '../../ports/observationAdapter'
import { InMemoryBoundDwarfs } from '../../testing/inMemoryBoundDwarfs'
import { InMemoryTransactions } from '../../testing/inMemoryTransactions'
import {
  JsonlObservationAdapter,
  OBSERVATION_SETTLE_MS,
  OBSERVATION_TAIL_GATE_BYTES,
  type JsonlLine
} from './jsonlObservationAdapter'

const T0 = 1_790_000_000_000
const MINE = '/work/moria' as FolderPath

const roots: string[] = []
const links: string[] = []
afterEach(async () => {
  // A junction is unlinked before its tree is removed, so nothing ever follows it (FM-093 fixture).
  await Promise.all(links.splice(0).map((link) => unlink(link).catch(() => undefined)))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dwarfai-observe-'))
  roots.push(root)
  return root
}

/** One fixture line: a person or dwarf message of a session. */
function line(n: number, role: 'person' | 'dwarf' = 'dwarf', pad = 0): string {
  return JSON.stringify({
    id: `m${n}`,
    session: 's1',
    cwd: MINE,
    role,
    text: `line ${n}`,
    pad: 'x'.repeat(pad)
  })
}

/** The fixture provider's parser: one message per line, a non-JSON line is malformed. */
function parse({ text, streamId, adapterId }: JsonlLine): ObservedEvent[] | null {
  let record: { id?: unknown; session?: unknown; cwd?: unknown; role?: unknown; text?: unknown }
  try {
    record = JSON.parse(text) as typeof record
  } catch {
    return null
  }
  if (typeof record.id !== 'string' || typeof record.session !== 'string') return null
  const identity: ProviderIdentity = { providerId: adapterId, providerSessionId: record.session }
  return [
    {
      kind: 'entries',
      sourceEventId: record.id,
      identity,
      cwd: record.cwd as FolderPath,
      entries: [
        {
          sourceKey: `${adapterId}:${streamId}:${record.id}`,
          role: record.role === 'person' ? 'person' : 'dwarf',
          text: String(record.text),
          providerTime: null
        }
      ]
    }
  ]
}

/** A FileSystem over the real disk that records how many bytes each tail read asked for. */
class MeasuredFs extends NodeFs {
  readonly tailReads: number[] = []
  override readTextTail(path: string, maxBytes: number): Promise<string> {
    this.tailReads.push(maxBytes)
    return super.readTextTail(path, maxBytes)
  }
}

function adapterOver(
  rootsOf: readonly string[],
  extra: {
    fs?: FileSystem
    clock?: FakeClock
    providerId?: string
    claimed?: readonly string[]
  } = {}
) {
  return new JsonlObservationAdapter({
    providerId: extra.providerId ?? 'fixture',
    capabilities: { observe: true },
    roots: rootsOf,
    claimedRoots: extra.claimed ?? [],
    matches: (name) => name.endsWith('.jsonl'),
    parse,
    fs: extra.fs ?? new NodeFs(),
    clock: extra.clock ?? new FakeClock(T0)
  })
}

describe('JsonlObservationAdapter (adapter base)', () => {
  it('[FM-088] a 50 MB fixture transcript is read only from its unread tail, within the size gate', async () => {
    const root = await tempRoot()
    const path = join(root, 'big.jsonl')
    const filler = line(0, 'dwarf', 1_000) + '\n'
    await writeFile(path, filler.repeat(Math.ceil((50 * 1024 * 1024) / filler.length)))
    const fs = new MeasuredFs()
    const adapter = adapterOver([root], { fs })
    const [source] = await adapter.discover(fs)
    expect(source?.size).toBeGreaterThanOrEqual(50 * 1024 * 1024)

    // From no cursor: one read of at most the gate, ending at the file's end.
    const first = await adapter.read(source!, null)
    expect(fs.tailReads).toEqual([OBSERVATION_TAIL_GATE_BYTES])
    expect(OBSERVATION_TAIL_GATE_BYTES).toBeLessThan(50 * 1024 * 1024)
    expect(first.next.value).toBe(source!.size)
    expect(first.warnings).toEqual([])

    // After an append: exactly the unread bytes, nothing before them.
    const appended = line(1) + '\n'
    await appendFile(path, appended)
    const [grown] = await adapter.discover(fs)
    const second = await adapter.read(grown!, first.next)
    expect(fs.tailReads.at(-1)).toBe(Buffer.byteLength(appended))
    expect(second.events.map((e) => e.sourceEventId)).toEqual(['m1'])
    expect(second.next.value).toBe(grown!.size)
  })

  it('[FM-089] with file-system events disabled a write is picked up by the next poll and re-parsed once writes settle', async () => {
    const root = await tempRoot()
    const path = join(root, 'session.jsonl')
    await writeFile(path, line(1, 'person') + '\n')
    const clock = new FakeClock(T0)
    const scheduler = new FakeScheduler(clock)
    const transactions = new InMemoryTransactions()
    const dwarfs = new InMemoryBoundDwarfs()
    dwarfs.bind({ providerId: 'fixture', providerSessionId: 's1' }, MINE, T0)
    const cursors = new InMemoryCursorStore(transactions)
    const sessions = new InMemoryObservedSessionStore(transactions, dwarfs)
    const sink = new RecordingObservedBatchSink(transactions)
    for (const p of [cursors, sessions, sink]) transactions.enlist(p)
    const bus = new RecordingEventBus<ObservationEvent>({ transactionScope: transactions })
    const fs = new NodeFs()
    // No watcher exists at all: the loop's poll is the only way a write is seen.
    const loop = new ObservationLoop({
      adapters: [adapterOver([root], { fs, clock })],
      fs,
      cursors,
      sessions,
      sink,
      transactions,
      bus,
      clock,
      scheduler,
      ids: new SequenceIdGenerator(),
      hostEpoch: 'epoch-0070',
      log: new RecordingDiagnosticsLog()
    })
    const texts = () => sink.applied.flatMap((b) => b.entries.map((e) => e.text))
    const poll = async () => {
      clock.advance(OBSERVATION_POLL_MS)
      await loop.whenIdle()
    }

    loop.start()
    await loop.whenIdle()
    expect(texts()).toEqual(['line 1'])

    // A complete line written between two polls is read by the next poll.
    await appendFile(path, line(2) + '\n')
    await poll()
    expect(texts()).toEqual(['line 1', 'line 2'])

    // A line still being written (no newline yet) is not parsed while the file keeps changing …
    const third = line(3)
    await appendFile(path, third.slice(0, 20))
    await poll()
    await appendFile(path, third.slice(20))
    await poll()
    expect(texts()).toEqual(['line 1', 'line 2'])
    // … and is parsed, once, when the file stopped changing for the settle time.
    expect(OBSERVATION_SETTLE_MS).toBeLessThanOrEqual(OBSERVATION_POLL_MS)
    await poll()
    expect(texts()).toEqual(['line 1', 'line 2', 'line 3'])
    await poll()
    expect(texts()).toEqual(['line 1', 'line 2', 'line 3'])
    loop.stop()
  })

  it('[FM-093] one file reached through two overlapping roots or a reparse point yields one stream, dispatched to the adapter with the longest root prefix', async () => {
    const root = await tempRoot()
    const codexRoot = join(root, 'codex')
    await mkdir(join(codexRoot, 'sessions'), { recursive: true })
    await writeFile(join(codexRoot, 'sessions', 'rollout.jsonl'), line(1) + '\n')
    await writeFile(join(root, 'own.jsonl'), line(2) + '\n')
    // A reparse point onto the same folder (a junction on Windows, a symlink elsewhere).
    const link = join(root, 'link')
    await symlink(codexRoot, link, 'junction')
    links.push(link)

    // One adapter whose roots overlap and reach the file three ways: one stream.
    const alone = adapterOver([root, codexRoot, link])
    const own = await alone.discover(new NodeFs())
    expect(own).toHaveLength(2)
    expect(new Set(own.map((s) => s.fileIdentity)).size).toBe(2)

    // Two adapters: the file under the longer root belongs to that adapter only.
    const broad = adapterOver([root], { providerId: 'broad', claimed: [codexRoot] })
    const narrow = adapterOver([codexRoot, link], { providerId: 'narrow', claimed: [root] })
    const broadSources = await broad.discover(new NodeFs())
    const narrowSources = await narrow.discover(new NodeFs())
    expect(broadSources.map((s) => s.adapterId)).toEqual(['broad'])
    expect(narrowSources.map((s) => s.adapterId)).toEqual(['narrow'])
    expect(broadSources[0]?.fileIdentity).not.toBe(narrowSources[0]?.fileIdentity)
    // The stream id is the same whichever path reached the file.
    const viaLink = await adapterOver([link], { providerId: 'narrow' }).discover(new NodeFs())
    expect(viaLink.map((s) => s.streamId)).toEqual(narrowSources.map((s) => s.streamId))
  })

  it('[ADR-007] TranscriptReader.entries pages a fixture transcript backwards by before and limit, and answers [] for an unreadable file', async () => {
    const root = await tempRoot()
    const path = join(root, 'session.jsonl')
    const lines = Array.from({ length: 30 }, (_, n) =>
      line(n + 1, n % 2 === 0 ? 'person' : 'dwarf')
    )
    await writeFile(path, lines.join('\n') + '\nnot json\n')
    const adapter = adapterOver([root])
    const [source] = await adapter.discover(new NodeFs())
    const ref = {
      dwarfId: '00000000-0000-7000-8000-000000000070' as DwarfId,
      streamIds: [source!.streamId]
    }
    const keyOf = (n: number) => `fixture:${source!.streamId}:m${n}`

    const newest = await adapter.entries(ref, { limit: 5 })
    expect(newest.map((e) => e.text)).toEqual([
      'line 26',
      'line 27',
      'line 28',
      'line 29',
      'line 30'
    ])
    const older = await adapter.entries(ref, { before: keyOf(26), limit: 5 })
    expect(older.map((e) => e.text)).toEqual([
      'line 21',
      'line 22',
      'line 23',
      'line 24',
      'line 25'
    ])
    const first = await adapter.entries(ref, { before: keyOf(3), limit: 5 })
    expect(first.map((e) => e.text)).toEqual(['line 1', 'line 2'])

    await rm(path)
    expect(await adapter.entries(ref, { limit: 5 })).toEqual([])
    expect(await adapter.entries({ ...ref, streamIds: ['fixture:unknown'] }, { limit: 5 })).toEqual(
      []
    )
  })
})
