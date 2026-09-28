import { describe, expect, it } from 'vitest'
import type { DwarfPermissionRequest } from '../../types'
import { chooseAt, type AskShape } from './questionAnswer'
import {
  askMark,
  askingName,
  digitPick,
  dropOtherAt,
  otherAt,
  permissionAsk,
  permissionRequestText,
  pickOtherAt,
  stepDots,
  writeOtherAt
} from './questionCard'

const ask: AskShape = {
  toolUseId: 'toolu_01',
  questions: [
    { question: 'Which database?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
    { question: 'Which region?', multiSelect: false, options: [{ label: 'East' }] },
    { question: 'Run it?', multiSelect: false, options: [{ label: 'Yes' }] }
  ]
}

function permission(overrides: Partial<DwarfPermissionRequest> = {}): DwarfPermissionRequest {
  return {
    toolUseId: 'toolu_09',
    toolName: 'Bash',
    input: 'pnpm install',
    channel: 'held',
    askedAt: '2026-09-28T09:00:00.000Z',
    ...overrides
  }
}

function key(
  value: string,
  modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey', boolean>> = {}
) {
  return { key: value, ctrlKey: false, metaKey: false, altKey: false, ...modifiers }
}

describe('the question card head', () => {
  it('names the card for its asker', () => {
    expect(askingName('dwarfai-54')).toBe('dwarfai-54 is asking')
  })

  it('marks a question "?" and a permission "!", as the needs-you queue does', () => {
    expect(askMark(false)).toBe('?')
    expect(askMark(true)).toBe('!')
  })
})

describe('a permission as the card draws it', () => {
  it('sets the request as the tool and its input, joined as the design writes it', () => {
    expect(permissionRequestText(permission())).toBe('Bash · pnpm install')
  })

  it('keeps the CLI’s own sentences, each on a line of its own, when the bridge sent them', () => {
    const text = permissionRequestText(
      permission({
        title: 'Claude wants to run a command',
        description: 'It changes the lockfile.'
      })
    )
    expect(text).toBe(
      'Bash · pnpm install\nClaude wants to run a command\nIt changes the lockfile.'
    )
  })

  it('is one step whose only decisions are Allow then Deny, with nothing described', () => {
    const shape = permissionAsk(permission())
    expect(shape.toolUseId).toBe('toolu_09')
    expect(shape.questions).toHaveLength(1)
    expect(shape.questions[0]!.question).toBe('Bash · pnpm install')
    expect(shape.questions[0]!.options).toEqual([{ label: 'Allow' }, { label: 'Deny' }])
    expect(shape.questions[0]!.multiSelect).toBe(false)
  })
})

describe('the digit keys', () => {
  it('pick the option with that number, and one past the options picks Other thing…', () => {
    expect(digitPick(key('1'), 3, true)).toBe(0)
    expect(digitPick(key('3'), 3, true)).toBe(2)
    expect(digitPick(key('4'), 3, true)).toBe(3)
  })

  it('pick nothing past Other thing…, and never Other thing… where it is closed', () => {
    expect(digitPick(key('5'), 3, true)).toBeNull()
    expect(digitPick(key('4'), 3, false)).toBeNull()
  })

  it('read single digits only, never 0, and never with a modifier held', () => {
    expect(digitPick(key('0'), 3, true)).toBeNull()
    expect(digitPick(key('a'), 3, true)).toBeNull()
    expect(digitPick(key('Enter'), 3, true)).toBeNull()
    expect(digitPick(key('1', { ctrlKey: true }), 3, true)).toBeNull()
    expect(digitPick(key('1', { metaKey: true }), 3, true)).toBeNull()
    expect(digitPick(key('1', { altKey: true }), 3, true)).toBeNull()
  })

  it('stop at nine, so an option past it is reached by pointer or Tab alone', () => {
    expect(digitPick(key('9'), 11, true)).toBe(8)
  })
})

describe('Other thing… on a step', () => {
  it('is not picked until it is, and holds what was typed for that step of that ask alone', () => {
    expect(otherAt(null, 'toolu_01', 0)).toBeNull()
    const picked = pickOtherAt(null, 'toolu_01', 0)
    expect(otherAt(picked, 'toolu_01', 0)).toBe('')
    const written = writeOtherAt(picked, 'toolu_01', 0, 'Redis')
    expect(otherAt(written, 'toolu_01', 0)).toBe('Redis')
    expect(otherAt(written, 'toolu_01', 1)).toBeNull()
    expect(otherAt(written, 'toolu_02', 0)).toBeNull()
  })

  it('keeps its words when it is picked again, and lets them go when it is dropped', () => {
    const written = writeOtherAt(pickOtherAt(null, 'toolu_01', 0), 'toolu_01', 0, 'Redis')
    expect(otherAt(pickOtherAt(written, 'toolu_01', 0), 'toolu_01', 0)).toBe('Redis')
    expect(otherAt(dropOtherAt(written, 'toolu_01', 0), 'toolu_01', 0)).toBeNull()
  })
})

describe('the step dots', () => {
  it('mark the step shown, each other answered step done, and the rest open', () => {
    const answers = chooseAt(null, ask, 0, 'A')
    expect(stepDots(ask, 1, answers, null)).toEqual(['done', 'here', 'open'])
    expect(stepDots(ask, 0, null, null)).toEqual(['here', 'open', 'open'])
  })

  it('count a step answered in the person’s own words only while they hold text', () => {
    const typed = writeOtherAt(pickOtherAt(null, 'toolu_01', 2), 'toolu_01', 2, 'later')
    expect(stepDots(ask, 0, null, typed)).toEqual(['here', 'open', 'done'])
    const blank = writeOtherAt(typed, 'toolu_01', 2, '   ')
    expect(stepDots(ask, 0, null, blank)).toEqual(['here', 'open', 'open'])
  })
})
