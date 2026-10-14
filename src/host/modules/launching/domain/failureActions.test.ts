import { describe, expect, it } from 'vitest'
import { failureActions } from './failureActions'

describe('failureActions (ADR-020 items 1–2)', () => {
  it('[US-LAUNCH-006.AC08] not-installed, exited-at-once and could-not-start allow Retry only, never Pick manually', () => {
    for (const cause of ['not-installed', 'exited-at-once', 'could-not-start'] as const) {
      expect(failureActions(cause)).toEqual(['retry'])
    }
  })

  it('[S5.14, S5.15] jev-unreachable allows Retry and Pick manually, jev-could-not-choose Pick manually only, and nothing with no-launchable-provider', () => {
    expect(failureActions('jev-unreachable', 'timeout')).toEqual(['retry', 'pick-manually'])
    expect(failureActions('jev-could-not-choose', 'no-key')).toEqual(['pick-manually'])
    expect(failureActions('jev-could-not-choose', 'no-launchable-provider')).toEqual([])
  })
})
