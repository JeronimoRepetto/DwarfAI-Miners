// layer: L4
// L4 flow (17 §1.4; 15 §6 C-20; ADR-021 Verification "recorded fixtures produce exactly one
// TurnEnded per turn with the expected kind; a re-parse produces no second event"): the committed
// observer fixtures (`fixtures/claude/observer/**`, `fixtures/codex/observer/**`) are read by the
// real Claude and Codex observation adapters from a per-test temp folder (17 §5.3), and each turn
// end goes to conversation `recordTurnEnd` over one copy of the template database, through the
// route declared here as `host/wiring` will declare it (later: ISSUE-120; AMENDMENT-10, OQ-78):
//
// - the observation loop stamps each adapter `turn-ended` record with its dwarf and publishes
//   `ObservedTurnEnded { identity, end }` after its batch committed (observationLoop.ts `eventsOf`);
//   this file stamps the records the same way, with a seeded dwarf per case, since the loop's own
//   arrival and hold rules are proven by observedConversation.flow.test.ts and
//   observedSessionAppears.test.ts;
// - the route caps the end by the session's `turnEnd` capability (`downgrade`, ADR-021 item 2) —
//   the adapter's declared `ObservedCapabilities`, where an omitted field fails closed to `none`
//   (ADR-009 D3) — and hands it to `recordTurnEnd`, which publishes `TurnEnded` once per
//   `turn:<dwarfId>:<turnKey>` (08 §2.6).
//
// The expectations are the hand-written `<case>.expected.json` `turnEnds` of each fixture (the
// `-crlf` and `-with-extra` variants share their case's). S-021-1, S-021-2 and S-032-1 have not
// passed (spike-results/): transcript-only Claude keeps `turnEnd: 'none'`, so its ends are inferred.
//
// TC-100-03.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { TurnEnded } from '../../kernel/domain/sharedContracts'
import type { DwarfId } from '../../kernel/domain/values'
import {
  announceable,
  createConversation,
  downgrade,
  type Conversation,
  type ConversationEvent,
  type TurnEndCapability
} from '../../modules/conversation'
import {
  ClaudeObservationAdapter,
  CodexObservationAdapter,
  type ObservationAdapter,
  type ObservedEvent,
  type ObservedTurnEnded
} from '../../modules/observation'
import { NodeFs } from '../../platform/fs/NodeFs'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openReadOnlySnapshot } from '../../platform/sqlite/readOnlySnapshot'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'

const T0 = 1_790_900_000_000
const MINE = '00000000-0000-7000-8000-0000000001f0'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const CLAUDE_FIXTURES = join(ROOT, 'fixtures/claude/observer/2.1.x')
const CODEX_FIXTURES = join(ROOT, 'fixtures/codex/observer/0.153.x')

type Provider = 'claude' | 'codex'
type ExpectedTurnEnd = Omit<TurnEnded, 'dwarfId'>

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(provider: Provider): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dwarfai-turn-ends-${provider}-`))
  temps.push(dir)
  return dir
}

const folderOf = (provider: Provider) => (provider === 'claude' ? CLAUDE_FIXTURES : CODEX_FIXTURES)

/** Every transcript case of `provider`'s fixtures, with the `turnEnds` it is held to. */
async function turnEndCases(
  provider: Provider
): Promise<Array<{ file: string; expected: ExpectedTurnEnd[] }>> {
  const folder = folderOf(provider)
  const files = (await readdir(folder)).filter((name) => name.endsWith('.jsonl')).sort()
  const cases: Array<{ file: string; expected: ExpectedTurnEnd[] }> = []
  for (const file of files) {
    const base = file.replace(/\.jsonl$/, '').replace(/-(crlf|with-extra)$/, '')
    const parsed = JSON.parse(await readFile(join(folder, `${base}.expected.json`), 'utf8')) as {
      turnEnds: ExpectedTurnEnd[]
    }
    cases.push({ file, expected: parsed.turnEnds })
  }
  return cases
}

/** The session (and subagent) that wrote a Claude transcript, from its first record that names one. */
async function claudeWriterOf(
  file: string
): Promise<{ sessionId: string; agentId?: string; cwd: string }> {
  const text = await readFile(join(CLAUDE_FIXTURES, file), 'utf8')
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
      // the malformed line of the malformed case
    }
  }
  throw new Error(`${file} names no session`)
}

/** Lays a Claude case out where Claude Code writes it, byte for byte, with a subagent's sidecar. */
async function placeClaude(configDir: string, file: string): Promise<void> {
  const writer = await claudeWriterOf(file)
  const project = join(configDir, 'projects', writer.cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  const bytes = await readFile(join(CLAUDE_FIXTURES, file))
  if (writer.agentId === undefined) {
    await mkdir(project, { recursive: true })
    await writeFile(join(project, `${writer.sessionId}.jsonl`), bytes)
    return
  }
  const subagents = join(project, writer.sessionId, 'subagents')
  await mkdir(subagents, { recursive: true })
  await writeFile(join(subagents, `agent-${writer.agentId}.jsonl`), bytes)
  const base = file.replace(/\.jsonl$/, '').replace(/-(crlf|with-extra)$/, '')
  await writeFile(
    join(subagents, `agent-${writer.agentId}.meta.json`),
    await readFile(join(CLAUDE_FIXTURES, `${base}.meta.json`))
  )
}

/** Lays a Codex rollout case out under `CODEX_HOME/sessions`, byte for byte. */
async function placeCodex(codexHome: string, file: string): Promise<void> {
  const folder = join(codexHome, 'sessions', '2026', '09', '30')
  await mkdir(folder, { recursive: true })
  const name = `rollout-2026-09-30T00-00-00-${file.replace(/\.jsonl$/, '')}.jsonl`
  await writeFile(join(folder, name), await readFile(join(CODEX_FIXTURES, file)))
}

/** A fresh adapter of `provider` over `dir` (a new one stands for a Host restart). */
function adapterAt(provider: Provider, dir: string): ObservationAdapter {
  const fs = new NodeFs()
  const clock = new FakeClock(T0)
  return provider === 'claude'
    ? new ClaudeObservationAdapter({
        providerId: 'claude',
        configDir: dir,
        claimedRoots: [],
        fs,
        clock
      })
    : new CodexObservationAdapter({
        providerId: 'codex',
        codexHome: dir,
        claimedRoots: [],
        fs,
        clock,
        openSnapshot: openReadOnlySnapshot
      })
}

/** The `turn-ended` records of one case, read from the start of its transcript. */
async function turnEndRecordsOf(provider: Provider, dir: string): Promise<ObservedEvent[]> {
  const adapter = adapterAt(provider, dir)
  const sources = (await adapter.discover(new NodeFs())).filter((s) => s.path.endsWith('.jsonl'))
  expect(sources).toHaveLength(1)
  const read = await adapter.read(sources[0]!, null)
  return read.events.filter((e) => e.kind === 'turn-ended')
}

/** The session's `turnEnd` capability as the adapter declares it; an omitted field fails closed. */
function turnEndCapabilityOf(adapter: ObservationAdapter): TurnEndCapability {
  return adapter.capabilities().turnEnd ?? 'none'
}

/** One Host database with conversation wired over it and a dwarf per case. */
function host() {
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const clock = new FakeClock(T0)
  const ids = new SequenceIdGenerator()
  const bus = new RecordingEventBus<ConversationEvent>({ transactionScope: transactions })
  const lifecycleFacts = new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock })
  const conversation: Conversation = createConversation({
    db,
    transactions,
    bus,
    lifecycleFacts,
    clock,
    ids,
    hostEpoch: 'epoch-0100'
  })
  transactions.inTransaction(() => {
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/mine-ten', 'mine-ten', 'mine-ten', 'active', ?, ?)`,
      [MINE, T0, T0]
    )
  })
  let dwarfs = 0
  return {
    bus,
    conversation,
    /** A dwarf row, as crew leaves it after the arrival of the observed session (09 §4.3). */
    dwarf(provider: Provider): DwarfId {
      dwarfs += 1
      const id = `00000000-0000-7000-8000-${String(dwarfs).padStart(12, '0')}` as DwarfId
      transactions.inTransaction(() => {
        db.run(
          `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
             process_state, turn_state, arrived_at, last_activity_at)
           VALUES (?, ?, ?, ?, 'Durin', 'foreman', 'running', 'none-yet', ?, ?)`,
          [id, MINE, provider, `session-${dwarfs}`, T0, T0]
        )
      })
      return id
    },
    turnFacts(dwarfId: DwarfId): string[] {
      return db
        .all(
          `SELECT source_key FROM dwarf_lifecycle_facts
           WHERE type = 'TurnEnded' AND dwarf_id = ? ORDER BY rowid`,
          [dwarfId]
        )
        .map((row) => String(row['source_key']))
    }
  }
}

/**
 * The route of `ObservedTurnEnded` to conversation, as `host/wiring` declares it (ISSUE-120): the
 * end capped by the session's capability, then recorded.
 */
function routeObservedTurnEnded(
  conversation: Conversation,
  capability: TurnEndCapability
): (payload: ObservedTurnEnded['payload']) => void {
  return (payload) => conversation.commands.recordTurnEnd(downgrade(payload.end, capability))
}

/** The loop's `ObservedTurnEnded` payloads of the records, stamped with the dwarf (eventsOf). */
function stamped(records: ObservedEvent[], dwarfId: DwarfId): ObservedTurnEnded['payload'][] {
  return records.flatMap((r) =>
    r.kind === 'turn-ended' ? [{ identity: r.identity, end: { ...r.end, dwarfId } }] : []
  )
}

describe('observer turn-end fixtures (C-20)', () => {
  it('[C-20, ADR-021] each observer turn-end fixture produces exactly one TurnEnded per turn with the expected kind and reliability, and a re-parse produces none', async () => {
    const h = host()
    const endsOf: Record<Provider, TurnEnded[]> = { claude: [], codex: [] }
    for (const provider of ['claude', 'codex'] as const) {
      const cases = await turnEndCases(provider)
      expect(cases.length, provider).toBeGreaterThan(0)
      for (const { file, expected } of cases) {
        const dir = await tempDir(provider)
        if (provider === 'claude') await placeClaude(dir, file)
        else await placeCodex(dir, file)
        const dwarfId = h.dwarf(provider)
        const route = routeObservedTurnEnded(
          h.conversation,
          turnEndCapabilityOf(adapterAt(provider, dir))
        )
        const before = h.bus.ofType('TurnEnded').length

        for (const payload of stamped(await turnEndRecordsOf(provider, dir), dwarfId)) {
          route(payload)
        }

        const published = h.bus.ofType('TurnEnded').slice(before)
        expect(
          published.map((e) => e.payload),
          `${provider} ${file}`
        ).toEqual(expected.map((end) => ({ dwarfId, end: { ...end, dwarfId } })))
        expect(h.turnFacts(dwarfId), `${provider} ${file}`).toEqual(
          expected.map((end) => `turn:${dwarfId}:${end.turnKey}`)
        )

        // A re-parse from the start by a fresh adapter (a Host restart) produces no second event.
        for (const payload of stamped(await turnEndRecordsOf(provider, dir), dwarfId)) {
          route(payload)
        }
        expect(h.bus.ofType('TurnEnded').length, `${provider} ${file}`).toBe(
          before + expected.length
        )
        expect(h.turnFacts(dwarfId), `${provider} ${file}`).toHaveLength(expected.length)
        endsOf[provider].push(...published.map((e) => e.payload.end))
      }
    }

    // Observed Codex ends are reliable (task_complete → concluded) and may play the finished cue;
    // transcript-only Claude ends are inferred and never do (ADR-021 items 3, 4).
    expect(endsOf.codex.length).toBeGreaterThan(0)
    expect(endsOf.codex.every((end) => end.reliability === 'reliable')).toBe(true)
    expect(endsOf.codex.some((end) => end.kind === 'concluded' && announceable(end))).toBe(true)
    expect(endsOf.claude.length).toBeGreaterThan(0)
    expect(endsOf.claude.every((end) => end.reliability === 'inferred')).toBe(true)
    expect(endsOf.claude.some(announceable)).toBe(false)
  })

  it('[S-021-1] a Claude transcript-only end stays inferred while the capability record says turnEnd none', async () => {
    const h = host()
    const dir = await tempDir('claude')
    await placeClaude(dir, 'turn-ends.jsonl')
    const adapter = adapterAt('claude', dir)
    // The capability transcript-only Claude declares until S-021-1 passes (ADR-021 item 4).
    expect(turnEndCapabilityOf(adapter)).toBe('none')
    const dwarfId = h.dwarf('claude')
    const route = routeObservedTurnEnded(h.conversation, turnEndCapabilityOf(adapter))

    // Even an end that claims to be reliable — a parser that read a terminal stop_reason as an
    // explicit end — is recorded inferred while the session's capability is none.
    const payloads = stamped(await turnEndRecordsOf('claude', dir), dwarfId)
    expect(payloads.length).toBeGreaterThan(1)
    for (const payload of payloads) {
      route({ ...payload, end: { ...payload.end, reliability: 'reliable' } })
    }

    const ends = h.bus.ofType('TurnEnded').map((e) => e.payload.end)
    expect(ends).toHaveLength(payloads.length)
    expect(ends.map((end) => end.reliability)).toEqual(payloads.map(() => 'inferred'))
    expect(ends.some(announceable)).toBe(false)
  })
})
