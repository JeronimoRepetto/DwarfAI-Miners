import { describe, expect, it } from 'vitest'
import type { Dwarf, Mine } from '../domain/types'
import type { HookEvent } from './hookPayload'
import {
  PermissionPromptRegistry,
  UNMATCHED_PROMPT_GRACE_MS,
  stampPermissionPrompts
} from './permissionPrompts'

const MINE_ID = 'mine:/home/j/code/anvil'

function foreman(overrides: Partial<Dwarf> = {}): Dwarf {
  return {
    id: 'claude:abc',
    provider: 'claude',
    role: 'foreman',
    name: 'anvil-1',
    status: 'waiting',
    sessionId: 'abc',
    ...overrides
  }
}

function mine(dwarfs: Dwarf[]): Mine {
  return {
    id: MINE_ID,
    path: '/home/j/code/anvil',
    name: 'anvil',
    tier: 'bronze',
    dwarfs,
    tokensObserved: 0,
    updatedAt: 5
  }
}

function promptEvent(sessionId?: string): HookEvent {
  return {
    provider: 'claude',
    event: 'Notification',
    ...(sessionId === undefined ? {} : { sessionId }),
    notificationType: 'permission_prompt'
  }
}

function hook(event: HookEvent['event'], sessionId = 'abc'): HookEvent {
  return { provider: 'claude', event, sessionId }
}

function registry(clock: { now: number }): PermissionPromptRegistry {
  return new PermissionPromptRegistry({ now: () => clock.now })
}

/** The reason each dwarf ends up carrying, in board order. */
function reasonsOf(mines: Mine[]): (string | undefined)[] {
  return mines.flatMap((entry) => entry.dwarfs.map((dwarf) => dwarf.waitingReason))
}

describe('stampPermissionPrompts', () => {
  it('marks the foreman of a session a prompt is open for', () => {
    const stamped = stampPermissionPrompts([mine([foreman()])], (id) => id === 'abc')
    expect(reasonsOf(stamped)).toEqual(['approval'])
  })

  it('leaves a dwarf alone when no prompt is open for its session', () => {
    const stamped = stampPermissionPrompts([mine([foreman()])], () => false)
    expect(reasonsOf(stamped)).toEqual([undefined])
  })

  it('never marks a worker sharing its foreman’s session id', () => {
    // The same trap stampHeldQuestions names: a Claude subagent carries its
    // foreman's sessionId, so keying on the id alone would mark every dwarf in
    // the session as the one being asked.
    const board = [mine([foreman(), foreman({ id: 'claude:abc/agent-1', role: 'worker' })])]
    expect(reasonsOf(stampPermissionPrompts(board, () => true))).toEqual(['approval', undefined])
  })

  it('refines the provider’s unnamed condition into the one the hook named', () => {
    // 'unknown' is "blocked, and the condition is not one this app can read".
    // A permission_prompt hook is a second structured proof naming it, which is
    // the one move WaitingReason's contract allows on that middle value.
    const board = [mine([foreman({ waitingReason: 'unknown' })])]
    expect(reasonsOf(stampPermissionPrompts(board, () => true))).toEqual(['approval'])
  })

  it('never overwrites the reason that suspends eviction', () => {
    // 'user-input' carries a behavioural promise ('approval' does not), so a
    // hook may add a reason where the provider named none and may never take
    // that one away.
    const board = [mine([foreman({ waitingReason: 'user-input' })])]
    expect(reasonsOf(stampPermissionPrompts(board, () => true))).toEqual(['user-input'])
  })

  it('invents no dwarf for a session the board does not have', () => {
    expect(stampPermissionPrompts([mine([])], () => true)).toEqual([mine([])])
  })
})

describe('PermissionPromptRegistry', () => {
  it('opens a prompt for the session the notification named', () => {
    const clock = { now: 1_000 }
    const prompts = registry(clock)
    prompts.note(promptEvent('abc'))
    expect(prompts.isOpen('abc')).toBe(true)
    expect(prompts.isOpen('other')).toBe(false)
  })

  it('opens nothing for a notification of another kind', () => {
    const clock = { now: 1_000 }
    const prompts = registry(clock)
    prompts.note({ provider: 'claude', event: 'Notification', sessionId: 'abc' })
    prompts.note({
      provider: 'claude',
      event: 'Notification',
      sessionId: 'abc',
      notificationType: 'idle_prompt'
    })
    expect(prompts.isOpen('abc')).toBe(false)
  })

  it('opens nothing for a notification that named no session', () => {
    const clock = { now: 1_000 }
    const prompts = registry(clock)
    prompts.note(promptEvent())
    expect(prompts.isOpen('abc')).toBe(false)
  })

  it('is unchanged by a second prompt while one is already open', () => {
    const clock = { now: 1_000 }
    const prompts = registry(clock)
    prompts.note(promptEvent('abc'))
    const board = [mine([foreman({ transcriptUpdatedAt: 10 })])]
    prompts.observe(board)
    clock.now += 500
    prompts.note(promptEvent('abc'))
    // The baseline the first prompt recorded still stands, so the same
    // transcript move clears it — a re-fired hook does not restart the clearing.
    prompts.observe([mine([foreman({ transcriptUpdatedAt: 11 })])])
    expect(prompts.isOpen('abc')).toBe(false)
  })

  it.each([['Stop'], ['SessionEnd']] as const)('closes the prompt on %s', (event) => {
    const clock = { now: 1_000 }
    const prompts = registry(clock)
    prompts.note(promptEvent('abc'))
    prompts.note(hook(event))
    expect(prompts.isOpen('abc')).toBe(false)
  })

  it('is not closed by a subagent finishing, which is not this session’s turn', () => {
    const clock = { now: 1_000 }
    const prompts = registry(clock)
    prompts.note(promptEvent('abc'))
    prompts.note(hook('SubagentStop'))
    expect(prompts.isOpen('abc')).toBe(true)
  })

  it('closes only the session whose turn ended', () => {
    const clock = { now: 1_000 }
    const prompts = registry(clock)
    prompts.note(promptEvent('abc'))
    prompts.note(promptEvent('def'))
    prompts.note(hook('Stop', 'abc'))
    expect(prompts.isOpen('abc')).toBe(false)
    expect(prompts.isOpen('def')).toBe(true)
  })

  it('closes the prompt once the transcript moves past what it stood at', () => {
    const clock = { now: 1_000 }
    const prompts = registry(clock)
    prompts.note(promptEvent('abc'))
    prompts.observe([mine([foreman({ transcriptUpdatedAt: 10 })])])
    expect(prompts.isOpen('abc')).toBe(true)
    prompts.observe([mine([foreman({ transcriptUpdatedAt: 10 })])])
    expect(prompts.isOpen('abc')).toBe(true)
    prompts.observe([mine([foreman({ transcriptUpdatedAt: 11 })])])
    expect(prompts.isOpen('abc')).toBe(false)
  })

  it('keeps the prompt open for a provider that stamps no transcript time', () => {
    // Absence of evidence is not evidence: a session whose transcript this app
    // cannot date has only the Stop hook to close its prompt.
    const clock = { now: 1_000 }
    const prompts = registry(clock)
    prompts.note(promptEvent('abc'))
    prompts.observe([mine([foreman()])])
    prompts.observe([mine([foreman()])])
    expect(prompts.isOpen('abc')).toBe(true)
  })

  it('waits for the poll that first draws the session the hook named', () => {
    // The hook can arrive before the board has the session at all, which is
    // the ordinary case for the very first tool call of a fresh session.
    const clock = { now: 1_000 }
    const prompts = registry(clock)
    prompts.note(promptEvent('abc'))
    prompts.observe([mine([])])
    clock.now += UNMATCHED_PROMPT_GRACE_MS - 1
    prompts.observe([mine([foreman({ transcriptUpdatedAt: 10 })])])
    expect(prompts.isOpen('abc')).toBe(true)
  })

  it('forgets a prompt no session on the board ever answered to', () => {
    const clock = { now: 1_000 }
    const prompts = registry(clock)
    prompts.note(promptEvent('abc'))
    clock.now += UNMATCHED_PROMPT_GRACE_MS
    prompts.observe([mine([])])
    expect(prompts.isOpen('abc')).toBe(false)
  })

  it('gives a prompt raised after an earlier one its own baseline', () => {
    const clock = { now: 1_000 }
    const prompts = registry(clock)
    prompts.note(promptEvent('abc'))
    prompts.observe([mine([foreman({ transcriptUpdatedAt: 10 })])])
    prompts.observe([mine([foreman({ transcriptUpdatedAt: 11 })])])
    expect(prompts.isOpen('abc')).toBe(false)

    prompts.note(promptEvent('abc'))
    prompts.observe([mine([foreman({ transcriptUpdatedAt: 11 })])])
    expect(prompts.isOpen('abc')).toBe(true)
    prompts.observe([mine([foreman({ transcriptUpdatedAt: 12 })])])
    expect(prompts.isOpen('abc')).toBe(false)
  })
})
