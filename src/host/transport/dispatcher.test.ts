// layer: L6
// The method dispatcher's role rule, table-driven over 14 §2.3 (14 §1.10: "the FORBIDDEN contract
// test is table-driven"; ADR-003 item 12).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FakeClock } from '../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { requestIdSchema } from '@dwarfai/contracts'
import { MUTATING_METHODS } from './dedupe/mutatingMethods'
import { Dispatcher } from './dispatcher'
import { FRAME_ROLES, METHOD_ROLES, type ChannelRole } from './roles'
import { FakeScheduler } from '../kernel/fakes/FakeScheduler'

const ROLES: readonly ChannelRole[] = ['ui', 'notifier', 'viewer']
const REQUEST_ID = '01890a5d-ac96-774b-bcce-b302099a8057'
const MUTATING_PARAMS = z.object({ requestId: requestIdSchema }).strict()

describe('Dispatcher role scopes (ADR-003 item 12)', () => {
  it('[ADR-003, FM-035] each role reaches exactly the methods 14 §2.3 lists for it, and every other call is FORBIDDEN', async () => {
    const dispatcher = new Dispatcher({
      log: new RecordingDiagnosticsLog(),
      clock: new FakeClock(),
      scheduler: new FakeScheduler(new FakeClock()),
      state: () => 'ready'
    })
    // AMENDED for ISSUE-027 (was: every method registered with `register` and params `{}`): the
    // 14 §1.6 mutating methods register with `registerMutating` and carry a UUIDv7 requestId.
    for (const [method, roles] of Object.entries(METHOD_ROLES)) {
      if (MUTATING_METHODS.has(method)) {
        dispatcher.registerMutating(method, MUTATING_PARAMS, roles, () => ({}))
      } else {
        dispatcher.register(method, z.object({}).strict(), roles, () => ({}))
      }
    }

    const reached: Record<ChannelRole, string[]> = { ui: [], notifier: [], viewer: [] }
    for (const role of ROLES) {
      for (const method of Object.keys(METHOD_ROLES)) {
        const params = MUTATING_METHODS.has(method) ? { requestId: REQUEST_ID } : {}
        const res = await dispatcher.dispatch({ id: '1', method, params }, { role, clientId: 'c' })
        if (res.ok) reached[role].push(method)
        else expect(res.error.code, `${role} ${method}`).toBe('FORBIDDEN')
      }
    }

    // 40 methods (B-M02…B-M41); the notifier never mutates and the viewer only reads its dwarf.
    expect(Object.keys(METHOD_ROLES)).toHaveLength(40)
    expect(reached.ui).toHaveLength(39)
    expect(reached.ui).not.toContain('attention.clicked')
    expect(reached.notifier.sort()).toEqual(['attention.clicked', 'ping', 'session.snapshot'])
    expect(reached.viewer.sort()).toEqual(['conversation.feed', 'events.subscribe', 'ping'])

    // 26 evt frames (B-F03…B-F28); the notifier receives only its three.
    expect(Object.keys(FRAME_ROLES)).toHaveLength(26)
    const notifierFrames = Object.entries(FRAME_ROLES)
      .filter(([, roles]) => roles.includes('notifier'))
      .map(([name]) => name)
      .sort()
    expect(notifierFrames).toEqual(['attention.notify', 'attention.withdraw', 'host.closing'])
  })
})
