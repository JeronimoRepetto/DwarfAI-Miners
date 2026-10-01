// The LifecycleFactLog conformance suite (16 §3 `runLifecycleFactLogContract`; 17 §1.3): run on
// the in-memory double and on the SQLite adapter. One departure per dwarf, one `TurnEnded` per
// turn key, one row per provider `source_key` and per identity; a repeat is `'duplicate'` with
// no row; `TurnEnded` rows trimmed to the newest 50 per dwarf in the inserting transaction; a call
// outside a transaction is a programming error; a rolled-back caller transaction leaves no fact.
import { afterEach, describe, expect, it } from 'vitest'
import { HostInvariantError } from '../domain/errors'
import type { LifecycleFact, LifecycleFactLog, LifecycleFactType } from '../ports/lifecycleFactLog'

/** One stored fact row, as the subject reads it back. */
export interface StoredLifecycleFact {
  type: LifecycleFactType
  dwarfId: string
  sourceKey: string | null
}

export interface LifecycleFactLogSubject {
  log: LifecycleFactLog
  /** Two dwarfs that exist in the subject's store (the SQLite half seeds their rows). */
  dwarfIds: readonly [string, string]
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  /** Every stored fact row, oldest insert first; readable inside an open transaction too. */
  facts(): StoredLifecycleFact[]
  dispose(): void | Promise<void>
}

class CallerFailure extends Error {}

const T0 = 1_750_000_000_000

export function runLifecycleFactLogContract(
  makeSubject: () => LifecycleFactLogSubject | Promise<LifecycleFactLogSubject>
): void {
  describe('LifecycleFactLog contract', () => {
    let subject: LifecycleFactLogSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async () => {
      subject = await makeSubject()
      return subject
    }

    const recordIn = (s: LifecycleFactLogSubject, fact: LifecycleFact) =>
      s.inTransaction(() => s.log.record(fact))

    it('[ADR-006] a first DwarfDeparted for a dwarf is new and a second is duplicate with no second row', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfIds

      const first = recordIn(s, {
        type: 'DwarfDeparted',
        dwarfId: dwarf,
        cause: 'stopped',
        occurredAt: T0
      })
      const second = recordIn(s, {
        type: 'DwarfDeparted',
        dwarfId: dwarf,
        cause: 'closed-elsewhere',
        sourceKey: 'claude:stream-1:closed-2',
        occurredAt: T0 + 1
      })
      const otherDwarf = recordIn(s, {
        type: 'DwarfDeparted',
        dwarfId: other,
        cause: 'crashed',
        occurredAt: T0 + 2
      })

      expect([first, second, otherDwarf]).toEqual(['new', 'duplicate', 'new'])
      expect(s.facts()).toEqual([
        { type: 'DwarfDeparted', dwarfId: dwarf, sourceKey: null },
        { type: 'DwarfDeparted', dwarfId: other, sourceKey: null }
      ])
    })

    it('[ADR-006] the same TurnEnded turn key reported by two paths is recorded once', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfIds

      const fromDriver = recordIn(s, {
        type: 'TurnEnded',
        dwarfId: dwarf,
        turnKey: 'turn-7',
        sourceKey: 'claude-stream-json:stream-1:result-7',
        occurredAt: T0
      })
      const fromTranscript = recordIn(s, {
        type: 'TurnEnded',
        dwarfId: dwarf,
        turnKey: 'turn-7',
        sourceKey: 'claude-transcript:stream-1:line-42',
        occurredAt: T0 + 5
      })
      const inferred = recordIn(s, {
        type: 'TurnEnded',
        dwarfId: dwarf,
        turnKey: 'turn-7',
        occurredAt: T0 + 9
      })
      const sameKeyOtherDwarf = recordIn(s, {
        type: 'TurnEnded',
        dwarfId: other,
        turnKey: 'turn-7',
        occurredAt: T0 + 9
      })

      expect([fromDriver, fromTranscript, inferred, sameKeyOtherDwarf]).toEqual([
        'new',
        'duplicate',
        'duplicate',
        'new'
      ])
      expect(s.facts()).toEqual([
        { type: 'TurnEnded', dwarfId: dwarf, sourceKey: `turn:${dwarf}:turn-7` },
        { type: 'TurnEnded', dwarfId: other, sourceKey: `turn:${other}:turn-7` }
      ])
    })

    it('[ADR-006] a provider fact with the same source_key is recorded once', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfIds
      const exited: LifecycleFact = {
        type: 'DriverSessionExited',
        dwarfId: dwarf,
        sourceKey: 'codex-app-server:stream-3:exit-1',
        exitCode: 0,
        occurredAt: T0
      }

      const answers = [
        recordIn(s, {
          type: 'SessionClosedObserved',
          dwarfId: dwarf,
          sourceKey: 'claude:stream-1:closed-9',
          occurredAt: T0
        }),
        recordIn(s, {
          type: 'SessionClosedObserved',
          dwarfId: dwarf,
          sourceKey: 'claude:stream-1:closed-9',
          occurredAt: T0 + 1
        }),
        recordIn(s, {
          type: 'SubagentObserved',
          dwarfId: dwarf,
          sourceKey: 'claude:stream-1:agent-2',
          occurredAt: T0
        }),
        recordIn(s, {
          type: 'SubagentObserved',
          dwarfId: dwarf,
          sourceKey: 'claude:stream-1:agent-2',
          occurredAt: T0 + 1
        }),
        recordIn(s, exited),
        recordIn(s, { ...exited, exitCode: 1, occurredAt: T0 + 1 })
      ]

      expect(answers).toEqual(['new', 'duplicate', 'new', 'duplicate', 'new', 'duplicate'])
      expect(s.facts()).toEqual([
        { type: 'SessionClosedObserved', dwarfId: dwarf, sourceKey: 'claude:stream-1:closed-9' },
        { type: 'SubagentObserved', dwarfId: dwarf, sourceKey: 'claude:stream-1:agent-2' },
        {
          type: 'DriverSessionExited',
          dwarfId: dwarf,
          sourceKey: 'codex-app-server:stream-3:exit-1'
        }
      ])
    })

    it('[ADR-006] DwarfArrived and DwarfRebound are keyed by the provider identity: a repeat is duplicate', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfIds
      const identity = 'claude|session-1|'
      const next = 'claude|session-2|'

      const answers = [
        recordIn(s, {
          type: 'DwarfArrived',
          dwarfId: dwarf,
          identityKey: identity,
          occurredAt: T0
        }),
        recordIn(s, {
          type: 'DwarfArrived',
          dwarfId: dwarf,
          identityKey: identity,
          occurredAt: T0 + 1
        }),
        recordIn(s, {
          type: 'DwarfRebound',
          dwarfId: dwarf,
          identityKey: next,
          occurredAt: T0 + 2
        }),
        recordIn(s, {
          type: 'DwarfRebound',
          dwarfId: dwarf,
          identityKey: next,
          occurredAt: T0 + 3
        }),
        // the same identity string under another type, or for another dwarf, is another key
        recordIn(s, {
          type: 'DwarfRebound',
          dwarfId: other,
          identityKey: next,
          occurredAt: T0 + 4
        }),
        recordIn(s, {
          type: 'DwarfArrived',
          dwarfId: other,
          identityKey: 'claude|session-3|',
          occurredAt: T0 + 5
        })
      ]

      expect(answers).toEqual(['new', 'duplicate', 'new', 'duplicate', 'new', 'new'])
      expect(s.facts().map((fact) => [fact.type, fact.dwarfId])).toEqual([
        ['DwarfArrived', dwarf],
        ['DwarfRebound', dwarf],
        ['DwarfRebound', other],
        ['DwarfArrived', other]
      ])
    })

    it('[ADR-006] TurnEnded rows beyond the newest 50 of a dwarf are trimmed in the inserting transaction', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfIds
      const turnEnd = (dwarfId: string, n: number): LifecycleFact => ({
        type: 'TurnEnded',
        dwarfId,
        turnKey: `turn-${n}`,
        occurredAt: T0 + n
      })
      const turnKeysOf = (dwarfId: string) =>
        s
          .facts()
          .filter((fact) => fact.type === 'TurnEnded' && fact.dwarfId === dwarfId)
          .map((fact) => fact.sourceKey)

      for (let n = 1; n <= 50; n += 1) recordIn(s, turnEnd(dwarf, n))
      recordIn(s, turnEnd(other, 1))
      recordIn(s, { type: 'DwarfArrived', dwarfId: dwarf, identityKey: 'id-a', occurredAt: T0 })
      expect(turnKeysOf(dwarf)).toHaveLength(50)

      const seenInside = s.inTransaction(() => {
        const answer = s.log.record(turnEnd(dwarf, 51))
        return { answer, keys: turnKeysOf(dwarf) }
      })

      expect(seenInside.answer).toBe('new')
      expect(seenInside.keys).toHaveLength(50)
      expect(seenInside.keys).not.toContain(`turn:${dwarf}:turn-1`)
      expect(seenInside.keys).toContain(`turn:${dwarf}:turn-2`)
      expect(seenInside.keys).toContain(`turn:${dwarf}:turn-51`)
      // other dwarfs' turn ends and other fact types are never trimmed
      expect(turnKeysOf(other)).toEqual([`turn:${other}:turn-1`])
      expect(s.facts().filter((fact) => fact.type === 'DwarfArrived')).toHaveLength(1)
    })

    it('[ADR-006] record outside a transaction throws HostInvariantError', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfIds

      expect(() =>
        s.log.record({ type: 'DwarfDeparted', dwarfId: dwarf, cause: 'stopped', occurredAt: T0 })
      ).toThrow(HostInvariantError)
      expect(s.facts()).toEqual([])
    })

    it('[ADR-006] a rolled-back caller transaction leaves no fact, so the same fact is new again afterwards', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfIds
      const departed: LifecycleFact = {
        type: 'DwarfDeparted',
        dwarfId: dwarf,
        cause: 'stopped',
        occurredAt: T0
      }
      const failure = new CallerFailure('the state change failed after the fact was recorded')

      expect(() =>
        s.inTransaction(() => {
          expect(s.log.record(departed)).toBe('new')
          throw failure
        })
      ).toThrow(failure)

      expect(s.facts()).toEqual([])
      expect(recordIn(s, departed)).toBe('new')
      expect(s.facts()).toEqual([{ type: 'DwarfDeparted', dwarfId: dwarf, sourceKey: null }])
    })
  })
}
