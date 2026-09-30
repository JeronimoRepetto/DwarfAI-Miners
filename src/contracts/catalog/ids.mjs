// CATALOG_PROVIDER_IDS: the catalog's provider ids, the one list (05 §2.1 `catalog/ids.mjs`). ESLint's R12
// literal list is derived from it (05 §5.3) and the suppliers catalog reads it (later: ISSUE-143); nobody keeps a
// second copy. Lead decision (2026-09-30): one id per provider family the found tree has, the first four being its
// provider registry keys (Claude, Codex, Antigravity, OpenCode), then the simulated provider.
// The list is append-only data: never reorder or remove an id; a new catalog provider is one appended entry.
export const CATALOG_PROVIDER_IDS = Object.freeze([
  'claude',
  'codex',
  'antigravity',
  'opencode',
  // SimulatedDriver (15 §4.12): the deterministic demo world, development builds only.
  'simulated'
])
