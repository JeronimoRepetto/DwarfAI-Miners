// The AttentionLedger conformance suite (16 §4.11 doubles row: "re-raised ask after simulated
// restart not announced"; 17 §1.3): run on `InMemoryAttentionLedger` and on `SqliteAttentionLedger`
// over the template database. A claimed key, emitted or suppressed, survives the ledger being
// reopened on the same storage, as after a Host restart (INV-100, S17.07, S17.08); a carry-over row
// written by the recovery pass is read by dwarf and kind and consumed once (ADR-018 item 3, S6.19,
// INV-103). Never imported by production code (R14).
import { afterEach, describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import { carryOverKey, type CarriedKind } from '../domain/carryOver'
import type { AttentionKind } from '../domain/decideLevel3'
import type { AttentionLedger } from '../ports/attentionLedger'

export interface AttentionLedgerSubject {
  ledger: AttentionLedger
  /** Two dwarfs the subject's storage knows (the SQLite rows reference `dwarfs`). */
  dwarfs: readonly [DwarfId, DwarfId]
  /** The caller's transaction (16 §2.2): commits when `work` returns. */
  inTransaction<T>(work: () => T): T
  /** Opens an ask of the dwarf in the subject's storage and returns its id (`attention_keys.ask_id`). */
  openAsk(dwarfId: DwarfId, kind: Exclude<AttentionKind, 'turn-finished'>): string
  /** Writes a carry-over row as the launching recovery pass does (ADR-015 item 5; ISSUE-173). */
  recordCarryOver(dwarfId: DwarfId, kind: CarriedKind, preCrashKey: string): void
  /** A new ledger over the same storage: what the next Host boot opens. */
  reopen(): AttentionLedger
  dispose(): void | Promise<void>
}

export function runAttentionLedgerContract(
  makeSubject: () => AttentionLedgerSubject | Promise<AttentionLedgerSubject>
): void {
  describe('AttentionLedger contract', () => {
    let subject: AttentionLedgerSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async (): Promise<AttentionLedgerSubject> => {
      subject = await makeSubject()
      return subject
    }

    it('[INV-100, S17.07] a key marked emitted is still emitted after the ledger is reopened on the same database', async () => {
      const s = await setUp()
      const [dwarf] = s.dwarfs
      const askKey = `${dwarf}:permission:${s.openAsk(dwarf, 'permission')}`
      const turnKey = `${dwarf}:turn-finished:turn-1`

      s.inTransaction(() => {
        s.ledger.markEmitted(askKey, dwarf, 'permission')
        s.ledger.markEmitted(turnKey, dwarf, 'turn-finished')
      })

      expect(s.ledger.emitted()).toStrictEqual(new Set([askKey, turnKey]))
      expect(s.reopen().emitted()).toStrictEqual(new Set([askKey, turnKey]))
    })

    it('[S17.08] a suppressed key is claimed and never reported as announceable later', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfs
      const suppressedTurn = `${dwarf}:turn-finished:turn-2`
      const suppressedAsk = `${other}:question:${s.openAsk(other, 'question')}`

      s.inTransaction(() => {
        s.ledger.markSuppressed(suppressedTurn, dwarf, 'turn-finished')
        s.ledger.markSuppressed(suppressedAsk, other, 'question')
      })

      // Claimed like an emitted key, so `onFact` finds it already decided (S17.07, S17.08).
      expect(s.ledger.emitted()).toStrictEqual(new Set([suppressedTurn, suppressedAsk]))
      expect(s.reopen().emitted()).toStrictEqual(new Set([suppressedTurn, suppressedAsk]))
    })

    it('[S6.19, INV-103] a carried-over pre-crash key is consumed by the first matching re-raised ask of that dwarf and kind, and only once', async () => {
      const s = await setUp()
      const [dwarf, other] = s.dwarfs
      const question = `${dwarf}:question:pre-crash-ask-1`
      const permission = `${dwarf}:permission:pre-crash-ask-2`
      const otherQuestion = `${other}:question:pre-crash-ask-3`
      s.recordCarryOver(dwarf, 'question', question)
      s.recordCarryOver(dwarf, 'permission', permission)
      s.recordCarryOver(other, 'question', otherQuestion)
      const ledger = s.reopen()

      expect(ledger.carryOver()).toStrictEqual(
        new Map([
          [carryOverKey(dwarf, 'question'), question],
          [carryOverKey(dwarf, 'permission'), permission],
          [carryOverKey(other, 'question'), otherQuestion]
        ])
      )

      // The first re-raised question of `dwarf` consumes its row; the other rows stay.
      s.inTransaction(() => ledger.consumeCarryOver(carryOverKey(dwarf, 'question')))
      const left = new Map([
        [carryOverKey(dwarf, 'permission'), permission],
        [carryOverKey(other, 'question'), otherQuestion]
      ])
      expect(ledger.carryOver()).toStrictEqual(left)

      // Only once: a second question of that dwarf finds nothing to consume, also after a reopen.
      s.inTransaction(() => ledger.consumeCarryOver(carryOverKey(dwarf, 'question')))
      expect(ledger.carryOver()).toStrictEqual(left)
      expect(s.reopen().carryOver()).toStrictEqual(left)
    })
  })
}
