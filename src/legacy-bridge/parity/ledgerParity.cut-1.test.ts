// layer: L2
// Observer parity for the ledger (21 §2 cut 1 exit; ADR-001 item 4.1): for every fixture session
// observed from its first record, the tokens the Host ledger credits (`ledger_entries`, through
// `creditUsage` and `creditSealedUnits`) equal what today's `src/main/domain/ledger.ts` (`accrue`)
// reports for the same records, except the differences listed below, which ISSUE-123 records in
// `docs/strangler/parity-cut-1.md`. Only `src/legacy-bridge/**` may import the legacy ledger
// (R16); the Host side is the ledger module over its in-memory doubles, which pass the same
// contract as the SQLite adapter.
//
// How today's ledger sees the same records: its observer polls a session's running token counter
// (a lifetime total, not a delta) and `accrue` credits the growth between polls, with the material
// of the mine's confirmed tier at that poll; a session seen for the first time only sets a baseline.
// A session observed from its first record is first polled at that record, before any usage
// (counter 0: the first record of a session is the person's prompt), then once per usage record.
import { describe, expect, it } from 'vitest'
import type { UsageObservation } from '../../host/kernel/domain/sharedContracts'
import type { DwarfId } from '../../host/kernel/domain/values'
import type { LiveMaterial } from '../../host/modules/ledger'
import { inMemoryLedger } from '../../host/modules/ledger/testing/inMemoryLedger'
import { accrue, emptyLedger, mineTotals, type TokenObservation } from '../../main/domain/ledger'

const INSTALL = 1_760_000_000_000

interface FixtureSession {
  name: string
  /** The mine's tier while the session works; `null` while its first measurement is running. */
  tier: LiveMaterial | null
  /** The tier the first measurement finds, for a session whose mine was still measuring. */
  measuredAs?: LiveMaterial
  /** Each usage unit's tokens, every kind added together, in record order. */
  units: number[]
  /** `true`: every record is read twice (a re-read after a restart, a replayed stream). */
  reRead?: boolean
  /** `'while-closed'`: the session started and ended while no app ran (PO #81, OQ-14). */
  seen: 'from-first-record' | 'while-closed'
}

/** The parity differences of cut 1 (21 §2 cut 1 exit), by fixture session. */
const PARITY_DIFFERENCES: Readonly<Record<string, string>> = {
  'offline session':
    'offline credit (ADR-006 item 7): the Host credits a session that started and ended while the app was closed in full; today it only sets a baseline'
}

// Not exercised here, recorded with the others in parity-cut-1.md: coal only via the backfill
// (ISSUE-077; live use never credits coal on either side, INV-95), once-only per `unitKey` across
// paths (today has one path), and Antigravity usage from its conversations database
// (AMENDMENT-13; today reads none).

const FIXTURE_WORLD: readonly FixtureSession[] = [
  { name: 'claude one turn', tier: 'copper', units: [12_400], seen: 'from-first-record' },
  {
    name: 'claude tool continuation',
    tier: 'silver',
    units: [8_000, 31_250, 4_100, 77_000],
    seen: 'from-first-record'
  },
  { name: 'codex two turns', tier: 'gold', units: [140_000, 260_500], seen: 'from-first-record' },
  {
    name: 'mine still measuring',
    tier: null,
    measuredAs: 'uranium',
    units: [90_000, 45_000],
    seen: 'from-first-record'
  },
  {
    name: 'stream read twice',
    tier: 'bronze',
    units: [2_000, 9_999, 15_001],
    reRead: true,
    seen: 'from-first-record'
  },
  { name: 'offline session', tier: 'copper', units: [20_000, 30_000], seen: 'while-closed' }
]

/** What today's `accrue` credits for the session's records. */
function legacyCredited(session: FixtureSession): number {
  const mineId = `mine:${session.name}`
  const observation = (
    tokensObserved: number,
    material: LiveMaterial | undefined
  ): TokenObservation => ({
    mineId,
    sessionKey: `claude:${session.name}`,
    material,
    tokensObserved
  })
  const material = session.tier ?? undefined
  const polls: TokenObservation[] = []
  let counter = 0
  if (session.seen === 'from-first-record') {
    polls.push(observation(0, material))
    for (const tokens of session.units) {
      counter += tokens
      polls.push(observation(counter, material))
      if (session.reRead === true) polls.push(observation(counter, material))
    }
  } else {
    counter = session.units.reduce((sum, tokens) => sum + tokens, 0)
    polls.push(observation(counter, material))
  }
  if (session.tier === null) polls.push(observation(counter, session.measuredAs))
  let state = emptyLedger()
  polls.forEach((poll, n) => {
    state = accrue(state, [poll], n + 1)
  })
  const totals = mineTotals(state, mineId)
  return Object.values(totals).reduce((sum, tokens) => sum + tokens, 0)
}

/** What the Host ledger credits for the same records. */
function hostCredited(session: FixtureSession): number {
  const w = inMemoryLedger()
  w.setInstallMoment(INSTALL)
  const mine = w.addMine(session.tier)
  const dwarf = w.addDwarf(mine, 'transcript')
  const commands = w.ledger.commands
  const records: UsageObservation[] = session.units.map((tokens, n) =>
    record(dwarf, session.name, n, tokens)
  )
  // An offline session is read from its cursor at the next boot (ADR-006 item 7): the same records.
  const reads = session.reRead === true ? [records, records] : [records]
  for (const read of reads) for (const o of read) commands.creditUsage(o, 'transcript')
  if (session.tier === null && session.measuredAs !== undefined) {
    w.measure(mine, session.measuredAs)
    commands.creditSealedUnits(mine)
  }
  return w.entries(mine).reduce((sum, entry) => sum + entry.tokens, 0)
}

function record(dwarfId: DwarfId, name: string, n: number, tokens: number): UsageObservation {
  return {
    sourceKey: `claude:claude:${name}:msg-${n}:usage`,
    unitKey: `claude:${name}:msg-${n}`,
    dwarfId,
    fidelity: 1,
    tokens: { inputNet: tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    sealed: true,
    providerTime: INSTALL + 1_000 * (n + 1),
    observedAt: INSTALL + 1_000 * (n + 1) + 100
  }
}

describe('ledger observer parity, cut 1 (21 §2)', () => {
  it("[ADR-006] for every fixture session observed from its first record the credited tokens equal today's ledger except the listed parity differences", () => {
    const outcomes = FIXTURE_WORLD.map((session) => ({
      name: session.name,
      legacy: legacyCredited(session),
      host: hostCredited(session),
      all: session.units.reduce((sum, tokens) => sum + tokens, 0)
    }))
    for (const outcome of outcomes) {
      if (PARITY_DIFFERENCES[outcome.name] === undefined) {
        expect(outcome.host, outcome.name).toBe(outcome.legacy)
        expect(outcome.host, outcome.name).toBe(outcome.all)
      }
    }
    // The one listed difference, exactly as listed: today credits nothing, the Host all of it.
    expect(outcomes.find((o) => o.name === 'offline session')).toEqual({
      name: 'offline session',
      legacy: 0,
      host: 50_000,
      all: 50_000
    })
    expect(
      Object.keys(PARITY_DIFFERENCES).every((name) => outcomes.some((o) => o.name === name))
    ).toBe(true)
  })
})
