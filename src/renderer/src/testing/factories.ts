import type { Dwarf, Mine } from '../types'

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
    updatedAt: 0,
    ...overrides
  }
}
