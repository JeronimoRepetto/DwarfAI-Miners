// layer: L2
import { describe, expect, it } from 'vitest'
import type { LegacyPushMap } from '../LegacyDwarfIdBridge'
import { createLegacySettlementJoin, createSettlementPushMap } from './legacySettlementJoin'

const LAUNCH_FAILED = 'agent:launchFailed' // A-P3
const SETTLED = 'dwarf:sendText:settled' // A-P4
const MINTED_LAUNCH = '01920000-0000-7000-8000-0000000001b1'
const MINTED_MESSAGE = '01920000-0000-7000-8000-0000000001b2'
const HOST_DWARF = '01920000-0000-7000-8000-0000000001b3'

const FAILED_PUSH = {
  launchId: 'receipt:7',
  provider: 'codex',
  mineId: '01920000-0000-7000-8000-0000000001b4',
  exitCode: 1,
  stderrTail: '',
  cause: 'exited-at-once'
}
const SETTLED_PUSH = {
  holdId: 'hold:3',
  dwarfId: HOST_DWARF,
  result: { delivered: true, via: 'codex-exec-resume' }
}

describe('legacy settlement join (21 §3.1, A-P3 and A-P4)', () => {
  it('[ADR-001] a receipt recorded with its minted launch id settles once to that id', () => {
    const join = createLegacySettlementJoin()
    join.recordLaunch('receipt:7', MINTED_LAUNCH)

    expect(join.settleLaunch('receipt:7')).toBe(MINTED_LAUNCH)
    expect(join.settleLaunch('receipt:7')).toBeNull()
  })

  it('[ADR-001] a hold recorded with its minted message id settles once to that id', () => {
    const join = createLegacySettlementJoin()
    join.recordHold('hold:3', MINTED_MESSAGE)

    expect(join.settleHold('hold:3')).toBe(MINTED_MESSAGE)
    expect(join.settleHold('hold:3')).toBeNull()
  })

  it('[ADR-001] a receipt and a hold never answer for each other', () => {
    const join = createLegacySettlementJoin()
    join.recordLaunch('same', MINTED_LAUNCH)

    expect(join.settleHold('same')).toBeNull()
    expect(join.settleLaunch('same')).toBe(MINTED_LAUNCH)
  })

  it('[ADR-001] past its capacity the join forgets the oldest entry first, so it never grows without bound', () => {
    const join = createLegacySettlementJoin({ capacity: 2 })
    join.recordLaunch('receipt:1', 'a')
    join.recordLaunch('receipt:2', 'b')
    join.recordLaunch('receipt:3', 'c')

    expect(join.settleLaunch('receipt:1')).toBeNull()
    expect(join.settleLaunch('receipt:2')).toBe('b')
    expect(join.settleLaunch('receipt:3')).toBe('c')
  })
})

describe('settlement push map (21 §3.1, A-P3 and A-P4 keep shape today)', () => {
  it('[ADR-001] an A-P3 push of a joined receipt leaves with the minted launch id in today shape', async () => {
    const join = createLegacySettlementJoin()
    join.recordLaunch('receipt:7', MINTED_LAUNCH)
    const map = createSettlementPushMap({ join })

    expect(map.pushChannels).toContain(LAUNCH_FAILED)
    expect(await map.push(LAUNCH_FAILED, FAILED_PUSH)).toEqual({
      ...FAILED_PUSH,
      launchId: MINTED_LAUNCH
    })
  })

  it('[ADR-001] an A-P4 push of a joined hold leaves with the minted message id in today shape', async () => {
    const join = createLegacySettlementJoin()
    join.recordHold('hold:3', MINTED_MESSAGE)
    const map = createSettlementPushMap({ join })

    expect(map.pushChannels).toContain(SETTLED)
    expect(await map.push(SETTLED, SETTLED_PUSH)).toEqual({
      ...SETTLED_PUSH,
      holdId: MINTED_MESSAGE
    })
  })

  it('[ADR-001] an unjoined receipt stays untouched', async () => {
    const map = createSettlementPushMap({ join: createLegacySettlementJoin() })

    expect(await map.push(LAUNCH_FAILED, FAILED_PUSH)).toEqual(FAILED_PUSH)
  })

  it('[ADR-001] a stale holdId, already settled once, stays untouched', async () => {
    const join = createLegacySettlementJoin()
    join.recordHold('hold:3', MINTED_MESSAGE)
    const map = createSettlementPushMap({ join })

    await map.push(SETTLED, SETTLED_PUSH)
    expect(await map.push(SETTLED, SETTLED_PUSH)).toEqual(SETTLED_PUSH)
  })

  it('[ADR-001] a push whose id is missing or not a string stays untouched, and so does any other channel', async () => {
    const join = createLegacySettlementJoin()
    join.recordHold('hold:3', MINTED_MESSAGE)
    join.recordHold('3', 'joined-as-text')
    const map = createSettlementPushMap({ join })
    const noId = { ...SETTLED_PUSH, holdId: 3 }

    expect(await map.push(SETTLED, noId)).toEqual(noId)
    expect(await map.push(SETTLED, null)).toBeNull()
    expect(await map.push('mines:updated', { holdId: 'hold:3' })).toEqual({ holdId: 'hold:3' })
    expect(join.settleHold('hold:3')).toBe(MINTED_MESSAGE)
    expect(join.settleHold('3')).toBe('joined-as-text')
  })

  it('[ADR-001] the id bridge maps first: its dwarf id rides along and a push it withholds stays withheld', async () => {
    const join = createLegacySettlementJoin()
    join.recordHold('hold:3', MINTED_MESSAGE)
    join.recordHold('hold:4', 'other')
    const inner: LegacyPushMap = {
      pushChannels: [SETTLED, LAUNCH_FAILED],
      push: (_channel, payload) => {
        const legacy = (payload as { dwarfId?: string }).dwarfId
        return Promise.resolve(
          legacy === 'codex:t-1' ? { ...(payload as object), dwarfId: HOST_DWARF } : null
        )
      }
    }
    const map = createSettlementPushMap({ join, inner })

    expect(await map.push(SETTLED, { ...SETTLED_PUSH, dwarfId: 'codex:t-1' })).toEqual({
      ...SETTLED_PUSH,
      holdId: MINTED_MESSAGE
    })
    expect(
      await map.push(SETTLED, { ...SETTLED_PUSH, holdId: 'hold:4', dwarfId: 'gone' })
    ).toBeNull()
    expect(map.pushChannels).toEqual([SETTLED, LAUNCH_FAILED])
  })
})
