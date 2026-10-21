// layer: L1
import { describe, expect, it } from 'vitest'
import { BUILD_PROFILES, builtModesOf } from './builtModes'

describe('the built-modes list (17 §1.9; ADR-034 item 2; BR-19; ISSUE-267, ISSUE-285)', () => {
  it('[ADR-034, BR-19] a release build lists the Panel alone; only the E2E build profile adds Veta and Valle', () => {
    expect(builtModesOf('release')).toEqual(['panel'])
    expect(builtModesOf('e2e')).toEqual(['panel', 'veta', 'valle'])
    // Any other value, or none at all, is a release build: a mode never reaches a person by a misspelt profile.
    for (const profile of [undefined, '', 'E2E', 'dev', 'veta']) {
      expect(builtModesOf(profile), String(profile)).toEqual(['panel'])
    }
    expect(Object.keys(BUILD_PROFILES).sort()).toEqual(['e2e', 'release'])
  })
})
