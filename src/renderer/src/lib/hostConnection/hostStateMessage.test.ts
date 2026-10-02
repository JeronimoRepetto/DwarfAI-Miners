import type { HostConnectionView } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import {
  heldHostStateMessage,
  hostReadOnly,
  hostStateMessage,
  hostStateToast,
  type HostStateMessage
} from './hostStateMessage'

/*
 * What the Panel says about the Host connection (ADR-002 D9; 07 §12B; 14 §3.8 `HostConnectionView`): one row per view
 * the Host connection can push. The message's words are design's (ADR-002 O-4, O-5; 13 FM-007 "O-15 crash-loop
 * variant"): every string is a marked placeholder, never shipped text (25-AGENTS §8.1).
 */
const unavailable = (reason: NonNullable<HostConnectionView['reason']>): HostConnectionView => ({
  state: 'unavailable',
  reason
})
const connected: HostConnectionView = {
  state: 'connected',
  hostVersion: '1.0.0',
  compat: false,
  capabilities: []
}
const placeholder = /^⟦COPY NEEDED: .+⟧$/

describe('hostStateMessage', () => {
  it('[ADR-002, S12.B06, FM-007] crash-loop maps to one message with retry', () => {
    const message = hostStateMessage(unavailable('crash-loop'))
    expect(message.variant).toBe('crash-loop')
    expect(message.action).toBe('retry')
    expect(message.live).toBe('assertive')
  })

  it('[ADR-002, S12.B09] unresponsive maps to one message with retry and never before the view says unresponsive', () => {
    const message = hostStateMessage(unavailable('unresponsive'))
    expect(message.variant).toBe('unresponsive')
    expect(message.action).toBe('retry')
    // The hung-Host message waits for the view: a long reconnect is still only reconnecting.
    const reconnecting = hostStateMessage({ state: 'reconnecting', since: 1 })
    expect(reconnecting.variant).toBe('reconnecting')
    expect(reconnecting.action).toBe('none')
    expect(reconnecting.live).toBe('polite')
    expect(hostStateMessage({ state: 'connecting' }).variant).toBe('none')
  })

  it('[ADR-002] incompatible maps to one message whose only action is Stop everything and quit and never an upgrade', () => {
    const message = hostStateMessage(unavailable('incompatible'))
    expect(message.variant).toBe('incompatible')
    expect(message.action).toBe('stop-everything')
    expect(message.actionLabel).toMatch(placeholder)
  })

  it('[ADR-002] in v1 no message offers confirmHostRestart and no view sends upgrade-drain', () => {
    // AMENDMENT-11: `generation-restart` is dormant in v1; this issue maps no state to it.
    const restart = hostStateMessage({
      state: 'unavailable',
      reason: 'generation-restart',
      restart: { resumable: 2, waiting: 1 }
    })
    expect(restart).toEqual({
      variant: 'none',
      action: 'none',
      text: null,
      actionLabel: null,
      live: 'off'
    })
    const reasons = [
      'spawn-failed',
      'crash-loop',
      'incompatible',
      'elevated-refused',
      'in-job',
      'unresponsive',
      'generation-restart'
    ] as const
    for (const reason of reasons) {
      expect(['retry', 'stop-everything', 'none']).toContain(
        hostStateMessage(unavailable(reason)).action
      )
    }
  })

  it('[ADR-002] connected and connected in compat mode show no message', () => {
    const none: HostStateMessage = {
      variant: 'none',
      action: 'none',
      text: null,
      actionLabel: null,
      live: 'off'
    }
    expect(hostStateMessage(connected)).toEqual(none)
    expect(hostStateMessage({ ...connected, compat: true })).toEqual(none)
    expect(hostReadOnly(connected)).toBe(false)
    expect(hostReadOnly({ ...connected, compat: true })).toBe(false)
  })

  it('[ADR-002, FM-008] a Host that never became ready shows the spawn failure with retry', () => {
    const message = hostStateMessage(unavailable('spawn-failed'))
    expect(message.variant).toBe('spawn-failed')
    expect(message.action).toBe('retry')
  })

  it('[ADR-002, FM-011] a Host refused for running elevated shows its reason with no action', () => {
    // The way out is to start the app normally; a retry would be refused the same way.
    const message = hostStateMessage(unavailable('elevated-refused'))
    expect(message.variant).toBe('elevated-refused')
    expect(message.action).toBe('none')
  })

  it('[ADR-002, FM-012] a Host inside a job shows the in-job message, and a connected one in a job keeps the Panel usable', () => {
    expect(hostStateMessage(unavailable('in-job'))).toMatchObject({
      variant: 'in-job',
      action: 'none'
    })
    // Degraded, not down: the sessions will end with the job, so the person is told, and nothing is disabled.
    const inJob: HostConnectionView = { ...connected, jobStatus: 'in-job' }
    expect(hostStateMessage(inJob)).toMatchObject({
      variant: 'in-job',
      action: 'none',
      live: 'polite'
    })
    expect(hostReadOnly(inJob)).toBe(false)
  })

  it('[ADR-002] every message string without approved copy is a marked placeholder key', () => {
    const views: HostConnectionView[] = [
      { state: 'reconnecting', since: 1 },
      unavailable('spawn-failed'),
      unavailable('crash-loop'),
      unavailable('incompatible'),
      unavailable('elevated-refused'),
      unavailable('in-job'),
      unavailable('unresponsive')
    ]
    for (const view of views) {
      const message = hostStateMessage(view)
      expect(message.text).toMatch(placeholder)
      if (message.action === 'none') expect(message.actionLabel).toBeNull()
      else expect(message.actionLabel).toMatch(placeholder)
    }
  })
})

describe('hostReadOnly', () => {
  it('[FM-146, ADR-002] the Panel is read-only in every state but connected', () => {
    expect(hostReadOnly({ state: 'connecting' })).toBe(true)
    expect(hostReadOnly({ state: 'reconnecting', since: 1 })).toBe(true)
    expect(hostReadOnly(unavailable('crash-loop'))).toBe(true)
    expect(hostReadOnly(unavailable('generation-restart'))).toBe(true)
    expect(hostReadOnly(connected)).toBe(false)
  })

  it('[ADR-002] with no Host connection served yet the Panel stays usable', () => {
    // Hidden until built (21 §1 item 8): until the cut-0 switch routes A-N03/A-N04 the renderer is never told a
    // state, and today's panel keeps working.
    expect(hostReadOnly(null)).toBe(false)
    expect(hostStateMessage(null).variant).toBe('none')
  })
})

describe('heldHostStateMessage', () => {
  it('[ADR-002, S12.B07] the unavailable message stays through the respawn its retry started', () => {
    const crashLoop = hostStateMessage(unavailable('crash-loop'))
    expect(heldHostStateMessage(crashLoop, { state: 'connecting' })).toEqual(crashLoop)
    expect(heldHostStateMessage(crashLoop, connected).variant).toBe('none')
    expect(heldHostStateMessage(crashLoop, unavailable('spawn-failed')).variant).toBe(
      'spawn-failed'
    )
  })

  it('[ADR-002] a first connect shows no message, and reconnecting replaces nothing it should not', () => {
    const none = hostStateMessage(connected)
    expect(heldHostStateMessage(none, { state: 'connecting' }).variant).toBe('none')
    const reconnecting = hostStateMessage({ state: 'reconnecting', since: 1 })
    expect(heldHostStateMessage(reconnecting, { state: 'connecting' }).variant).toBe('none')
  })
})

/*
 * Owner's ruling (2026-10-02): a Host-state notice without an action is a toast, raised once when the state is entered,
 * never a banner. The notices with an action stay the dialog (HostStateMessage.vue).
 */
describe('hostStateToast', () => {
  const none = hostStateMessage(null)
  const inJob = hostStateMessage({ ...connected, jobStatus: 'in-job' })

  it.each([
    [
      'reconnecting',
      hostStateMessage({ state: 'reconnecting', since: 1 }),
      'O-5 reconnecting message'
    ],
    [
      'elevated-refused',
      hostStateMessage(unavailable('elevated-refused')),
      'O-4 elevated-refused message'
    ],
    ['unavailable in-job', hostStateMessage(unavailable('in-job')), 'O-4 in-job message'],
    ['connected in-job', inJob, 'O-4 in-job message']
  ] as const)('[ADR-002, FM-012] entering %s toasts its notice once', (_name, entered, copy) => {
    expect(hostStateToast(none, entered)).toBe(`⟦COPY NEEDED: ${copy}⟧`)
    // The same state again (a re-render, a repeated push) toasts nothing.
    expect(hostStateToast(entered, entered)).toBeNull()
  })

  it('[ADR-002, S12.B06] a notice with an action never toasts: it is the dialog', () => {
    for (const reason of ['crash-loop', 'unresponsive', 'spawn-failed', 'incompatible'] as const) {
      expect(hostStateToast(none, hostStateMessage(unavailable(reason)))).toBeNull()
    }
    expect(hostStateToast(none, none)).toBeNull()
  })

  it('[ADR-002] a new entry into the same state toasts again, and a connected in-job differs from an unavailable one', () => {
    const reconnecting = hostStateMessage({ state: 'reconnecting', since: 1 })
    const back = hostStateMessage(connected)
    expect(hostStateToast(back, reconnecting)).not.toBeNull()
    expect(hostStateToast(inJob, hostStateMessage(unavailable('in-job')))).not.toBeNull()
  })
})
