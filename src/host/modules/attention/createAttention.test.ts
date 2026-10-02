// layer: L2
// L2 (17 §1.2): `createAttention` composes the policy behind `AttentionInputs` (05 §3.11, 16 §4.11)
// over the module's doubles.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId, MineId } from '../../kernel/domain/values'
import { FakeAttentionSettings } from './ports/fakes/FakeAttentionSettings'
import { InMemoryAttentionLedger } from './ports/fakes/InMemoryAttentionLedger'
import { createAttention, turnFinishedFact, type AttentionEvent } from './index'

const T0 = 1_790_000_000_000
const DWARF = 'dwarf-0001' as DwarfId
const MINE = 'mine-0001' as MineId

describe('createAttention', () => {
  it('[US-SHELL-010.AC03, US-SHELL-010.AC09] the composed inputs notify a reliable turn end in a mine off screen, titled by the injected formatter', () => {
    const settings = new FakeAttentionSettings()
    const bus = new RecordingEventBus<AttentionEvent>()
    const { inputs } = createAttention({
      settings,
      ledger: new InMemoryAttentionLedger(),
      transactions: { inTransaction: (work) => work() },
      bus,
      clock: new FakeClock(T0),
      ids: new SequenceIdGenerator(),
      hostEpoch: 'epoch-0109',
      titles: (kind, displayName) => `fake ${kind} title for ${displayName}`
    })
    const finished = turnFinishedFact(
      {
        dwarfId: DWARF,
        turnKey: 'turn-7',
        kind: 'concluded',
        at: T0,
        reliability: 'reliable',
        cancelledFromApp: false
      },
      MINE
    )

    inputs.presenceChanged('ui-1', {
      anyUiAttached: true,
      anyWindowVisible: false,
      onScreenMineIds: new Set(),
      seq: 1
    })
    if (finished !== undefined) {
      inputs.onFact(finished, { displayName: 'Gimli', mineName: 'Moria' })
    }

    expect(bus.ofType('AttentionNotified').map((e) => e.payload.notification)).toStrictEqual([
      {
        key: `${DWARF}:turn-finished:turn-7`,
        kind: 'turn-finished',
        title: 'fake turn-finished title for Gimli',
        body: 'Moria',
        mineId: MINE,
        dwarfId: DWARF,
        sensitive: true
      }
    ])
  })
})
