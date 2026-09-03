import { describe, expect, it } from 'vitest'
import {
  LEDGER_VERSION,
  SESSION_MEMORY_MS,
  accrue,
  creditMaterial,
  emptyLedger,
  knownMineTotals,
  ledgerTotals,
  mineTotals,
  observationsFrom,
  parseLedger,
  pruneSessions,
  serializeLedger,
  type LedgerState,
  type TokenObservation
} from './ledger'
import { emptyMaterialTotals } from './materials'
import { defaultDwarf, defaultMine, type Mine } from './types'

function mine(overrides: Partial<Mine>): Mine {
  return { ...defaultMine(), ...overrides }
}

function observation(overrides: Partial<TokenObservation> = {}): TokenObservation {
  return {
    mineId: 'mine:proj',
    sessionKey: 'claude:s1',
    material: 'copper',
    tokensObserved: 0,
    ...overrides
  }
}

/** Two polls in a row, from a clean ledger, at times 1 and 2. */
function twoPolls(first: TokenObservation[], second: TokenObservation[]): LedgerState {
  return accrue(accrue(emptyLedger(), first, 1), second, 2)
}

describe('accrue', () => {
  it('credits nothing the first time a session is seen, only a baseline', () => {
    // The counter is a running lifetime total, not a delta. Crediting it whole
    // on first sight would re-credit the same tokens after every restart.
    const state = accrue(emptyLedger(), [observation({ tokensObserved: 50_000 })], 1)
    expect(mineTotals(state, 'mine:proj').copper).toBe(0)
    expect(state.sessions['claude:s1']).toEqual({ tokens: 50_000, seenAt: 1 })
  })

  it('credits the growth between two polls to the current tier material', () => {
    const state = twoPolls(
      [observation({ tokensObserved: 1_000 })],
      [observation({ tokensObserved: 1_750 })]
    )
    expect(mineTotals(state, 'mine:proj').copper).toBe(750)
  })

  it('leaves earlier material untouched when the mine upgrades tier', () => {
    // No retroactive conversion: what was mined as copper stays copper forever.
    const state = accrue(
      twoPolls(
        [observation({ tokensObserved: 1_000 })],
        [observation({ tokensObserved: 3_000, material: 'copper' })]
      ),
      [observation({ tokensObserved: 5_000, material: 'silver' })],
      3
    )
    const totals = mineTotals(state, 'mine:proj')
    expect(totals.copper).toBe(2_000)
    expect(totals.silver).toBe(2_000)
  })

  it('credits nothing when the counter goes backwards, and rebaselines to it', () => {
    // A decrease is evidence of a reset (a restarted runtime, a rolled
    // transcript tail), never of negative work.
    const state = twoPolls(
      [observation({ tokensObserved: 9_000 })],
      [observation({ tokensObserved: 200 })]
    )
    expect(mineTotals(state, 'mine:proj').copper).toBe(0)
    expect(state.sessions['claude:s1']?.tokens).toBe(200)
  })

  it('credits only the growth after a reset, never the pre-reset total again', () => {
    const afterReset = accrue(
      twoPolls([observation({ tokensObserved: 9_000 })], [observation({ tokensObserved: 200 })]),
      [observation({ tokensObserved: 500 })],
      3
    )
    expect(mineTotals(afterReset, 'mine:proj').copper).toBe(300)
  })

  it('credits nothing for an unchanged counter', () => {
    const state = twoPolls(
      [observation({ tokensObserved: 4_000 })],
      [observation({ tokensObserved: 4_000 })]
    )
    expect(mineTotals(state, 'mine:proj').copper).toBe(0)
  })

  it('keeps a departed session accrued material after it stops being observed', () => {
    const earned = twoPolls(
      [observation({ tokensObserved: 1_000 })],
      [observation({ tokensObserved: 6_000 })]
    )
    // The dwarf leaves: later polls carry no observation for it at all.
    const afterDeparture = accrue(earned, [], 3)
    expect(mineTotals(afterDeparture, 'mine:proj').copper).toBe(5_000)
  })

  it('tracks each session independently within one mine', () => {
    const state = twoPolls(
      [
        observation({ sessionKey: 'claude:s1', tokensObserved: 100 }),
        observation({ sessionKey: 'codex:s2', tokensObserved: 4_000 })
      ],
      [
        observation({ sessionKey: 'claude:s1', tokensObserved: 400 }),
        observation({ sessionKey: 'codex:s2', tokensObserved: 4_500 })
      ]
    )
    expect(mineTotals(state, 'mine:proj').copper).toBe(800)
  })

  it('keeps two mines separate', () => {
    const state = twoPolls(
      [
        observation({ mineId: 'mine:a', sessionKey: 'claude:s1', tokensObserved: 10 }),
        observation({ mineId: 'mine:b', sessionKey: 'claude:s2', tokensObserved: 10 })
      ],
      [
        observation({ mineId: 'mine:a', sessionKey: 'claude:s1', tokensObserved: 60 }),
        observation({ mineId: 'mine:b', sessionKey: 'claude:s2', tokensObserved: 110 })
      ]
    )
    expect(mineTotals(state, 'mine:a').copper).toBe(50)
    expect(mineTotals(state, 'mine:b').copper).toBe(100)
  })

  it('never mutates the state handed to it', () => {
    const base = accrue(emptyLedger(), [observation({ tokensObserved: 1_000 })], 1)
    const snapshot = JSON.stringify(base)
    accrue(base, [observation({ tokensObserved: 8_000 })], 2)
    expect(JSON.stringify(base)).toBe(snapshot)
  })

  it('keeps the same mines object when nothing was credited', () => {
    // Callers use this identity to tell "the vault moved" from "only the
    // session marks moved", which is what stops an idle machine rewriting its
    // ledger file on every poll forever.
    const base = accrue(emptyLedger(), [observation({ tokensObserved: 1_000 })], 1)
    const unchanged = accrue(base, [observation({ tokensObserved: 1_000 })], 2)
    expect(unchanged.mines).toBe(base.mines)
  })

  it('replaces the mines object as soon as something is credited', () => {
    const base = accrue(emptyLedger(), [observation({ tokensObserved: 1_000 })], 1)
    const grown = accrue(base, [observation({ tokensObserved: 1_500 })], 2)
    expect(grown.mines).not.toBe(base.mines)
  })

  it('keeps the same mines object when a first sighting only sets a baseline', () => {
    const base = emptyLedger()
    expect(accrue(base, [observation({ tokensObserved: 9_000 })], 1).mines).toBe(base.mines)
  })

  it('never credits coal from live observation', () => {
    // Coal is pre-install history only; nothing a poll sees may add to it.
    const state = twoPolls(
      [observation({ tokensObserved: 1_000 })],
      [observation({ tokensObserved: 9_000, material: 'coal' })]
    )
    expect(mineTotals(state, 'mine:proj').coal).toBe(0)
  })

  it('refreshes seenAt on every sighting so an active session is never pruned', () => {
    const state = twoPolls(
      [observation({ tokensObserved: 10 })],
      [observation({ tokensObserved: 20 })]
    )
    expect(state.sessions['claude:s1']?.seenAt).toBe(2)
  })

  it('credits nothing for an observation whose tier is still being computed', () => {
    // No material is ever credited from a guess (#41).
    const state = twoPolls(
      [observation({ tokensObserved: 1_000 })],
      [observation({ tokensObserved: 9_000, material: undefined })]
    )
    expect(mineTotals(state, 'mine:proj')).toEqual(emptyMaterialTotals())
  })

  it('keeps the baseline frozen while the tier is pending, then credits the whole wait', () => {
    // Nothing is lost by waiting: the counter is cumulative, so leaving the
    // mark where it was makes the delta spanning the wait land whole on the
    // material the walk actually found.
    const waited = accrue(
      twoPolls(
        [observation({ tokensObserved: 1_000 })],
        [observation({ tokensObserved: 9_000, material: undefined })]
      ),
      [observation({ tokensObserved: 12_000, material: 'silver' })],
      3
    )
    expect(mineTotals(waited, 'mine:proj').silver).toBe(11_000)
    expect(mineTotals(waited, 'mine:proj').bronze).toBe(0)
  })

  it('takes a baseline for a session first seen while its tier is pending', () => {
    // Nothing is credited from it, but remembering the counter is exactly what
    // makes those tokens creditable — to the right material — once the walk
    // lands. Dropping the sighting entirely would forfeit them instead.
    const state = accrue(
      emptyLedger(),
      [observation({ tokensObserved: 4_000, material: undefined })],
      1
    )
    expect(state.sessions['claude:s1']).toEqual({ tokens: 4_000, seenAt: 1 })
    expect(mineTotals(state, 'mine:proj')).toEqual(emptyMaterialTotals())
  })

  it('refreshes seenAt while the tier is pending so a waiting session is never pruned', () => {
    const state = twoPolls(
      [observation({ tokensObserved: 10 })],
      [observation({ tokensObserved: 20, material: undefined })]
    )
    expect(state.sessions['claude:s1']).toEqual({ tokens: 10, seenAt: 2 })
  })

  it('keeps the same mines object while a tier is pending', () => {
    const base = accrue(emptyLedger(), [observation({ tokensObserved: 1_000 })], 1)
    const pending = accrue(base, [observation({ tokensObserved: 5_000, material: undefined })], 2)
    expect(pending.mines).toBe(base.mines)
  })
})

describe('observationsFrom', () => {
  /** Every mine in these cases carries a tier a walk already computed (#41). */
  const confirmed = (target: Mine) => target.tier

  it('seals each dwarf delta with the tier its mine is on right now', () => {
    const observations = observationsFrom(
      [
        mine({
          id: 'mine:a',
          tier: 'gold',
          dwarfs: [{ ...defaultDwarf(), id: 'claude:s1', tokensObserved: 42 }]
        })
      ],
      confirmed
    )
    expect(observations).toEqual([
      { mineId: 'mine:a', sessionKey: 'claude:s1', material: 'gold', tokensObserved: 42 }
    ])
  })

  it('skips a dwarf whose provider reports no token counter at all', () => {
    // Absent is not zero: treating it as zero would look like a reset and
    // throw away a real baseline.
    expect(
      observationsFrom(
        [mine({ id: 'mine:a', dwarfs: [{ ...defaultDwarf(), id: 'claude:s1' }] })],
        confirmed
      )
    ).toEqual([])
  })

  it('returns nothing for a mine with no crew', () => {
    expect(observationsFrom([mine({ id: 'mine:a' })], confirmed)).toEqual([])
  })

  it('leaves an observation unsealed while its mine tier is still being computed', () => {
    // The mine is drawn bronze on the first frames; that placeholder must not
    // reach the vault as a material (#41).
    expect(
      observationsFrom(
        [
          mine({
            id: 'mine:a',
            tier: 'bronze',
            dwarfs: [{ ...defaultDwarf(), id: 'claude:s1', tokensObserved: 42 }]
          })
        ],
        () => undefined
      )
    ).toEqual([
      { mineId: 'mine:a', sessionKey: 'claude:s1', material: undefined, tokensObserved: 42 }
    ])
  })

  it('seals with the confirmed tier, never with the one the mine is drawn as', () => {
    // The stamped tier is whatever the renderer draws right now. Only the
    // walk's own answer may decide which material a delta becomes.
    const observations = observationsFrom(
      [
        mine({
          id: 'mine:a',
          tier: 'bronze',
          dwarfs: [{ ...defaultDwarf(), id: 'claude:s1', tokensObserved: 42 }]
        })
      ],
      () => 'silver'
    )
    expect(observations[0]?.material).toBe('silver')
  })
})

describe('creditMaterial', () => {
  it('credits a material directly, which is how the coal backfill pays in', () => {
    const state = creditMaterial(emptyLedger(), 'mine:old', 'coal', 12_000)
    expect(mineTotals(state, 'mine:old').coal).toBe(12_000)
  })

  it('does not mutate its input', () => {
    const base = emptyLedger()
    creditMaterial(base, 'mine:old', 'coal', 5)
    expect(base.mines['mine:old']).toBeUndefined()
  })
})

describe('mineTotals', () => {
  it('returns an empty breakdown for a mine that has never produced', () => {
    expect(mineTotals(emptyLedger(), 'mine:unknown')).toEqual(emptyMaterialTotals())
  })
})

describe('knownMineTotals', () => {
  it('returns undefined for a mine the ledger has no row for at all (#90)', () => {
    // Unlike mineTotals(), which zero-fills for the same case: a browse spans
    // projects nobody has ever mined, and the caller must be able to tell
    // "never produced" from "produced and happens to total zero".
    expect(knownMineTotals(emptyLedger(), 'mine:unknown')).toBeUndefined()
  })

  it('returns the mine breakdown exactly as persisted once it has one', () => {
    const state = creditMaterial(emptyLedger(), 'mine:a', 'gold', 100)
    expect(knownMineTotals(state, 'mine:a')).toEqual({ ...emptyMaterialTotals(), gold: 100 })
  })
})

describe('ledgerTotals', () => {
  it('sums every mine in the ledger, including ones with no live crew today', () => {
    // Coal is credited to projects that may have no dwarf running right now;
    // the global vault must still show it.
    const state = creditMaterial(
      creditMaterial(emptyLedger(), 'mine:a', 'gold', 100),
      'mine:archived',
      'coal',
      900
    )
    const totals = ledgerTotals(state)
    expect(totals.gold).toBe(100)
    expect(totals.coal).toBe(900)
  })
})

describe('pruneSessions', () => {
  it('forgets a session not seen for longer than the memory window', () => {
    const state = accrue(emptyLedger(), [observation({ tokensObserved: 10 })], 1_000)
    const pruned = pruneSessions(state, 1_000 + SESSION_MEMORY_MS + 1)
    expect(pruned.sessions['claude:s1']).toBeUndefined()
  })

  it('keeps a session seen inside the window', () => {
    const state = accrue(emptyLedger(), [observation({ tokensObserved: 10 })], 1_000)
    expect(pruneSessions(state, 1_000 + SESSION_MEMORY_MS - 1).sessions['claude:s1']).toBeDefined()
  })

  it('never drops accrued material, only the delta bookkeeping', () => {
    const state = twoPolls(
      [observation({ tokensObserved: 1_000 })],
      [observation({ tokensObserved: 3_000 })]
    )
    const pruned = pruneSessions(state, 2 + SESSION_MEMORY_MS + 1)
    expect(mineTotals(pruned, 'mine:proj').copper).toBe(2_000)
  })
})

describe('serializeLedger / parseLedger', () => {
  it('round-trips a ledger through its stored bytes', () => {
    const state = accrue(
      twoPolls(
        [observation({ tokensObserved: 1_000 })],
        [observation({ tokensObserved: 4_000, material: 'silver' })]
      ),
      [observation({ tokensObserved: 4_000, material: 'silver' })],
      3
    )
    const restored = parseLedger(serializeLedger(state))
    expect(restored).toEqual(state)
  })

  it('restores enough to keep crediting deltas without double-counting', () => {
    const before = twoPolls(
      [observation({ tokensObserved: 1_000 })],
      [observation({ tokensObserved: 5_000 })]
    )
    const afterRestart = accrue(
      parseLedger(serializeLedger(before)),
      [observation({ tokensObserved: 5_000 })],
      3
    )
    expect(mineTotals(afterRestart, 'mine:proj').copper).toBe(4_000)
  })

  it('ends the stored document with a newline, like the other userData files', () => {
    expect(serializeLedger(emptyLedger()).endsWith('\n')).toBe(true)
  })

  it('falls back to an empty ledger on corrupt JSON', () => {
    expect(parseLedger('{ not json')).toEqual(emptyLedger())
  })

  it('falls back to an empty ledger on a wrong-shaped document', () => {
    expect(parseLedger('[]')).toEqual(emptyLedger())
    expect(parseLedger('null')).toEqual(emptyLedger())
    expect(parseLedger('{"mines":"nope"}')).toEqual(emptyLedger())
  })

  it('falls back to an empty ledger written by a future version', () => {
    // Forward compatibility is not worth guessing at: a newer shape is
    // discarded rather than half-read into a wrong vault.
    const future = JSON.stringify({ ...emptyLedger(), version: LEDGER_VERSION + 1 })
    expect(parseLedger(future)).toEqual(emptyLedger())
  })

  it('drops individual junk entries instead of discarding the whole vault', () => {
    const raw = JSON.stringify({
      version: LEDGER_VERSION,
      mines: { 'mine:a': { gold: 100, bogus: 5, silver: 'nope' } },
      sessions: { 'claude:s1': { tokens: 7, seenAt: 3 }, 'claude:s2': { tokens: 'x' } }
    })
    const parsed = parseLedger(raw)
    expect(mineTotals(parsed, 'mine:a').gold).toBe(100)
    expect(mineTotals(parsed, 'mine:a').silver).toBe(0)
    expect((mineTotals(parsed, 'mine:a') as Record<string, unknown>).bogus).toBeUndefined()
    expect(parsed.sessions['claude:s1']).toEqual({ tokens: 7, seenAt: 3 })
    expect(parsed.sessions['claude:s2']).toBeUndefined()
  })

  it('discards a negative stored total rather than trusting a hand-edited file', () => {
    const raw = JSON.stringify({
      version: LEDGER_VERSION,
      mines: { 'mine:a': { gold: -5 } },
      sessions: {}
    })
    expect(mineTotals(parseLedger(raw), 'mine:a').gold).toBe(0)
  })
})
