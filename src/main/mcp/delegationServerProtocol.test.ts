import { describe, expect, it } from 'vitest'
import * as canonical from './delegationProtocol'
import {
  DELEGATE_ROUTE,
  DELEGATION_TOKEN_HEADER,
  MAX_DELEGATION_BODY_BYTES,
  MAX_DELEGATION_CONTEXT_CHARS,
  MAX_DELEGATION_TASK_CHARS,
  NATIVE_SUBAGENT_FALLBACK_SENTENCE,
  RESULT_ROUTE_PREFIX,
  delegationFailure,
  parseDelegateRequestBody
} from './delegationServerProtocol'

/**
 * The server-only twin of `delegationProtocol.ts`'s own runtime vocabulary
 * (#511 T3) — see this module's own top comment for why it exists at all
 * rather than importing `delegationProtocol.ts` directly. This test file's
 * whole job is proving the local copies never silently drift from the
 * canonical ones — a test file is never part of the production build graph,
 * so it is the one place both can be imported together safely.
 */

describe('delegationServerProtocol drift guard', () => {
  it('DELEGATE_ROUTE matches the canonical constant', () => {
    expect(DELEGATE_ROUTE).toBe(canonical.DELEGATE_ROUTE)
  })

  it('DELEGATION_TOKEN_HEADER matches the canonical constant', () => {
    expect(DELEGATION_TOKEN_HEADER).toBe(canonical.DELEGATION_TOKEN_HEADER)
  })

  it('MAX_DELEGATION_TASK_CHARS matches the canonical constant', () => {
    expect(MAX_DELEGATION_TASK_CHARS).toBe(canonical.MAX_DELEGATION_TASK_CHARS)
  })

  it('MAX_DELEGATION_CONTEXT_CHARS matches the canonical constant', () => {
    expect(MAX_DELEGATION_CONTEXT_CHARS).toBe(canonical.MAX_DELEGATION_CONTEXT_CHARS)
  })

  it('NATIVE_SUBAGENT_FALLBACK_SENTENCE matches the canonical constant', () => {
    expect(NATIVE_SUBAGENT_FALLBACK_SENTENCE).toBe(canonical.NATIVE_SUBAGENT_FALLBACK_SENTENCE)
  })

  it('RESULT_ROUTE_PREFIX matches what the canonical resultRoute() builds on', () => {
    expect(canonical.resultRoute('abc')).toBe(`${RESULT_ROUTE_PREFIX}abc`)
  })

  it('delegationFailure produces the exact same shape as the canonical function', () => {
    expect(delegationFailure('jev-unreachable', 'reason')).toEqual(
      canonical.delegationFailure('jev-unreachable', 'reason')
    )
  })
})

describe('parseDelegateRequestBody', () => {
  it('round-trips a task with no context', () => {
    expect(parseDelegateRequestBody({ task: 'find the bug' })).toEqual({ task: 'find the bug' })
  })

  it('round-trips a task with context', () => {
    const body = { task: 'find the bug', context: 'it started after #511' }
    expect(parseDelegateRequestBody(body)).toEqual(body)
  })

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['missing task', { context: 'x' }],
    ['empty task', { task: '' }],
    ['wrong task type', { task: 5 }],
    ['task over the character bound', { task: 'x'.repeat(MAX_DELEGATION_TASK_CHARS + 1) }],
    ['wrong context type', { task: 'x', context: 5 }],
    [
      'context over the character bound',
      { task: 'x', context: 'y'.repeat(MAX_DELEGATION_CONTEXT_CHARS + 1) }
    ]
  ])('returns undefined for %s', (_label, json) => {
    expect(parseDelegateRequestBody(json)).toBeUndefined()
  })

  it('accepts a task and a context each exactly at their own character bound', () => {
    const body = {
      task: 'x'.repeat(MAX_DELEGATION_TASK_CHARS),
      context: 'y'.repeat(MAX_DELEGATION_CONTEXT_CHARS)
    }
    expect(parseDelegateRequestBody(body)).toEqual(body)
  })
})

describe('MAX_DELEGATION_BODY_BYTES', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(MAX_DELEGATION_BODY_BYTES)).toBe(true)
    expect(MAX_DELEGATION_BODY_BYTES).toBeGreaterThan(0)
  })
})
