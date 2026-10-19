// layer: L1
import { describe, expect, it } from 'vitest'
import { requestIdSchema } from '@dwarfai/contracts'
import { isMutation, mintRequestId, resendAfterReconnect } from './requestIds'

// 14 §1.6: a UUIDv7 `requestId` per intent, and which in-flight mutations main re-sends after a reconnect.

describe('requestIds (14 §1.6)', () => {
  it('[ADR-003] a minted requestId is a UUIDv7 whose time prefix is the clock reading', () => {
    const at = Date.UTC(2026, 9, 1, 12, 0, 0)
    const id = mintRequestId({ now: () => at, random: (n) => new Uint8Array(n).fill(0xab) })
    expect(requestIdSchema.safeParse(id).success).toBe(true)
    expect(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(at)
  })

  it('[ADR-003] two requestIds minted in the same millisecond differ', () => {
    let seed = 0
    const random = (n: number) => new Uint8Array(n).map(() => (seed += 37) & 0xff)
    const a = mintRequestId({ now: () => 1, random })
    const b = mintRequestId({ now: () => 1, random })
    expect(a).not.toBe(b)
  })

  it('[ADR-003] a mutation is a call whose params carry a requestId', () => {
    expect(
      isMutation({ requestId: '01890a5d-ac96-774b-bcce-b302099a8057', mode: 'stop-all' })
    ).toBe(true)
    expect(isMutation({})).toBe(false)
    expect(isMutation({ sections: ['meta'] })).toBe(false)
  })

  it('[ADR-003] on a hot reconnect any in-flight mutation is re-sent; after a new epoch only conversation.send and asking.answer*', () => {
    for (const method of ['host.shutdown', 'crew.stop', 'conversation.send']) {
      expect(resendAfterReconnect(method, { epochChanged: false })).toBe(true)
    }
    expect(resendAfterReconnect('conversation.send', { epochChanged: true })).toBe(true)
    expect(resendAfterReconnect('asking.answerQuestion', { epochChanged: true })).toBe(true)
    expect(resendAfterReconnect('asking.answerPermission', { epochChanged: true })).toBe(true)
    for (const method of ['host.shutdown', 'crew.stop', 'conversation.retry', 'mines.remove']) {
      expect(resendAfterReconnect(method, { epochChanged: true })).toBe(false)
    }
  })
})
