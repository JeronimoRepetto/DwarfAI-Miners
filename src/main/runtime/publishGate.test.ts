import { describe, expect, it } from 'vitest'
import type { MaterialTotals, Mine } from '../../shared/contracts'
import { PublishGate } from './publishGate'

const NO_MATERIALS: MaterialTotals = {
  coal: 0,
  bronze: 0,
  copper: 0,
  silver: 0,
  gold: 0,
  uranium: 0
}

function mine(overrides: Partial<Mine> = {}): Mine {
  return {
    id: 'mine:c:/proj',
    path: 'C:/proj',
    name: 'proj',
    tier: 'bronze',
    dwarfs: [],
    tokensObserved: 0,
    updatedAt: 1_000,
    ...overrides
  }
}

describe('PublishGate', () => {
  it('always publishes the first snapshot', () => {
    expect(new PublishGate().shouldPublish([mine()], NO_MATERIALS)).toBe(true)
  })

  it('suppresses a snapshot identical to the one already sent', () => {
    const gate = new PublishGate()
    gate.shouldPublish([mine()], NO_MATERIALS)
    expect(gate.shouldPublish([mine()], NO_MATERIALS)).toBe(false)
  })

  it('publishes again once anything about a mine changes', () => {
    const gate = new PublishGate()
    gate.shouldPublish([mine()], NO_MATERIALS)
    expect(gate.shouldPublish([mine({ updatedAt: 2_000 })], NO_MATERIALS)).toBe(true)
  })

  it('notices a dwarf changing status inside an otherwise identical mine', () => {
    const gate = new PublishGate()
    const working = mine({
      dwarfs: [
        {
          id: 'claude:a',
          provider: 'claude',
          role: 'foreman',
          name: 'a',
          status: 'working',
          sessionId: 'a'
        }
      ]
    })
    const waiting = mine({
      dwarfs: [
        {
          id: 'claude:a',
          provider: 'claude',
          role: 'foreman',
          name: 'a',
          status: 'waiting',
          sessionId: 'a'
        }
      ]
    })
    gate.shouldPublish([working], NO_MATERIALS)
    expect(gate.shouldPublish([waiting], NO_MATERIALS)).toBe(true)
  })

  it('notices the vault growing even when no mine changed', () => {
    const gate = new PublishGate()
    gate.shouldPublish([mine()], NO_MATERIALS)
    expect(gate.shouldPublish([mine()], { ...NO_MATERIALS, coal: 5 })).toBe(true)
  })

  it('notices a mine leaving', () => {
    const gate = new PublishGate()
    gate.shouldPublish([mine(), mine({ id: 'mine:c:/other' })], NO_MATERIALS)
    expect(gate.shouldPublish([mine()], NO_MATERIALS)).toBe(true)
  })

  it('suppresses only while the state holds still, then resumes', () => {
    const gate = new PublishGate()
    expect(gate.shouldPublish([mine()], NO_MATERIALS)).toBe(true)
    expect(gate.shouldPublish([mine()], NO_MATERIALS)).toBe(false)
    expect(gate.shouldPublish([mine({ tokensObserved: 9 })], NO_MATERIALS)).toBe(true)
    expect(gate.shouldPublish([mine({ tokensObserved: 9 })], NO_MATERIALS)).toBe(false)
  })

  it('publishes an empty snapshot once, then holds', () => {
    const gate = new PublishGate()
    expect(gate.shouldPublish([], NO_MATERIALS)).toBe(true)
    expect(gate.shouldPublish([], NO_MATERIALS)).toBe(false)
  })

  it('treats a snapshot with no materials as its own state', () => {
    const gate = new PublishGate()
    expect(gate.shouldPublish([mine()], undefined)).toBe(true)
    expect(gate.shouldPublish([mine()], undefined)).toBe(false)
    expect(gate.shouldPublish([mine()], NO_MATERIALS)).toBe(true)
  })
})
