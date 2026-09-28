import type { Dwarf } from '../../types'

/**
 * The name a view shows for a dwarf (#635; decision log, Dwarf names): the custom name a person
 * gave it, which replaces the base name everywhere the app names the dwarf, or the base name
 * while it has none. DISPLAY ONLY, as `Dwarf.customName` is: anything bound for a provider, a
 * relay or a log reads `name` itself.
 */
export function dwarfDisplayName(dwarf: Pick<Dwarf, 'name' | 'customName'>): string {
  return dwarf.customName ?? dwarf.name
}
