import type { DwarfId, DwarfWire, MineId, MineWire } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import type { NeedsYouQueue } from '../lib/valle/needsYou'
import type { VallePreset } from '../lib/valle/preset'
import { useValleNeedsYou } from './useValleNeedsYou'

/*
 * The needs-you counter and queue wired to the Valle composables (07 S34.05…S34.07; UC-059): a press jumps through the
 * pins (S29.19), the mosaic (S32.14) and the current mine (S35.01) in the Control room, or the Work front's swap
 * (S28.15) and the pins there, and never through the preset. The jump's parts are recorded by hand-written deps.
 */
const MORIA = '01920000-0000-7000-8000-00000000a001' as MineId
const EREBOR = '01920000-0000-7000-8000-00000000a002' as MineId
const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId
const DAIN = '01920000-0000-7000-8000-00000000d002' as DwarfId
const NALI = '01920000-0000-7000-8000-00000000d003' as DwarfId

function world(initial: NeedsYouQueue, options: { focus?: boolean } = {}) {
  const calls: string[] = []
  const preset = shallowRef<VallePreset>('control')
  const front = shallowRef<MineId | null>(null)
  const queue = shallowRef<NeedsYouQueue>(initial)
  const dwarfs = shallowRef<readonly DwarfWire[]>([
    { id: BORIN, mineId: MORIA, baseName: 'borin', customName: null } as DwarfWire,
    { id: DAIN, mineId: EREBOR, baseName: 'dain', customName: 'Dain Ironfoot' } as DwarfWire,
    { id: NALI, mineId: MORIA, baseName: 'nali', customName: null } as DwarfWire
  ])
  const scope = effectScope()
  const part = scope.run(() =>
    useValleNeedsYou({
      model: {
        needsYou: queue,
        dwarfs,
        mines: shallowRef<readonly MineWire[]>([]),
        askOf: () => 'question'
      },
      preset: () => preset.value,
      frontMine: () => front.value,
      jump: {
        reveal: (mineId) => calls.push(`reveal ${mineId}`),
        pin: (dwarfId, mineId) => calls.push(`pin ${dwarfId} ${mineId}`),
        current: (mineId) => calls.push(`current ${mineId}`),
        swap: (mineId, dwarfId) => calls.push(`swap ${mineId} ${dwarfId}`),
        ...(options.focus ? { focus: (dwarfId: DwarfId) => calls.push(`focus ${dwarfId}`) } : {})
      }
    })
  )!
  return { part, calls, preset, front, queue, dwarfs, scope }
}

describe('the needs-you jump in Valle (ISSUE-306)', () => {
  it('[US-VALLE-004.AC01, US-VALLE-012.AC02, S34.05, S34.06, S34.07] a press outlines the mine and expands the chat in the Control room, or swaps and opens the tab in the Work front, never through the preset', () => {
    const w = world([
      { dwarfId: BORIN, mineId: MORIA, askedAt: 1 },
      { dwarfId: DAIN, mineId: EREBOR, askedAt: 2 }
    ])
    expect(w.part.entries.value.map((e) => e.name)).toEqual(['borin', 'Dain Ironfoot'])
    // The Control room: the oldest's column added and scrolled to, its chat pinned and focused, its mine current, its
    // zone called with the ring.
    w.part.press()
    expect(w.calls.splice(0)).toEqual([
      `reveal ${MORIA}`,
      `pin ${BORIN} ${MORIA}`,
      `current ${MORIA}`
    ])
    expect(w.part.called.value).toEqual({ mineId: MORIA, seq: 1 })
    // An entry: that dwarf, the same way; a later call restarts the ring's flash.
    w.part.pressEntry({ dwarfId: DAIN, mineId: EREBOR })
    expect(w.calls.splice(0)).toEqual([
      `reveal ${EREBOR}`,
      `pin ${DAIN} ${EREBOR}`,
      `current ${EREBOR}`
    ])
    expect(w.part.called.value).toEqual({ mineId: EREBOR, seq: 2 })
    // The called mine has nobody waiting any more: no ring stays on it.
    w.queue.value = [{ dwarfId: BORIN, mineId: MORIA, askedAt: 1 }]
    expect(w.part.called.value).toBeNull()

    // The Work front on EREBOR: a swap to MORIA naming BORIN (S28.15), then its tab; on its own mine, only the tab.
    w.preset.value = 'front'
    w.front.value = EREBOR
    w.part.press()
    expect(w.calls.splice(0)).toEqual([`swap ${MORIA} ${BORIN}`, `pin ${BORIN} ${MORIA}`])
    w.front.value = MORIA
    w.part.pressEntry({ dwarfId: BORIN, mineId: MORIA })
    expect(w.calls.splice(0)).toEqual([`pin ${BORIN} ${MORIA}`])
    // Nothing above ever went through the preset: it is only read.
    expect(w.preset.value).toBe('front')
    w.scope.stop()
  })

  it('[US-VALLE-004.AC02, S34.08, S34.11] with nobody waiting a press does nothing, and a stale entry opens its chat only while the dwarf is present', () => {
    const w = world([])
    expect(w.part.counter.value.disabled).toBe(true)
    w.part.press()
    expect(w.calls).toEqual([])
    // DAIN's ask closed before the press ran: the dwarf is present, so its chat still opens.
    w.part.pressEntry({ dwarfId: DAIN, mineId: EREBOR })
    expect(w.calls.splice(0)).toEqual([
      `reveal ${EREBOR}`,
      `pin ${DAIN} ${EREBOR}`,
      `current ${EREBOR}`
    ])
    // DAIN left: nothing.
    w.dwarfs.value = w.dwarfs.value.filter((d) => d.id !== DAIN)
    w.part.pressEntry({ dwarfId: DAIN, mineId: EREBOR })
    expect(w.calls).toEqual([])
    w.scope.stop()
  })

  // Owner ruling 2026-10-23 (VQA-02, VQA-13): the counter goes round the queue, the next after the one last jumped to,
  // and every jump, the counter's or an entry's, hands the keyboard to that dwarf's chat (`DS` valle.js `answer`).
  it('[US-VALLE-004.AC01, US-VALLE-012.AC02, S34.05, S34.07] three presses with three waiters reach each in turn and wrap, an entry press moves the turn, and each jump ends with the keyboard in the chat', () => {
    const w = world(
      [
        { dwarfId: BORIN, mineId: MORIA, askedAt: 1 },
        { dwarfId: DAIN, mineId: EREBOR, askedAt: 2 },
        { dwarfId: NALI, mineId: MORIA, askedAt: 3 }
      ],
      { focus: true }
    )
    const focused = (): string[] => w.calls.splice(0).filter((call) => call.startsWith('focus'))
    w.part.press()
    expect(w.calls.at(-1)).toBe(`focus ${BORIN}`)
    expect(focused()).toEqual([`focus ${BORIN}`])
    w.part.press()
    expect(focused()).toEqual([`focus ${DAIN}`])
    w.part.press()
    expect(focused()).toEqual([`focus ${NALI}`])
    // Round the queue.
    w.part.press()
    expect(focused()).toEqual([`focus ${BORIN}`])
    // An entry press is a jump too: the keyboard goes to its chat, and the next press follows it.
    w.part.pressEntry({ dwarfId: DAIN, mineId: EREBOR })
    expect(w.calls.at(-1)).toBe(`focus ${DAIN}`)
    expect(focused()).toEqual([`focus ${DAIN}`])
    // DAIN answered meanwhile: skipped, the next after DAIN is NALI.
    w.queue.value = w.queue.value.filter((entry) => entry.dwarfId !== DAIN)
    w.part.press()
    expect(focused()).toEqual([`focus ${NALI}`])
    // The Work front reads the same turn: round to BORIN, swapped in, then the keyboard in his chat.
    w.preset.value = 'front'
    w.front.value = EREBOR
    w.part.press()
    expect(w.calls.splice(0)).toEqual([
      `swap ${MORIA} ${BORIN}`,
      `pin ${BORIN} ${MORIA}`,
      `focus ${BORIN}`
    ])
    w.scope.stop()
  })
})
