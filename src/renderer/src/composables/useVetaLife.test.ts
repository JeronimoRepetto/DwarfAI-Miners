import type { HostFrame, SnapshotParams } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { effectScope } from 'vue'
import {
  BORIN,
  DAIN,
  EREBOR,
  frame,
  MORIA,
  dwarfWire,
  mineWire,
  snapshotPage
} from '../lib/veta/testing/vetaFixtures'
import { useVetaLife, type VetaLifeBridge } from './useVetaLife'

/*
 * ISSUE-287: the Veta window's own read model (ADR-033 items 3, 5: one store set per window) of the `meta`, `mines`
 * and `dwarfs` sections and their frames, relayed by UI main over A-N01 and A-N02, with the life state machine 20
 * derives from them. Tested against scripted snapshots and frames.
 */
function scriptedHost(answers: unknown[]) {
  const listeners = new Set<(frames: readonly HostFrame[]) => void>()
  const requests: SnapshotParams[] = []
  const bridge: VetaLifeBridge = {
    onHostEvent(listener) {
      listeners.add(listener as (frames: readonly HostFrame[]) => void)
      return () => listeners.delete(listener as (frames: readonly HostFrame[]) => void)
    },
    getHostSnapshot(params) {
      requests.push(params)
      return Promise.resolve(answers.shift())
    },
    onHostConnection: () => () => undefined,
    moveToMode: () => Promise.resolve({ ok: true, value: undefined })
  }
  return {
    bridge,
    requests,
    push: (frames: HostFrame[]) => {
      for (const listener of [...listeners]) listener(frames)
    }
  }
}

function visibility(initial: boolean) {
  const listeners = new Set<() => void>()
  const view = {
    shown: initial,
    set(shown: boolean) {
      view.shown = shown
      for (const listener of [...listeners]) listener()
    },
    deps: {
      shown: () => view.shown,
      onChange(listener: () => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }
  return view
}

describe('useVetaLife', () => {
  it('[US-VETA-001.AC05, S20.17] reads the meta, mines and dwarfs sections, follows their frames, and keeps tracking them while Veta is not shown', async () => {
    const host = scriptedHost([
      snapshotPage(10, {
        minesEverKnown: true,
        mines: [mineWire(MORIA), mineWire(EREBOR)],
        dwarfs: [dwarfWire(BORIN, MORIA)]
      })
    ])
    const shown = visibility(true)
    const scope = effectScope()
    const life = scope.run(() => useVetaLife({ bridge: host.bridge, visibility: shown.deps }))!
    expect(life.state.value).toBeNull()
    await life.start()

    expect(host.requests).toEqual([{ sections: ['meta', 'mines', 'dwarfs'] }])
    expect(life.state.value).toBe('all-idle')
    expect(life.chambers.value.map((c) => c.mine.id)).toEqual([MORIA])

    // A frame already in the snapshot is not applied again; a newer one is.
    host.push([
      frame(9, 'dwarf.changed', { dwarf: dwarfWire(BORIN, MORIA, { status: 'working' }) })
    ])
    expect(life.state.value).toBe('all-idle')
    host.push([
      frame(11, 'dwarf.arrived', {
        dwarf: dwarfWire(DAIN, EREBOR, { status: 'asking', needsYou: true }),
        announce: true
      })
    ])
    expect(life.state.value).toBe('sessions-working')
    expect(life.chambers.value.map((c) => [c.mine.id, c.attention])).toEqual([
      [MORIA, false],
      [EREBOR, true]
    ])

    // Hidden: the facts are still followed, with no choreography.
    shown.set(false)
    expect(life.shown.value).toBe(false)
    host.push([
      frame(12, 'dwarf.departed', { dwarfId: DAIN, mineId: EREBOR, cause: 'closed-elsewhere' })
    ])
    expect(life.state.value).toBe('all-idle')
    expect(life.last.value).toMatchObject({ id: 'S20.09', animate: false })
    shown.set(true)
    expect(life.last.value).toMatchObject({ id: 'S20.03', from: null, animate: false })

    scope.stop()
  })
})
