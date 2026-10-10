// layer: L4
// L4 (17 §1.4) observer conformance of `ClaudeObservationAdapter` over `fixtures/claude/observer/**`
// (15 §6 C-11, C-19, C-20, C-21; 15 §5 Claude row): each case is replayed from a per-test temp
// Claude configuration folder (17 §5.3) through the real file system, laid out as Claude Code
// lays it out (`projects/<encoded cwd>/<sessionId>.jsonl`, and a subagent at
// `<sessionId>/subagents/agent-<id>.jsonl` beside its `agent-<id>.meta.json` sidecar), and its facts
// are compared with the hand-written `<case>.expected.json` (the `-crlf` and `-with-extra` variants
// share their case's expectation). The fixtures are synthetic (meta.json `capturedBy:
// ci-synthetic`): the recorded ones of ISSUE-319 replace them.
//
// Candidate decision (21 §6): `src/main/providers/claude/parse.ts` and `subagents.ts` are replaced.
// Their 396 tests pass unchanged at the branch point (`pnpm vitest run src/main/providers/claude`:
// 2 files, 396 passed), but they are written against today's snapshot `Provider.scan()`,
// `parseClaudeTranscriptTail` / `extractClaudeFeed` over a whole tail and the legacy `FsLike`, not
// the cursor-based `ObservationAdapter` of 16 §4.3: the candidate keeps a "latest observed" token
// floor instead of one sealed observation per `message.id` (ADR-006 item 4), keys nothing
// (ADR-006 item 2), and only src/legacy-bridge may import it (R16). Its tests stay where they are,
// with the legacy provider they cover (no test removed). Its rules are reimplemented here: the
// lossy project-folder encoding with the real cwd from the records, the sidecar's
// `parentAgentId` (#267, #391), the person-line rules (#188 compaction flags, #216 block arrays,
// meta and tag-opened lines, #180 a message typed mid-turn) and the `tool_result`-only lines.
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderIdentity } from '../../../../kernel/domain/values'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import type { FileSystem } from '../../../../kernel/ports/fileSystem'
import { NodeFs } from '../../../../platform/fs/NodeFs'
import type { Cursor, ObservedEvent, SourceFile } from '../../ports/observationAdapter'
import {
  ClaudeObservationAdapter,
  claudeConfigDirOf,
  claudeConfigDirsOf
} from './ClaudeObservationAdapter'

type ClaudeRead = Awaited<ReturnType<ClaudeObservationAdapter['read']>>

const T0 = 1_790_800_000_000
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../fixtures/claude/observer/2.1.x'
)

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dwarfai-claude-'))
  temps.push(dir)
  return dir
}

/** Claude Code's own project-folder name: every non-alphanumeric character becomes a dash. */
function encodedFolderOf(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** The JSONL cases of the fixture folder, each with the expectation it is held to. */
async function transcriptCases(): Promise<Array<{ file: string; base: string; expected: string }>> {
  const names = (await readdir(FIXTURES)).filter((name) => name.endsWith('.jsonl')).sort()
  return names.map((file) => {
    const base = file.replace(/\.jsonl$/, '').replace(/-(crlf|with-extra)$/, '')
    return { file, base, expected: `${base}.expected.json` }
  })
}

async function expectation(name: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as Record<string, unknown>
  delete parsed['$comment']
  return parsed
}

function adapterAt(configDir: string, fs: FileSystem = new NodeFs()) {
  return new ClaudeObservationAdapter({
    providerId: 'claude',
    configDir,
    claimedRoots: [],
    fs,
    clock: new FakeClock(T0)
  })
}

/** Who a fixture's records say wrote it: the first record that names a session. */
async function writerOf(
  file: string
): Promise<{ sessionId: string; agentId?: string; cwd: string }> {
  const text = await readFile(join(FIXTURES, file), 'utf8')
  for (const line of text.split(/\r?\n/)) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>
      if (typeof record['sessionId'] === 'string' && typeof record['cwd'] === 'string') {
        return {
          sessionId: record['sessionId'],
          cwd: record['cwd'],
          ...(typeof record['agentId'] === 'string' ? { agentId: record['agentId'] } : {})
        }
      }
    } catch {
      // a malformed line of the malformed case
    }
  }
  throw new Error(`${file} names no session`)
}

/**
 * Lays one case out where Claude Code would have written it, byte for byte (CRLF kept), and its
 * sidecar beside a subagent transcript. `folder` overrides the project-folder name.
 */
async function place(
  configDir: string,
  file: string,
  options: { folder?: string; sidecar?: boolean } = {}
): Promise<string> {
  const writer = await writerOf(file)
  const project = join(configDir, 'projects', options.folder ?? encodedFolderOf(writer.cwd))
  const bytes = await readFile(join(FIXTURES, file))
  if (writer.agentId === undefined) {
    await mkdir(project, { recursive: true })
    const path = join(project, `${writer.sessionId}.jsonl`)
    await writeFile(path, bytes)
    return path
  }
  const subagents = join(project, writer.sessionId, 'subagents')
  await mkdir(subagents, { recursive: true })
  const path = join(subagents, `agent-${writer.agentId}.jsonl`)
  await writeFile(path, bytes)
  if (options.sidecar !== false) {
    const base = file.replace(/\.jsonl$/, '').replace(/-(crlf|with-extra)$/, '')
    await writeFile(
      join(subagents, `agent-${writer.agentId}.meta.json`),
      await readFile(join(FIXTURES, `${base}.meta.json`))
    )
  }
  return path
}

async function sourcesOf(adapter: ClaudeObservationAdapter): Promise<SourceFile[]> {
  return adapter.discover(new NodeFs())
}

async function onlySource(adapter: ClaudeObservationAdapter): Promise<SourceFile> {
  const sources = await sourcesOf(adapter)
  expect(sources).toHaveLength(1)
  return sources[0]!
}

function turnEndsOf(read: ClaudeRead) {
  return read.events.flatMap((e) => (e.kind === 'turn-ended' ? [e.end] : []))
}

function sessionsOf(read: ClaudeRead) {
  return read.events.flatMap((e) => (e.kind === 'session' ? [e] : []))
}

/** The facts of a read in the shape of `<case>.expected.json`. */
function summary(read: ClaudeRead) {
  return {
    warnings: read.warnings.length,
    sessions: sessionsOf(read).map((s) => ({
      providerSessionId: s.identity.providerSessionId,
      providerAgentId: s.identity.providerAgentId ?? null,
      cwd: s.cwd,
      at: s.at,
      parent:
        s.parentIdentity === undefined
          ? null
          : {
              providerSessionId: s.parentIdentity.providerSessionId,
              providerAgentId: s.parentIdentity.providerAgentId ?? null
            }
    })),
    entries: read.events.flatMap((e) =>
      e.kind === 'entries'
        ? e.entries.map((x) => ({
            role: x.role,
            text: x.text,
            providerTime: x.providerTime,
            ...(x.controlPlane === true ? { controlPlane: true } : {})
          }))
        : []
    ),
    activity: read.events.flatMap((e) => (e.kind === 'activity' ? [e.activity] : [])),
    turnEnds: turnEndsOf(read),
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
function keysOf(read: ClaudeRead): string[] {
  return [
    ...read.events.map((e) => `${e.kind}:${e.sourceEventId}`),
    ...read.events.flatMap((e) => (e.kind === 'entries' ? e.entries.map((x) => x.sourceKey) : [])),
    ...read.events.flatMap((e) => (e.kind === 'usage' ? [e.usage.sourceKey] : [])),
    ...read.events.flatMap((e) => (e.kind === 'turn-ended' ? [`turn:${e.end.turnKey}`] : []))
  ]
}

function identityKey(event: ObservedEvent): string {
  const { providerSessionId, providerAgentId } = event.identity
  return `${providerSessionId}:${providerAgentId ?? ''}`
}

async function readCase(file: string): Promise<{ read: ClaudeRead; source: SourceFile }> {
  const configDir = await tempDir()
  await place(configDir, file)
  const adapter = adapterAt(configDir)
  const source = await onlySource(adapter)
  return { read: await adapter.read(source, null), source }
}

describe('ClaudeObservationAdapter conformance (fixtures/claude/observer)', () => {
  it('[C-19] every Claude fixture replayed twice yields identical source keys and no new event', async () => {
    const cases = await transcriptCases()
    expect(cases.length).toBeGreaterThanOrEqual(18)
    const keysOfBase = new Map<string, string[]>()
    for (const { file, base, expected } of cases) {
      const configDir = await tempDir()
      await place(configDir, file)
      const adapter = adapterAt(configDir)
      const source = await onlySource(adapter)
      const first = await adapter.read(source, null)
      expect(summary(first), file).toEqual(await expectation(expected))
      expect(first.next.value, file).toBe(source.size)

      // Read again from the cursor it returned: nothing new.
      const again = await adapter.read(source, first.next)
      expect(again.events, file).toEqual([])
      expect(again.next, file).toEqual(first.next)

      // Replayed from the start by a fresh adapter (a Host restart): the same keys, in order.
      const replay = await adapterAt(configDir).read(source, null)
      expect(keysOf(replay), file).toEqual(keysOf(first))
      expect(new Set(keysOf(first)).size, file).toBe(keysOf(first).length)

      // The same records in other bytes (CRLF, unknown fields) are the same facts: the same keys.
      const known = keysOfBase.get(base)
      if (known === undefined) keysOfBase.set(base, keysOf(first))
      else expect(keysOf(first), file).toEqual(known)
    }
  })

  it('[C-11, FM-086] a malformed line and control-plane entries are skipped with a warning and never throw', async () => {
    for (const file of ['malformed-line.jsonl', 'malformed-line-crlf.jsonl']) {
      const { read, source } = await readCase(file)
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
      expect(read.next.value, file).toBe(source.size)
    }

    for (const file of ['control-plane.jsonl', 'control-plane-crlf.jsonl']) {
      const { read } = await readCase(file)
      // Control-plane records are the provider's own, well formed: no drift warning.
      expect(read.warnings, file).toEqual([])
      const entries = read.events.flatMap((e) => (e.kind === 'entries' ? e.entries : []))
      // Only the person's and the dwarf's words are conversation.
      expect(
        entries.filter((e) => e.controlPlane !== true).map((e) => [e.role, e.text]),
        file
      ).toEqual([
        ['person', 'Now run the linter.'],
        ['person', 'Also check formatting.'],
        ['dwarf', 'Lint and format are clean.']
      ])
      // The rest keep their key (claimed at ingest, never a row, INV-68) and carry none of the
      // record's own text: a label only.
      const controlPlane = entries.filter((e) => e.controlPlane === true)
      expect(controlPlane.length, file).toBe(8)
      for (const entry of controlPlane) {
        expect(entry.role, file).toBe('system-line')
        expect(entry.text, file).toMatch(/^(command|meta|compaction|warmup|side-chain|synthetic)$/)
        expect(entry.sourceKey, file).toMatch(
          /^claude:claude:01a0b000-0000-7000-8000-000000000714:00000000-0000-4000-8000-0000000714\d\d$/
        )
      }
      // A control-plane record spends nothing the ledger credits and ends no turn.
      expect(
        summary(read).usage.map((u) => u.unitKey),
        file
      ).toEqual(['msg_01ControlG'])
      expect(turnEndsOf(read), file).toHaveLength(1)
    }

    // Bytes that are not a transcript at all never throw.
    const configDir = await tempDir()
    const project = join(configDir, 'projects', 'garbage')
    await mkdir(project, { recursive: true })
    await writeFile(
      join(project, '01a0b000-0000-7000-8000-0000000007ff.jsonl'),
      Buffer.from([
        0xff, 0xfe, 0x00, 0x0a, 0x7b, 0x0a, 0x5b, 0x5d, 0x0a, 0x6e, 0x75, 0x6c, 0x6c, 0x0a
      ])
    )
    const adapter = adapterAt(configDir)
    const read = await adapter.read(await onlySource(adapter), null)
    expect(read.events).toEqual([])
    expect(read.warnings).toHaveLength(4)
  })

  it('[C-20] every Claude turn-end value maps to its TurnEnded kind and an unknown one maps to errored', async () => {
    const { read } = await readCase('turn-ends.jsonl')
    const ends = turnEndsOf(read)
    // tool_use and pause_turn continue the turn; every terminal stop_reason ends it once.
    expect(ends.map((e) => [e.kind, e.detail])).toEqual([
      ['concluded', undefined],
      ['concluded', undefined],
      ['capped', undefined],
      ['errored', 'refusal'],
      ['capped', undefined],
      ['errored', 'synthetic_unknown_reason']
    ])
    // Transcript-only Claude has no reliable end until S-021-1 passes (ADR-021 item 4): every
    // end is inferred, so it never fires a cue (ADR-021 item 3), and the capability says none.
    for (const end of ends) {
      expect(end.reliability).toBe('inferred')
      expect(end.cancelledFromApp).toBe(false)
    }
    expect(adapterAt(await tempDir()).capabilities().turnEnd).toBe('none')
  })

  it('[C-21] usage rows yield one sealed observation per message id', async () => {
    const expected = (await expectation('usage-rows.expected.json'))['usage'] as unknown[]
    const fixture = await readFile(join(FIXTURES, 'usage-rows.jsonl'), 'utf8')
    const lines = fixture.split('\n').filter((line) => line !== '')

    // Whole file at once.
    const configDir = await tempDir()
    const path = await place(configDir, 'usage-rows.jsonl')
    const adapter = adapterAt(configDir)
    const read = await adapter.read(await onlySource(adapter), null)
    expect(summary(read).usage).toEqual(expected)
    const units = summary(read).usage.map((u) => u.unitKey)
    expect(new Set(units).size).toBe(units.length)

    // One line per poll: the same units, each sealed exactly once.
    const streamedDir = await tempDir()
    const streamedPath = await place(streamedDir, 'usage-rows.jsonl')
    await writeFile(streamedPath, '')
    const streamed = adapterAt(streamedDir)
    let cursor: Cursor | null = null
    const polled: unknown[] = []
    for (const line of lines) {
      await appendFile(streamedPath, line + '\n')
      const step = await streamed.read(await onlySource(streamed), cursor)
      polled.push(...summary(step).usage)
      cursor = step.next
    }
    expect(polled).toEqual(expected)

    // A Host restart with the cursor after the first final row of msg_01UsageRowsC: a fresh
    // adapter rebuilds the stream state from before the cursor, so the later row of the same
    // message seals nothing a second time.
    const afterFirstFinal = Buffer.byteLength(lines.slice(0, 4).join('\n') + '\n')
    const restarted = adapterAt(configDir)
    const source = await onlySource(restarted)
    expect(source.path.endsWith('.jsonl') && path.endsWith('.jsonl')).toBe(true)
    const resumed = await restarted.read(source, {
      adapterId: 'claude',
      kind: 'byte-offset',
      value: afterFirstFinal,
      fileIdentity: source.fileIdentity
    })
    expect(summary(resumed).usage).toEqual(expected.slice(1))
  })

  it('[ADR-030] the session cwd comes from the records, not from the encoded folder name', async () => {
    const cwd = 'C:\\Users\\j\\work\\sample.project'
    // Claude Code's own folder name for that cwd is lossy (the dot became a dash), and a folder
    // name that says nothing about the cwd changes nothing either.
    for (const folder of [encodedFolderOf(cwd), 'unrelated-folder-name']) {
      const configDir = await tempDir()
      await place(configDir, 'plain-session.jsonl', { folder })
      const adapter = adapterAt(configDir)
      const read = await adapter.read(await onlySource(adapter), null)
      expect(
        sessionsOf(read).map((s) => s.cwd),
        folder
      ).toEqual([cwd])
      for (const event of read.events) expect(event.cwd, folder).toBe(cwd)
    }
    expect(encodedFolderOf(cwd)).toBe('C--Users-j-work-sample-project')
  })

  it('[ADR-015] a subagent with its sidecar is a separate identity with its parent agent id', async () => {
    const session = '01a0b000-0000-7000-8000-000000000716'
    const configDir = await tempDir()
    await place(configDir, 'subagent.jsonl')
    await place(configDir, 'nested-subagent.jsonl')
    const adapter = adapterAt(configDir)
    const sources = await sourcesOf(adapter)
    expect(sources).toHaveLength(2)
    const reads = await Promise.all(sources.map((source) => adapter.read(source, null)))
    const sessions = reads.flatMap(sessionsOf).map((s) => [s.identity, s.parentIdentity])
    expect(sessions).toEqual(
      expect.arrayContaining([
        [
          {
            providerId: 'claude',
            providerSessionId: session,
            providerAgentId: 'a1b2c3d4e5f607181'
          },
          { providerId: 'claude', providerSessionId: session }
        ],
        [
          {
            providerId: 'claude',
            providerSessionId: session,
            providerAgentId: 'b2c3d4e5f6071829a'
          },
          { providerId: 'claude', providerSessionId: session, providerAgentId: 'a1b2c3d4e5f607181' }
        ]
      ])
    )
    expect(sessions).toHaveLength(2)
    // Every fact of a subagent is its own: its identity, and its agent id on every entry.
    for (const read of reads) {
      const identities = new Set(read.events.map(identityKey))
      expect(identities.size).toBe(1)
      for (const event of read.events) {
        if (event.kind !== 'entries') continue
        for (const entry of event.entries) {
          expect(entry.providerAgentId).toBe(event.identity.providerAgentId)
        }
      }
    }

    // Without its sidecar, nothing names a parent agent: the subagent's parent is its session.
    const bare = await tempDir()
    await place(bare, 'nested-subagent.jsonl', { sidecar: false })
    const unnamed = adapterAt(bare)
    const read = await unnamed.read(await onlySource(unnamed), null)
    expect(sessionsOf(read).map((s) => s.parentIdentity)).toEqual([
      { providerId: 'claude', providerSessionId: session }
    ])
  })

  it('[FM-145] a resumed or forked session with a new session id is a new identity', async () => {
    const configDir = await tempDir()
    await place(configDir, 'plain-session.jsonl')
    await place(configDir, 'resumed-session.jsonl')
    const adapter = adapterAt(configDir)
    const sources = await sourcesOf(adapter)
    expect(sources).toHaveLength(2)
    const reads = await Promise.all(sources.map((source) => adapter.read(source, null)))
    const ids = reads.map((read) => [...new Set(read.events.map(identityKey))])
    expect(ids.flat().sort()).toEqual([
      '01a0b000-0000-7000-8000-000000000711:',
      '01a0b000-0000-7000-8000-000000000717:'
    ])
    // Two dwarfs, two histories: no key is shared.
    const [a, b] = reads.map((read) => new Set(keysOf(read).filter((k) => k.includes(':'))))
    for (const key of a!) expect(b!.has(key), key).toBe(false)
  })

  it('[S4.41, ADR-015] a message from its coordinator re-announces a subagent at its own time with its parent, read from the cursor alone or after a restart', async () => {
    // Claude Code's SendMessage to an agent appends to its transcript (owner amendment I): the
    // loop needs a fact that the agent runs again, and the parent its resumed generation joins.
    const session = '01a0b000-0000-7000-8000-000000000730'
    const agent: ProviderIdentity = {
      providerId: 'claude',
      providerSessionId: session,
      providerAgentId: 'e5f60718293abcd01'
    }
    const resumedAt = Date.parse('2026-09-30T19:01:00.000Z')
    for (const file of ['resumed-subagent.jsonl', 'resumed-subagent-crlf.jsonl']) {
      const configDir = await tempDir()
      const path = await place(configDir, file)
      const lines = (await readFile(path, 'utf8')).split(/(?<=\n)/)
      // Its first turn only, read live; then the coordinator's message and its answer.
      await writeFile(path, lines.slice(0, 2).join(''))
      const adapter = adapterAt(configDir)
      const first = await adapter.read(await onlySource(adapter), null)
      await appendFile(path, lines.slice(2).join(''))
      for (const reader of [adapter, adapterAt(configDir)]) {
        const later = await reader.read(await onlySource(reader), first.next)
        expect(
          sessionsOf(later).map((s) => [s.identity, s.parentIdentity, s.at]),
          file
        ).toEqual([[agent, { providerId: 'claude', providerSessionId: session }, resumedAt]])
      }
    }
  })

  it('[FM-091] with no readable configuration folder discover finds nothing and logs no path', async () => {
    const home = join('/home', 'j')
    expect(claudeConfigDirOf({}, home)).toBe(join(home, '.claude'))
    expect(claudeConfigDirOf({ CLAUDE_CONFIG_DIR: '' }, home)).toBe(join(home, '.claude'))
    expect(claudeConfigDirOf({ CLAUDE_CONFIG_DIR: join('/data', 'claude') }, home)).toBe(
      join('/data', 'claude')
    )

    // The variable set only in the person's shell: the Host looks where nothing is.
    const configDir = await tempDir()
    await place(configDir, 'plain-session.jsonl')
    expect(await adapterAt(configDir).discover(new NodeFs())).toHaveLength(1)
    expect(await adapterAt(join(configDir, 'elsewhere')).discover(new NodeFs())).toEqual([])

    // A folder the Host may not read: nothing found, nothing thrown, so no error text (which
    // names the path) ever reaches the loop's log (ADR-026 item 4).
    const denied: FileSystem = Object.assign(Object.create(new NodeFs()) as NodeFs, {
      listDir: (path: string) =>
        Promise.reject(
          Object.assign(new Error(`EACCES: permission denied, scandir '${path}'`), {
            code: 'EACCES'
          })
        )
    })
    const blocked = adapterAt(configDir, denied)
    const found = await blocked.discover(denied)
    expect(found).toEqual([])
    expect(JSON.stringify(found)).not.toContain(configDir)
  })
})

// Several Claude accounts, each with its own configuration folder (HO-09; `contracts/config`
// `ClaudeConfig.configDirs`, CLAUDE_CONFIG_DIRS): the adapter reads every configured root.
describe('ClaudeObservationAdapter over several configuration roots (CLAUDE_CONFIG_DIRS)', () => {
  function adapterOver(configDirs: readonly string[]) {
    return new ClaudeObservationAdapter({
      providerId: 'claude',
      // Never read when `configDirs` is given.
      configDir: join(tmpdir(), 'dwarfai-claude-not-a-root'),
      configDirs,
      claimedRoots: [],
      fs: new NodeFs(),
      clock: new FakeClock(T0)
    })
  }

  it('[FM-091] claudeConfigDirsOf expands a leading ~, keeps the listed order, drops repeats, and else falls back to CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    const home = join('/home', 'j')
    expect(claudeConfigDirsOf(['~/.claude', '~/.claude-work', '~/.claude'], {}, home)).toEqual([
      join(home, '.claude'),
      join(home, '.claude-work')
    ])
    expect(claudeConfigDirsOf(['~', join('/data', 'claude')], {}, home)).toEqual([
      home,
      join('/data', 'claude')
    ])
    // A listed root wins over CLAUDE_CONFIG_DIR, as the shipped setting does.
    expect(
      claudeConfigDirsOf(['~/.claude-work'], { CLAUDE_CONFIG_DIR: join('/data', 'claude') }, home)
    ).toEqual([join(home, '.claude-work')])
    expect(claudeConfigDirsOf(null, { CLAUDE_CONFIG_DIR: join('/data', 'claude') }, home)).toEqual([
      join('/data', 'claude')
    ])
    expect(claudeConfigDirsOf(null, {}, home)).toEqual([join(home, '.claude')])
  })

  it('[FM-091] every configured root is discovered, sessions and subagents alike, and a root that does not exist is skipped', async () => {
    const first = await tempDir()
    const second = await tempDir()
    await place(first, 'plain-session.jsonl')
    await place(second, 'resumed-session.jsonl')
    await place(second, 'subagent.jsonl')
    const adapter = adapterOver([join(first, 'missing'), first, second])

    const sources = await sourcesOf(adapter)
    expect(sources).toHaveLength(3)
    const reads = await Promise.all(sources.map((source) => adapter.read(source, null)))
    const identities = new Set(reads.flatMap((read) => read.events.map(identityKey)))
    expect([...identities].sort()).toEqual(
      [
        '01a0b000-0000-7000-8000-000000000711:',
        '01a0b000-0000-7000-8000-000000000717:',
        `${(await writerOf('subagent.jsonl')).sessionId}:${(await writerOf('subagent.jsonl')).agentId}`
      ].sort()
    )
  })

  it('[FM-093] one root listed twice in two spellings yields one stream per file', async () => {
    const root = await tempDir()
    await place(root, 'plain-session.jsonl')
    const adapter = adapterOver([root, `${root}${sep}.`])
    const sources = await sourcesOf(adapter)
    expect(sources).toHaveLength(1)
  })
})
