import { describe, expect, it } from 'vitest'
import type { Dwarf, Mine } from '../domain/types'
import { defaultDwarf, defaultMine } from '../domain/types'
import {
  decideNotifications,
  emptyNotifyMemory,
  permissionCopy,
  questionCopy,
  turnEndCopy,
  type NotifyInput,
  type NotifyMemory
} from './notifyDecision'

/**
 * The decision behind a system notification (#316), as a fold over two boards.
 *
 * Nothing here touches Electron: the OS surface is a port, and what decides
 * WHETHER to notify is this pure function, so every rule the issue states — the
 * two cases, the dedupe key, the focus condition, the withdrawal — is assertable
 * without a notification centre.
 */

function dwarf(overrides: Partial<Dwarf>): Dwarf {
  return { ...defaultDwarf(), ...overrides }
}

function mine(id: string, name: string, dwarfs: Dwarf[]): Mine {
  return { ...defaultMine(), id, name, dwarfs }
}

function input(mines: Mine[], overrides: Partial<NotifyInput> = {}): NotifyInput {
  return {
    mines,
    focus: { panelVisible: false, openMineId: null },
    enabled: true,
    now: 1_000,
    ...overrides
  }
}

/** Seed the memory with a board, as the first poll of a run does. */
function seeded(mines: Mine[], overrides: Partial<NotifyInput> = {}): NotifyMemory {
  return decideNotifications(emptyNotifyMemory(), input(mines, overrides)).memory
}

const QUIET = mine('m1', 'Forge', [dwarf({ id: 'd1', role: 'foreman', status: 'waiting' })])

const ASKING = mine('m1', 'Forge', [
  dwarf({
    id: 'd1',
    role: 'foreman',
    status: 'waiting',
    pendingQuestion: {
      toolUseId: 'ask-1',
      question: 'Which branch?',
      channel: 'held',
      multiSelect: false,
      questionCount: 1,
      options: []
    }
  })
])

const PERMITTING = mine('m1', 'Forge', [
  dwarf({
    id: 'd1',
    role: 'foreman',
    status: 'waiting',
    pendingPermission: {
      toolUseId: 'tool-1',
      toolName: 'Bash',
      input: 'rm -rf build',
      channel: 'held',
      askedAt: '2026-09-12T10:00:00.000Z'
    }
  })
])

describe('notification copy', () => {
  it('words each case exactly as #316 states it', () => {
    expect(questionCopy('Forge')).toBe('A question is waiting in Forge')
    expect(permissionCopy('Forge')).toBe('Forge is waiting for your approval')
    expect(turnEndCopy('Forge')).toBe('Forge finished its turn')
  })
})

describe('decideNotifications — the first board', () => {
  it('only seeds, so a panel starting on five open asks does not fire five times', () => {
    const { decision } = decideNotifications(emptyNotifyMemory(), input([ASKING]))
    expect(decision.show).toEqual([])
    expect(decision.withdraw).toEqual([])
  })

  it('remembers what it saw, so nothing already open is later read as new', () => {
    const memory = seeded([ASKING])
    expect(decideNotifications(memory, input([ASKING])).decision.show).toEqual([])
  })
})

describe('decideNotifications — a question or a permission appears', () => {
  it('names the mine when a structured question turns up', () => {
    const { decision } = decideNotifications(seeded([QUIET]), input([ASKING]))
    expect(decision.show).toEqual([
      {
        key: 'question:d1:ask-1',
        kind: 'question',
        title: 'A question is waiting in Forge',
        mineId: 'm1'
      }
    ])
  })

  it('names the approval when a permission prompt turns up', () => {
    const { decision } = decideNotifications(seeded([QUIET]), input([PERMITTING]))
    expect(decision.show).toEqual([
      {
        key: 'permission:d1:tool-1',
        kind: 'permission',
        title: 'Forge is waiting for your approval',
        mineId: 'm1'
      }
    ])
  })

  it('reads a waitingReason of user-input as a question, where no structured ask crossed', () => {
    const asked = mine('m1', 'Forge', [
      dwarf({ id: 'd1', role: 'foreman', status: 'waiting', waitingReason: 'user-input' })
    ])
    const { decision } = decideNotifications(seeded([QUIET]), input([asked]))
    expect(decision.show).toEqual([
      {
        key: 'question:d1:waiting',
        kind: 'question',
        title: 'A question is waiting in Forge',
        mineId: 'm1'
      }
    ])
  })

  it('reads a waitingReason of approval as the approval it is', () => {
    const asked = mine('m1', 'Forge', [
      dwarf({ id: 'd1', role: 'foreman', status: 'waiting', waitingReason: 'approval' })
    ])
    expect(decideNotifications(seeded([QUIET]), input([asked])).decision.show).toEqual([
      {
        key: 'permission:d1:waiting',
        kind: 'permission',
        title: 'Forge is waiting for your approval',
        mineId: 'm1'
      }
    ])
  })

  it("says nothing for 'unknown', because absence of proof is not proof", () => {
    const blocked = mine('m1', 'Forge', [
      dwarf({ id: 'd1', role: 'foreman', status: 'waiting', waitingReason: 'unknown' })
    ])
    expect(decideNotifications(seeded([QUIET]), input([blocked])).decision.show).toEqual([])
  })

  it('says nothing about a dwarf that is already leaving', () => {
    // The grace window freezes the last real snapshot, ask and all, and there is
    // nobody left at the other end to answer it.
    const gone = mine('m1', 'Forge', [
      { ...ASKING.dwarfs[0], status: 'leaving' as const }
    ])
    expect(decideNotifications(seeded([QUIET]), input([gone])).decision.show).toEqual([])
  })

  it('notifies once for an ask that stays open across polls', () => {
    let memory = seeded([QUIET])
    const first = decideNotifications(memory, input([ASKING]))
    memory = first.memory
    expect(first.decision.show).toHaveLength(1)
    expect(decideNotifications(memory, input([ASKING])).decision.show).toEqual([])
  })

  it('withdraws the notification once the ask is gone', () => {
    const memory = decideNotifications(seeded([QUIET]), input([ASKING])).memory
    const { decision } = decideNotifications(memory, input([QUIET]))
    expect(decision.withdraw).toEqual(['question:d1:ask-1'])
    expect(decision.show).toEqual([])
  })

  it('treats a new toolUseId on the same dwarf as a new fact', () => {
    const memory = decideNotifications(seeded([QUIET]), input([ASKING])).memory
    const second = mine('m1', 'Forge', [
      { ...ASKING.dwarfs[0], pendingQuestion: { ...ASKING.dwarfs[0].pendingQuestion!, toolUseId: 'ask-2' } }
    ])
    const { decision } = decideNotifications(memory, input([second]))
    expect(decision.show.map((one) => one.key)).toEqual(['question:d1:ask-2'])
    expect(decision.withdraw).toEqual(['question:d1:ask-1'])
  })

  it('speaks once for a dwarf holding both an ask and a permission, the ask first', () => {
    // WAITING_ON_HUMAN_REASON's own precedence: where both are open the session
    // is blocked on the question, and two sentences about one dwarf read as two
    // dwarfs.
    const both = mine('m1', 'Forge', [
      { ...ASKING.dwarfs[0], pendingPermission: PERMITTING.dwarfs[0].pendingPermission }
    ])
    expect(decideNotifications(seeded([QUIET]), input([both])).decision.show).toEqual([
      {
        key: 'question:d1:ask-1',
        kind: 'question',
        title: 'A question is waiting in Forge',
        mineId: 'm1'
      }
    ])
  })
})

describe('decideNotifications — never for the mine on screen', () => {
  it('says nothing while the panel is showing that mine interior', () => {
    const { decision } = decideNotifications(
      seeded([QUIET]),
      input([ASKING], { focus: { panelVisible: true, openMineId: 'm1' } })
    )
    expect(decision.show).toEqual([])
  })

  it('still notifies for another mine while one is open', () => {
    const other = mine('m2', 'Quarry', [dwarf({ id: 'd9', role: 'foreman' })])
    const { decision } = decideNotifications(
      seeded([QUIET, other]),
      input([ASKING, other], { focus: { panelVisible: true, openMineId: 'm2' } })
    )
    expect(decision.show.map((one) => one.mineId)).toEqual(['m1'])
  })

  it('notifies even for the open mine once the panel is hidden', () => {
    const { decision } = decideNotifications(
      seeded([QUIET]),
      input([ASKING], { focus: { panelVisible: false, openMineId: 'm1' } })
    )
    expect(decision.show).toHaveLength(1)
  })

  it('counts the map with no interior open as focused on no mine at all', () => {
    const { decision } = decideNotifications(
      seeded([QUIET]),
      input([ASKING], { focus: { panelVisible: true, openMineId: null } })
    )
    expect(decision.show).toHaveLength(1)
  })

  it('keeps the fact in memory even where focus suppressed it, so leaving the mine is not an arrival', () => {
    const memory = decideNotifications(
      seeded([QUIET]),
      input([ASKING], { focus: { panelVisible: true, openMineId: 'm1' } })
    ).memory
    const { decision } = decideNotifications(
      memory,
      input([ASKING], { focus: { panelVisible: true, openMineId: null } })
    )
    expect(decision.show).toEqual([])
  })
})

describe('decideNotifications — a turn ends', () => {
  const WORKING = mine('m1', 'Forge', [dwarf({ id: 'd1', role: 'foreman', status: 'working' })])
  const RESTING = mine('m1', 'Forge', [dwarf({ id: 'd1', role: 'foreman', status: 'waiting' })])

  it('notifies once when the mine foreman stops working', () => {
    const { decision } = decideNotifications(seeded([WORKING]), input([RESTING], { now: 7 }))
    expect(decision.show).toEqual([
      { key: 'turn:d1:7', kind: 'turn-end', title: 'Forge finished its turn', mineId: 'm1' }
    ])
  })

  it('notifies when the foreman leaves the board entirely', () => {
    const empty = mine('m1', 'Forge', [])
    expect(
      decideNotifications(seeded([WORKING]), input([empty], { now: 7 })).decision.show
    ).toHaveLength(1)
  })

  it('does not repeat it on the next poll', () => {
    const memory = decideNotifications(seeded([WORKING]), input([RESTING])).memory
    expect(decideNotifications(memory, input([RESTING])).decision.show).toEqual([])
  })

  it('says nothing when a WORKER stops working — the turn belongs to the foreman', () => {
    const busy = mine('m1', 'Forge', [dwarf({ id: 'w1', role: 'worker', status: 'working' })])
    const idle = mine('m1', 'Forge', [dwarf({ id: 'w1', role: 'worker', status: 'waiting' })])
    expect(decideNotifications(seeded([busy]), input([idle])).decision.show).toEqual([])
  })

  it('says nothing for a turn that ends in the mine on screen', () => {
    const { decision } = decideNotifications(
      seeded([WORKING]),
      input([RESTING], { focus: { panelVisible: true, openMineId: 'm1' } })
    )
    expect(decision.show).toEqual([])
  })

  it('never withdraws a turn end, because an ended turn does not come back', () => {
    const memory = decideNotifications(seeded([WORKING]), input([RESTING])).memory
    expect(decideNotifications(memory, input([RESTING])).decision.withdraw).toEqual([])
  })

  it('fires again when the same foreman starts and finishes another turn', () => {
    let memory = decideNotifications(seeded([WORKING]), input([RESTING])).memory
    memory = decideNotifications(memory, input([WORKING])).memory
    expect(decideNotifications(memory, input([RESTING], { now: 9 })).decision.show).toEqual([
      { key: 'turn:d1:9', kind: 'turn-end', title: 'Forge finished its turn', mineId: 'm1' }
    ])
  })
})

describe('decideNotifications — the Settings switch', () => {
  it('shows nothing at all while it is off', () => {
    const { decision } = decideNotifications(
      seeded([QUIET], { enabled: false }),
      input([ASKING], { enabled: false })
    )
    expect(decision.show).toEqual([])
  })

  it('does not fire the backlog when it comes back on', () => {
    // Memory is folded whether or not anything is shown, so an ask that appeared
    // while the switch was off is not new when it is switched on again.
    const memory = decideNotifications(
      seeded([QUIET], { enabled: false }),
      input([ASKING], { enabled: false })
    ).memory
    expect(decideNotifications(memory, input([ASKING])).decision.show).toEqual([])
  })

  it('still withdraws a fact that went away, so nothing shown earlier is stranded', () => {
    const memory = decideNotifications(seeded([QUIET]), input([ASKING])).memory
    const { decision } = decideNotifications(memory, input([QUIET], { enabled: false }))
    expect(decision.withdraw).toEqual(['question:d1:ask-1'])
  })
})
