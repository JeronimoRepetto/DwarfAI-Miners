// layer: L3
// L3 (17 §1.3): `ProviderHistoryScanner` runs the HistoricalUsageScanner contract the double runs
// (16 §2.8), over provider history written to a per-test temporary folder, plus the per-provider
// cases of 09 §5.5. Every record is synthetic, written by hand in the shapes of the providers' own
// files (15 §5; transplanted shapes of `coalScan.test.ts` at `0bfd108`): no real path, name or
// conversation text.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FolderPath, MineId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import type { FileSystem } from '../../../kernel/ports/fileSystem'
import { NodeFs } from '../../../platform/fs/NodeFs'
import { NodeSqliteDatabase } from '../../../platform/sqlite/NodeSqliteDatabase'
import {
  openReadOnlySnapshot,
  type ReadOnlySnapshotOpener
} from '../../../platform/sqlite/readOnlySnapshot'
import {
  collect,
  runHistoricalUsageScannerContract,
  scanBudget,
  SCAN_BEFORE,
  type ContractHistory
} from '../testing/historicalUsageScanner.contract'
import { ProviderHistoryScanner, type ProviderHistoryScannerDeps } from './ProviderHistoryScanner'

const B = SCAN_BEFORE
const MINE = '00000000-0000-7000-8000-000000000770' as MineId
const MINE_FOLDER = '/work/mine-a'
const ELSEWHERE = '/work/not-a-mine'

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dwarfai-coal-'))
  temps.push(dir)
  return dir
}

const iso = (at: number) => new Date(at).toISOString()

/** One Claude transcript row of an assistant message (`message.id` is the live unit key). */
function claudeRow(id: string, at: number, cwd: string, usage: Record<string, number>): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: iso(at),
    cwd,
    sessionId: 'session-synthetic',
    message: { id, role: 'assistant', usage }
  })
}

const claudeUsage = (input: number) => ({
  input_tokens: input,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0
})

/** One Codex rollout whose lifetime total is `tokens` and whose newest record is at `at`. */
function codexRollout(threadId: string, tokens: number, at: number, cwd: string): string {
  return [
    JSON.stringify({
      timestamp: iso(at - 60_000),
      type: 'session_meta',
      payload: { id: threadId, cwd, timestamp: iso(at - 60_000) }
    }),
    JSON.stringify({
      timestamp: iso(at),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: tokens,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: tokens
          }
        }
      }
    })
  ].join('\n')
}

/** A FileSystem whose reads under `broken` reject, as a vanished or locked file does. */
function faultyFs(inner: FileSystem, broken: readonly string[]): FileSystem {
  const fails = (path: string) => broken.some((prefix) => path.startsWith(prefix))
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'readTextTail' || property === 'readTextHead') {
        return (path: string, maxBytes: number) =>
          fails(path) ? Promise.reject(new Error('EBUSY')) : target[property](path, maxBytes)
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

const resolveMine = (folder: FolderPath) => Promise.resolve(folder === MINE_FOLDER ? MINE : null)

const noStore: ReadOnlySnapshotOpener = () =>
  Promise.resolve({ kind: 'unavailable', code: 'not-found' })

function scannerOver(
  overrides: Partial<ProviderHistoryScannerDeps> & Pick<ProviderHistoryScannerDeps, 'fs'>
) {
  return new ProviderHistoryScanner({
    clock: new FakeClock(B + 10_000),
    openSnapshot: noStore,
    claudeRoots: [],
    codexHome: null,
    opencodeStoreRoot: null,
    resolveMine,
    ...overrides
  })
}

/** The contract history as Claude project directories (per-unit) and Codex days (lifetime). */
async function providerSubject(history: ContractHistory) {
  const root = await tempRoot()
  const claudeRoot = join(root, 'claude')
  const codexHome = join(root, 'codex')
  const units = new Map<string, { dir: string; adapter: string; files: number }>()
  let day = 0
  for (const unit of history.units) {
    if (unit.shape === 'per-unit') {
      const dir = join(claudeRoot, 'projects', unit.name)
      await mkdir(dir, { recursive: true })
      const rows = unit.records.map((r) =>
        claudeRow(r.id, r.at, r.inMine ? MINE_FOLDER : ELSEWHERE, claudeUsage(r.tokens))
      )
      await writeFile(join(dir, `session-${unit.name}.jsonl`), `${rows.join('\n')}\n`)
      units.set(unit.name, { dir, adapter: 'claude', files: 1 })
    } else {
      day += 1
      const dir = join(codexHome, 'sessions', '2026', '01', `0${day}`)
      await mkdir(dir, { recursive: true })
      for (const r of unit.records) {
        await writeFile(
          join(dir, `rollout-2026-01-0${day}T00-00-00-${r.id}.jsonl`),
          codexRollout(r.id, r.tokens, r.at, r.inMine ? MINE_FOLDER : ELSEWHERE)
        )
      }
      units.set(unit.name, { dir, adapter: 'codex', files: unit.records.length })
    }
  }
  const broken = history.units
    .filter((unit) => unit.unreadable === true)
    .map((unit) => units.get(unit.name)?.dir ?? '')
  const scanner = scannerOver({
    fs: faultyFs(new NodeFs(), broken),
    claudeRoots: [claudeRoot],
    codexHome
  })
  const shapeOf = (name: string) => history.units.find((u) => u.name === name)?.shape
  return {
    scanner,
    mineId: MINE,
    scanUnitOf: (name: string) => {
      const unit = units.get(name)
      return unit === undefined ? '' : `${unit.adapter}:${unit.dir}`
    },
    unitKeyOf: (unit: string, record: string) =>
      shapeOf(unit) === 'lifetime' ? `coal:${record}` : record,
    filesOf: (name: string) => units.get(name)?.files ?? 0,
    dispose: () => undefined
  }
}

describe('ProviderHistoryScanner', () => {
  runHistoricalUsageScannerContract(providerSubject)

  it('[ADR-006] a Claude message written in several rows is one unit with its final usage, and rows without usage, cwd or time pay nothing', async () => {
    const root = await tempRoot()
    const dir = join(root, 'projects', 'project-a')
    await mkdir(join(dir, 'session-1', 'subagents'), { recursive: true })
    const rows = [
      '{"partial line cut by the tail',
      claudeRow('msg-1', B - 9_000, MINE_FOLDER, claudeUsage(100)),
      claudeRow('msg-1', B - 8_000, MINE_FOLDER, {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40
      }),
      JSON.stringify({ type: 'user', timestamp: iso(B - 7_000), cwd: MINE_FOLDER }),
      JSON.stringify({
        type: 'assistant',
        timestamp: iso(B - 6_000),
        message: { id: 'msg-no-cwd', usage: claudeUsage(5) }
      }),
      JSON.stringify({
        type: 'assistant',
        cwd: MINE_FOLDER,
        message: { id: 'msg-no-time', usage: claudeUsage(5) }
      })
    ]
    await writeFile(join(dir, 'session-1.jsonl'), rows.join('\r\n'))
    await writeFile(
      join(dir, 'session-1', 'subagents', 'agent-1.jsonl'),
      claudeRow('msg-sub', B - 1, MINE_FOLDER, claudeUsage(9))
    )
    await writeFile(join(dir, 'notes.txt'), 'not a transcript')

    const items = await collect(
      scannerOver({ fs: new NodeFs(), claudeRoots: [root] }).scan(
        B,
        scanBudget(),
        new AbortController().signal
      )
    )

    expect(items).toEqual([
      {
        kind: 'scanned',
        scanUnit: `claude:${dir}`,
        adapterId: 'claude',
        records: [
          { unitKey: 'msg-1', span: 'unit', mineId: MINE, tokens: 100, providerTime: B - 8_000 }
        ]
      }
    ])
  })

  it('[S19.03] a unit reads at most its per-directory budget and the time budget stops the scan between units', async () => {
    const root = await tempRoot()
    for (const name of ['project-a', 'project-b']) {
      const dir = join(root, 'projects', name)
      await mkdir(dir, { recursive: true })
      for (const n of [1, 2, 3]) {
        await writeFile(
          join(dir, `s-${n}.jsonl`),
          claudeRow(`${name}-msg-${n}`, B - n, MINE_FOLDER, claudeUsage(n))
        )
      }
    }
    const clock = new FakeClock(B + 10_000)
    const fs = new NodeFs()
    // Each file read takes 1 s of the run's time budget.
    const slow = new Proxy(fs, {
      get(target, property, receiver) {
        if (property === 'readTextTail') {
          return (path: string, maxBytes: number) => {
            clock.advance(1_000)
            return target.readTextTail(path, maxBytes)
          }
        }
        const value: unknown = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })

    const items = await collect(
      scannerOver({ fs: slow, clock, claudeRoots: [root] }).scan(
        B,
        scanBudget({ maxFilesPerDir: 2, maxDurationMs: 2_000 }),
        new AbortController().signal
      )
    )

    expect(items).toEqual([
      {
        kind: 'scanned',
        scanUnit: `claude:${join(root, 'projects', 'project-a')}`,
        adapterId: 'claude',
        records: [
          {
            unitKey: 'project-a-msg-1',
            span: 'unit',
            mineId: MINE,
            tokens: 1,
            providerTime: B - 1
          },
          { unitKey: 'project-a-msg-2', span: 'unit', mineId: MINE, tokens: 2, providerTime: B - 2 }
        ]
      },
      { kind: 'budget-reached' }
    ])
  })

  it('[ADR-006, INV-95] the OpenCode store is one unit of lifetime session totals: a session updated after the moment pays nothing, and a busy store is unreadable', async () => {
    const storeRoot = await tempRoot()
    const location = join(storeRoot, 'opencode.db')
    const db = NodeSqliteDatabase.open(location)
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER,
      time_updated INTEGER, time_archived INTEGER, tokens_input INTEGER, tokens_output INTEGER,
      tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER)`)
    const add = (id: string, dir: string, updated: number, archived: number | null) =>
      db.run('INSERT INTO session VALUES (?, ?, ?, ?, ?, 100, 20, 3, 4, 5)', [
        id,
        dir,
        updated - 1,
        updated,
        archived
      ])
    add('ses-old', MINE_FOLDER, B - 1, null)
    add('ses-straddling', MINE_FOLDER, B, null)
    add('ses-elsewhere', ELSEWHERE, B - 1, null)
    add('ses-archived', MINE_FOLDER, B - 1, B - 1)
    db.close()

    const items = await collect(
      scannerOver({
        fs: new NodeFs(),
        opencodeStoreRoot: storeRoot,
        openSnapshot: openReadOnlySnapshot
      }).scan(B, scanBudget(), new AbortController().signal)
    )
    expect(items).toEqual([
      {
        kind: 'scanned',
        scanUnit: `opencode:${location}`,
        adapterId: 'opencode',
        records: [
          {
            unitKey: 'coal:ses-old',
            span: 'lifetime',
            mineId: MINE,
            tokens: 132,
            providerTime: B - 1
          }
        ]
      }
    ])

    const busy = await collect(
      scannerOver({
        fs: new NodeFs(),
        opencodeStoreRoot: storeRoot,
        openSnapshot: () => Promise.resolve({ kind: 'retry-next-cycle', code: 'SQLITE_BUSY' })
      }).scan(B, scanBudget(), new AbortController().signal)
    )
    expect(busy).toEqual([
      {
        kind: 'unreadable',
        scanUnit: `opencode:${location}`,
        adapterId: 'opencode',
        errCode: 'SQLITE_BUSY'
      }
    ])

    // A store that does not exist is no unit at all: OpenCode was never used here.
    expect(
      await collect(
        scannerOver({ fs: new NodeFs(), opencodeStoreRoot: join(storeRoot, 'none') }).scan(
          B,
          scanBudget(),
          new AbortController().signal
        )
      )
    ).toEqual([])
  })
})
