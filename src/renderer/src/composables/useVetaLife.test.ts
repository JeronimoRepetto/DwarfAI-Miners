import type { HostFrame, SnapshotParams } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { effectScope, nextTick } from 'vue'
import type { VetaChamberView } from '../lib/veta/lifeState'
import {
  BORIN,
  DAIN,
  EREBOR,
  frame,
  MORIA,
  NALI,
  dwarfWire,
  mineWire,
  snapshotPage
} from '../lib/veta/testing/vetaFixtures'
import { useVetaChoreography } from './useVetaChoreography'
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
  it('[US-VETA-003.AC05, S22.07] publishes every live mine with its present crew, for the mine picker', async () => {
    const host = scriptedHost([
      snapshotPage(10, {
        minesEverKnown: true,
        mines: [mineWire(MORIA), mineWire(EREBOR)],
        dwarfs: [dwarfWire(BORIN, MORIA)]
      })
    ])
    const scope = effectScope()
    const life = scope.run(() =>
      useVetaLife({ bridge: host.bridge, visibility: visibility(true).deps })
    )!
    expect(life.mines.value).toEqual([])
    await life.start()
    expect(life.mines.value.map((m) => [m.mine.id, m.crew])).toEqual([
      [MORIA, 1],
      [EREBOR, 0]
    ])
    host.push([frame(11, 'mine.removed', { mineId: MORIA, removedAt: 11 })])
    expect(life.mines.value.map((m) => m.mine.id)).toEqual([EREBOR])
    scope.stop()
  })

  // APPENDED for ISSUE-292: machine 26's inputs are the arrival and departure frames alone (ADR-033 item 3).
  it('[ADR-033, S26.15, S26.16] hands the choreography the dwarf.arrived and dwarf.departed frames once drawn, and a snapshot as a snapshot', async () => {
    const host = scriptedHost([
      snapshotPage(10, {
        minesEverKnown: true,
        mines: [mineWire(MORIA), mineWire(EREBOR)],
        dwarfs: [dwarfWire(BORIN, MORIA)]
      })
    ])
    const scope = effectScope()
    const life = scope.run(() =>
      useVetaLife({ bridge: host.bridge, visibility: visibility(true).deps })
    )!
    const heard: Array<{ facts: string[]; chambers: number }> = []
    life.onFacts((facts) => {
      heard.push({
        facts: facts.map((f) =>
          f.kind === 'snapshot'
            ? 'snapshot'
            : `${f.kind}:${f.kind === 'arrived' ? f.dwarf.id : f.dwarfId}`
        ),
        chambers: life.chambers.value.length
      })
    })
    await life.start()
    expect(heard).toEqual([{ facts: ['snapshot'], chambers: 1 }])

    // A status change and a mine change are not choreography inputs; arrivals and departures are, in order, once drawn.
    host.push([
      frame(11, 'dwarf.changed', { dwarf: dwarfWire(BORIN, MORIA, { status: 'idle' }) }),
      frame(12, 'dwarf.arrived', { dwarf: dwarfWire(DAIN, EREBOR), announce: true }),
      frame(13, 'dwarf.departed', { dwarfId: BORIN, mineId: MORIA, cause: 'stopped' })
    ])
    expect(heard.at(-1)).toEqual({ facts: [`arrived:${DAIN}`, `departed:${BORIN}`], chambers: 1 })
    host.push([
      frame(14, 'dwarf.changed', { dwarf: dwarfWire(DAIN, EREBOR, { status: 'asleep' }) })
    ])
    expect(heard).toHaveLength(2)
    scope.stop()
  })

  // APPENDED for ISSUE-296: the Host connection dropping (UC-067; ADR-002 D9; ADR-033 item 3), the life state and machine
  // 26 wired together as the Veta root wires them.
  it('[S20.15, ADR-002] while reconnecting or unreachable Veta keeps every chamber and dwarf as last known and draws no walk', async () => {
    const host = connectedHost(
      snapshotPage(10, {
        minesEverKnown: true,
        mines: [mineWire(MORIA), mineWire(EREBOR)],
        dwarfs: [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, EREBOR, { status: 'working' })]
      })
    )
    const strip = stripOf(host)
    await strip.life.start()
    host.connection({ state: 'connected' })
    await settle()
    expect(strip.life.held.value).toBe(false)
    const known = crewOf(strip.life.chambers.value)
    expect(known).toEqual([`${MORIA}:${BORIN}`, `${EREBOR}:${DAIN}`])

    // The connection drops: nothing is cleared, nothing walks.
    for (const view of [
      { state: 'reconnecting' },
      { state: 'unavailable', reason: 'crash-loop' },
      { state: 'connecting' },
      { state: 'unavailable', reason: 'unresponsive' }
    ]) {
      host.connection(view)
      await settle()
      expect(strip.life.held.value, view.state).toBe(true)
      expect(strip.life.state.value).toBe('sessions-working')
      expect(crewOf(strip.life.chambers.value)).toEqual(known)
      expect(crewOf(strip.choreo.chambers.value)).toEqual(known)
      expect(strip.choreo.walking.value.size).toBe(0)
    }
    expect(strip.cues).toEqual([])
    strip.stop()
  })

  it('[S20.16, S26.15, ADR-033] a re-snapshot missing a dwarf removes it with no walk-out and a new dwarf stands at its station', async () => {
    const host = connectedHost(
      snapshotPage(10, {
        minesEverKnown: true,
        mines: [mineWire(MORIA), mineWire(EREBOR)],
        dwarfs: [dwarfWire(DAIN, MORIA)]
      })
    )
    const strip = stripOf(host)
    await strip.life.start()
    // Borin arrives by a frame and walks in: the choreography knows him as walked in.
    host.push([frame(11, 'dwarf.arrived', { dwarf: dwarfWire(BORIN, MORIA), announce: true })])
    await settle()
    expect(strip.cues).toEqual(['walk-in'])
    expect([...strip.choreo.arrived.value]).toEqual([BORIN])

    // The Host is lost and comes back with a new epoch: the snapshot lacks Borin and has Nali, new, in Erebor.
    host.connection({ state: 'reconnecting' })
    host.answer = Promise.resolve(
      snapshotPage(
        3,
        {
          minesEverKnown: true,
          mines: [mineWire(MORIA), mineWire(EREBOR)],
          dwarfs: [dwarfWire(DAIN, MORIA), dwarfWire(NALI, EREBOR)]
        },
        'epoch-veta-2'
      )
    )
    host.connection({ state: 'connected' })
    await settle()
    expect(strip.life.held.value).toBe(false)
    const now = [`${MORIA}:${DAIN}`, `${EREBOR}:${NALI}`]
    expect(crewOf(strip.life.chambers.value)).toEqual(now)
    // Borin vanished and Nali stands at his station: nothing walked out, nothing walked in, no chamber opened.
    expect(crewOf(strip.choreo.chambers.value)).toEqual(now)
    expect(strip.cues).toEqual(['walk-in'])
    expect(strip.choreo.walking.value.size).toBe(0)
    expect(strip.choreo.machine.value.state).toBe('settled')
    expect([...strip.choreo.arrived.value]).toEqual([])
    expect(strip.chats).toEqual([])
    strip.stop()
  })
})

/** A Host whose snapshot answer and A-N04 pushes the test scripts (ISSUE-296). */
function connectedHost(first: unknown) {
  const frames = new Set<(frames: readonly HostFrame[]) => void>()
  const views = new Set<(view: unknown) => void>()
  const host: {
    answer: Promise<unknown>
    bridge: VetaLifeBridge
    push(pushed: HostFrame[]): void
    connection(view: unknown): void
  } = {
    answer: Promise.resolve(first),
    bridge: {
      onHostEvent(listener) {
        frames.add(listener as (frames: readonly HostFrame[]) => void)
        return () => frames.delete(listener as (frames: readonly HostFrame[]) => void)
      },
      getHostSnapshot: () => host.answer,
      onHostConnection(listener) {
        views.add(listener)
        return () => views.delete(listener)
      },
      moveToMode: () => Promise.resolve({ ok: true, value: undefined })
    } satisfies VetaLifeBridge,
    push(pushed: HostFrame[]) {
      for (const listener of [...frames]) listener(pushed)
    },
    connection(view: unknown) {
      for (const listener of [...views]) listener(view)
    }
  }
  return host
}

/** The life state and machine 26 over one window, as the Veta root wires them; every motion ends at once. */
function stripOf(host: ReturnType<typeof connectedHost>) {
  const cues: string[] = []
  const chats: string[] = []
  const scope = effectScope()
  const parts = scope.run(() => {
    const life = useVetaLife({ bridge: host.bridge, visibility: visibility(true).deps })
    const choreo = useVetaChoreography({
      facts: () => life.chambers.value,
      onFacts: (listener) => life.onFacts(listener),
      shown: () => life.shown.value,
      reduced: () => false,
      drawn: () => life.chambers.value.map((c) => c.mine.id),
      opens: () => true,
      fit: () => Promise.resolve(),
      grow: () => Promise.resolve(),
      shrink: () => Promise.resolve(),
      fold: () => Promise.resolve(),
      play(cue) {
        cues.push(cue.kind)
        cue.mutate?.()
        return Promise.resolve()
      },
      cancel: () => undefined,
      chat: (dwarfId, cause) => chats.push(`${dwarfId}:${cause}`),
      timers: { set: () => null, clear: () => undefined }
    })
    return { life, choreo }
  })!
  return { ...parts, cues, chats, stop: () => scope.stop() }
}

const crewOf = (chambers: readonly VetaChamberView[]): string[] =>
  chambers.flatMap((c) => c.dwarfs.map((d) => `${c.mine.id}:${d.id}`))

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}
