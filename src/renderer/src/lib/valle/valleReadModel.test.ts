import type { HostFrame, UiPreferencesMap } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { effectScope } from 'vue'
import { VALLE_STORE_DEFAULTS, useValleStores } from '../../composables/useValleStores'
import {
  BORIN,
  DAIN,
  EREBOR,
  MORIA,
  NALI,
  dwarfWire,
  frame,
  mineWire,
  snapshotPage
} from '../veta/testing/vetaFixtures'
import { createValleReadModel, type ValleFact, type ValleReadModelBridge } from './valleReadModel'

/**
 * The Valle read-model roots (ADR-033 items 3, 5: one store set per window; UC-067, the Valle half; 07 S34.12): the
 * window's own read model of the Host's `mines` and `dwarfs` sections and their frames, relayed by UI main over A-N01
 * and A-N02, held while A-N04 says anything but `connected`. Tested against scripted snapshots, frames and connection
 * pushes.
 */
function scriptedHost(answers: unknown[]) {
  const frames = new Set<(frames: readonly HostFrame[]) => void>()
  const connections = new Set<(view: unknown) => void>()
  const reads: number[] = []
  const bridge: ValleReadModelBridge = {
    onHostEvent(listener) {
      frames.add(listener)
      return () => frames.delete(listener)
    },
    getHostSnapshot() {
      reads.push(reads.length + 1)
      return Promise.resolve(answers.shift())
    },
    onHostConnection(listener) {
      connections.add(listener)
      return () => connections.delete(listener)
    }
  }
  return {
    bridge,
    reads,
    push: (batch: HostFrame[]) => {
      for (const listener of [...frames]) listener(batch)
    },
    connection: (view: unknown) => {
      for (const listener of [...connections]) listener(view)
    }
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

const PINS: UiPreferencesMap['pins'] = [{ dwarfId: BORIN, mineId: MORIA, order: 0 }]

describe('the Valle read models (ADR-033; UC-067; ISSUE-299)', () => {
  it('[S34.12, ADR-033, ADR-002] while the Host is unreachable Valle keeps its read models and pins, and a re-snapshot applies without motion', async () => {
    const host = scriptedHost([
      snapshotPage(10, {
        minesEverKnown: true,
        mines: [mineWire(MORIA), mineWire(EREBOR)],
        dwarfs: [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, EREBOR)]
      }),
      // The Host back: DAIN left meanwhile, NALI arrived.
      snapshotPage(30, {
        minesEverKnown: true,
        mines: [mineWire(MORIA), mineWire(EREBOR)],
        dwarfs: [dwarfWire(BORIN, MORIA), dwarfWire(NALI, EREBOR)]
      })
    ])
    const scope = effectScope()
    const { model, stores } = scope.run(() => ({
      model: createValleReadModel(host.bridge),
      stores: useValleStores(
        {
          getUiPreferences: () => Promise.resolve({}),
          getUiSession: () => Promise.resolve({}),
          onUiPreferencesReset: () => () => undefined
        },
        { ...VALLE_STORE_DEFAULTS, pins: PINS }
      )
    }))!
    const facts: ValleFact[][] = []
    model.onFacts((batch) => facts.push([...batch]))
    host.connection({ state: 'connected' })
    expect(await model.start()).toBe(true)
    const ids = (): string[] => model.dwarfs.value.map((d) => d.id)
    expect(ids()).toEqual([BORIN, DAIN])
    expect(model.mines.value.map((m) => m.id)).toEqual([MORIA, EREBOR])
    // A frame newer than the snapshot is an observed fact, with its motion.
    host.push([frame(11, 'dwarf.arrived', { dwarf: dwarfWire(NALI, MORIA), announce: true })])
    expect(facts.at(-1)).toEqual([
      { kind: 'arrived', dwarf: dwarfWire(NALI, MORIA), announce: true }
    ])
    // The connection drops: every read model and the pins are held as last known, read-only.
    for (const view of [{ state: 'reconnecting' }, { state: 'unavailable' }]) {
      host.connection(view)
      expect(model.held.value, view.state).toBe(true)
      expect(ids(), view.state).toEqual([BORIN, DAIN, NALI])
      expect(stores.stores.value.pins, view.state).toEqual(PINS)
    }
    expect(host.reads).toEqual([1])
    // Connected again: a fresh snapshot, applied as one snapshot, with no arrival for NALI and no walk-out for DAIN.
    const before = facts.length
    host.connection({ state: 'connected' })
    await flush()
    expect(model.held.value).toBe(false)
    expect(host.reads).toEqual([1, 2])
    expect(ids()).toEqual([BORIN, NALI])
    expect(facts.slice(before)).toEqual([[{ kind: 'snapshot' }]])
    expect(stores.stores.value.pins).toEqual(PINS)
    scope.stop()
  })
})

// APPENDED for ISSUE-302: what the pins hear of the Host (07 S29.13, S29.14, S29.15).
describe('what the Valle pins hear of the Host (ISSUE-302)', () => {
  const ask = (id: string, dwarfId: string, kind: 'question' | 'permission', openedAt: number) =>
    ({
      id,
      dwarfId,
      kind,
      channel: 'driver',
      providerRequestId: `request-${id}`,
      payload:
        kind === 'question'
          ? { steps: [{ text: 'Which one?', options: ['a', 'b'], allowsFreeText: true }] }
          : { toolName: 'Bash', requestText: 'run a command' },
      currentStep: 0,
      state: 'open',
      reannounce: false,
      openedAt
    }) as const
  const ASK_1 = '01920000-0000-7000-8000-00000000e001'
  const ASK_2 = '01920000-0000-7000-8000-00000000e002'

  it('[S29.13, S29.14, S29.15] the window knows each dwarf’s open ask and hears a departure with its cause and a mine’s removal', async () => {
    const page = snapshotPage(10, {
      minesEverKnown: true,
      mines: [mineWire(MORIA), mineWire(EREBOR)],
      dwarfs: [dwarfWire(BORIN, MORIA), dwarfWire(DAIN, EREBOR), dwarfWire(NALI, MORIA)]
    })
    if (!page.ok) throw new Error('fixture')
    const withAsks = {
      ...page,
      value: {
        ...page.value,
        chunks: [
          ...page.value.chunks,
          {
            section: 'asks',
            data: {
              asks: [ask(ASK_1, BORIN, 'permission', 5)],
              needsYou: [{ dwarfId: BORIN, mineId: MORIA, askedAt: 5 }]
            }
          }
        ]
      }
    }
    const host = scriptedHost([withAsks])
    const model = createValleReadModel(host.bridge)
    const facts: ValleFact[][] = []
    model.onFacts((batch) => facts.push([...batch]))
    host.connection({ state: 'connected' })
    expect(await model.start()).toBe(true)
    expect(model.askOf(BORIN)).toBe('permission')
    expect(model.askOf(DAIN)).toBeNull()

    host.push([
      frame(11, 'ask.opened', { ask: ask(ASK_2, DAIN, 'question', 7) as never }),
      frame(12, 'ask.closed', { askId: ASK_1 as never, dwarfId: BORIN, reason: 'answered-in-app' })
    ])
    expect(model.askOf(DAIN)).toBe('question')
    expect(model.askOf(BORIN)).toBeNull()

    host.push([
      frame(13, 'dwarf.departed', { dwarfId: DAIN, mineId: EREBOR, cause: 'stopped' }),
      frame(14, 'dwarf.departed', { dwarfId: NALI, mineId: MORIA, cause: 'mine-removed' }),
      frame(15, 'mine.removed', { mineId: MORIA, removedAt: 15 })
    ])
    expect(facts.at(-1)).toEqual([
      { kind: 'departed', dwarfId: DAIN, mineId: EREBOR, mineRemoved: false },
      { kind: 'departed', dwarfId: NALI, mineId: MORIA, mineRemoved: true },
      { kind: 'mine-removed', mineId: MORIA }
    ])
    // A departed dwarf's ask goes with it.
    expect(model.askOf(DAIN)).toBeNull()
    model.stop()
  })
})
