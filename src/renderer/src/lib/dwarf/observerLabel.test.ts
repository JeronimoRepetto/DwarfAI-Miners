import { describe, expect, it } from 'vitest'
import { DWARF_PROVIDERS, PANEL_OBSERVER } from '../../types'
import { HOSTED_OBSERVER_LABEL, observerLabel } from './observerLabel'

describe('observerLabel', () => {
  it('calls a provider by its own name', () => {
    for (const provider of DWARF_PROVIDERS) {
      expect(observerLabel(provider)).toBe(provider)
    }
  })

  /*
   * The wire value is 'panel', which names the OBSERVER precisely and reads
   * wrongly on screen: a person looking at a tooltip wants to know what this
   * dwarf is, and "panel" describes who is watching it. 'hosted' says the
   * useful half — this is a program this app is running, not a CLI it found.
   */
  it('calls a process this panel holds hosted, not panel', () => {
    expect(observerLabel(PANEL_OBSERVER)).toBe(HOSTED_OBSERVER_LABEL)
    expect(observerLabel(PANEL_OBSERVER)).not.toBe(PANEL_OBSERVER)
  })

  it('never claims a hosted process is one of the known providers', () => {
    expect(DWARF_PROVIDERS).not.toContain(observerLabel(PANEL_OBSERVER))
  })
})
