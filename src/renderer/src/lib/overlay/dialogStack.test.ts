import { describe, expect, it } from 'vitest'
import { createDialogStack } from './dialogStack'

describe('dialogStack (ISSUE-141)', () => {
  it('puts the later of two ordinary dialogs on top', () => {
    const stack = createDialogStack()
    stack.open(1, false)
    stack.open(2, false)
    expect(stack.top()).toBe(2)
    expect([stack.depth(1), stack.depth(2)]).toEqual([0, 1])
  })

  it('[ADR-002] keeps a dialog opened over all on top, whichever opened first', () => {
    const stack = createDialogStack()
    stack.open(1, true)
    stack.open(2, false)
    expect(stack.top()).toBe(1)
    expect(stack.depth(2)).toBe(0)
  })

  it('gives the top back to the one beneath once the top closes', () => {
    const stack = createDialogStack()
    stack.open(1, false)
    stack.open(2, true)
    stack.close(2)
    expect(stack.top()).toBe(1)
    expect(stack.depth(2)).toBe(-1)
  })

  it('has no top while nothing is open', () => {
    expect(createDialogStack().top()).toBeUndefined()
  })
})
