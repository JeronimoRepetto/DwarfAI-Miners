import { describe, expect, it } from 'vitest'
import { describeEffort } from './effort'

describe('describeEffort', () => {
  it.each([
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
    ['xhigh', 'Extra high'],
    ['max', 'Max']
  ])('normalizes Claude effort %s to %s', (raw, label) => {
    expect(describeEffort('claude', raw)).toBe(label)
  })

  it('passes an unrecognized Claude value through as-is', () => {
    expect(describeEffort('claude', 'ultra')).toBe('ultra')
  })

  it("passes Codex's reasoning_effort values through unchanged", () => {
    expect(describeEffort('codex', 'medium')).toBe('medium')
    expect(describeEffort('codex', 'high')).toBe('high')
  })

  it('reports unknown when no effort was observed at all', () => {
    expect(describeEffort('claude', undefined)).toBe('unknown')
    expect(describeEffort('codex', undefined)).toBe('unknown')
  })
})
