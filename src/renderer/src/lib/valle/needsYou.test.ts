import type { DwarfId, MineId } from '@dwarfai/contracts'
import { describe, expect, it } from 'vitest'
import {
  QUEUE_EMPTY_TEXT,
  counterView,
  entryView,
  needsYouState,
  stepNeedsYou,
  type EntryFacts,
  type NeedsYouEntry,
  type NeedsYouInput,
  type NeedsYouQueue,
  type NeedsYouStep
} from './needsYou'

/*
 * 07 machine 34 (VA6, the needs-you queue and the "Need you ▸" counter; UC-059): the counter's and the row's words and
 * accessible names, the Host queue patched in place by the asks opening and closing, and where a press jumps in the
 * preset shown. The queue order is the Host's `NeedsYouQueue` (ordered by `askedAt`, ADR-032 D6), never re-sorted here.
 */
const MORIA = '01920000-0000-7000-8000-00000000a001' as MineId
const EREBOR = '01920000-0000-7000-8000-00000000a002' as MineId
const KHAZAD = '01920000-0000-7000-8000-00000000a003' as MineId
const BORIN = '01920000-0000-7000-8000-00000000d001' as DwarfId
const DAIN = '01920000-0000-7000-8000-00000000d002' as DwarfId
const NALI = '01920000-0000-7000-8000-00000000d003' as DwarfId
const FLOI = '01920000-0000-7000-8000-00000000d004' as DwarfId

const entry = (dwarfId: DwarfId, mineId: MineId, askedAt: number): NeedsYouEntry => ({
  dwarfId,
  mineId,
  askedAt
})

/** The Host's queue: BORIN asked first, then DAIN, then NALI. */
const HOST_QUEUE: NeedsYouQueue = [
  entry(BORIN, MORIA, 10),
  entry(DAIN, EREBOR, 20),
  entry(NALI, KHAZAD, 30)
]

const NAMES: Record<string, string> = { [BORIN]: 'borin', [DAIN]: 'dain', [NALI]: 'nali' }
const MINES: Record<string, string> = { [MORIA]: 'Moria', [EREBOR]: 'Erebor', [KHAZAD]: 'Khazad' }
const facts = (kinds: Record<string, 'question' | 'permission'>): EntryFacts => ({
  name: (dwarfId) => NAMES[dwarfId] ?? '',
  mineName: (mineId) => MINES[mineId] ?? '',
  askOf: (dwarfId) => kinds[dwarfId] ?? null
})

/** Steps the machine through `inputs`, failing on the first refusal. */
function run(
  queue: NeedsYouQueue,
  ...inputs: NeedsYouInput[]
): { queue: NeedsYouQueue; steps: NeedsYouStep[] } {
  const steps: NeedsYouStep[] = []
  let now = queue
  for (const input of inputs) {
    const step = stepNeedsYou(now, input)
    steps.push(step)
    if (!step.ok) throw new Error(`refused ${input.kind}`)
    now = step.queue
  }
  return { queue: now, steps }
}

const dwarfs = (queue: NeedsYouQueue): DwarfId[] => queue.map((e) => e.dwarfId)

describe('machine 34 diagram conformance', () => {
  it('[US-VALLE-004.AC01, S34.05, S34.06] the counter jumps to the oldest waiting dwarf, outlining its mine and expanding its chat in the Control room or swapping and opening its tab in the Work front, with no preset change', () => {
    const control = stepNeedsYou(HOST_QUEUE, {
      kind: 'counter',
      preset: 'control',
      frontMine: null
    })
    expect(control).toEqual({
      ok: true,
      id: 'S34.05',
      queue: HOST_QUEUE,
      jump: { preset: 'control', dwarfId: BORIN, mineId: MORIA }
    })
    // The Work front shows another mine: a swap to BORIN's mine, then its tab.
    const swap = stepNeedsYou(HOST_QUEUE, { kind: 'counter', preset: 'front', frontMine: EREBOR })
    expect(swap).toEqual({
      ok: true,
      id: 'S34.06',
      queue: HOST_QUEUE,
      jump: { preset: 'front', dwarfId: BORIN, mineId: MORIA, swap: true }
    })
    // Already on BORIN's mine: no swap, only its tab.
    const here = stepNeedsYou(HOST_QUEUE, { kind: 'counter', preset: 'front', frontMine: MORIA })
    expect(here.ok && here.jump).toEqual({
      preset: 'front',
      dwarfId: BORIN,
      mineId: MORIA,
      swap: false
    })
    // The jump names the preset it answers in, never another: no preset change.
    for (const step of [control, swap, here]) {
      if (!step.ok || step.jump === null) throw new Error('jumped')
      expect(step.jump.preset).toBe(step.id === 'S34.05' ? 'control' : 'front')
    }
  })

  // Owner ruling 2026-10-23 (VQA-02): the counter goes to the NEXT waiter after the one last jumped to, round the
  // queue (`DS` valle.js `nextNeed`), not always to the oldest as 07 machine 34 S34.05/S34.06 read.
  it('[US-VALLE-004.AC01, S34.05, S34.06] each press goes to the next waiting dwarf after the one last jumped to, in queue order, and wraps round to the oldest', () => {
    const press = (after: NeedsYouEntry | null): DwarfId => {
      const step = stepNeedsYou(HOST_QUEUE, {
        kind: 'counter',
        preset: 'control',
        frontMine: null,
        after
      })
      if (!step.ok || step.jump === null) throw new Error('jumped')
      return step.jump.dwarfId
    }
    // No jump yet: the oldest.
    expect(press(null)).toBe(BORIN)
    expect(press(HOST_QUEUE[0]!)).toBe(DAIN)
    expect(press(HOST_QUEUE[1]!)).toBe(NALI)
    // Round the queue: after the newest comes the oldest again.
    expect(press(HOST_QUEUE[2]!)).toBe(BORIN)
    // The Work front reads the same order: after BORIN, DAIN's mine swapped in.
    const front = stepNeedsYou(HOST_QUEUE, {
      kind: 'counter',
      preset: 'front',
      frontMine: MORIA,
      after: HOST_QUEUE[0]!
    })
    expect(front).toMatchObject({
      ok: true,
      id: 'S34.06',
      jump: { preset: 'front', dwarfId: DAIN, mineId: EREBOR, swap: true }
    })
  })

  it('[US-VALLE-004.AC01, S34.05, S34.03] a dwarf that left the queue is skipped: the press goes to the one that followed it, else round to the oldest', () => {
    const counter = (queue: NeedsYouQueue, after: NeedsYouEntry): DwarfId | null => {
      const step = stepNeedsYou(queue, {
        kind: 'counter',
        preset: 'control',
        frontMine: null,
        after
      })
      return step.ok && step.jump !== null ? step.jump.dwarfId : null
    }
    // DAIN was jumped to, then answered: the next is NALI, who followed DAIN, never BORIN again.
    const withoutDain = [HOST_QUEUE[0]!, HOST_QUEUE[2]!]
    expect(counter(withoutDain, HOST_QUEUE[1]!)).toBe(NALI)
    // NALI, the newest, was jumped to and answered: round to the oldest.
    expect(counter(HOST_QUEUE.slice(0, 2), HOST_QUEUE[2]!)).toBe(BORIN)
    // DAIN jumped to, then DAIN and NALI answered while FLOI asked: the next after DAIN is FLOI, not BORIN.
    expect(counter([HOST_QUEUE[0]!, entry(FLOI, MORIA, 40)], HOST_QUEUE[1]!)).toBe(FLOI)
    // Nobody waiting: nothing, whatever was jumped to (S34.08).
    expect(
      stepNeedsYou([], {
        kind: 'counter',
        preset: 'control',
        frontMine: null,
        after: HOST_QUEUE[0]!
      })
    ).toEqual({ ok: true, id: 'S34.08', queue: [], jump: null })
  })

  it('[US-VALLE-004.AC02, S34.08] with nobody waiting the counter reads Nobody waiting, is disabled and does nothing', () => {
    expect(needsYouState([])).toBe('nobody-waiting')
    expect(counterView([])).toEqual({
      state: 'nobody-waiting',
      count: 0,
      text: 'Nobody waiting',
      label: 'Nobody is waiting on you',
      disabled: true
    })
    expect(stepNeedsYou([], { kind: 'counter', preset: 'control', frontMine: null })).toEqual({
      ok: true,
      id: 'S34.08',
      queue: [],
      jump: null
    })
  })

  it('[US-VALLE-004.AC03, BR-12] one waiting reads 1 needs you', () => {
    const view = counterView([entry(BORIN, MORIA, 10)])
    expect(view.text).toBe('1 needs you')
    expect(view.disabled).toBe(false)
    expect(view.state).toBe('waiting')
  })

  it('[US-VALLE-004.AC04, BR-12] any other count reads n need you', () => {
    expect(counterView(HOST_QUEUE.slice(0, 2)).text).toBe('2 need you')
    expect(counterView(HOST_QUEUE).text).toBe('3 need you')
    const many = Array.from({ length: 12 }, (_, at) =>
      entry(`${BORIN.slice(0, -3)}${String(100 + at)}` as DwarfId, MORIA, at)
    )
    expect(counterView(many).text).toBe('12 need you')
  })

  it('[US-VALLE-004.AC06, S34.09] both presets show the same queue and count', () => {
    const switched = run(HOST_QUEUE, { kind: 'preset-switch' }, { kind: 'preset-switch' })
    expect(switched.steps.map((s) => s.ok && s.id)).toEqual(['S34.09', 'S34.09'])
    expect(switched.queue).toBe(HOST_QUEUE)
    // The words read the queue alone: nothing in them depends on the preset shown.
    expect(counterView(switched.queue)).toEqual(counterView(HOST_QUEUE))
  })

  it("[US-VALLE-004.AC07] the counter's accessible name counts and names no dwarf", () => {
    expect(counterView([entry(BORIN, MORIA, 10)]).label).toBe(
      '1 waiting on you. Jump to the next one'
    )
    const label = counterView(HOST_QUEUE).label
    expect(label).toBe('3 waiting on you. Jump to the next one')
    for (const name of Object.values(NAMES)) expect(label).not.toContain(name)
    for (const mine of Object.values(MINES)) expect(label).not.toContain(mine)
  })

  it('[US-VALLE-012.AC01, S34.01] the queue lists one entry per waiting dwarf, oldest first, with its mark, name and mine', () => {
    const opened = stepNeedsYou([], { kind: 'snapshot', queue: HOST_QUEUE })
    expect(opened).toEqual({ ok: true, id: 'S34.01', queue: HOST_QUEUE, jump: null })
    const views = HOST_QUEUE.map((e) =>
      entryView(e, facts({ [BORIN]: 'question', [DAIN]: 'permission', [NALI]: 'question' }))
    )
    expect(views.map((v) => [v.mark, v.name, v.where])).toEqual([
      ['?', 'borin', 'Moria'],
      ['!', 'dain', 'permission · Erebor'],
      ['?', 'nali', 'Khazad']
    ])
    // The Host's order is the order: a snapshot is taken as it comes, never re-sorted here (ADR-032 D6).
    const hostOrder = [entry(DAIN, EREBOR, 20), entry(BORIN, MORIA, 10)]
    const kept = stepNeedsYou([], { kind: 'snapshot', queue: hostOrder })
    expect(kept.ok && dwarfs(kept.queue)).toEqual([DAIN, BORIN])
  })

  it('[US-VALLE-012.AC02, S34.07] pressing an entry answers in the preset shown, without changing it', () => {
    const control = stepNeedsYou(HOST_QUEUE, {
      kind: 'entry',
      dwarfId: DAIN,
      mineId: EREBOR,
      preset: 'control',
      frontMine: null,
      present: true
    })
    expect(control).toEqual({
      ok: true,
      id: 'S34.07',
      queue: HOST_QUEUE,
      jump: { preset: 'control', dwarfId: DAIN, mineId: EREBOR }
    })
    const front = stepNeedsYou(HOST_QUEUE, {
      kind: 'entry',
      dwarfId: NALI,
      mineId: KHAZAD,
      preset: 'front',
      frontMine: MORIA,
      present: true
    })
    expect(front.ok && front.jump).toEqual({
      preset: 'front',
      dwarfId: NALI,
      mineId: KHAZAD,
      swap: true
    })
  })

  it('[US-VALLE-012.AC04, S34.03] an answered or cleared ask removes its entry and the row closes the gap', () => {
    const answered = run(
      HOST_QUEUE,
      // DAIN's only ask answered (any reason, answered elsewhere included).
      { kind: 'ask-closed', dwarfId: DAIN, next: null }
    )
    expect(answered.steps[0]).toMatchObject({ ok: true, id: 'S34.03' })
    expect(dwarfs(answered.queue)).toEqual([BORIN, NALI])
    // The entries that stay are the same entries, in the same order.
    expect(answered.queue[0]).toBe(HOST_QUEUE[0])
    expect(answered.queue[1]).toBe(HOST_QUEUE[2])
    // A departure clears its entry too; the last one leaves nobody waiting.
    const gone = run(
      answered.queue,
      { kind: 'departed', dwarfId: BORIN },
      { kind: 'ask-closed', dwarfId: NALI, next: null }
    )
    expect(gone.steps.map((s) => s.ok && s.id)).toEqual(['S34.03', 'S34.03'])
    expect(gone.queue).toEqual([])
    expect(needsYouState(gone.queue)).toBe('nobody-waiting')
  })

  it('[US-VALLE-012.AC06] with nobody waiting the row reads Nobody is waiting on you.', () => {
    expect(QUEUE_EMPTY_TEXT).toBe('Nobody is waiting on you.')
  })

  it('[US-VALLE-012.AC07] an entry’s accessible name reads dwarf asks for a permission in mine or dwarf has a question in mine', () => {
    const kinds = facts({ [BORIN]: 'question', [DAIN]: 'permission' })
    expect(entryView(HOST_QUEUE[0]!, kinds).label).toBe('borin has a question in Moria')
    expect(entryView(HOST_QUEUE[1]!, kinds).label).toBe('dain asks for a permission in Erebor')
    // Never the mark alone.
    for (const e of HOST_QUEUE.slice(0, 2)) {
      const label = entryView(e, kinds).label
      expect(label).not.toMatch(/^[?!]$/)
      expect(label).not.toContain('?')
      expect(label).not.toContain('!')
    }
  })

  it('[S34.02, S34.04, S34.10, S34.11] an observed ask counts, an auto-denied one never enters, a dwarf keeps one entry, overflow keeps the counter’s reach, and a stale press opens the chat only if the dwarf is present', () => {
    // S34.02: a new asker appends at the end; the others stay the same entries, in place.
    const appended = run(HOST_QUEUE, {
      kind: 'ask-opened',
      dwarfId: FLOI,
      mineId: MORIA,
      askedAt: 40,
      state: 'open'
    })
    expect(appended.steps[0]).toMatchObject({ ok: true, id: 'S34.02' })
    expect(dwarfs(appended.queue)).toEqual([BORIN, DAIN, NALI, FLOI])
    HOST_QUEUE.forEach((e, at) => expect(appended.queue[at]).toBe(e))
    // An observed ask with no card counts the same (PO #76): nothing here reads its channel.
    // An auto-denied ask never enters.
    expect(
      stepNeedsYou(HOST_QUEUE, {
        kind: 'ask-opened',
        dwarfId: FLOI,
        mineId: MORIA,
        askedAt: 40,
        state: 'auto-denied'
      })
    ).toEqual({ ok: false, reason: 'not-listed' })
    // A second ask of a waiting dwarf adds no entry: one per dwarf.
    const second = run(appended.queue, {
      kind: 'ask-opened',
      dwarfId: BORIN,
      mineId: MORIA,
      askedAt: 50,
      state: 'open'
    })
    expect(second.queue).toBe(appended.queue)
    // S34.04: BORIN's first ask closes, its next becomes current: one entry, placed where the Host's order puts it.
    const advanced = run(second.queue, { kind: 'ask-closed', dwarfId: BORIN, next: 50 })
    expect(advanced.steps[0]).toMatchObject({ ok: true, id: 'S34.04' })
    expect(dwarfs(advanced.queue)).toEqual([DAIN, NALI, FLOI, BORIN])
    expect(advanced.queue.find((e) => e.dwarfId === BORIN)?.askedAt).toBe(50)
    // S34.10: however long the row, the counter reaches every one, oldest first, as each is answered.
    const many = Array.from({ length: 30 }, (_, at) =>
      entry(`${BORIN.slice(0, -3)}${String(200 + at)}` as DwarfId, MORIA, at)
    )
    let left: NeedsYouQueue = many
    const reached: DwarfId[] = []
    while (left.length > 0) {
      const step = stepNeedsYou(left, { kind: 'counter', preset: 'control', frontMine: null })
      if (!step.ok || step.jump === null) throw new Error('reached')
      reached.push(step.jump.dwarfId)
      const closed = stepNeedsYou(left, {
        kind: 'ask-closed',
        dwarfId: step.jump.dwarfId,
        next: null
      })
      if (!closed.ok) throw new Error('closed')
      left = closed.queue
    }
    expect(reached).toEqual(many.map((e) => e.dwarfId))
    // S34.11: the pressed entry's ask closed before the jump ran: the chat opens when the dwarf is present ...
    const stale = stepNeedsYou([], {
      kind: 'entry',
      dwarfId: DAIN,
      mineId: EREBOR,
      preset: 'control',
      frontMine: null,
      present: true
    })
    expect(stale).toEqual({
      ok: true,
      id: 'S34.11',
      queue: [],
      jump: { preset: 'control', dwarfId: DAIN, mineId: EREBOR }
    })
    // ... and nothing when it left.
    expect(
      stepNeedsYou([], {
        kind: 'entry',
        dwarfId: DAIN,
        mineId: EREBOR,
        preset: 'front',
        frontMine: MORIA,
        present: false
      })
    ).toEqual({ ok: true, id: 'S34.11', queue: [], jump: null })
  })

  it('[ADR-024] a transition not listed in 07 machine 34 is rejected', () => {
    const refused = { ok: false, reason: 'not-listed' }
    // An ask closing, or a departure, for a dwarf with no entry.
    expect(stepNeedsYou(HOST_QUEUE, { kind: 'ask-closed', dwarfId: FLOI, next: null })).toEqual(
      refused
    )
    expect(stepNeedsYou(HOST_QUEUE, { kind: 'departed', dwarfId: FLOI })).toEqual(refused)
    // A preset switch is listed from `waiting` only.
    expect(stepNeedsYou([], { kind: 'preset-switch' })).toEqual(refused)
    // An ask that is not open or answering does not make its dwarf asking.
    expect(
      stepNeedsYou([], {
        kind: 'ask-opened',
        dwarfId: FLOI,
        mineId: MORIA,
        askedAt: 1,
        state: 'answered-in-app'
      })
    ).toEqual(refused)
  })
})
