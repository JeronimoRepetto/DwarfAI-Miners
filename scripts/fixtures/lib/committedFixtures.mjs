/**
 * The privacy check of the committed `fixtures/` tree (17 §1.4 "Redaction", §5.2 privacy guard;
 * ADR-008, ADR-026). Pure: it takes the tracked files as `{ path, text }` (binary files left out by
 * the caller) and returns one violation per file and rule:
 *
 * - `raw-capture`: a recorder's raw capture (`*.raw.*`) is committed (17 §1.4 recording step 3);
 * - `meta-json`, `meta-fields`, `scrubbed`, `captured-by-role`: a provider fixture folder's
 *   `meta.json` is not a scrubbed record with a role as `capturedBy` (the layout check's rules);
 * - `secret`: a line of a provider fixture matches an ADR-026 secret pattern or holds a bearer
 *   token.
 *
 * The secret scan covers the provider fixture folders (`fixtures/<provider>/<driver>/<version>/`),
 * the recorder's output. The hand-written DB ladder (`db/`) and stub kit (`bin/`) hold values the
 * deliberately lossy ADR-026 rules cannot tell from a token (a migration's SHA-256 checksum, a Codex
 * rollout file name); they are reviewed in their own lanes and grepped by the CI privacy guard.
 *
 * It never returns the matched value, so its result can be printed.
 */
import { metaProblems } from '../../checks/fixtures-layout.mjs'
import { findSecrets } from './scrubRules.mjs'

/** Top-level folders of `fixtures/` that hold no provider fixture (`fixtures/README.md`). */
const NON_PROVIDER_FOLDERS = new Set(['bin', 'db', 'ipc'])
const RAW_CAPTURE = /\.raw\./

/**
 * @param {{ path: string, text: string }[]} files repository-relative posix paths under `fixtures/`
 * @returns {{ file: string, rule: string }[]} sorted by file, then rule
 */
export function checkCommittedFixtures(files) {
  const violations = []
  for (const { path: file, text } of files) {
    const segments = file.split('/')
    const name = segments.at(-1)
    if (RAW_CAPTURE.test(name)) violations.push({ file, rule: 'raw-capture' })
    const providerFixture = segments.length >= 5 && !NON_PROVIDER_FOLDERS.has(segments[1])
    if (name === 'meta.json' && providerFixture) {
      const rules = new Set(metaProblems(text).map(([rule]) => rule))
      for (const rule of rules) violations.push({ file, rule })
    }
    if (providerFixture && findSecrets(text).length > 0) violations.push({ file, rule: 'secret' })
  }
  return violations.sort((a, b) =>
    a.file === b.file ? a.rule.localeCompare(b.rule) : a.file < b.file ? -1 : 1
  )
}
