import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import { sceneDwarfLabel, sceneDwarfMark, sceneDwarfResting, sceneDwarfStatus } from './sceneDwarf'

const QUESTION = {
  toolUseId: 't1',
  channel: 'terminal' as const,
  questions: [{ question: 'Which one?', multiSelect: false, options: [{ label: 'A' }] }]
}

describe('sceneDwarfStatus', () => {
  it('draws a working session as working', () => {
    expect(sceneDwarfStatus(defaultDwarf({ status: 'working' }))).toBe('working')
  })

  /*
   * Asking is a proven ask and nothing weaker (dwarfNeedsYou): a question waiting for an answer
   * or a permission the session holds open. The "?" is attention level 1 and must not be spent on
   * a dwarf that asked nobody anything.
   */
  it('draws a waiting session that asked a question, or needs a permission, as asking', () => {
    expect(sceneDwarfStatus(defaultDwarf({ status: 'waiting', pendingQuestion: QUESTION }))).toBe(
      'asking'
    )
    expect(sceneDwarfStatus(defaultDwarf({ status: 'waiting', waitingReason: 'approval' }))).toBe(
      'asking'
    )
  })

  it('draws a waiting session nobody was asked anything by as asleep', () => {
    expect(sceneDwarfStatus(defaultDwarf({ status: 'waiting' }))).toBe('asleep')
    expect(sceneDwarfStatus(defaultDwarf({ status: 'waiting', waitingReason: 'user-input' }))).toBe(
      'asleep'
    )
  })

  it('draws a leaving session as idle: it neither works nor sleeps on its way out', () => {
    expect(sceneDwarfStatus(defaultDwarf({ status: 'leaving' }))).toBe('idle')
  })
})

describe('sceneDwarfResting', () => {
  /*
   * The design's asking dwarf stops and raises a hand on its idle sheet (screens/mine.md, W3·2);
   * it does not lie down. Only a dwarf asleep plays the sleep sequence.
   */
  it('rests an asleep dwarf and never an asking one', () => {
    expect(sceneDwarfResting(defaultDwarf({ status: 'waiting' }))).toBe(true)
    expect(sceneDwarfResting(defaultDwarf({ status: 'waiting', pendingQuestion: QUESTION }))).toBe(
      false
    )
    expect(sceneDwarfResting(defaultDwarf({ status: 'working' }))).toBe(false)
  })
})

describe('sceneDwarfLabel', () => {
  it('names the button "<name>, <state>", with "needs you" for an asking dwarf', () => {
    expect(sceneDwarfLabel('dwarfai-53', 'working')).toBe('dwarfai-53, working')
    expect(sceneDwarfLabel('dwarfai-54', 'asking')).toBe('dwarfai-54, needs you')
    expect(sceneDwarfLabel('dwarfai-55', 'asleep')).toBe('dwarfai-55, asleep')
    expect(sceneDwarfLabel('dwarfai-57', 'idle')).toBe('dwarfai-57, idle')
  })
})

describe('sceneDwarfMark', () => {
  it('draws nothing when no message or kick is on its way', () => {
    expect(sceneDwarfMark(undefined, undefined)).toBeNull()
  })

  it('draws the four marks from the send verdict: … ✓ ✓✓ ✕', () => {
    expect(sceneDwarfMark({ phase: 'sending' }, undefined)).toMatchObject({
      mark: 'pending',
      glyph: '…'
    })
    expect(sceneDwarfMark({ phase: 'delivered' }, undefined)).toMatchObject({
      mark: 'delivered',
      glyph: '✓'
    })
    expect(sceneDwarfMark({ phase: 'reacted' }, undefined)).toMatchObject({
      mark: 'reacted',
      glyph: '✓✓'
    })
    expect(sceneDwarfMark({ phase: 'failed' }, undefined)).toMatchObject({
      mark: 'failed',
      glyph: '✕'
    })
  })

  /*
   * Delivered and reacted are different facts (AGENTS.md): a held message has been handed to
   * nothing, so it is pending, and a delivered one never claims the session acted on it.
   */
  it('keeps a held message pending and a delivered one short of reacted', () => {
    expect(sceneDwarfMark({ phase: 'held' }, undefined)?.mark).toBe('pending')
    expect(sceneDwarfMark({ phase: 'delivered', awaitingReaction: false }, undefined)?.mark).toBe(
      'delivered'
    )
  })

  it('carries the verdict’s own sentence as its title', () => {
    expect(sceneDwarfMark({ phase: 'failed', error: 'The CLI is gone.' }, undefined)?.title).toBe(
      'The CLI is gone.'
    )
  })

  /*
   * The design draws one mark per dwarf; today's sprite drew the kick on the opposite corner. The
   * message outranks the kick, and a kick alone still shows, so neither verdict is lost.
   */
  it('draws the kick verdict when no message is on its way, and the message when both are', () => {
    expect(sceneDwarfMark(undefined, { phase: 'kicking' })).toMatchObject({ mark: 'pending' })
    expect(sceneDwarfMark({ phase: 'reacted' }, { phase: 'failed' })?.mark).toBe('reacted')
  })
})
