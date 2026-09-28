import { describe, expect, it } from 'vitest'
import { defaultDwarf } from '../../testing/factories'
import { dwarfDisplayName } from './displayName'

// The name a view shows for a dwarf (#635; decision log, Dwarf names).
describe('dwarfDisplayName', () => {
  it('is the custom name a person gave the dwarf, where there is one', () => {
    expect(dwarfDisplayName(defaultDwarf({ name: 'dwarfai-55', customName: 'Watcher' }))).toBe(
      'Watcher'
    )
  })

  it('is the base name otherwise', () => {
    expect(dwarfDisplayName(defaultDwarf({ name: 'dwarfai-55' }))).toBe('dwarfai-55')
  })
})
