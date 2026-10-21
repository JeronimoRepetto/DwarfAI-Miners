// layer: L1
import type { DwarfId, MineId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import {
  nextChatHandoff,
  startChatHandoff,
  type ChatHandoffEvent,
  type ChatHandoffNode
} from './chatHandoff'

/*
 * ISSUE-293 (07 machine 9, S9.01–S9.09; ADR-025 item 3; ADR-024 item 3; OQ-37 B): the chat hand-off between mode
 * windows as a table, pure. The `ModeCoordinator` steps it for a run that carries a chat.
 */

const CHAT = {
  dwarfId: '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a01' as DwarfId,
  mineId: '018f3a2e-7c4b-7d1e-9a5b-2f6c8d0e1a02' as MineId
}

/** Steps `node` through `events`, failing on a refused one; answers the ids, the effects and the last node. */
function walk(
  node: ChatHandoffNode,
  events: ChatHandoffEvent[]
): { ids: string[]; effects: string[][]; last: ChatHandoffNode } {
  const ids: string[] = []
  const effects: string[][] = []
  let at = node
  for (const event of events) {
    const step = nextChatHandoff(at, event)
    if (!step.ok) throw new Error(`${event.type} refused in ${at.state}: ${step.error}`)
    ids.push(step.value.id)
    effects.push([...step.value.effects])
    at = step.value.to
  }
  return { ids, effects, last: at }
}

const fromVeta = (): ChatHandoffNode => startChatHandoff(CHAT, 'veta')

describe('machine 9 diagram conformance', () => {
  it('[S9.01, S9.02, S9.03] a mode control with an open chat flushes, transitions and lands the chat in the target', () => {
    const { ids, effects, last } = walk(fromVeta(), [
      { type: 'mode-control', to: 'panel', built: true },
      { type: 'flushed' },
      { type: 'done' }
    ])
    expect(ids).toEqual(['S9.01', 'S9.02', 'S9.03'])
    expect(effects).toEqual([['pre-size-target'], ['end-ime'], ['hide-source', 'focus-target']])
    expect(last).toEqual({
      state: 'in-target',
      chat: CHAT,
      from: 'veta',
      to: 'panel',
      ending: 'live'
    })

    // Into Veta the chat rises once the run has landed (S9.03 with S24.18).
    const intoVeta = walk(startChatHandoff(CHAT, 'panel'), [
      { type: 'mode-control', to: 'veta', built: true },
      { type: 'flushed' },
      { type: 'done' }
    ])
    expect(intoVeta.effects.at(-1)).toEqual(['hide-source', 'focus-target', 'rise-after-landing'])
  })

  it('[S9.04, S9.05, S9.07] the watchdog, reduced motion and hiding mid-motion end in the target with the same state', () => {
    const toPanel: ChatHandoffEvent = { type: 'mode-control', to: 'panel', built: true }
    const watchdog = walk(fromVeta(), [toPanel, { type: 'flushed' }, { type: 'watchdog' }])
    const reduced = walk(fromVeta(), [toPanel, { type: 'reduced-motion' }])
    const hidden = walk(fromVeta(), [toPanel, { type: 'flushed' }, { type: 'hidden' }])

    expect(watchdog.ids.at(-1)).toBe('S9.04')
    expect(reduced.ids.at(-1)).toBe('S9.05')
    expect(hidden.ids.at(-1)).toBe('S9.07')
    // The same chat lands in the target each time; the state is already in the session store.
    for (const run of [watchdog, reduced, hidden]) {
      expect(run.last).toMatchObject({ state: 'in-target', chat: CHAT, from: 'veta', to: 'panel' })
    }
    expect(watchdog.last.ending).toBe('live')
    expect(reduced.last.ending).toBe('live')
    // Hidden mid-motion resolves at once and focuses nothing: restoring shows the target.
    expect(hidden.last.ending).toBe('hidden')
    expect(hidden.effects.at(-1)).toEqual(['hide-source'])
    // Reduced motion is the same state transfer: the IME still ends at the switch.
    expect(reduced.effects.at(-1)).toEqual(['end-ime', 'hide-source', 'focus-target'])
  })

  it('[S9.06, FM-046] a target that fails to show keeps the chat in the source and writes nothing', () => {
    const { ids, effects, last } = walk(fromVeta(), [
      { type: 'mode-control', to: 'panel', built: true },
      { type: 'target-failed' }
    ])
    expect(ids).toEqual(['S9.01', 'S9.06'])
    expect(last).toEqual({ state: 'in-source', chat: CHAT, from: 'veta' })
    // Logged, and nothing else: no hide, no focus, no store write.
    expect(effects.at(-1)).toEqual(['log-failed'])
  })

  it('[S9.08] a dwarf departing during the hand-off lands read-only or closed by cause', () => {
    const toPanel: ChatHandoffEvent = { type: 'mode-control', to: 'panel', built: true }
    for (const cause of [
      'stopped',
      'closed-elsewhere',
      'crashed',
      'recovery-failed',
      'recovery-dismissed'
    ] as const) {
      const { ids, last } = walk(fromVeta(), [
        toPanel,
        { type: 'flushed' },
        { type: 'departed', cause }
      ])
      expect(ids.at(-1)).toBe('S9.08')
      expect(last).toMatchObject({ state: 'in-target', ending: 'read-only' })
    }
    const removed = walk(fromVeta(), [toPanel, { type: 'departed', cause: 'mine-removed' }])
    expect(removed.ids.at(-1)).toBe('S9.08')
    expect(removed.last).toMatchObject({ state: 'in-target', ending: 'closed' })
  })

  it('[S9.09] a UI crash loses drafts and view state and nothing else', () => {
    const toPanel: ChatHandoffEvent = { type: 'mode-control', to: 'panel', built: true }
    for (const events of [[], [toPanel], [toPanel, { type: 'flushed' } as const]]) {
      const { ids, effects, last } = walk(fromVeta(), [...events, { type: 'crashed' }])
      expect(ids.at(-1)).toBe('S9.09')
      expect(last.state).toBe('lost')
      expect(effects.at(-1)).toEqual(['lose-drafts-and-views'])
    }
  })

  it('[ADR-025] a transition not listed in 07 machine 9 is rejected', () => {
    const source = fromVeta()
    expect(nextChatHandoff(source, { type: 'done' })).toEqual({ ok: false, error: 'not-listed' })
    expect(nextChatHandoff(source, { type: 'flushed' })).toEqual({ ok: false, error: 'not-listed' })
    // S9.01's guard: the target mode is built (BR-19).
    expect(nextChatHandoff(source, { type: 'mode-control', to: 'valle', built: false })).toEqual({
      ok: false,
      error: 'not-built'
    })
    const transitioning = walk(source, [
      { type: 'mode-control', to: 'panel', built: true },
      { type: 'flushed' }
    ]).last
    // Once both windows animate, the target cannot fail any more, and reduced motion is decided before the flush.
    expect(nextChatHandoff(transitioning, { type: 'target-failed' })).toEqual({
      ok: false,
      error: 'not-listed'
    })
    expect(nextChatHandoff(transitioning, { type: 'reduced-motion' })).toEqual({
      ok: false,
      error: 'not-listed'
    })
    const landed = walk(transitioning, [{ type: 'done' }]).last
    expect(nextChatHandoff(landed, { type: 'departed', cause: 'stopped' })).toEqual({
      ok: false,
      error: 'not-listed'
    })
    const lost = walk(source, [{ type: 'crashed' }]).last
    expect(nextChatHandoff(lost, { type: 'crashed' })).toEqual({ ok: false, error: 'not-listed' })
  })
})
