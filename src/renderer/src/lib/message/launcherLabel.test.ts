import { describe, expect, it } from 'vitest'
import { defaultDwarf, defaultMine } from '../../testing/factories'
import { launcherIssuerOf, launcherLabel } from './launcherLabel'

// The launcher label of a delegated worker's brief (US-DLG-003; PO decision 2026-09-28 #53;
// AMENDMENT-23): the Host names the launcher by its id, and the label reads it as the board has it.
describe('launcherIssuerOf', () => {
  const launcher = defaultDwarf({ id: 'dwarf-parent', role: 'foreman', name: 'dwarfai-12' })
  const board = (customName?: string) => [
    defaultMine({
      dwarfs: [
        defaultDwarf({ id: 'dwarf-worker' }),
        { ...launcher, ...(customName === undefined ? {} : { customName }) }
      ]
    })
  ]

  it('[US-DLG-003.AC03] names the launcher by its custom name when one is set, else its base name, keeping its id', () => {
    expect(launcherIssuerOf('dwarf-parent', board('Borin'))).toEqual({
      role: 'foreman',
      name: 'Borin',
      launcherId: 'dwarf-parent'
    })
    expect(launcherIssuerOf('dwarf-parent', board())).toEqual({
      role: 'foreman',
      name: 'dwarfai-12',
      launcherId: 'dwarf-parent'
    })
  })

  it('[US-DLG-003.AC03] is undefined for a launcher the board does not hold', () => {
    expect(launcherIssuerOf('dwarf-gone', board())).toBeUndefined()
  })
})

describe('launcherLabel', () => {
  it('[US-DLG-003.AC04] reads "from <dwarf>"', () => {
    expect(launcherLabel({ name: 'Borin' })).toBe('from Borin')
  })
})
