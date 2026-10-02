// The strangler-only `PresentDwarfs` conformance suite (05 §3.2 `presentIdentities`; AMENDMENT-8,
// OQ-69; 17 §1.3): run on the in-memory double and on the SQLite adapter, beside the
// DwarfRepository contract. Every present dwarf of every mine, in arrival order, a subagent in its
// parent's session as its own dwarf (INV-21), and no departed one. Deleted with B-M41 at the end
// of cut 4 (later: ISSUE-241).
import { afterEach, describe, expect, it } from 'vitest'
import type { DwarfId, MineId, ProviderIdentity } from '../../../kernel/domain/values'
import type { PresentDwarfs } from '../application/crewQueries'
import { baseNameFor } from '../domain/baseName'
import { applyPresence, arriveDwarf, type Dwarf } from '../domain/dwarf'
import { rankForDepth } from '../domain/rank'
import type { DwarfRepositorySubject } from './dwarfRepository.contract'

export interface PresentDwarfsSubject extends Omit<DwarfRepositorySubject, 'repository'> {
  repository: DwarfRepositorySubject['repository'] & PresentDwarfs
}

const T0 = 1_790_000_000_000

let sequence = 0x100
const nextId = (): DwarfId =>
  `00000000-0000-7000-8000-${(++sequence).toString(16).padStart(12, '0')}` as DwarfId

function arrived(mineId: MineId, identity: ProviderIdentity, at: number, parent?: Dwarf): Dwarf {
  return arriveDwarf({
    id: nextId(),
    mineId,
    identity,
    baseName: baseNameFor(identity),
    delegated: false,
    parentDwarfId: parent?.id ?? null,
    rank: rankForDepth(parent === undefined ? 0 : 1),
    status: 'idle',
    at
  })
}

export function runPresentDwarfsContract(
  makeSubject: () => PresentDwarfsSubject | Promise<PresentDwarfsSubject>
): void {
  describe('PresentDwarfs contract (strangler-only)', () => {
    let subject: PresentDwarfsSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    it('[INV-21] present lists every present dwarf of every mine in arrival order, a subagent as its own dwarf, and no departed one', async () => {
      const s = await makeSubject()
      subject = s
      const [mine, other] = s.mineIds
      const root: ProviderIdentity = { providerId: 'claude', providerSessionId: 'session-1' }
      const parent = arrived(mine, root, T0)
      const subagent = arrived(mine, { ...root, providerAgentId: 'agent-1' }, T0 + 1, parent)
      const gone = applyPresence(
        arrived(mine, { providerId: 'codex', providerSessionId: 'thread-9' }, T0 + 2),
        { type: 'session-closed', cause: 'closed-elsewhere', at: T0 + 3 }
      )
      if (!gone.ok) throw new Error('fixture transition refused')
      const elsewhere = arrived(
        other,
        { providerId: 'codex', providerSessionId: 'thread-1' },
        T0 + 4
      )

      s.inTransaction(() => {
        for (const d of [parent, subagent, gone.value, elsewhere]) s.repository.save(d)
      })

      expect(s.repository.present().map((d) => [d.id, d.identity])).toStrictEqual([
        [parent.id, root],
        [subagent.id, { ...root, providerAgentId: 'agent-1' }],
        [elsewhere.id, { providerId: 'codex', providerSessionId: 'thread-1' }]
      ])
    })
  })
}
