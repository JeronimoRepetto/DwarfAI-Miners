import type { DwarfId, MineId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import type { VetaChamberView } from '../lib/veta/lifeState'
import {
  BORIN,
  DAIN,
  EREBOR,
  MORIA,
  NALI,
  dwarfWire,
  mineWire
} from '../lib/veta/testing/vetaFixtures'
import {
  useVetaChoreography,
  type VetaChoreographyDeps,
  type VetaChoreographyTimers,
  type VetaCue
} from './useVetaChoreography'
import type { VetaFact } from './useVetaLife'

/*
 * ISSUE-292: machine 26 carried out over the Veta window (`useVetaChoreography`). It hears the arrival and departure
 * frames alone (`useVetaLife.onFacts`), draws the staged strip (the facts, less the arrivals not placed yet, with the
 * departed dwarfs standing until they have walked out), grows the window before a growth and shrinks it after the
 * motion, and plays each state's motion through the injected player. The player, the window and the timers are
 * hand-written fakes: a motion ends when the test says so, and the watchdog fires when the test fires it.
 */

const chamber = (mineId: MineId, dwarfIds: readonly DwarfId[]): VetaChamberView => ({
  mine: mineWire(mineId),
  dwarfs: dwarfIds.map((id) => dwarfWire(id, mineId)),
  attention: false
})

function world(
  initial: readonly VetaChamberView[],
  options: { shown?: boolean; reduced?: boolean } = {}
) {
  const facts = shallowRef<readonly VetaChamberView[]>(initial)
  const shown = shallowRef(options.shown ?? true)
  const listeners = new Set<(facts: readonly VetaFact[]) => void>()
  const log: string[] = []
  const cues: VetaCue[] = []
  const ends: Array<() => void> = []
  const timers: Array<{ run: () => void; ms: number; live: boolean }> = []
  const fakeTimers: VetaChoreographyTimers = {
    set(run, ms) {
      const timer = { run, ms, live: true }
      timers.push(timer)
      return timer
    },
    clear(handle) {
      ;(handle as { live: boolean }).live = false
    }
  }
  // What the window draws: the staged strip, read back once the composable exists.
  let staged: () => readonly VetaChamberView[] = () => facts.value
  const deps: VetaChoreographyDeps = {
    facts: () => facts.value,
    onFacts(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    shown: () => shown.value,
    reduced: () => options.reduced ?? false,
    drawn: () => staged().map((c) => c.mine.id),
    opens: () => true,
    fit: async () => undefined,
    grow: async (chambers) => {
      log.push(`grow:${chambers.map((c) => c.dwarfs.length).join(',')}`)
    },
    shrink: async () => {
      log.push('shrink')
    },
    fold: async () => {
      log.push('fold')
    },
    play(cue) {
      cues.push(cue)
      log.push(`play:${cue.kind}`)
      cue.mutate?.()
      return new Promise<void>((resolve) => ends.push(resolve))
    },
    cancel: (ids) => {
      log.push(ids === undefined ? 'cancel' : `cancel:${ids.join(',')}`)
    },
    chat: (dwarfId, cause) => {
      log.push(`chat:${dwarfId}:${cause}`)
    },
    timers: fakeTimers
  }
  const scope = effectScope()
  const choreo = scope.run(() => useVetaChoreography(deps))!
  staged = () => choreo.chambers.value
  return {
    facts,
    shown,
    log,
    cues,
    choreo,
    /** The Host's frames, once the facts they changed are published. */
    async hear(next: readonly VetaChamberView[], heard: readonly VetaFact[]) {
      facts.value = next
      for (const listener of [...listeners]) listener(heard)
      await settle()
    },
    /** Ends the oldest motion in flight. */
    async end() {
      ends.shift()?.()
      await settle()
    },
    /** The live timers, by duration. */
    live: () => timers.filter((t) => t.live).map((t) => t.ms),
    async fire(ms: number) {
      const timer = timers.find((t) => t.live && t.ms === ms)!
      timer.live = false
      timer.run()
      await settle()
    },
    stop: () => scope.stop()
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const crew = (chambers: readonly VetaChamberView[]): string[] =>
  chambers.map(
    (c) =>
      `${c.mine.id === MORIA ? 'moria' : c.mine.id === EREBOR ? 'erebor' : 'other'}:${c.dwarfs.map((d) => d.id.slice(-1)).join('')}`
  )

describe('useVetaChoreography', () => {
  it('[US-VETA-007.AC01, S26.01, S26.02, S26.03, S26.06] carries the first arrival: grows first, lights the lamp, builds, then walks the dwarf in', async () => {
    const w = world([])
    await w.hear([chamber(MORIA, [BORIN])], [{ kind: 'arrived', dwarf: dwarfWire(BORIN, MORIA) }])
    // The window is placed for the final island before anything shows; the entrance lamp lights, the dwarf held back.
    expect(w.log).toEqual(['grow:1'])
    expect(w.choreo.machine.value.state).toBe('lighting')
    expect(w.choreo.lit.value).toBe(true)
    expect(w.choreo.chambers.value).toEqual([])
    expect(w.choreo.closed.value).toBe(true)
    // The lamp holds for M = 270 ms; its watchdog sits at 310 ms.
    expect(w.live().sort((a, b) => a - b)).toEqual([270, 310])
    await w.fire(270)
    expect(w.choreo.machine.value.state).toBe('building')
    expect(w.choreo.closed.value).toBe(false)
    expect(w.choreo.lit.value).toBe(false)
    // Built at its final size, the dwarf in place but not walked in yet.
    expect(crew(w.choreo.chambers.value)).toEqual(['moria:1'])
    expect(w.choreo.walking.value.get(BORIN)).toBe('waiting')
    expect(w.log.at(-1)).toBe('play:build')
    await w.end()
    expect(w.choreo.machine.value.state).toBe('walking-in')
    expect(w.choreo.walking.value.get(BORIN)).toBe('in')
    await w.end()
    expect(w.choreo.machine.value.state).toBe('settled')
    expect(w.choreo.walking.value.size).toBe(0)
    // Its status sheet starts on arrival.
    expect([...w.choreo.arrived.value]).toEqual([BORIN])
    expect(w.choreo.last.value).toMatchObject({ id: 'S26.06' })
    w.stop()
  })

  it('[US-VETA-008.AC01, US-VETA-008.AC02, S26.07, S26.08, S26.11] keeps a departed dwarf drawn while it walks out, closes its emptied chamber, then shrinks the window', async () => {
    const w = world([chamber(MORIA, [BORIN]), chamber(EREBOR, [DAIN])])
    await w.hear(
      [chamber(EREBOR, [DAIN])],
      [{ kind: 'departed', dwarfId: BORIN, mineId: MORIA, cause: 'closed-elsewhere' }]
    )
    // Its chat follows its cause; it walks out where it stood.
    expect(w.log).toEqual([`chat:${BORIN}:closed-elsewhere`, 'play:walk-out'])
    expect(crew(w.choreo.chambers.value)).toEqual(['moria:1', 'erebor:2'])
    expect(w.choreo.walking.value.get(BORIN)).toBe('out')
    await w.end()
    expect(w.choreo.machine.value.state).toBe('closing-chamber')
    expect(w.log.at(-1)).toBe('play:close-chamber')
    // The cue removes the chamber once it has faded, so what lay beyond can slide back.
    expect(crew(w.choreo.chambers.value)).toEqual(['erebor:2'])
    expect(w.log).not.toContain('shrink')
    await w.end()
    expect(w.log.at(-1)).toBe('shrink')
    expect(w.choreo.machine.value.state).toBe('settled')
    w.stop()
  })

  it('[S26.14] a departure of a dwarf still walking in resolves the walk at once, then walks it out', async () => {
    const w = world([chamber(MORIA, [BORIN])])
    await w.hear(
      [chamber(MORIA, [BORIN, DAIN])],
      [{ kind: 'arrived', dwarf: dwarfWire(DAIN, MORIA) }]
    )
    expect(w.choreo.machine.value.state).toBe('walking-in')
    await w.hear(
      [chamber(MORIA, [BORIN])],
      [{ kind: 'departed', dwarfId: DAIN, mineId: MORIA, cause: 'stopped' }]
    )
    expect(w.choreo.last.value).toMatchObject({ id: 'S26.14' })
    expect(w.log.slice(-3)).toEqual([`cancel:${DAIN}`, `chat:${DAIN}:stopped`, 'play:walk-out'])
    expect(w.choreo.walking.value.get(DAIN)).toBe('out')
    // It stays where it stood, second in its crew, until it has walked out.
    expect(crew(w.choreo.chambers.value)).toEqual(['moria:12'])
    w.stop()
  })

  it('[S26.13] the watchdog at the motion’s duration + 40 ms applies the end state at once', async () => {
    const w = world([chamber(MORIA, [BORIN])])
    await w.hear([chamber(MORIA, [BORIN])], [])
    await w.hear(
      [chamber(MORIA, [BORIN, DAIN])],
      [{ kind: 'arrived', dwarf: dwarfWire(DAIN, MORIA) }]
    )
    expect(w.live()).toEqual([400])
    await w.fire(400)
    expect(w.choreo.last.value).toMatchObject({ id: 'S26.13' })
    expect(w.log.slice(-2)).toEqual(['cancel', 'shrink'])
    expect(w.choreo.walking.value.size).toBe(0)
    expect([...w.choreo.arrived.value]).toEqual([DAIN])
    w.stop()
  })

  it('[S26.12, NFR-TIM-02] under reduced motion an arrival and a departure land in one frame', async () => {
    const w = world([], { reduced: true })
    await w.hear([chamber(MORIA, [BORIN])], [{ kind: 'arrived', dwarf: dwarfWire(BORIN, MORIA) }])
    expect(w.choreo.machine.value.state).toBe('settled')
    expect(w.choreo.last.value).toMatchObject({ id: 'S26.12' })
    expect(crew(w.choreo.chambers.value)).toEqual(['moria:1'])
    expect(w.log.filter((l) => l.startsWith('play'))).toEqual([])
    await w.hear([], [{ kind: 'departed', dwarfId: BORIN, mineId: MORIA, cause: 'stopped' }])
    expect(w.choreo.chambers.value).toEqual([])
    expect(w.choreo.closed.value).toBe(true)
    expect(w.log.filter((l) => l.startsWith('play'))).toEqual([])
    w.stop()
  })

  it('[S26.16, S26.15] nothing walks while Veta is not shown, and a snapshot never walks anyone', async () => {
    const w = world([chamber(MORIA, [BORIN])], { shown: false })
    await w.hear(
      [chamber(MORIA, [BORIN, DAIN])],
      [{ kind: 'arrived', dwarf: dwarfWire(DAIN, MORIA) }]
    )
    await w.hear(
      [chamber(MORIA, [DAIN])],
      [{ kind: 'departed', dwarfId: BORIN, mineId: MORIA, cause: 'mine-removed' }]
    )
    expect(w.choreo.last.value).toMatchObject({ id: 'S26.16' })
    expect(crew(w.choreo.chambers.value)).toEqual(['moria:2'])
    expect(w.log).toEqual([`chat:${BORIN}:mine-removed`])
    w.shown.value = true
    await w.hear([chamber(MORIA, [DAIN]), chamber(EREBOR, [NALI])], [{ kind: 'snapshot' }])
    expect(crew(w.choreo.chambers.value)).toEqual(['moria:2', 'erebor:3'])
    expect(w.log.filter((l) => l.startsWith('play'))).toEqual([])
    w.stop()
  })
})
