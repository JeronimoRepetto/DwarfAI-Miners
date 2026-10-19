// layer: L4
// L4 (17 §1.4) observer conformance of `OpenCodeObservationAdapter` over
// `fixtures/opencode/observer/**` (15 §6 C-11, C-19, C-20, C-21; 15 §5 OpenCode row): each case is
// built into an `opencode.db` in a per-test temp store root (17 §5.3) from the measured
// `schema.sql` plus `<case>.sql`, read through the real read-only snapshot (FM-090), and its facts
// are compared with the hand-written `<case>.expected.json` (the `-with-extra` variant shares its
// case's expectation). The fixtures are synthetic (meta.json `capturedBy: ci-synthetic`): the
// recorded ones of ISSUE-319 replace them.
//
// Candidate decision (21 §6): `src/main/providers/opencode/*` is replaced. Its 114 tests pass
// unchanged at the branch point (`pnpm vitest run src/main/providers/opencode`), but they are
// written against today's snapshot `Provider.scan()` over the legacy `SqliteDb`, which reads the
// live file in place and has no cursor, not the watermark `ObservationAdapter` of 16 §4.3 over the
// WAL-safe snapshot (HR O1); it emits no per-message usage, and only src/legacy-bridge may import
// it (R16). Its rules are reimplemented here: `session.parent_id` as the only topology,
// `message.data.parentID` never read as one, text parts as the words, reasoning never shown, the
// archived session skipped, and `session.tokens_*` as the session's lifetime total (Row 14).
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeFs } from '../../../../platform/fs/NodeFs'
import { NodeSqliteDatabase } from '../../../../platform/sqlite/NodeSqliteDatabase'
import { openReadOnlySnapshot } from '../../../../platform/sqlite/readOnlySnapshot'
import type { SourceFile } from '../../ports/observationAdapter'
import { OpenCodeObservationAdapter, openCodeStoreRootOf } from './OpenCodeObservationAdapter'

type OpenCodeRead = Awaited<ReturnType<OpenCodeObservationAdapter['read']>>

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../fixtures/opencode/observer/1.18.x'
)

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A per-test store root, in its real spelling (macOS `/private/var`, Windows 8.3 names). */
async function tempRoot(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'dwarfai-opencode-')))
  temps.push(dir)
  return dir
}

/** Every case of the fixture folder, each with the expectation it is held to. */
async function cases(): Promise<Array<{ file: string; expected: string }>> {
  const names = (await readdir(FIXTURES))
    .filter((name) => name.endsWith('.sql') && name !== 'schema.sql')
    .sort()
  return names.map((file) => ({
    file,
    expected: `${file.replace(/\.sql$/, '').replace(/-with-extra$/, '')}.expected.json`
  }))
}

async function expectation(name: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as Record<string, unknown>
  delete parsed['$comment']
  return parsed
}

/** A store root whose `opencode.db` is built from `schema.sql` and one case, then closed. */
async function storeWith(file: string): Promise<string> {
  const root = await tempRoot()
  const db = NodeSqliteDatabase.open(join(root, 'opencode.db'))
  db.exec(await readFile(join(FIXTURES, 'schema.sql'), 'utf8'))
  db.exec(await readFile(join(FIXTURES, file), 'utf8'))
  db.close()
  return root
}

function adapterAt(storeRoot: string): OpenCodeObservationAdapter {
  return new OpenCodeObservationAdapter({
    providerId: 'opencode',
    storeRoot,
    openSnapshot: openReadOnlySnapshot
  })
}

async function onlySource(adapter: OpenCodeObservationAdapter): Promise<SourceFile> {
  const sources = await adapter.discover(new NodeFs())
  expect(sources).toHaveLength(1)
  return sources[0]!
}

/** The facts of a read in the shape of `<case>.expected.json`. */
async function summary(
  adapter: OpenCodeObservationAdapter,
  source: SourceFile,
  read: OpenCodeRead
) {
  const totals = await adapter.lifetimeTotals(source)
  return {
    warnings: read.warnings.length,
    watermark: read.next.value,
    sessions: read.events.flatMap((e) =>
      e.kind === 'session'
        ? [
            {
              providerSessionId: e.identity.providerSessionId,
              cwd: e.cwd,
              at: e.at,
              parentProviderSessionId: e.parentIdentity?.providerSessionId ?? null
            }
          ]
        : []
    ),
    entries: read.events.flatMap((e) =>
      e.kind === 'entries'
        ? e.entries.map((x) => ({
            providerSessionId: e.identity.providerSessionId,
            sourceKey: x.sourceKey,
            role: x.role,
            text: x.text,
            providerTime: x.providerTime
          }))
        : []
    ),
    usage: read.events.flatMap((e) =>
      e.kind === 'usage'
        ? [
            {
              providerSessionId: e.identity.providerSessionId,
              sourceKey: e.usage.sourceKey,
              unitKey: e.usage.unitKey,
              fidelity: e.usage.fidelity,
              tokens: e.usage.tokens,
              sealed: e.usage.sealed,
              providerTime: e.usage.providerTime
            }
          ]
        : []
    ),
    turnEnds: read.events.flatMap((e) => (e.kind === 'turn-ended' ? [e.end] : [])),
    lifetimeTotals:
      totals.kind === 'totals'
        ? totals.totals.map((t) => ({
            providerSessionId: t.identity.providerSessionId,
            unitKey: t.unitKey,
            tokens: t.tokens,
            newestRecordAt: t.newestRecordAt
          }))
        : totals
  }
}

/** Every deterministic key a read produced (ADR-006 item 2, HO-37). */
function keysOf(read: OpenCodeRead): string[] {
  return [
    ...read.events.map((e) => `${e.kind}:${e.sourceEventId}`),
    ...read.events.flatMap((e) => (e.kind === 'entries' ? e.entries.map((x) => x.sourceKey) : [])),
    ...read.events.flatMap((e) => (e.kind === 'usage' ? [e.usage.sourceKey] : []))
  ]
}

describe('OpenCodeObservationAdapter conformance (fixtures/opencode/observer)', () => {
  it('[C-19] every OpenCode fixture replayed twice yields identical source keys and no new event', async () => {
    const all = await cases()
    expect(all.length).toBeGreaterThanOrEqual(6)
    for (const { file, expected } of all) {
      const root = await storeWith(file)
      const adapter = adapterAt(root)
      const source = await onlySource(adapter)
      const first = await adapter.read(source, null)
      expect(await summary(adapter, source, first), file).toEqual(await expectation(expected))
      expect(first.next.kind, file).toBe('watermark')
      expect(first.next.value, file).toBe(source.size)

      // Read again from the cursor it returned: nothing new.
      const again = await adapter.read(source, first.next)
      expect(again.events, file).toEqual([])
      expect(again.warnings, file).toEqual([])
      expect(again.next, file).toEqual(first.next)

      // Replayed from the start by a fresh adapter (a Host restart): the same keys, in order.
      const replay = await adapterAt(root).read(source, null)
      expect(keysOf(replay), file).toEqual(keysOf(first))
      expect(new Set(keysOf(first)).size, file).toBe(keysOf(first).length)
    }
  })

  it('[C-21] each assistant message yields one sealed usage observation', async () => {
    const adapter = adapterAt(await storeWith('assistant-usage.sql'))
    const read = await adapter.read(await onlySource(adapter), null)
    const usage = read.events.flatMap((e) => (e.kind === 'usage' ? [e.usage] : []))
    // Two finished replies spent tokens (the first in two steps, each with its step-finish part);
    // the one that ended in an error spent nothing.
    expect(usage.map((u) => u.unitKey)).toEqual(['msg_usage_0002', 'msg_usage_0005'])
    for (const u of usage) {
      expect(u.sealed).toBe(true)
      expect(u.fidelity).toBe(1)
    }
    expect(usage[0]!.tokens).toEqual({
      inputNet: 1500,
      output: 100,
      cacheRead: 3500,
      cacheWrite: 150,
      reasoning: 60
    })
    expect(adapter.capabilities().usage).toEqual({ fidelity: 1, rateLimits: false })
  })

  it('[C-21] a reply read while it streams is sealed once, when it finishes', async () => {
    const root = await tempRoot()
    const writer = NodeSqliteDatabase.open(join(root, 'opencode.db'))
    try {
      writer.exec(await readFile(join(FIXTURES, 'schema.sql'), 'utf8'))
      writer.exec(await readFile(join(FIXTURES, 'session-parent.sql'), 'utf8'))
      // A second reply, still streaming: its first step is done, the message is not.
      const step = (input: number) => ({
        type: 'step-finish',
        tokens: { input, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }
      })
      writer.run('INSERT INTO message VALUES (?, ?, ?, ?, ?)', [
        'msg_stream_0001',
        'ses_parent_0001',
        1790800010000,
        1790800011000,
        JSON.stringify({
          role: 'assistant',
          time: { created: 1790800010000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }
        })
      ])
      writer.run('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)', [
        'prt_stream_0001',
        'msg_stream_0001',
        'ses_parent_0001',
        1790800011000,
        1790800011000,
        JSON.stringify(step(100))
      ])
      const adapter = adapterAt(root)
      const units = (read: OpenCodeRead) =>
        read.events.flatMap((e) => (e.kind === 'usage' ? [e.usage] : []))
      const first = await adapter.read(await onlySource(adapter), null)
      expect(units(first).map((u) => u.unitKey)).toEqual(['msg_parent_0002'])

      // The second step finishes and so does the message.
      writer.run('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)', [
        'prt_stream_0002',
        'msg_stream_0001',
        'ses_parent_0001',
        1790800014000,
        1790800014000,
        JSON.stringify(step(50))
      ])
      writer.run('UPDATE message SET time_updated = ?, data = ? WHERE id = ?', [
        1790800014000,
        JSON.stringify({
          role: 'assistant',
          time: { created: 1790800010000, completed: 1790800014000 },
          tokens: { input: 150, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: 'stop'
        }),
        'msg_stream_0001'
      ])
      const second = await adapter.read(await onlySource(adapter), first.next)
      expect(units(second)).toEqual([
        {
          sourceKey: 'opencode:opencode:ses_parent_0001:msg_stream_0001',
          unitKey: 'msg_stream_0001',
          fidelity: 1,
          tokens: { inputNet: 150, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          sealed: true,
          providerTime: 1790800014000
        }
      ])
      expect(units(await adapter.read(await onlySource(adapter), second.next))).toEqual([])
    } finally {
      writer.close()
    }
  })

  it('[ADR-006] a row that commits after a read with an earlier stamp is still read, once', async () => {
    const root = await tempRoot()
    const writer = NodeSqliteDatabase.open(join(root, 'opencode.db'))
    try {
      writer.exec(await readFile(join(FIXTURES, 'schema.sql'), 'utf8'))
      writer.exec(await readFile(join(FIXTURES, 'session-parent.sql'), 'utf8'))
      const adapter = adapterAt(root)
      const first = await adapter.read(await onlySource(adapter), null)
      expect(first.next.value).toBe(1790800009000)

      // OpenCode stamped this person turn before the newest row read, and committed it after.
      writer.run('INSERT INTO message VALUES (?, ?, ?, ?, ?)', [
        'msg_late_0001',
        'ses_parent_0001',
        1790800008500,
        1790800008500,
        JSON.stringify({ role: 'user', time: { created: 1790800008500 } })
      ])
      writer.run('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)', [
        'prt_late_0001',
        'msg_late_0001',
        'ses_parent_0001',
        1790800008500,
        1790800008500,
        JSON.stringify({ type: 'text', text: 'One more thing.' })
      ])
      const late = await adapter.read(await onlySource(adapter), first.next)
      expect(keysOf(late)).toEqual([
        'entries:prt_late_0001',
        'opencode:opencode:ses_parent_0001:prt_late_0001'
      ])
      expect((await adapter.read(await onlySource(adapter), late.next)).events).toEqual([])
    } finally {
      writer.close()
    }
  })

  it('[C-20] with no turn-end signal the adapter declares turnEnd none', async () => {
    expect(adapterAt(await tempRoot()).capabilities().turnEnd).toBe('none')
    // No case yields a turn end, not even a reply whose `finish` is "stop" (S-021-2 is partial:
    // no event of OpenCode's is known to end a turn, ADR-021 item 4).
    for (const { file } of await cases()) {
      const adapter = adapterAt(await storeWith(file))
      const read = await adapter.read(await onlySource(adapter), null)
      expect(
        read.events.filter((e) => e.kind === 'turn-ended'),
        file
      ).toEqual([])
    }
  })

  it('[C-11, FM-086] a malformed part is skipped with a warning', async () => {
    const adapter = adapterAt(await storeWith('malformed-part.sql'))
    const source = await onlySource(adapter)
    const read = await adapter.read(source, null)
    // Three unreadable parts and one unreadable message, each a warning naming its row id and
    // nothing it held.
    expect(read.warnings).toEqual([
      'unreadable part prt_bad_0002',
      'unreadable part prt_bad_0003',
      'unreadable part prt_bad_0004',
      'unreadable message msg_bad_0002'
    ])
    // The rows around them still read.
    const texts = read.events.flatMap((e) =>
      e.kind === 'entries' ? e.entries.map((x) => x.text) : []
    )
    expect(texts).toEqual(['Is the build green?', 'Yes, all checks passed.'])
    expect(read.next.value).toBe(source.size)
  })

  it('[ADR-015] a child session is a subagent identity of its parent session', async () => {
    const adapter = adapterAt(await storeWith('session-child.sql'))
    const read = await adapter.read(await onlySource(adapter), null)
    const child = read.events.find(
      (e) => e.kind === 'session' && e.identity.providerSessionId === 'ses_child_0002'
    )
    expect(child?.kind === 'session' ? child.parentIdentity : undefined).toEqual({
      providerId: 'opencode',
      providerSessionId: 'ses_root_0002'
    })
    // The parent is announced before its child, and the child's words are its own identity's.
    const order = read.events.flatMap((e) =>
      e.kind === 'session' ? [e.identity.providerSessionId] : []
    )
    expect(order).toEqual(['ses_root_0002', 'ses_child_0002'])
    const childWords = read.events.flatMap((e) =>
      e.kind === 'entries' && e.identity.providerSessionId === 'ses_child_0002'
        ? e.entries.map((x) => x.text)
        : []
    )
    expect(childWords).toEqual(['Count the test files in the project.', 'There are 42 test files.'])
    expect(adapter.capabilities().subagents).toBe('transcript')
  })

  it("[ADR-006] a session's lifetime token total is exposed with the coal:<streamId> unit key", async () => {
    const adapter = adapterAt(await storeWith('assistant-usage.sql'))
    const source = await onlySource(adapter)
    const totals = await adapter.lifetimeTotals(source)
    if (totals.kind !== 'totals') throw new Error(`expected totals, got ${totals.kind}`)
    expect(totals.totals).toHaveLength(1)
    const total = totals.totals[0]!
    expect(total.streamId).toBe('opencode:session:ses_usage_0004')
    expect(total.unitKey).toBe(`coal:${total.streamId}`)
    expect(total.newestRecordAt).toBe(1790830040000)
    // The lifetime total equals the sum of the session's per-message units (Row 14).
    const read = await adapter.read(source, null)
    const sum = { inputNet: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
    for (const e of read.events) {
      if (e.kind !== 'usage') continue
      for (const k of Object.keys(sum) as Array<keyof typeof sum>) sum[k] += e.usage.tokens[k]
    }
    expect(total.tokens).toEqual(sum)
  })

  it('[ADR-014] the adapter declares no verified process identity', async () => {
    const adapter = adapterAt(await tempRoot())
    expect(adapter.processIdentitySource).toBe('none')
    expect(adapter.capabilities().console).toBe('log')
    for (const { file } of await cases()) {
      const fresh = adapterAt(await storeWith(file))
      const read = await fresh.read(await onlySource(fresh), null)
      expect(JSON.stringify(read), file).not.toMatch(/"pid"|processIdentity/i)
    }
  })

  it('[FM-091] the adapter reads ~/.local/share/opencode and finds nothing without a database', async () => {
    const home = join('/home', 'j')
    expect(openCodeStoreRootOf(home)).toBe(join(home, '.local', 'share', 'opencode'))
    const root = await storeWith('session-parent.sql')
    expect(await adapterAt(root).discover(new NodeFs())).toHaveLength(1)
    expect(await adapterAt(join(root, 'elsewhere')).discover(new NodeFs())).toEqual([])
  })
})
