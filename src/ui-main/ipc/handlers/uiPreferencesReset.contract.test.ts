// layer: L6
import { describe, expect, it } from 'vitest'
import {
  CHANNELS,
  HOST_METHOD_SCHEMAS,
  ROW_IDS,
  UNROUTED,
  type ChannelKey,
  type EvtFrame
} from '@dwarfai/contracts'
import { InMemorySessionStore } from '../../window/adapters/InMemorySessionStore'
import { createUiPreferencesReset } from '../../window/application/uiPreferencesReset'
import { createUiSession } from '../../window/application/uiSession'
import { InMemoryUiPreferenceStore } from '../../window/ports/fakes/InMemoryUiPreferenceStore'
import { RecordingHostClient } from '../../window/ports/fakes/RecordingHostClient'
import { ROUTES } from '../routes'
import { createUiPreferencesResetPush, UI_PREFERENCES_RESET_PUSH } from './uiPreferencesReset'

/**
 * A-N12 `onUiPreferencesReset` (14 §2.2, §3.8 `{ epoch: number }`; NEW, `ui-local`, owner `window`) and B-M09
 * `ui.resetPreferences.ack` (14 §2.3, §3.4 `{ epoch: number }`): what UI main sends on the Host's B-F26
 * `ui.resetPreferences {epoch}` (ADR-023 item 4 step 5; ADR-024 item 8). The row is unrouted until the cut-1 switch
 * (ISSUE-123) routes it; its payload is the registry's own schema.
 */
const PANEL_ID = 7
const VETA_ID = 8

function world() {
  const host = new RecordingHostClient()
  const pushes: Array<{ to: number; push: string; payload: unknown }> = []
  const windows = [PANEL_ID, VETA_ID].map((id) => ({
    send: (push: string, payload: unknown) => void pushes.push({ to: id, push, payload })
  }))
  const reset = createUiPreferencesReset({
    store: new InMemoryUiPreferenceStore(),
    session: createUiSession({ store: new InMemorySessionStore(), windows: () => [], host }),
    push: createUiPreferencesResetPush(() => windows),
    host
  })
  reset.listen()
  return { host, pushes }
}

describe('A-N12 onUiPreferencesReset and B-M09 ui.resetPreferences.ack (14 §2.2, §2.3)', () => {
  it('[ADR-023] A-N12 carries only the epoch and ui.resetPreferences.ack echoes it', () => {
    const key: ChannelKey = UI_PREFERENCES_RESET_PUSH
    // The registry row: a NEW `ui-local` push, A-N12, unrouted until the cut-1 switch routes it.
    expect(CHANNELS[key]?.kind).toBe('push')
    expect(CHANNELS[key]?.placement).toBe('ui-local')
    expect(CHANNELS[key]?.status).toBe('new')
    expect(ROW_IDS[key]).toBe('A-N12')
    // AMENDED for ISSUE-123 (was: `UNROUTED[key]` is 'cut-1'): the cut-1 switch routed it `ui-local`.
    expect(UNROUTED[key]).toBeUndefined()
    expect(ROUTES.filter((route) => route.channel === key).map((route) => route.owner)).toEqual([
      'ui-local'
    ])
    const payloadSchema = CHANNELS[key].response
    const ackSchema = HOST_METHOD_SCHEMAS['ui.resetPreferences.ack'].params

    const { host, pushes } = world()
    const frame = {
      type: 'evt',
      seq: 3,
      epoch: 'boot-1',
      name: 'ui.resetPreferences',
      data: { epoch: 4 }
    }
    host.deliver({ kind: 'frame', frame: frame as unknown as EvtFrame })

    // Every window gets A-N12 with exactly the frame's epoch: nothing else rides on it (14 §3.9 usage rule).
    expect(pushes).toEqual([
      { to: PANEL_ID, push: 'ui:preferences:reset', payload: { epoch: 4 } },
      { to: VETA_ID, push: 'ui:preferences:reset', payload: { epoch: 4 } }
    ])
    for (const { payload } of pushes) expect(payloadSchema.safeParse(payload).success).toBe(true)
    expect(payloadSchema.safeParse({ epoch: 4, startWithSystem: true }).success).toBe(false)
    expect(payloadSchema.safeParse({}).success).toBe(false)
    expect(payloadSchema.safeParse({ epoch: 0 }).success).toBe(false)

    // B-M09 echoes the epoch, in the Host's strict params shape.
    const acks = host.calls.filter((c) => c.member === 'call')
    expect(acks).toEqual([
      { member: 'call', method: 'ui.resetPreferences.ack', params: { epoch: 4 } }
    ])
    expect(ackSchema.safeParse(acks[0]?.member === 'call' ? acks[0].params : null).success).toBe(
      true
    )
  })
})
