// layer: L2
// L2 (17 §1.2): the strangler-only `CrewQueries.presentIdentities()` (05 §3.2; 14 §3.4
// `StranglerDwarfIdentity`; AMENDMENT-8, OQ-69) over the crew application and its in-memory
// doubles: one record per present dwarf, across every mine, built from the imported names only
// (`DwarfId`, `ProviderId`, `ProviderIdentity`; ADR-015 item 7). A Claude subagent sharing its
// parent's session is its own dwarf with its own `providerAgentId` (INV-21). Deleted with B-M41 at
// the end of cut 4 (later: ISSUE-241).
import { describe, expect, it } from 'vitest'
import type { MineId, ProviderIdentity } from '../../../kernel/domain/values'
import { rankForDepth } from '../domain/rank'
import { inMemoryCrew } from '../testing/inMemoryCrew'

const MINE = '00000000-0000-7000-8000-0000000000f1' as MineId
const OTHER_MINE = '00000000-0000-7000-8000-0000000000f2' as MineId

const PARENT: ProviderIdentity = { providerId: 'claude', providerSessionId: 'session-1' }
const SUBAGENT: ProviderIdentity = {
  providerId: 'claude',
  providerSessionId: 'session-1',
  providerAgentId: 'agent-1'
}
const CODEX: ProviderIdentity = { providerId: 'codex', providerSessionId: 'thread-1' }
const LEFT: ProviderIdentity = { providerId: 'codex', providerSessionId: 'thread-2' }

describe('CrewQueries.presentIdentities (strangler-only)', () => {
  it('[ADR-015] one record per present dwarf with providerId equal to identity.providerId and departed dwarfs excluded', () => {
    const crew = inMemoryCrew()
    const parent = crew.commands.arrive({
      mineId: MINE,
      identity: PARENT,
      rank: rankForDepth(0),
      status: 'working'
    })
    const subagent = crew.commands.arrive({
      mineId: MINE,
      identity: SUBAGENT,
      parent,
      rank: rankForDepth(1),
      status: 'working'
    })
    const left = crew.commands.arrive({
      mineId: MINE,
      identity: LEFT,
      rank: rankForDepth(0),
      status: 'idle'
    })
    const codex = crew.commands.arrive({
      mineId: OTHER_MINE,
      identity: CODEX,
      rank: rankForDepth(0),
      status: 'idle'
    })
    crew.commands.sessionClosed(left, 'closed-elsewhere')

    const records = crew.queries.presentIdentities()

    expect(records).toStrictEqual([
      { dwarfId: parent, providerId: 'claude', identity: PARENT },
      { dwarfId: subagent, providerId: 'claude', identity: SUBAGENT },
      { dwarfId: codex, providerId: 'codex', identity: CODEX }
    ])
    for (const record of records) expect(record.providerId).toBe(record.identity.providerId)
  })
})
