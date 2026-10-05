// layer: L4
// L4 (17 §1.4) observer conformance of `CodexObservationAdapter` over `fixtures/codex/observer/**`
// (15 §6 C-11, C-19, C-20, C-21; 15 §5 Codex row): each rollout case is replayed from a per-test
// temp `CODEX_HOME` (17 §5.3) through the real file system, and its facts are compared with the
// hand-written `<case>.expected.json` (the `-crlf` and `-with-extra` variants share their case's
// expectation). The state database is built from `state.sql` and read through the read-only
// snapshot (FM-090). The fixtures are synthetic (meta.json `capturedBy: ci-synthetic`): the
// recorded ones of ISSUE-319 replace them.
//
// Candidate decision (21 §6): `src/main/providers/codex/*` is replaced. Its 247 tests pass
// unchanged at the branch point (`pnpm vitest run src/main/providers/codex`), but they are written
// against today's snapshot `Provider.scan()`, `parseCodexRolloutTail` over a whole tail and the
// legacy `SqliteDb`, not the cursor-based `ObservationAdapter` of 16 §4.3; the candidate differences
// no usage at all, and only src/legacy-bridge may import it (R16). Its rules are reimplemented
// here: the session_meta head, `task_complete` / `turn_aborted` (#219, #34), the person-line rule
// for `codex exec` (#458), the `\\?\` cwd prefix and the sub-agent spawn blob of `threads.source`.
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { NodeFs } from '../../../../platform/fs/NodeFs'
import { NodeSqliteDatabase } from '../../../../platform/sqlite/NodeSqliteDatabase'
import {
  openReadOnlySnapshot,
  type ReadOnlySnapshot
} from '../../../../platform/sqlite/readOnlySnapshot'
import type { Cursor, SourceFile } from '../../ports/observationAdapter'
import { CodexObservationAdapter, codexHomeOf, type CodexRead } from './CodexObservationAdapter'

const T0 = 1_790_800_000_000
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../fixtures/codex/observer/0.153.x'
)

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dwarfai-codex-'))
  temps.push(dir)
  return dir
}

/** The rollout cases of the fixture folder, each with the expectation it is held to. */
async function rolloutCases(): Promise<Array<{ file: string; expected: string }>> {
  const names = (await readdir(FIXTURES)).filter((name) => name.endsWith('.jsonl')).sort()
  return names.map((file) => ({
    file,
    expected: `${file.replace(/\.jsonl$/, '').replace(/-(crlf|with-extra)$/, '')}.expected.json`
  }))
}

async function expectation(name: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as Record<string, unknown>
  delete parsed['$comment']
  return parsed
}

function adapterAt(
  codexHome: string,
  extra: { openSnapshot?: (location: string) => Promise<ReadOnlySnapshot> } = {}
) {
  return new CodexObservationAdapter({
    providerId: 'codex',
    codexHome,
    claimedRoots: [],
    fs: new NodeFs(),
    clock: new FakeClock(T0),
    openSnapshot: extra.openSnapshot ?? openReadOnlySnapshot
  })
}

/** A `CODEX_HOME` holding one rollout case, copied byte for byte (CRLF kept). */
async function homeWithRollout(file: string): Promise<{ home: string; path: string }> {
  const home = await tempHome()
  const folder = join(home, 'sessions', '2026', '09', '30')
  await mkdir(folder, { recursive: true })
  const path = join(folder, `rollout-2026-09-30T00-00-00-${file.replace(/\.jsonl$/, '')}.jsonl`)
  await writeFile(path, await readFile(join(FIXTURES, file)))
  return { home, path }
}

/** A `CODEX_HOME` holding the state database built from `state.sql`. */
async function homeWithState(): Promise<string> {
  const home = await tempHome()
  const db = NodeSqliteDatabase.open(join(home, 'state_5.sqlite'))
  db.exec(await readFile(join(FIXTURES, 'state.sql'), 'utf8'))
  db.close()
  return home
}

async function onlySource(
  adapter: CodexObservationAdapter,
  kind: 'rollout' | 'state'
): Promise<SourceFile> {
  const sources = (await adapter.discover(new NodeFs())).filter((s) =>
    kind === 'state' ? s.path.endsWith('state_5.sqlite') : s.path.endsWith('.jsonl')
  )
  expect(sources).toHaveLength(1)
  return sources[0]!
}

/** The facts of a read in the shape of `<case>.expected.json`. */
function summary(read: CodexRead) {
  const session = read.events.find((e) => e.kind === 'session')
  return {
    warnings: read.warnings.length,
    session:
      session?.kind === 'session'
        ? {
            providerSessionId: session.identity.providerSessionId,
            cwd: session.cwd,
            at: session.at,
            parentProviderSessionId: session.parentIdentity?.providerSessionId ?? null
          }
        : null,
    entries: read.events.flatMap((e) =>
      e.kind === 'entries'
        ? e.entries.map((x) => ({ role: x.role, text: x.text, providerTime: x.providerTime }))
        : []
    ),
    activity: read.events.flatMap((e) => (e.kind === 'activity' ? [e.activity] : [])),
    turnEnds: read.turnEnds.map((t) => t.end),
    usage: read.events.flatMap((e) =>
      e.kind === 'usage'
        ? [
            {
              unitKey: e.usage.unitKey,
              fidelity: e.usage.fidelity,
              tokens: e.usage.tokens,
              sealed: e.usage.sealed,
              providerTime: e.usage.providerTime
            }
          ]
        : []
    )
  }
}

/** Every deterministic key a read produced (ADR-006 item 2, HO-37). */
function keysOf(read: CodexRead): string[] {
  return [
    ...read.events.map((e) => `${e.kind}:${e.sourceEventId}`),
    ...read.events.flatMap((e) => (e.kind === 'entries' ? e.entries.map((x) => x.sourceKey) : [])),
    ...read.events.flatMap((e) => (e.kind === 'usage' ? [e.usage.sourceKey] : [])),
    ...read.turnEnds.map((t) => `turn:${t.sourceEventId}:${t.end.turnKey}`)
  ]
}

/** The state database's facts in the shape of `state.expected.json`. */
function stateSummary(read: CodexRead) {
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
    )
  }
}

describe('CodexObservationAdapter conformance (fixtures/codex/observer)', () => {
  it('[C-19] every Codex fixture replayed twice yields identical source keys and no new event', async () => {
    const cases = await rolloutCases()
    expect(cases.length).toBeGreaterThanOrEqual(9)
    for (const { file, expected } of cases) {
      const { home } = await homeWithRollout(file)
      const adapter = adapterAt(home)
      const source = await onlySource(adapter, 'rollout')
      const first = await adapter.readWithTurnEnds(source, null)
      expect(summary(first), file).toEqual(await expectation(expected))
      expect(first.next.value, file).toBe(source.size)

      // Read again from the cursor it returned: nothing new.
      const again = await adapter.readWithTurnEnds(source, first.next)
      expect(again.events, file).toEqual([])
      expect(again.turnEnds, file).toEqual([])
      expect(again.next, file).toEqual(first.next)

      // Replayed from the start by a fresh adapter (a Host restart): the same keys, in order.
      const replay = await adapterAt(home).readWithTurnEnds(source, null)
      expect(keysOf(replay), file).toEqual(keysOf(first))
      expect(new Set(keysOf(first)).size, file).toBe(keysOf(first).length)
    }

    const home = await homeWithState()
    const adapter = adapterAt(home)
    const state = await onlySource(adapter, 'state')
    const first = await adapter.readWithTurnEnds(state, null)
    expect(stateSummary(first)).toEqual(await expectation('state.expected.json'))
    expect(first.next.kind).toBe('watermark')
    const again = await adapter.readWithTurnEnds(state, first.next)
    expect(again.events).toEqual([])
    const replay = await adapterAt(home).readWithTurnEnds(state, null)
    expect(keysOf(replay)).toEqual(keysOf(first))
  })

  it('[C-11, FM-086] a malformed rollout line is skipped with a warning', async () => {
    for (const file of ['malformed-line.jsonl', 'malformed-line-crlf.jsonl']) {
      const { home } = await homeWithRollout(file)
      const adapter = adapterAt(home)
      const source = await onlySource(adapter, 'rollout')
      const read = await adapter.readWithTurnEnds(source, null)
      // Three unreadable lines, each a warning naming its byte offset and nothing it held.
      expect(read.warnings, file).toHaveLength(3)
      for (const warning of read.warnings) {
        expect(warning, file).toMatch(/^unreadable line at byte \d+$/)
      }
      // The lines around them still read, and the record of an unknown type is no warning.
      expect(
        summary(read).entries.map((e) => e.text),
        file
      ).toEqual(['Is the build green?', 'Yes, all checks passed.'])
      expect(
        read.turnEnds.map((t) => t.end.kind),
        file
      ).toEqual(['concluded'])
      expect(read.next.value, file).toBe(source.size)
    }
  })

  it('[C-20] task_complete and turn_aborted map to reliable turn ends and an unknown value maps to errored', async () => {
    const ends = []
    for (const file of ['turn-with-usage.jsonl', 'turn-aborted.jsonl']) {
      const { home } = await homeWithRollout(file)
      const adapter = adapterAt(home)
      const read = await adapter.readWithTurnEnds(await onlySource(adapter, 'rollout'), null)
      ends.push(...read.turnEnds.map((t) => t.end))
      for (const { end } of read.turnEnds) {
        expect(end.reliability).toBe('reliable')
        expect(end.cancelledFromApp).toBe(false)
      }
    }
    expect(ends.map((e) => [e.kind, e.detail])).toEqual([
      ['concluded', undefined],
      ['concluded', undefined],
      ['interrupted', undefined],
      ['errored', 'synthetic_unknown_reason']
    ])
    expect(adapterAt(await tempHome()).capabilities().turnEnd).toBe('reliable')
  })

  it('[C-21] lifetime usage is differenced into one sealed observation per turn id', async () => {
    const expected = (await expectation('turn-with-usage.expected.json'))['usage']
    const fixture = await readFile(join(FIXTURES, 'turn-with-usage.jsonl'), 'utf8')
    const lines = fixture.split('\n').filter((line) => line !== '')

    // Whole file at once.
    const whole = await homeWithRollout('turn-with-usage.jsonl')
    const adapter = adapterAt(whole.home)
    const read = await adapter.readWithTurnEnds(await onlySource(adapter, 'rollout'), null)
    expect(summary(read).usage).toEqual(expected)

    // One line per poll: the same units, each sealed exactly once.
    const home = await tempHome()
    const folder = join(home, 'sessions', '2026', '09', '30')
    await mkdir(folder, { recursive: true })
    const path = join(folder, 'rollout-2026-09-30T00-00-00-streamed.jsonl')
    await writeFile(path, '')
    const streamed = adapterAt(home)
    let cursor: Cursor | null = null
    const units: unknown[] = []
    for (const line of lines) {
      await appendFile(path, line + '\n')
      const step = await streamed.readWithTurnEnds(await onlySource(streamed, 'rollout'), cursor)
      units.push(...summary(step).usage)
      cursor = step.next
    }
    expect(units).toEqual(expected)

    // A Host restart with the cursor between the two turns: a fresh adapter still differences
    // the second turn against the lifetime total before it.
    const between = Buffer.byteLength(lines.slice(0, 12).join('\n') + '\n')
    const restarted = adapterAt(whole.home)
    const source = await onlySource(restarted, 'rollout')
    const resumed = await restarted.readWithTurnEnds(source, {
      adapterId: 'codex',
      kind: 'byte-offset',
      value: between,
      fileIdentity: source.fileIdentity
    })
    expect(summary(resumed).usage).toEqual([(expected as unknown[])[1]])
  })

  it('[ADR-014] the adapter declares no readable process identity', async () => {
    const adapter = adapterAt(await tempHome())
    expect(adapter.processIdentitySource).toBe('none')
    // No pid to focus or kill: the console is the log (15 §3.2 row X3).
    expect(adapter.capabilities().console).toBe('log')
    // And no observed fact carries one.
    for (const { file } of await rolloutCases()) {
      const { home } = await homeWithRollout(file)
      const fresh = adapterAt(home)
      const read = await fresh.readWithTurnEnds(await onlySource(fresh, 'rollout'), null)
      expect(JSON.stringify(read), file).not.toMatch(/"pid"|processIdentity/i)
    }
  })

  it('[FM-091] the adapter reads CODEX_HOME when it is set and ~/.codex otherwise', async () => {
    const home = join('/home', 'j')
    expect(codexHomeOf({}, home)).toBe(join(home, '.codex'))
    expect(codexHomeOf({ CODEX_HOME: '' }, home)).toBe(join(home, '.codex'))
    expect(codexHomeOf({ CODEX_HOME: join('/data', 'codex') }, home)).toBe(join('/data', 'codex'))

    const { home: codexHome } = await homeWithRollout('turn-with-usage.jsonl')
    expect(await adapterAt(codexHome).discover(new NodeFs())).toHaveLength(1)
    expect(await adapterAt(join(codexHome, 'elsewhere')).discover(new NodeFs())).toEqual([])
  })

  it('[FM-090] a busy Codex state database is read again next cycle, with no event and no warning', async () => {
    const home = await homeWithState()
    let busy = true
    const adapter = adapterAt(home, {
      openSnapshot: (location) =>
        busy
          ? Promise.resolve({ kind: 'retry-next-cycle', code: 'SQLITE_BUSY' })
          : openReadOnlySnapshot(location)
    })
    busy = false
    const state = await onlySource(adapter, 'state')
    busy = true
    const blocked = await adapter.readWithTurnEnds(state, null)
    expect(blocked.events).toEqual([])
    expect(blocked.warnings).toEqual([])
    expect(blocked.next.value).toBe(0)
    busy = false
    const next = await adapter.readWithTurnEnds(state, null)
    expect(stateSummary(next).sessions).toHaveLength(3)
  })
})
