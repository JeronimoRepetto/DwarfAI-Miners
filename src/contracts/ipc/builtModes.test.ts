// layer: L1
import { describe, expect, it } from 'vitest'
import { BUILD_PROFILES, builtModesOf } from './builtModes'

describe('the built-modes list (17 §1.9; ADR-034 item 2; BR-19; ISSUE-267, ISSUE-285)', () => {
  // AMENDED for ISSUE-294 (was: a release build lists the Panel alone): ADR-034 item 2 ships Veta after the Panel, and
  // ISSUE-294 is the issue that adds it to the release list.
  // AMENDED for ISSUE-311 (was: a release build lists the Panel and Veta; only the E2E build profile adds Valle): once
  // Valle ships every mode is shown (ADR-034 item 2; BR-19), so both profiles list the three modes.
  it('[ADR-034, BR-19] a release build lists every mode: the Panel, Veta and Valle', () => {
    expect(builtModesOf('release')).toEqual(['panel', 'veta', 'valle'])
    expect(builtModesOf('e2e')).toEqual(['panel', 'veta', 'valle'])
    // Any other value, or none at all, is a release build: a mode never reaches a person by a misspelt profile.
    for (const profile of [undefined, '', 'E2E', 'dev', 'veta']) {
      expect(builtModesOf(profile), String(profile)).toEqual(['panel', 'veta', 'valle'])
    }
    expect(Object.keys(BUILD_PROFILES).sort()).toEqual(['e2e', 'release'])
  })

  // AMENDED for ISSUE-311 (was: a release build lists the Panel and Veta, never Valle): Valle ships with ISSUE-311
  // (ADR-034 item 2), so a release build, and a build with no profile, now contains it.
  it('[ADR-034, BR-19] a release build lists the Panel, Veta and Valle', () => {
    expect(BUILD_PROFILES.release).toContain('panel')
    expect(BUILD_PROFILES.release).toContain('veta')
    expect(BUILD_PROFILES.release).toContain('valle')
    expect(builtModesOf(undefined)).toContain('valle')
  })
})
