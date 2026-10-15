import { describe, expect, it } from 'vitest'
import { supplierLabel } from './supplierLabel'

describe('supplierLabel (US-LAUNCH-006)', () => {
  it("[US-LAUNCH-006.AC10] the label is the chip's own label, The custom command for Other, or The supplier when none was chosen", () => {
    expect(supplierLabel({ checked: { kind: 'chip', label: 'Codex CLI' } })).toBe('Codex CLI')
    expect(supplierLabel({ checked: { kind: 'custom-command' } })).toBe('The custom command')
    expect(supplierLabel({ checked: null })).toBe('The supplier')
  })

  it("[US-LAUNCH-006.AC11] with Jev on the label is Jev's pick unless the person changed it, and the supplier Jev was about to pick when Jev is the cause", () => {
    const jevPick = { kind: 'chip', label: 'Claude Code' } as const
    const personPick = { kind: 'chip', label: 'OpenCode' } as const

    expect(
      supplierLabel({ checked: jevPick, jev: { pick: jevPick, changedByPerson: false } })
    ).toBe('Claude Code')
    expect(
      supplierLabel({ checked: personPick, jev: { pick: jevPick, changedByPerson: true } })
    ).toBe('OpenCode')
    // Jev is the cause and had not answered: nothing is checked yet, the label is its intended pick
    expect(supplierLabel({ checked: null, jev: { pick: jevPick, changedByPerson: false } })).toBe(
      'Claude Code'
    )
    expect(supplierLabel({ checked: null, jev: { pick: null, changedByPerson: false } })).toBe(
      'The supplier'
    )
  })
})
