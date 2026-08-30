import { describe, expect, it } from 'vitest'
import { versionLabel, versionTitle } from './appBuild'

/*
 * Issue #79. The maintainer had a packaged 0.3.0 and a dev build of the same
 * checkout running on one machine, could not explain a behaviour, and guessed
 * he was on an old version. He was not — he was on the other build. So the two
 * facts the label carries are the number AND which of the two is speaking, and
 * the invariant below is the whole feature: one version, two builds, never the
 * same string.
 */
describe('versionLabel', () => {
  it('prints an installed build bare, exactly as the installer names it', () => {
    // The bug-report template asks for the version "from the installer
    // filename" and shows 0.2.1 — bare, no `v`. A reporter must be able to
    // copy what the panel prints straight into that field.
    expect(versionLabel({ version: '0.3.0', packaged: true })).toBe('0.3.0')
  })

  it('marks a build run from a checkout', () => {
    expect(versionLabel({ version: '0.3.0', packaged: false })).toBe('0.3.0-dev')
  })

  it('never prints one string for both builds of the same version', () => {
    // The incident itself: two builds of 0.3.0 on one machine. A label that
    // reads identically for both answers the question it was added to answer
    // with the same wrong confidence the maintainer already had.
    const version = '0.3.0'
    expect(versionLabel({ version, packaged: true })).not.toBe(
      versionLabel({ version, packaged: false })
    )
  })

  it('prints whatever main reported, without parsing or reformatting it', () => {
    // app.getVersion() reads a package.json this app does not own at runtime;
    // a prerelease or a hand-edited value must survive to the panel intact
    // rather than be normalised into a number that looks tidier and is not
    // the one on the executable.
    expect(versionLabel({ version: '1.0.0-rc.2', packaged: true })).toBe('1.0.0-rc.2')
  })
})

describe('versionTitle', () => {
  it('names an installed build in words', () => {
    expect(versionTitle({ version: '0.3.0', packaged: true })).toBe('Version 0.3.0 (installed)')
  })

  it('spells out what the -dev suffix means', () => {
    // The suffix is five characters and the panel has room for none more, so
    // the sentence that makes it unambiguous lives in the hover line — the
    // same place the pin and the gear put theirs.
    expect(versionTitle({ version: '0.3.0', packaged: false })).toBe(
      'Version 0.3.0 (development build, run from a checkout)'
    )
  })
})
