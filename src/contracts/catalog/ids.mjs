// CATALOG_PROVIDER_IDS: the catalog's provider ids, the one list (05 §2.1 `catalog/ids.mjs`). ESLint's R12
// literal list is derived from it (05 §5.3) and the suppliers catalog reads it (later: ISSUE-143); nobody keeps a
// second copy. Lead decision (2026-09-30): the ids are the found tree's provider registry keys, one per provider
// family of 15 §3 the tree has (Claude, Codex, Antigravity, OpenCode). Appending an id is the whole change a new
// catalog provider needs here.
export const CATALOG_PROVIDER_IDS = Object.freeze(['claude', 'codex', 'antigravity', 'opencode'])
