// layer: L3
// L3 (17 §1.3) of `OpenCodeObservationAdapter` over a real `opencode.db` in a per-test temp store
// root (17 §5.3), with a live writer standing in for OpenCode (13 FM-090; 18 T-30): the store is
// read only through the read-only, WAL-merging snapshot of `host/platform/sqlite` (R11), it is
// never written, and a store the provider holds is read again next cycle.
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeFs } from '../../../../platform/fs/NodeFs'
import { NodeSqliteDatabase } from '../../../../platform/sqlite/NodeSqliteDatabase'
import { openReadOnlySnapshot } from '../../../../platform/sqlite/readOnlySnapshot'
import type { ObservedEvent } from '../../ports/observationAdapter'
import { OpenCodeObservationAdapter } from './OpenCodeObservationAdapter'

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../fixtures/opencode/observer/1.18.x'
)

const temps: string[] = []
const writers: NodeSqliteDatabase[] = []
afterEach(async () => {
  for (const db of writers.splice(0)) {
    try {
      db.close()
    } catch {
      // Already closed by the test.
    }
  }
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'dwarfai-opencode-live-')))
  temps.push(dir)
  return dir
}

async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function textsOf(events: readonly ObservedEvent[]): string[] {
  return events.flatMap((e) => (e.kind === 'entries' ? e.entries.map((x) => x.text) : []))
}

/** One more person turn, as OpenCode writes it: a message row and its text part. */
function personTurn(db: NodeSqliteDatabase, n: number, at: number, text: string): void {
  db.run('INSERT INTO message VALUES (?, ?, ?, ?, ?)', [
    `msg_live_000${n}`,
    'ses_parent_0001',
    at,
    at,
    JSON.stringify({ role: 'user', time: { created: at } })
  ])
  db.run('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)', [
    `prt_live_000${n}`,
    `msg_live_000${n}`,
    'ses_parent_0001',
    at,
    at,
    JSON.stringify({ type: 'text', text })
  ])
}

describe('OpenCodeObservationAdapter over a store being written', () => {
  it('[FM-090] reading while OpenCode writes never writes the database and a busy file is retried next cycle', async () => {
    const root = await tempRoot()
    const path = join(root, 'opencode.db')
    // The provider: a WAL store whose newest commit stays in the WAL (no checkpoint moves it).
    const writer = NodeSqliteDatabase.open(path)
    writers.push(writer)
    writer.exec('PRAGMA wal_autocheckpoint = 0')
    writer.exec(await readFile(join(FIXTURES, 'schema.sql'), 'utf8'))
    writer.exec(await readFile(join(FIXTURES, 'session-parent.sql'), 'utf8'))
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    personTurn(writer, 1, 1790800010000, 'And how is it tested?')

    const mainBefore = await digest(path)
    const walBefore = await digest(`${path}-wal`)
    const filesBefore = (await readdir(root)).sort()
    const opened: string[] = []
    const adapter = new OpenCodeObservationAdapter({
      providerId: 'opencode',
      storeRoot: root,
      openSnapshot: (location) => {
        opened.push(location)
        return openReadOnlySnapshot(location)
      }
    })

    const [source] = await adapter.discover(new NodeFs())
    if (source === undefined) throw new Error('expected the store as a source')
    const first = await adapter.read(source, null)
    // The commit that is only in the WAL is read: an `immutable` open would not see it.
    expect(textsOf(first.events)).toContain('And how is it tested?')
    expect(first.warnings).toEqual([])
    // Every read went through the snapshot factory, on the store's own path (no URI flags).
    expect(opened.length).toBeGreaterThan(0)
    expect(new Set(opened)).toEqual(new Set([path]))
    // Nothing was written: not the database, not its WAL, and no file appeared beside them.
    expect(await digest(path)).toBe(mainBefore)
    expect(await digest(`${path}-wal`)).toBe(walBefore)
    expect((await readdir(root)).sort()).toEqual(filesBefore)

    // The next turn is found; before it is read, OpenCode takes its store exclusively for a third.
    personTurn(writer, 2, 1790800020000, 'Run the tests.')
    const [changed] = await adapter.discover(new NodeFs())
    if (changed === undefined) throw new Error('expected the store as a source')
    writer.exec('PRAGMA locking_mode = EXCLUSIVE')
    personTurn(writer, 3, 1790800030000, 'And the linter.')
    const busy = await adapter.read(changed, first.next)
    expect(busy.events).toEqual([])
    expect(busy.warnings).toEqual([])
    expect(busy.next).toEqual(first.next)
    // Found again while it is held: the last known source, still nothing read and no warning.
    const [held] = await adapter.discover(new NodeFs())
    if (held === undefined) throw new Error('a busy store keeps its last known source')
    const stillBusy = await adapter.read(held, busy.next)
    expect(stillBusy.events).toEqual([])
    expect(stillBusy.warnings).toEqual([])

    // Next cycle, the provider has let go: both turns arrive, once.
    writer.close()
    const [freed] = await adapter.discover(new NodeFs())
    if (freed === undefined) throw new Error('expected the store as a source')
    const next = await adapter.read(freed, stillBusy.next)
    expect(textsOf(next.events)).toEqual(['Run the tests.', 'And the linter.'])
    expect((await adapter.read(freed, next.next)).events).toEqual([])

    // With OpenCode closed there is no WAL, and a read leaves the folder exactly as it was.
    const resting = (await readdir(root)).sort()
    expect(resting).toEqual(['opencode.db'])
    const restingDigest = await digest(path)
    const fresh = new OpenCodeObservationAdapter({
      providerId: 'opencode',
      storeRoot: root,
      openSnapshot: openReadOnlySnapshot
    })
    const [closedSource] = await fresh.discover(new NodeFs())
    if (closedSource === undefined) throw new Error('expected the store as a source')
    expect(textsOf((await fresh.read(closedSource, null)).events)).toContain('Run the tests.')
    expect((await readdir(root)).sort()).toEqual(resting)
    expect(await digest(path)).toBe(restingDigest)
  })
})
