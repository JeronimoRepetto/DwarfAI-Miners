// layer: L5
// L5 (17 §1.5): the mines step of the Reset-metrics saga (16 §4.12 `ResetDbStep`; 07 S3.24; 09
// §7.2 row "`mines` with a present dwarf": `map_site_*` re-picked) over a copy of the template
// database: several recreated mines are each given a free spawn site, never one another kept mine
// holds (the `mapSite.ts` rules, US-MAP-004.AC01), and their walks wait for the commit.
//
// TC-097-01.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import type { MineId } from '../../../../kernel/domain/values'
import { SqliteTransactionRunner } from '../../../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../../../platform/sqlite/testing/templateDb'
import { MinesResetStep } from './MinesResetStep'

const T0 = 1_790_000_000_000
const MINES = [
  '00000000-0000-7000-8000-0000000097a1',
  '00000000-0000-7000-8000-0000000097a2'
] as const
const SITES = [
  { xPct: 5, yPct: 5 },
  { xPct: 15, yPct: 25 },
  { xPct: 35, yPct: 45 }
] as const

function seeded() {
  const { db } = openTemplateCopy()
  const runner = new SqliteTransactionRunner(db)
  runner.inTransaction(() => {
    MINES.forEach((id, n) => {
      // Both stand on the first site's neighbour before the reset.
      db.run(
        `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at,
           map_site_x_pct, map_site_y_pct)
         VALUES (?, ?, 'm', 'm', 'active', ?, ?, ?, ?)`,
        [id, `/mine-${n}`, T0, T0, SITES[2 - n]!.xPct, SITES[2 - n]!.yPct]
      )
      db.run(
        `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
           process_state, turn_state, arrived_at, last_activity_at)
         VALUES (?, ?, 'codex', ?, 'Oin', 'foreman', 'running', 'none-yet', ?, ?)`,
        [`00000000-0000-7000-8000-0000000097b${n}`, id, `session-${n}`, T0, T0]
      )
    })
  })
  const walked: MineId[] = []
  const step = new MinesResetStep({
    db,
    scope: runner,
    clock: new FakeClock(T0 + 1),
    mapSites: SITES,
    random: () => 0,
    remeasure: (mineId) => walked.push(mineId)
  })
  return { db, runner, step, walked }
}

describe('MinesResetStep', () => {
  it('[S3.24] each recreated mine gets a free map site, never one another kept mine holds', () => {
    const { db, runner, step } = seeded()

    runner.inTransaction(() => step.reset(runner))

    // In id order, with `random` 0: the first free site, then the first one still free.
    expect(
      db
        .all('SELECT id, map_site_x_pct, map_site_y_pct FROM mines ORDER BY id')
        .map((row) => ({ ...row }))
    ).toStrictEqual([
      { id: MINES[0], map_site_x_pct: SITES[0].xPct, map_site_y_pct: SITES[0].yPct },
      { id: MINES[1], map_site_x_pct: SITES[1].xPct, map_site_y_pct: SITES[1].yPct }
    ])
  })

  it('[S3.24] the walks of the recreated mines are queued once, after the commit', () => {
    const { runner, step, walked } = seeded()

    runner.inTransaction(() => {
      step.reset(runner)
      expect(walked).toStrictEqual([])
    })
    step.walkRecreatedMines()
    step.walkRecreatedMines()

    expect(walked).toStrictEqual([...MINES])
  })
})
