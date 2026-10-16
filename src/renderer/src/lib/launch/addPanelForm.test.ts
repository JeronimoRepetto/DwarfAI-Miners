// layer: L1
import { describe, expect, it } from 'vitest'
import {
  addPanelForm,
  addPanelFormLocked,
  addPanelFormStateOf,
  addPanelSendRule,
  type AddPanelFormEvent,
  type AddPanelFormState,
  type AddPanelFormTarget,
  type AddPanelFormTransitionId
} from './addPanelForm'

/*
 * Machine 5A, the Add-panel form (07 §5A), walked through its pure transition function (17 §1.1):
 * every transition id reaches its target from its source, and every other pair of a state and an
 * event is rejected, so a transition the table does not list cannot pass for one it does.
 */

const STATES: AddPanelFormState[] = [
  'invalid',
  'ready',
  'enabling-integration',
  'paused-for-notice',
  'sending',
  'failed-shown'
]

interface Row {
  id: AddPanelFormTransitionId
  from: AddPanelFormState
  event: AddPanelFormEvent
  to: AddPanelFormTarget
}

/** One row per transition of the table, with S5.01's two directions and S5.28's two targets. */
const WALK: Row[] = [
  { id: 'S5.01', from: 'invalid', event: { type: 'fields-edited', sendRule: true }, to: 'ready' },
  { id: 'S5.01', from: 'ready', event: { type: 'fields-edited', sendRule: false }, to: 'invalid' },
  {
    id: 'S5.02',
    from: 'ready',
    event: { type: 'notice-action', integrationGatedOff: true },
    to: 'enabling-integration'
  },
  {
    id: 'S5.03',
    from: 'enabling-integration',
    event: { type: 'integration-changed' },
    to: 'ready'
  },
  { id: 'S5.04', from: 'ready', event: { type: 'send', hostConnected: true }, to: 'sending' },
  { id: 'S5.05', from: 'sending', event: { type: 'dwarf-launched' }, to: 'message-panel' },
  {
    id: 'S5.06',
    from: 'sending',
    event: { type: 'launch-failed', cause: 'exited-at-once' },
    to: 'failed-shown'
  },
  { id: 'S5.07', from: 'sending', event: { type: 'handed-back' }, to: 'ready' },
  {
    id: 'S5.08a',
    from: 'failed-shown',
    event: { type: 'retry', cause: 'not-installed' },
    to: 'sending'
  },
  {
    id: 'S5.08b',
    from: 'failed-shown',
    event: { type: 'pick-manually', cause: 'jev-unreachable', launchableProvider: true },
    to: 'ready'
  },
  ...STATES.map((from): Row => ({ id: 'S5.08c', from, event: { type: 'close' }, to: 'hidden' })),
  { id: 'S5.08d', from: 'sending', event: { type: 'host-reconnecting' }, to: 'sending' },
  {
    id: 'S5.25',
    from: 'ready',
    event: { type: 'jev-suggested', autoAccept: true, integrationGatedOff: true },
    to: 'paused-for-notice'
  },
  {
    id: 'S5.26',
    from: 'paused-for-notice',
    event: { type: 'notice-action', integrationGatedOff: true },
    to: 'enabling-integration'
  },
  {
    id: 'S5.27',
    from: 'paused-for-notice',
    event: { type: 'send', hostConnected: true },
    to: 'sending'
  },
  {
    id: 'S5.28',
    from: 'paused-for-notice',
    event: { type: 'fields-edited', sendRule: true },
    to: 'ready'
  },
  {
    id: 'S5.28',
    from: 'paused-for-notice',
    event: { type: 'fields-edited', sendRule: false },
    to: 'invalid'
  }
]

/** One instance of every event, guards met, for the rejection sweep. */
const EVENTS: AddPanelFormEvent[] = [
  { type: 'fields-edited', sendRule: true },
  { type: 'notice-action', integrationGatedOff: true },
  { type: 'integration-changed' },
  { type: 'send', hostConnected: true },
  { type: 'dwarf-launched' },
  { type: 'launch-failed', cause: 'not-installed' },
  { type: 'handed-back' },
  { type: 'retry', cause: 'could-not-start' },
  { type: 'pick-manually', cause: 'jev-unreachable', launchableProvider: true },
  { type: 'close' },
  { type: 'host-reconnecting' },
  { type: 'jev-suggested', autoAccept: true, integrationGatedOff: true }
]

/** Every listed (state, event) pair, read off the walk itself. */
const LISTED = new Set(WALK.map((row) => row.from + ' ' + row.event.type))

describe('machine 5A, the Add-panel form', () => {
  it('[S5.01, S5.02, S5.03, S5.04, S5.05, S5.06, S5.07, S5.08a, S5.08b, S5.08c, S5.08d, S5.25, S5.26, S5.27, S5.28] the Add-panel form walks every machine 5A transition to its target state and rejects any other', () => {
    for (const row of WALK) {
      const step = addPanelForm(row.from, row.event)
      expect(step, `${row.id} from ${row.from} on ${row.event.type}`).toMatchObject({
        ok: true,
        id: row.id,
        from: row.from,
        to: row.to
      })
    }
    const walked = new Set(WALK.map((row) => row.id))
    expect([...walked].sort()).toEqual(
      [
        'S5.01',
        'S5.02',
        'S5.03',
        'S5.04',
        'S5.05',
        'S5.06',
        'S5.07',
        'S5.08a',
        'S5.08b',
        'S5.08c',
        'S5.08d',
        'S5.25',
        'S5.26',
        'S5.27',
        'S5.28'
      ].sort()
    )

    for (const from of STATES) {
      for (const event of EVENTS) {
        if (LISTED.has(from + ' ' + event.type)) continue
        expect(addPanelForm(from, event), `${event.type} from ${from}`).toEqual({
          ok: false,
          from,
          event: event.type
        })
      }
    }

    // A guard that does not hold is no transition either.
    const unguarded: [AddPanelFormState, AddPanelFormEvent][] = [
      ['ready', { type: 'notice-action', integrationGatedOff: false }],
      ['ready', { type: 'send', hostConnected: false }],
      ['failed-shown', { type: 'retry', cause: 'jev-could-not-choose' }],
      [
        'failed-shown',
        { type: 'pick-manually', cause: 'exited-at-once', launchableProvider: true }
      ],
      [
        'failed-shown',
        { type: 'pick-manually', cause: 'jev-could-not-choose', launchableProvider: false }
      ],
      ['ready', { type: 'jev-suggested', autoAccept: false, integrationGatedOff: true }],
      ['ready', { type: 'jev-suggested', autoAccept: true, integrationGatedOff: false }]
    ]
    for (const [from, event] of unguarded) {
      expect(addPanelForm(from, event).ok, `${event.type} from ${from}, guard unmet`).toBe(false)
    }
  })

  it('[S5.08c] Close hides the panel only and never cancels the Host launch', () => {
    for (const from of STATES) {
      const step = addPanelForm(from, { type: 'close' })
      expect(step.ok && step.effects, `Close from ${from}`).toEqual([{ kind: 'hide-panel' }])
    }
  })

  it('[S5.04, S5.08a, S5.27] only Send and Retry send launching.launch, a Retry as the identical request', () => {
    const launches: [AddPanelFormState, AddPanelFormEvent][] = []
    for (const from of STATES) {
      for (const event of EVENTS) {
        const step = addPanelForm(from, event)
        if (step.ok && step.effects.some((effect) => effect.kind === 'launch')) {
          launches.push([from, event])
        }
      }
    }
    expect(launches.map(([from, event]) => from + ' ' + event.type).sort()).toEqual(
      ['failed-shown retry', 'paused-for-notice send', 'ready send'].sort()
    )
    const retry = addPanelForm('failed-shown', { type: 'retry', cause: 'exited-at-once' })
    expect(retry.ok && retry.effects).toEqual([{ kind: 'launch', retryOf: true }])
  })

  it('[S5.02, S5.26] the OpenCode notice action sends preferences.setOpenCodePermissions on for the Add panel', () => {
    for (const from of ['ready', 'paused-for-notice'] as const) {
      const step = addPanelForm(from, { type: 'notice-action', integrationGatedOff: true })
      expect(step.ok && step.effects).toEqual([
        { kind: 'set-opencode-permissions', enabled: true, origin: 'add-panel' }
      ])
    }
  })

  it('[S5.25] a Jev pick paused for the notice is shown as a suggestion and launches nothing', () => {
    const step = addPanelForm('ready', {
      type: 'jev-suggested',
      autoAccept: true,
      integrationGatedOff: true
    })
    expect(step.ok && step.effects).toEqual([
      { kind: 'show-suggestion' },
      { kind: 'show-integration-notice' }
    ])
  })

  it('[S5.28] leaving the pause keeps the notice only while the gated supplier is still chosen', () => {
    const kept = addPanelForm('paused-for-notice', {
      type: 'fields-edited',
      sendRule: true,
      gatedSupplierChosen: true
    })
    const hidden = addPanelForm('paused-for-notice', { type: 'fields-edited', sendRule: true })
    expect(kept.ok && kept.effects).toEqual([{ kind: 'drop-suggestion' }])
    expect(hidden.ok && hidden.effects).toEqual([
      { kind: 'drop-suggestion' },
      { kind: 'hide-integration-notice' }
    ])
  })

  it('[S5.06, S5.08b] a failure shows its cause, and Pick manually turns Jev off and focuses the first chip', () => {
    const failed = addPanelForm('sending', { type: 'launch-failed', cause: 'could-not-start' })
    expect(failed.ok && failed.effects).toEqual([{ kind: 'show-notice', cause: 'could-not-start' }])
    const manual = addPanelForm('failed-shown', {
      type: 'pick-manually',
      cause: 'jev-could-not-choose',
      launchableProvider: true
    })
    expect(manual.ok && manual.effects).toEqual([{ kind: 'jev-off' }, { kind: 'focus-first-chip' }])
  })
})

describe('the Add panel read as machine 5A', () => {
  it('[S5.01] the Send rule needs a way to run and a prompt that is not only whitespace', () => {
    expect(addPanelSendRule({ wayToRun: true, prompt: 'dig' })).toBe(true)
    expect(addPanelSendRule({ wayToRun: true, prompt: '  \n ' })).toBe(false)
    expect(addPanelSendRule({ wayToRun: false, prompt: 'dig' })).toBe(false)
  })

  it('[S5.01, S5.04, S5.06] the panel reads as sending while a launch is in flight, then failed-shown, then ready or invalid', () => {
    expect(addPanelFormStateOf({ inFlight: true, failureShown: true, sendRule: true })).toBe(
      'sending'
    )
    expect(addPanelFormStateOf({ inFlight: false, failureShown: true, sendRule: true })).toBe(
      'failed-shown'
    )
    expect(addPanelFormStateOf({ inFlight: false, failureShown: false, sendRule: true })).toBe(
      'ready'
    )
    expect(addPanelFormStateOf({ inFlight: false, failureShown: false, sendRule: false })).toBe(
      'invalid'
    )
  })

  it('[US-LAUNCH-004.AC04, S5.04] every control but Close is locked in sending, and only there', () => {
    expect(STATES.filter((state) => addPanelFormLocked(state))).toEqual(['sending'])
  })
})
