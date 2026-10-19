// The DwarfRepository conformance suite (16 §4.2 `runDwarfRepositoryContract`; 17 §1.3): run on
// the in-memory double and on the SQLite adapter. One dwarf per provider identity, a subagent in
// its parent's session is its own dwarf, a rebind keeps the id and the custom name; every stored
// field reads back, the Host-memory ones do not; `save` runs only inside the caller's transaction
// and a rolled-back transaction leaves nothing.
import { afterEach, describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, MineId, ProviderIdentity } from '../../../kernel/domain/values'
import { baseNameFor } from '../domain/baseName'
import {
  applyPresence,
  arriveDwarf,
  rebindDwarf,
  recordPendingEnd,
  type Dwarf
} from '../domain/dwarf'
import { rankForDepth } from '../domain/rank'
import { askOpened, turnEnded } from '../domain/statusFacts'
import type { DwarfRepository } from '../ports/dwarfRepository'

export interface DwarfRepositorySubject {
  repository: DwarfRepository
  /** Two mines that exist in the subject's store (the SQLite half seeds their rows). */
  mineIds: readonly [MineId, MineId]
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  dispose(): void | Promise<void>
}

class CallerFailure extends Error {}

const T0 = 1_790_000_000_000
const ROOT: ProviderIdentity = { providerId: 'claude', providerSessionId: 'session-1' }

let sequence = 0
const nextId = (): DwarfId =>
  `00000000-0000-7000-8000-${(++sequence).toString(16).padStart(12, '0')}` as DwarfId

function arrived(
  mineId: MineId,
  identity: ProviderIdentity,
  extra: { parent?: Dwarf; at?: number } = {}
): Dwarf {
  return arriveDwarf({
    id: nextId(),
    mineId,
    identity,
    baseName: baseNameFor(identity),
    delegated: false,
    parentDwarfId: extra.parent?.id ?? null,
    rank: rankForDepth(extra.parent === undefined ? 0 : 1),
    status: 'idle',
    at: extra.at ?? T0
  })
}

export function runDwarfRepositoryContract(
  makeSubject: () => DwarfRepositorySubject | Promise<DwarfRepositorySubject>
): void {
  describe('DwarfRepository contract', () => {
    let subject: DwarfRepositorySubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async () => {
      subject = await makeSubject()
      return subject
    }

    const saveIn = (s: DwarfRepositorySubject, d: Dwarf) =>
      s.inTransaction(() => s.repository.save(d))

    it('[INV-21] a second dwarf with the same provider identity is refused', async () => {
      const s = await setUp()
      const [mine] = s.mineIds
      const first = arrived(mine, ROOT)
      const second = arrived(mine, { ...ROOT })
      saveIn(s, first)

      expect(() => saveIn(s, second)).toThrow()

      expect(s.repository.byProviderIdentity(ROOT)?.id).toBe(first.id)
      expect(s.repository.byId(second.id)).toBeNull()
      expect(s.repository.inMine(mine).map((d) => d.id)).toEqual([first.id])
    })

    it("[INV-21] a Claude subagent with its own providerAgentId in the parent's session is a separate dwarf", async () => {
      const s = await setUp()
      const [mine] = s.mineIds
      const parent = arrived(mine, ROOT)
      const subagentIdentity: ProviderIdentity = { ...ROOT, providerAgentId: 'agent-7' }
      const subagent = arrived(mine, subagentIdentity, { parent, at: T0 + 1 })

      saveIn(s, parent)
      saveIn(s, subagent)

      expect(s.repository.byProviderIdentity(ROOT)?.id).toBe(parent.id)
      expect(s.repository.byProviderIdentity({ ...ROOT, providerAgentId: '' })?.id).toBe(parent.id)
      expect(s.repository.byProviderIdentity(subagentIdentity)?.id).toBe(subagent.id)
      expect(s.repository.byId(subagent.id)?.parentDwarfId).toBe(parent.id)
      expect(s.repository.inMine(mine).map((d) => d.id)).toEqual([parent.id, subagent.id])
    })

    it('[INV-22] rebind keeps the dwarf id and the custom name and stores the previous provider session id', async () => {
      const s = await setUp()
      const [mine] = s.mineIds
      const dwarf: Dwarf = { ...arrived(mine, ROOT), customName: 'Gimli' }
      saveIn(s, dwarf)
      const next: ProviderIdentity = { ...ROOT, providerSessionId: 'session-2' }

      saveIn(s, rebindDwarf(dwarf, next))

      const stored = s.repository.byId(dwarf.id)
      expect(stored).toMatchObject({
        id: dwarf.id,
        customName: 'Gimli',
        identity: next,
        previousProviderSessionId: 'session-1'
      })
      expect(s.repository.byProviderIdentity(next)?.id).toBe(dwarf.id)
      expect(s.repository.byProviderIdentity(ROOT)).toBeNull()
    })

    it('[ADR-015] a saved dwarf reads back by id, by identity and in its mine with every stored field', async () => {
      const s = await setUp()
      const [mine, other] = s.mineIds
      const parent = arrived(mine, ROOT)
      const base = arrived(mine, { ...ROOT, providerAgentId: 'agent-7' }, { parent, at: T0 + 1 })
      const left = applyPresence(
        {
          ...base,
          customName: 'Gimli',
          stopInFlight: true,
          sessionProfile: {
            providerId: 'claude',
            model: 'model-x',
            effort: 'high',
            permissionMode: 'ask'
          },
          facts: turnEnded(base.facts, {
            at: T0 + 5,
            reliability: 'inferred',
            cancelledFromApp: false
          })
        },
        { type: 'session-closed', cause: 'stopped', at: T0 + 9 }
      )
      if (!left.ok) throw new Error('fixture transition refused')
      const elsewhere = arrived(other, { providerId: 'codex', providerSessionId: 'thread-1' })

      saveIn(s, parent)
      saveIn(s, left.value)
      saveIn(s, elsewhere)

      expect(s.repository.byId(left.value.id)).toEqual(left.value)
      expect(s.repository.byProviderIdentity(left.value.identity)).toEqual(left.value)
      expect(s.repository.inMine(mine)).toEqual([parent, left.value])
      expect(s.repository.inMine(other)).toEqual([elsewhere])
      expect(s.repository.byId(nextId())).toBeNull()
    })

    it('[ADR-032] the pending end and the open ask are Host memory and never stored', async () => {
      const s = await setUp()
      const [mine] = s.mineIds
      const dwarf = arrived(mine, ROOT)
      const asking = recordPendingEnd(
        {
          ...dwarf,
          facts: askOpened(dwarf.facts, { kind: 'question', askedAt: T0 + 1, state: 'open' })
        },
        'stop-dwarf'
      )

      saveIn(s, asking)

      expect(s.repository.byId(dwarf.id)).toEqual(dwarf)
    })

    it('[ADR-015] save outside a transaction is a programming error and a rolled-back save leaves nothing', async () => {
      const s = await setUp()
      const [mine] = s.mineIds
      const dwarf = arrived(mine, ROOT)

      expect(() => s.repository.save(dwarf)).toThrow(HostInvariantError)
      expect(() =>
        s.inTransaction(() => {
          s.repository.save(dwarf)
          throw new CallerFailure('the caller failed after saving')
        })
      ).toThrow(CallerFailure)

      expect(s.repository.byId(dwarf.id)).toBeNull()
      expect(s.repository.inMine(mine)).toEqual([])
    })
  })
}
