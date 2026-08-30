import { emptyMaterialTotals } from '../lib/vault'
import type { Dwarf, MaterialTotals, Mine } from '../types'

/**
 * Deterministic material breakdown for renderer tests: every material at zero
 * unless the test names one, exactly as the wire always carries it.
 */
export function defaultMaterials(overrides: Partial<MaterialTotals> = {}): MaterialTotals {
  return { ...emptyMaterialTotals(), ...overrides }
}

/** Deterministic dwarf fixture for renderer tests. */
export function defaultDwarf(overrides: Partial<Dwarf> = {}): Dwarf {
  return {
    id: 'dwarf-1',
    provider: 'claude',
    role: 'worker',
    name: 'Sample Worker',
    model: 'test-model',
    effort: 'medium',
    status: 'working',
    sessionId: 'session-1',
    ...overrides
  }
}

/** Deterministic mine fixture for renderer tests. */
export function defaultMine(overrides: Partial<Mine> = {}): Mine {
  return {
    id: 'C:/dev/sample',
    path: 'C:/dev/sample',
    name: 'sample',
    tier: 'bronze',
    dwarfs: [],
    tokensObserved: 0,
    // Stamped by default because main always stamps it: a Mine reaching the
    // panel without a breakdown is not a state the renderer has to handle.
    materials: defaultMaterials(),
    updatedAt: 0,
    ...overrides
  }
}
