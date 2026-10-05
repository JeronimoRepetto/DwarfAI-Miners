// The MineRepository conformance suite (16 §4.1 `runMineRepositoryContract`; 17 §1.3): run on the
// in-memory double and on the SQLite adapter. One mine per canonical path, removed mines included
// (INV-02); removal is soft and keeps the mine's row, id and ledger rows (INV-06, NFR-PERS-08); a
// removed mine is found by path so rediscovery reuses its id (INV-07); every query is bound
// (ADR-005); `save` runs only inside the caller's transaction (16 §2.2); a new mine is given a free
// map site (the `mapSite.ts` rules); and the browse filters, sorts and pages as `MineQuery` says.
import { afterEach, describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { FolderPath, MineId } from '../../../kernel/domain/values'
import {
  mineIdOf,
  mineNameOf,
  openMine,
  transition,
  type MapSite,
  type Mine,
  type MineInput
} from '../domain/mine'
import { canonicalMinePath } from '../domain/minePath'
import { DEFAULT_TIER_THRESHOLDS } from '../domain/tier'
import type { MineQuery, MineRepository } from '../ports/mineRepository'

/** A ledger material (09 §4.7 `ledger_entries.material`). */
export type LedgerMaterial = 'coal' | 'bronze' | 'copper' | 'silver' | 'gold' | 'uranium'

export interface MineRepositorySubject {
  repository: MineRepository
  /** The spawn sites the subject's repository picks from, in order; its random source answers 0. */
  mapSites: readonly [MapSite, MapSite]
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  /** Credits `tokens` of `material` to a stored mine's ledger (one ledger row per call). */
  credit(mineId: MineId, material: LedgerMaterial, tokens: number): void
  /** How many ledger rows the mine has. */
  ledgerRows(mineId: MineId): number
  dispose(): void | Promise<void>
}

class CallerFailure extends Error {}

const T0 = 1_790_000_000_000
const KB = 1024

let sequence = 0
const nextId = (): MineId =>
  mineIdOf(`00000000-0000-7000-8000-${(++sequence).toString(16).padStart(12, '0')}`)

/** A mine declared at `/work/<name>` ("Add a mine", S3.04): `measuring`, never measured. */
function declared(name: string, at = T0): Mine {
  const step = openMine(
    {
      cause: 'declared',
      birth: {
        id: nextId(),
        path: canonicalMinePath(`/work/${name}`, { style: 'posix', caseFold: false }),
        name: mineNameOf(name)
      }
    },
    at
  )
  if (step.mine === null) throw new Error('fixture opening refused')
  return step.mine
}

/** One step of machine 3 that must apply. */
function then(mine: Mine, input: MineInput, at = T0): Mine {
  const step = transition(mine, input, at)
  if (step.mine === null || step.transition === null)
    throw new Error(`fixture ${input.type} refused`)
  return step.mine
}

const measuredAt = (mine: Mine, kb: number, at = T0): Mine =>
  then(
    mine,
    { type: 'measured', sourceWeight: { bytes: kb * KB }, thresholds: DEFAULT_TIER_THRESHOLDS },
    at
  )

const removedAt = (mine: Mine, at: number): Mine =>
  then(
    then(mine, { type: 'removal-requested' }, at),
    { type: 'removal-settled', everyDwarfEnded: true },
    at
  )

const pathOf = (mine: Mine): FolderPath => mine.path as string as FolderPath

/** A stored mine without the map site the repository picked for it. */
function withoutSite(mine: Mine | null): Mine | null {
  if (mine === null) return null
  const rest: { -readonly [K in keyof Mine]: Mine[K] } = { ...mine }
  delete rest.mapSite
  return rest
}

export function runMineRepositoryContract(
  makeSubject: () => MineRepositorySubject | Promise<MineRepositorySubject>
): void {
  describe('MineRepository contract', () => {
    let subject: MineRepositorySubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async () => {
      subject = await makeSubject()
      return subject
    }

    const saveIn = (s: MineRepositorySubject, ...mines: Mine[]) =>
      s.inTransaction(() => {
        for (const mine of mines) s.repository.save(mine)
      })

    const names = (mines: Mine[]) => mines.map((m) => m.name)

    it('[INV-02] saving a second mine with the same canonical path is refused', async () => {
      const s = await setUp()
      const first = declared('repo')
      const second: Mine = { ...declared('elsewhere'), path: first.path }
      saveIn(s, first)

      expect(() => saveIn(s, second)).toThrow(HostInvariantError)

      expect(s.repository.byPath(pathOf(first))?.id).toBe(first.id)
      expect(s.repository.byId(second.id)).toBeNull()
      // Removed mines keep their path: a new mine at a removed mine's folder is refused too.
      saveIn(s, removedAt(first, T0 + 1))
      expect(() => saveIn(s, second)).toThrow(HostInvariantError)
      expect(s.repository.byId(second.id)).toBeNull()
    })

    it('[INV-02] save outside a transaction is a programming error and a rolled-back save leaves nothing', async () => {
      const s = await setUp()
      const mine = declared('repo')

      expect(() => s.repository.save(mine)).toThrow(HostInvariantError)
      expect(() =>
        s.inTransaction(() => {
          s.repository.save(mine)
          throw new CallerFailure('the caller failed after saving')
        })
      ).toThrow(CallerFailure)

      expect(s.repository.byId(mine.id)).toBeNull()
      expect(s.repository.byPath(pathOf(mine))).toBeNull()
    })

    it('[INV-02] a saved mine reads back by id and by path with every stored field', async () => {
      const s = await setUp()
      const site: MapSite = { xPct: 12.5, yPct: 87.25 }
      const walked = then(measuredAt({ ...declared('repo', T0), mapSite: site }, 2_000, T0 + 5), {
        type: 'folder-checked',
        folder: 'missing',
        reason: 'The folder was moved or deleted.'
      })
      const fresh = declared('fresh', T0 + 9)

      saveIn(s, walked, fresh)

      expect(walked).toMatchObject({ state: 'unenterable', tier: 'silver', hasBeenMeasured: true })
      expect(s.repository.byId(walked.id)).toEqual(walked)
      expect(s.repository.byPath(pathOf(walked))).toEqual(walked)
      expect(withoutSite(s.repository.byId(fresh.id))).toEqual(fresh)
      expect(s.repository.byId(nextId())).toBeNull()
      expect(s.repository.byPath('/work/nowhere' as FolderPath)).toBeNull()
    })

    it('[INV-06, NFR-PERS-08] a removed mine keeps its row, id and ledger rows', async () => {
      const s = await setUp()
      const mine = measuredAt(declared('repo'), 400)
      saveIn(s, mine)
      s.credit(mine.id, 'gold', 120)
      s.credit(mine.id, 'coal', 30)

      const removed = removedAt(mine, T0 + 50)
      saveIn(s, removed)

      const stored = s.repository.byId(mine.id)
      expect(stored).toMatchObject({ id: mine.id, state: 'removed', removedAt: T0 + 50 })
      expect(stored?.tier).toBe('copper')
      expect(s.ledgerRows(mine.id)).toBe(2)
      // A removed mine is never listed (09 §4.11), but it is still stored.
      expect(s.repository.query({ sortBy: 'name', direction: 'asc' })).toEqual([])
    })

    it('[INV-07] byPath finds a removed mine so rediscovery reuses its id', async () => {
      const s = await setUp()
      const mine = measuredAt(declared('repo'), 400)
      saveIn(s, mine)
      s.credit(mine.id, 'silver', 7)
      saveIn(s, removedAt(mine, T0 + 50))

      const found = s.repository.byPath(pathOf(mine))
      expect(found).toMatchObject({ id: mine.id, state: 'removed' })
      const back = then(
        found!,
        { type: 'session-observed', inLinkedWorktree: false, endedByTerminator: false },
        T0 + 60
      )
      saveIn(s, back)

      expect(s.repository.byId(mine.id)).toMatchObject({
        id: mine.id,
        state: 'active',
        lastUsedAt: T0 + 60
      })
      expect(s.repository.byId(mine.id)?.removedAt).toBeUndefined()
      expect(s.ledgerRows(mine.id)).toBe(1)
      expect(s.repository.query({ sortBy: 'name', direction: 'asc' }).map((m) => m.id)).toEqual([
        mine.id
      ])
    })

    it("[US-MAP-004.AC01] a mine's first save picks a free map site, a later save keeps it, and none is left past the last site", async () => {
      const s = await setUp()
      const [first, second] = s.mapSites
      const a = declared('a')
      const b = declared('b')
      const c = declared('c')

      saveIn(s, a)
      saveIn(s, b)
      expect(s.repository.byId(a.id)?.mapSite).toEqual(first)
      expect(s.repository.byId(b.id)?.mapSite).toEqual(second)

      // The caller's copy carries no site: the stored one stays.
      saveIn(s, { ...a, lastUsedAt: T0 + 1 })
      expect(s.repository.byId(a.id)).toMatchObject({ mapSite: first, lastUsedAt: T0 + 1 })

      // Every site is held (a removed mine keeps its own): the third mine gets none.
      saveIn(s, removedAt(s.repository.byId(b.id)!, T0 + 2))
      saveIn(s, c)
      expect(s.repository.byId(c.id)?.mapSite).toBeUndefined()
    })

    it('[ADR-005] query binds every parameter; a name containing a quote or a percent sign matches literally', async () => {
      const s = await setUp()
      saveIn(
        s,
        declared("it's 100%"),
        declared('its 1000'),
        declared('100 percent'),
        declared('a_b'),
        declared('axb'),
        declared('back\\slash')
      )
      const search = (nameContains: string) =>
        names(s.repository.query({ sortBy: 'name', direction: 'asc', nameContains }))

      expect(search("'s 100%")).toEqual(["it's 100%"])
      expect(search('100%')).toEqual(["it's 100%"])
      expect(search('%')).toEqual(["it's 100%"])
      expect(search('a_b')).toEqual(['a_b'])
      expect(search('\\')).toEqual(['back\\slash'])
      expect(search("' OR 1=1 --")).toEqual([])
      // Folded like the stored name: case and accents are ignored (US-MINES-001.AC05).
      expect(search('  IT’S')).toEqual([])
      expect(search('  ITS ')).toEqual(['its 1000'])
      expect(search('   ')).toHaveLength(6)
    })

    // The Mines page fixture: four listed mines and a removed one.
    //   alpha    copper 400 KB, last used T0+3, gold 10
    //   Bravo    silver 2000 KB, last used T0+1, uranium 1
    //   charlie  never measured, last used T0+4, no ore
    //   delta    copper 500 KB, last used T0+2, gold 10 + coal 5
    //   echo     removed (silver), last used T0+9, uranium 99
    async function minesPage() {
      const s = await setUp()
      const alpha = measuredAt(declared('alpha', T0 + 3), 400)
      const bravo = measuredAt(declared('Bravo', T0 + 1), 2_000)
      const charlie = declared('charlie', T0 + 4)
      const delta = measuredAt(declared('delta', T0 + 2), 500)
      const echo = measuredAt(declared('echo', T0 + 9), 3_000)
      saveIn(s, alpha, bravo, charlie, delta, echo)
      s.credit(alpha.id, 'gold', 10)
      s.credit(bravo.id, 'uranium', 1)
      s.credit(delta.id, 'gold', 10)
      s.credit(delta.id, 'coal', 5)
      s.credit(echo.id, 'uranium', 99)
      saveIn(s, removedAt(echo, T0 + 10))
      const list = (q: MineQuery) => names(s.repository.query(q))
      return { s, alpha, list }
    }

    it('[US-MINES-002.AC06, US-MINES-002.AC07] query filters by the stored tier: a never-measured mine matches no tier and a re-measuring mine keeps its last one', async () => {
      const { s, alpha, list } = await minesPage()

      expect(list({ tier: 'copper', sortBy: 'name', direction: 'asc' })).toEqual(['alpha', 'delta'])
      expect(list({ tier: 'silver', sortBy: 'name', direction: 'asc' })).toEqual(['Bravo'])
      expect(list({ tier: 'bronze', sortBy: 'name', direction: 'asc' })).toEqual([])
      expect(list({ tier: 'uranium', sortBy: 'name', direction: 'asc' })).toEqual([])

      saveIn(s, then(s.repository.byId(alpha.id)!, { type: 'remeasure-requested' }))
      expect(list({ tier: 'copper', sortBy: 'name', direction: 'asc' })).toEqual(['alpha', 'delta'])
      // Search composes with the tier filter (US-MINES-001.AC04).
      expect(
        list({ tier: 'copper', sortBy: 'name', direction: 'asc', nameContains: 'ELT' })
      ).toEqual(['delta'])
    })

    it('[US-MINES-003.AC03] query sorts by name, last used, tier then source weight with never-measured last, or ore richest material first, in both directions', async () => {
      const { list } = await minesPage()
      const sorted = (sortBy: MineQuery['sortBy'], direction: MineQuery['direction']) =>
        list({ sortBy, direction })

      expect(sorted('name', 'asc')).toEqual(['alpha', 'Bravo', 'charlie', 'delta'])
      expect(sorted('name', 'desc')).toEqual(['delta', 'charlie', 'Bravo', 'alpha'])
      expect(sorted('lastUsed', 'desc')).toEqual(['charlie', 'alpha', 'delta', 'Bravo'])
      expect(sorted('lastUsed', 'asc')).toEqual(['Bravo', 'delta', 'alpha', 'charlie'])
      expect(sorted('tier', 'desc')).toEqual(['Bravo', 'delta', 'alpha', 'charlie'])
      expect(sorted('tier', 'asc')).toEqual(['alpha', 'delta', 'Bravo', 'charlie'])
      expect(sorted('ore', 'desc')).toEqual(['Bravo', 'delta', 'alpha', 'charlie'])
      expect(sorted('ore', 'asc')).toEqual(['charlie', 'alpha', 'delta', 'Bravo'])
    })

    it('[ADR-005] query pages with limit and offset over a total order and never lists a removed mine', async () => {
      const { s, list } = await minesPage()

      expect(list({ sortBy: 'name', direction: 'asc', limit: 2, offset: 1 })).toEqual([
        'Bravo',
        'charlie'
      ])
      expect(list({ sortBy: 'name', direction: 'asc', offset: 3 })).toEqual(['delta'])
      expect(list({ sortBy: 'name', direction: 'asc', limit: 1 })).toEqual(['alpha'])
      expect(list({ sortBy: 'name', direction: 'asc', offset: 4 })).toEqual([])

      // Equal keys fall back to the id, so paging never skips or repeats a mine.
      const twins = [declared('twin', T0 + 20), declared('twin-b', T0 + 20)]
      saveIn(s, ...twins)
      const byRecency = s.repository.query({ sortBy: 'lastUsed', direction: 'desc', limit: 2 })
      expect(byRecency.map((m) => m.id)).toEqual(twins.map((m) => m.id).sort())
    })
  })
}
