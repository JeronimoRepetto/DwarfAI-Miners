```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:7e40b6555dd79fe2a07fb25ce181ac9c83c9d3f717cd01cd0e0d802d3b31f037
verdict: pass
blockers: 0
critical_findings: 0
requirements: 17/17
scenarios: 39/39
test_command: node node_modules/vitest/vitest.mjs run src/main/config/configFile.test.ts src/main/providers/pathPortability.test.ts src/main/providers/opencode src/renderer/src/lib/delivery/actionBar.test.ts src/main/domain/launchProviders.test.ts
test_exit_code: 0
test_output_hash: sha256:dccd7521a39c6ed2575b9749d5cf3863db62f9a5e84e1cf9cb2fdd256a7b6e46
build_command: node node_modules/electron-vite/bin/electron-vite.js build
build_exit_code: 0
build_output_hash: sha256:bada3180cedcdc084c5143c7cadbefb41621914f9afbaf32e77d7c937da70e3d
```

## Final verification for archive (#453, HEAD 1eface17fb6436e8f7964695c0adcd428b735cf0) - 2026-09-17

**Scope**: bounded, final re-verification of the six Follow-up #453 commits (`16f07d3`, `2021d6e`,
`deb9b66`, `bd747a1`, `cefc836`, `1eface1`) in a dedicated worktree
(`agent-name-worktrees/observer-453`, branch `fix/opencode-observer-verify-exceptions`), on top of
`origin/main` `f61c6ed` -- which already carries the merged PR #452 through `aa1e982`, i.e. both prior
remediation rounds. `evidence_revision` is the SHA-256 over the exact bytes of
`git diff origin/main...HEAD`: the follow-up's own patch (9 files, +300/-15 -- 5 test files, 1
production comment-only file, 2 openspec docs, 1 spec.md amendment), not the whole change. Every
line item below was checked directly against source (`git show`, direct file reads of the current
implementation) and by re-running the named tests myself in this worktree; nothing here is taken on
the apply report's word alone.

### Per-item verification

| Item                                           | Commit    | Test (file > title)                                                                                                                           | Verified by                                                                                                                                                                            | Result                              |
| ---------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| SUGGESTION 1 (DET-R1, blank-env-over-file)     | `16f07d3` | `configFile.test.ts > does not let a blank OPENCODE_STORE_ROOT mask the file value`                                                           | Read `withConfigFileFallback`'s blank-over-file guard (`configFile.ts:44-51`); re-ran the test                                                                                         | PASS                                |
| SUGGESTION 2 (DET-R1, OS-invariant expansion)  | `2021d6e` | `pathPortability.test.ts > expands the default OpenCode store root identically, given a fixed home`                                           | Read `expandHomePath`/`defaultConfig` (`runtime.ts:531-537`, `config.ts:236-239`); confirmed no `Platform` value is read anywhere under `src/main/providers/opencode`; re-ran the test | PASS, see note below tables         |
| SUGGESTION 3 (DET-R2, `snapshot.cwd`)          | `deb9b66` | `opencodeProvider.test.ts > appears within one scan` (assertion added)                                                                        | Read the scan loop's `cwd = normalize(session.cwd)` and the `cwd,` field in the published snapshot (`opencodeProvider.ts:197-198,256`); re-ran the test                                | PASS                                |
| WARNING 4 (mutation-tested promotion test)     | `deb9b66` | `opencodeProvider.test.ts > promotes a middle-tier worker to foreman once it becomes a parent itself, without losing its own parentId`        | Read `roleOf`/`parentSessions` (`opencodeProvider.ts:176,273-276`) and independently confirmed the deviation (see below); re-ran the test                                              | PASS, deviation judged CORRECT      |
| SUGGESTION 5 (DET-R6, panel actions)           | `bd747a1` | `actionBar.test.ts > observed OpenCode dwarf (DET-R6)` (3 cases)                                                                              | Read `kickAction` (`actionBar.ts`) and `DwarfCapabilities.cancel`'s doc comment (`contracts.ts`); re-ran the tests                                                                     | PASS, spec amendment judged CORRECT |
| WARNING 5 (stale `NOT_LAUNCHABLE` doc comment) | `cefc836` | `launchProviders.test.ts > pins that a detected OpenCode is marked installed but not launchable, with NOT_LAUNCHABLE as its reason` (renamed) | Read the rewritten comment in `launchProviders.ts`; re-ran the test                                                                                                                    | PASS                                |
| Tasks/apply-progress bookkeeping               | `1eface1` | N/A -- docs only                                                                                                                              | Confirmed R7-R13 all checked in `tasks.md`; confirmed zero unchecked task lines remain anywhere in the file                                                                            | PASS                                |

Independently re-run in this worktree (not copied from the apply report):

- `node node_modules/vitest/vitest.mjs run src/main/config/configFile.test.ts src/main/providers/pathPortability.test.ts src/main/providers/opencode src/renderer/src/lib/delivery/actionBar.test.ts src/main/domain/launchProviders.test.ts`
  -> 9 test files, 183 tests, 0 failed, exit 0.
- `node node_modules/electron-vite/bin/electron-vite.js build` -> exit 0, all three targets built
  (built in under 1 second, no errors).
- `node skills/test-safety/assets/test-census.mjs --base origin/main` -> net +6 across 5 files,
  0 lost, exit 0 -- reproduces `apply-progress.md`'s own census table exactly.

`permissionSummary.test.ts` (WARNING 3's fix) and `feedWindow.test.ts`/`config.test.ts` (other
pre-existing FEED-R2/FEED-R3/DET-R1 evidence) were not re-run in this pass: `git diff --stat
origin/main...HEAD` shows the follow-up touched none of their production sources, so the prior
re-verification's evidence for them (HEAD `aa1e982`, same underlying code) stands unchanged.

### Deviations -- verdict

- **(a) WARNING 4's proposed mutation target.** Judged CORRECT. `roleOf(sessionId,
parentSessionId)` (`opencodeProvider.ts:273-276`) returns `'foreman'` when EITHER
  `parentSessions.has(sessionId)` OR `parentSessionId === undefined`. Every pre-existing topology
  fixture's foreman session carries no `parentSessionId` of its own, so the second branch alone
  already answers `'foreman'` for all 27 pre-existing cases regardless of what the `parentSessions`
  set (populated at line 176) holds -- confirmed directly by reading both call sites, not only by
  trusting the apply report's mutation run. The new "promotes a middle-tier worker" test is the only
  case in the file where the session under test HAS its own `parentSessionId` (so it starts from the
  `'worker'` branch) and is simultaneously somebody else's parent -- exactly the condition line 176
  exists to decide. The substitute test is the right one and is genuinely load-bearing.
- **(b) DET-R6's spec correction.** Judged CORRECT. `kickAction` (`actionBar.ts`) never returns
  `NO_CHANNEL_REASON`: when `channel` (i.e. `dwarf.capabilities?.cancel`) is `null`, it returns
  `DISMISS_HINT`, `ENDED_DISMISS_HINT`, or `OPEN_TURN_NO_INTERRUPT_HINT` depending on `ended`/
  `openTurn` -- `NO_CHANNEL_REASON` belongs to `chatAction` alone. `DwarfCapabilities.cancel`'s own
  doc comment in `contracts.ts` states, in its own "AMENDED for #293" note: null means nothing can
  INTERRUPT this session, and no longer that the Kick control is dead, it decides WHICH kick to
  offer -- precisely the fact the follow-up used to correct the scenario. The old scenario text
  ("Send and Kick are disabled with `NO_CHANNEL_REASON`") was stale and predates #293; the amendment
  is accurate, and the three new tests exercise the corrected clause specifically for
  `provider: 'opencode'` rather than only through the generic `PANEL_OBSERVER` case.

### Coverage totals -- all four specs, as they stand after the spec.md amendment

#### opencode-store-evidence -- 8/8 complete (unchanged by #453; inspection-based by design, no test layer for this capability)

| Req   | Scenario                                                     | Evidence                                                                             | Result     |
| ----- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------- |
| SE-R1 | A claim carried over from exploration without being observed | `docs/opencode-format.md` V/I legend; no I-marked key read by `parse.ts`/`state.ts`  | PASS       |
| SE-R1 | Build changes under the fixtures later                       | `docs/opencode-format.md` version stamp (build, date, host OS)                       | PASS       |
| SE-R2 | The measured install wrote SQLite only                       | Fixture set (DDL + row fixtures + unknown-schema DB, no JSON tree) + `state.test.ts` | PASS       |
| SE-R2 | A row set is captured before any session has run             | N/A -- GIVEN never held; row set was captured from a real turn                       | PASS (N/A) |
| SE-R2 | A captured value carries a machine identifier                | Fixture scrub + fingerprint re-check (Remediation, `0569e53`)                        | PASS       |
| SE-R3 | A row comes back negative                                    | `docs/opencode-format.md` row 10 negative + spec amendment (task 1.11)               | PASS       |
| SE-R3 | The native Windows binary misbehaves                         | `docs/opencode-format.md:121-129` records both paths                                 | PASS       |
| SE-R4 | A parser is attempted from the exploration document alone    | Commit order: evidence/fixtures precede the parser                                   | PASS       |

#### opencode-session-detection -- 14/14 complete (4 closed by #453)

| Req    | Scenario                                            | Test                                                                                                                                                          | Result          |
| ------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| DET-R1 | All three layers are present                        | `configFile.test.ts > does not let a blank OPENCODE_STORE_ROOT mask the file value` (#453) + pre-existing env-wins/file-only cases                            | PASS            |
| DET-R1 | The default shape is the same on every OS           | `pathPortability.test.ts > expands the default OpenCode store root identically, given a fixed home` (#453) + static: no `Platform` param exists to vary by OS | PASS (see note) |
| DET-R2 | The measured store shape                            | `opencodeProvider.test.ts > appears within one scan` (`snapshot.cwd` assertion, #453)                                                                         | PASS            |
| DET-R2 | Legacy JSON tree and no database                    | `opencodeProvider.test.ts > returns no snapshots and does not throw when no store exists` + static: `store.ts` never lists a directory                        | PASS            |
| DET-R3 | Machine without OpenCode installed                  | `opencodeProvider.test.ts > returns no snapshots and does not throw when no store exists`                                                                     | PASS            |
| DET-R3 | Database with an unknown schema                     | `opencodeProvider.test.ts > returns no snapshots and does not throw against an unknown schema` + `state.test.ts` (x4)                                         | PASS            |
| DET-R4 | Database mtime frozen while the session works       | `opencodeProvider.test.ts > is working when only event.seq advanced since the previous poll`                                                                  | PASS            |
| DET-R4 | An assistant message is still streaming             | `opencodeProvider.test.ts > is working while the newest assistant message lacks time.completed`                                                               | PASS            |
| DET-R4 | A turn stops between tool calls                     | `opencodeProvider.test.ts > is still working after a completed intermediate step (finish: tool-calls)`                                                        | PASS            |
| DET-R4 | The turn finishes                                   | `opencodeProvider.test.ts > turns waiting once time.completed is set with finish: stop` + `> never reports ... waiting`                                       | PASS            |
| DET-R4 | Session quits and goes stale                        | `opencodeProvider.test.ts > drops a frozen session even while another session keeps the store WAL hot` (Remediation, `c690273`)                               | PASS            |
| DET-R5 | A finished turn with token columns filled           | `opencodeProvider.test.ts > never puts tokens or cost on the wire, even once a finished turn fills those columns` (Remediation 2, `86a53e3`)                  | PASS            |
| DET-R6 | Panel offers actions for an observed OpenCode dwarf | `actionBar.test.ts > observed OpenCode dwarf (DET-R6)`, 3 cases (#453) + `specs/opencode-session-detection/spec.md` amended                                   | PASS            |
| DET-R6 | Add Panel shows OpenCode                            | `launchProviders.test.ts > pins that a detected OpenCode is marked installed but not launchable, with NOT_LAUNCHABLE as its reason`                           | PASS            |

See the note below the tables on DET-R1's OS-invariance evidence.

#### opencode-session-feed -- 8/8 complete (unchanged by #453)

| Req     | Scenario                                                  | Test                                                                                                                        | Result |
| ------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| FEED-R1 | Session has replied at least once                         | `opencodeProvider.test.ts > carries the newest assistant text as lastMessage, absent when none exists`                      | PASS   |
| FEED-R1 | Session has not replied yet                               | Same test, strengthened with `expect(noReplyYet).toHaveLength(1)` (Remediation 2, `86a53e3`)                                | PASS   |
| FEED-R2 | Unknown dwarf id                                          | `opencodeProvider.test.ts > returns null from feed and feedPage for an id the latest scan does not know`                    | PASS   |
| FEED-R2 | The session row was deleted between the scan and the read | `opencodeProvider.test.ts > answers feed [] and feedPage an empty reachedStart page when the store vanished after the scan` | PASS   |
| FEED-R2 | Paging older than the panel's oldest row                  | `opencodeProvider.test.ts > redacts a secret in a feed row...` (2nd half) + `feedWindow.test.ts`                            | PASS   |
| FEED-R3 | A secret appears in a user turn                           | `opencodeProvider.test.ts > redacts a secret in a feed row, and a cursor built from the redacted row still matches`         | PASS   |
| FEED-R3 | A cursor names a row that contained a secret              | Same test + `feedWindow.test.ts > cursorIndex... > resolves a cursor against rows already redacted`                         | PASS   |
| FEED-R4 | A terminal tail is requested for an OpenCode dwarf        | `opencodeProvider.test.ts > never returns a transcriptPath and never offers a delivery channel`                             | PASS   |

#### opencode-session-topology -- 9/9 complete (unchanged by #453 except the renamed pin)

| Req     | Scenario                                                     | Test                                                                                                                                                                                       | Result |
| ------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| TOPO-R1 | Row 4 positive -- a subagent is spawned                      | `opencodeProvider.test.ts > pins that a child ranks below the root and the parent shows foreman -- the measured row-4 pair` (renamed, #453)                                                | PASS   |
| TOPO-R1 | A root session whose assistant messages carry a reply edge   | `parse.test.ts > never surfaces message.data.parentID as a parent -- it is a reply edge, not topology` + `opencodeProvider.test.ts > publishes a null parent_id session as a root foreman` | PASS   |
| TOPO-R1 | Row 4 closed positive -- a Task subagent populates the field | Same measured-pair test + `docs/opencode-format.md:95-112`                                                                                                                                 | PASS   |
| TOPO-R1 | A parent edge points at a session this scan did not see      | `opencodeProvider.test.ts > publishes a child whose parent is absent from the store, inventing no parent`                                                                                  | PASS   |
| TOPO-R2 | Worker beside foreman                                        | `opencodeProvider.test.ts > pins that a child ranks below the root...` (child worker, parent foreman)                                                                                      | PASS   |
| TOPO-R2 | The crew finishes                                            | `opencodeProvider.test.ts > keeps a foreman rank after its crew has gone home`                                                                                                             | PASS   |
| TOPO-R3 | Unproven root                                                | `opencodeProvider.test.ts > keeps a root (foreman) dwarf past the short window, up to the long one`                                                                                        | PASS   |
| TOPO-R3 | A child session's window                                     | `opencodeProvider.test.ts > drops a worker (parent_id set) past the short window`                                                                                                          | PASS   |
| TOPO-R3 | Nothing records a decision from unknown                      | `opencodeProvider.test.ts > reports unknown attendance, as D4 and task 3.6 both state (#444)` (Remediation 2, `86a53e3`)                                                                   | PASS   |

**Totals: 17/17 requirements, 39/39 scenarios -- every scenario evidenced by a passing test, except
`opencode-store-evidence`'s 8, which are evidenced by direct inspection of committed artifacts, as
recorded by design since no test layer exists for that capability (`tasks.md` PR 1 header).**

**Note on DET-R1's "The default shape is the same on every OS" evidence (marked "PASS (see note)" above).** The new test
runs `expandHomePath`/`node:path.join` once, on whichever host actually runs the suite (Windows, in
this pass) -- it does not literally invoke a win32/darwin/linux build three times and compare the
three outputs, because no such per-OS builder exists: `expandHomePath` and `defaultConfig` take no
`Platform` parameter at all, confirmed by searching across `src/main/providers/opencode` (unchanged
from the first pass). Given the code has zero OS-conditional branches, there is no possible per-host
variance for three separate invocations to expose; the one thing the previous PARTIAL actually
lacked -- proof that the literal expansion (not just the unexpanded default string) resolves
correctly -- is what the new test now supplies. This is judged sufficient to close the scenario, but
it is a narrower proof than "run for three platforms" reads literally as, and is recorded here rather
than silently rounded up to an unqualified pass.

### Residual, non-blocking items (out of #453's stated scope, never closed by this batch)

These were never claimed closed by Follow-up #453 and remain open exactly as the first pass left
them -- SUGGESTION-level coverage polish, never CRITICAL/WARNING, and none of them corresponds to an
UNTESTED scenario in the totals above:

- SUGGESTION 6 -- `FEED-R3`'s `lastMessage` field specifically (not just `feed()`/`feedPage()` rows)
  has no dedicated redaction test; the Requirement's prose names it but the two enumerated scenarios
  only exercise `feed()` rows, so this is a requirement-level polish note, not a scenario gap.
- SUGGESTION 7 -- `runtime.test.ts:5268`'s `not.toHaveBeenCalledWith('opencode')` could be
  strengthened to `not.toHaveBeenCalled()`.
- SUGGESTION 8 -- the change shipped as one ~1,900-line PR against D9's four-PR forecast; already
  accepted as exception-ok/size:exception by the apply run.

### Validator run

`gentle-ai sdd-verify-validate --input openspec/changes/opencode-observer/verify-report.md
--requirements 17 --scenarios 39` -- output recorded verbatim below this line.

```json
{
  "valid": true,
  "verdict": "pass",
  "evidence_revision": "sha256:7e40b6555dd79fe2a07fb25ce181ac9c83c9d3f717cd01cd0e0d802d3b31f037"
}
```

### Final verdict

PASS. Zero CRITICAL, zero WARNING, zero GAP, zero FAILING. All 17 requirements and all 39 scenarios
across the four specs are now evidenced by a passing test (or, for `opencode-store-evidence`, by
direct inspection as recorded by design). Both stated deviations (WARNING 4's mutation target,
DET-R6's spec correction) were independently re-derived from source in this pass and judged correct,
not merely restated from the apply report. Three non-blocking SUGGESTIONs remain open, out of scope
for #453 and not affecting the 17/17 / 39/39 counts above. This change is archive-ready.

---

```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:653e476a0773d38546bda2cd9ce9eed7d4785f4f5f42cdb985a21a07fe17a4e7
verdict: fail
blockers: 0
critical_findings: 0
requirements: 14/17
scenarios: 35/39
test_command: pnpm exec vitest run src/main/providers/opencode src/main/domain/permissionSummary.test.ts
test_exit_code: 0
test_output_hash: sha256:9bc339e9336375978d014078f03f3a4eeafb2c6f922d8fe436266b6dff980422
build_command: pnpm build
build_exit_code: 0
build_output_hash: sha256:1dd4719de6420b4a7068d8ffed92b4fc9832ce64a60600f15fefe4386edc683b
```

`evidence_revision` is the SHA-256 over the exact bytes of `git diff 3d8fb3b...aa1e982` (UTF-8, host
line endings) - the same base commit `3d8fb3be74e852f675a64e0d996ced9d6c50a51c` the first pass used,
not the shared `main` tree's current tip (`f3146d5`, which has since advanced through unrelated
merges on this machine). HEAD is `aa1e982b464120f73739e6280cbf94250672ec50` on `feat/opencode-observer`.

## Re-verification after remediation (HEAD aa1e982) - 2026-09-17

**Scope**: bounded re-verification of the four remediation commits (`0569e53`, `c690273`,
`86a53e3`, `aa1e982`) against the first pass's FAIL findings. This section does not redo the whole
first pass; it confirms each finding's resolution against code and tests, re-checks the affected
Spec Compliance Matrix rows, and re-runs the real-store smoke check. The first pass's full report
is preserved verbatim below, unedited.

### A shared-tree hazard encountered and how it was handled

Before any evidence was collected, the shared main checkout was found already switched to `main`
at `f3146d5` (a concurrent agent's merge of PR #448), with a live uncommitted change in flight
(`D src/renderer/src/components/scene/SessionStrip.vue`, later joined by edits to `App.vue`,
`MineScene.vue`/`.test.ts` and two more deletions) - exactly the "another agent's work in flight"
condition `AGENTS.md` describes as routine. An initial focused test run executed against that
shared tree before this was noticed returned a result that could not be trusted (the tree's branch
could have changed between commands), so per the project's own worktree memory ("never `git
checkout` another branch in the main checkout") no checkout was ever performed on the shared tree.

Instead, all code-level re-verification in this section ran inside a disposable, detached git
worktree at `agent-name-worktrees/verify-opencode-observer`, pinned to `aa1e982`, with
`node_modules` junctioned per the project's documented convention, and every check invoked through
the binaries directly (`node node_modules/vitest/vitest.mjs`,
`node node_modules/electron-vite/bin/electron-vite.js build`) - never `pnpm <script>` - to avoid
pnpm's dependency-status check deleting the shared, junctioned `node_modules`. The junction was
removed and the worktree deregistered after each use; the shared main tree was read (`git status`,
`git branch`) but never written to, checked out, staged, or otherwise touched at any point in this
verification.

### Per-finding resolution

| #          | Finding (first pass)                                                                                         | Resolution              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL 1 | Real user-configured OpenCode agent nickname committed; README falsely claimed redaction                     | RESOLVED (`0569e53`)    | Live-store fingerprint check re-run against the exact `aa1e982` tracked-file snapshot (isolated worktree): the value matching the first pass's fingerprint (19 chars, lowercase, hyphenated, SHA-256 prefix `85b896e1`, confirmed by re-hashing the live store's own distinct `session.agent` values) has zero occurrences in tracked files; `sample-agent` appears on 21 lines across the nine files the commit lists. `parse.test.ts` and the whole `opencode` directory pass.                                                                                |
| CRITICAL 2 | Store-wide `opencode.db-wal` mtime floored every session's `activityMs`, so no dwarf was ever dropped        | RESOLVED (`c690273`)    | `git show` confirms `walStat?.mtimeMs` is no longer a `Math.max` argument (a comment records why). The new test `drops a frozen session even while another session keeps the store WAL hot` was reproduced RED in the isolated worktree by temporarily re-adding the removed term (reverted immediately after): `expected [ 'ses_frozen', 'ses_active' ] to deeply equal [ 'ses_active' ]`, byte-for-byte the failure the commit message reports. Restoring the real code turns it GREEN. Nine amended seeds were spot-checked; none had an assertion weakened. |
| WARNING 1  | Built `Dwarf` never carried `attendance`, though D4 and task 3.6 both say `'unknown'`                        | RESOLVED (`86a53e3`)    | `attendance: 'unknown'` added to the object literal; `reports unknown attendance, as D4 and task 3.6 both state (#444)` passes in the focused run.                                                                                                                                                                                                                                                                                                                                                                                                              |
| WARNING 2  | `noReplyYet[0]?.dwarfs[0]?.lastMessage).toBeUndefined()` passed vacuously even if `scan()` published nothing | RESOLVED (`86a53e3`)    | `expect(noReplyYet).toHaveLength(1)` added immediately before the pre-existing assertion; the test can no longer pass on an empty publish.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| WARNING 3  | `TOOL_ACTIVITY_KINDS` keyed only `glob`, missing 81/82 measured OpenCode tool calls                          | RESOLVED (`86a53e3`)    | `bash: 'run'`, `read: 'read'`, `grep: 'search'`, `write: 'edit'` added, each with a passing `it.each` row in `permissionSummary.test.ts`; `task` stays deliberately unmapped (agent traffic already drawn as a dwarf), matching Claude's own `Agent` omission in the same table.                                                                                                                                                                                                                                                                                |
| GAP DET-R5 | No test pinned "tokens/cost never reach the wire" against real non-zero columns                              | RESOLVED (`86a53e3`)    | New test seeds `cost`/`tokens_*` via a raw `UPDATE` and asserts `'tokensObserved' in dwarf === false` and `'cost' in dwarf === false`; passes (GREEN-on-first-run is explicitly acceptable for a pin test per the original report's own instruction).                                                                                                                                                                                                                                                                                                           |
| WARNING 4  | Four test groups were GREEN on first run and never demonstrated they could fail                              | DEFERRED - non-blocking | Test-hygiene only (Strict TDD triangulation quality), not a spec or behavior gap; no code changed this batch that would alter the analysis. Left open per `apply-progress.md`'s own statement that it was out of Remediation 2's scope. Does not block merge: nothing it names is untested, only unproven-by-mutation.                                                                                                                                                                                                                                          |
| WARNING 5  | `NOT_LAUNCHABLE`'s doc comment still claims the string is unreachable, though this change makes it reachable | DEFERRED - non-blocking | Re-read at `aa1e982`: `launchProviders.ts`'s comment is still stale (confirmed unchanged). Comment-only drift with no behavioral or spec effect - the code and its test already assert the correct (reachable) behavior; only the prose describing it is wrong. Does not block merge.                                                                                                                                                                                                                                                                           |

### Updated Spec Compliance Matrix rows

| Req     | Scenario                                      | Prior   | Now       | Test                                                                                                   |
| ------- | --------------------------------------------- | ------- | --------- | ------------------------------------------------------------------------------------------------------ |
| SE-R2   | A captured value carries a machine identifier | FAILING | COMPLIANT | Fixture scrub + fingerprint re-check (above)                                                           |
| DET-R4  | Session quits and goes stale                  | FAILING | COMPLIANT | `opencodeProvider.test.ts > drops a frozen session even while another session keeps the store WAL hot` |
| DET-R5  | A finished turn with token columns filled     | GAP     | COMPLIANT | `opencodeProvider.test.ts > never puts tokens or cost on the wire...`                                  |
| TOPO-R3 | Nothing records a decision from unknown       | PARTIAL | COMPLIANT | `opencodeProvider.test.ts > reports unknown attendance...`                                             |
| FEED-R1 | Session has not replied yet                   | PARTIAL | COMPLIANT | `opencodeProvider.test.ts > carries the newest assistant text...` (strengthened)                       |

Requirements fully satisfied: 14/17 (store-evidence 4/4, detection 3/6, feed 4/4, topology 3/3) -
up from 9/17. Scenarios fully evidenced: 35/39 - up from 30/39.

Four PARTIAL scenario rows remain unchanged, not addressed this batch, and not blocking - each was
already a SUGGESTION (coverage polish), never a CRITICAL/WARNING, in the first pass:

| Req    | Scenario                                            | Status  | First-pass suggestion |
| ------ | --------------------------------------------------- | ------- | --------------------- |
| DET-R1 | All three layers are present                        | PARTIAL | SUGGESTION 1          |
| DET-R1 | The default shape is the same on every OS           | PARTIAL | SUGGESTION 2          |
| DET-R2 | The measured store shape                            | PARTIAL | SUGGESTION 3          |
| DET-R6 | Panel offers actions for an observed OpenCode dwarf | PARTIAL | SUGGESTION 5          |

### Test execution (re-run)

`node node_modules/vitest/vitest.mjs run src/main/providers/opencode src/main/domain/permissionSummary.test.ts`
(binary-equivalent of `pnpm exec vitest run` - the isolated worktree is junctioned, per the "never
run `pnpm <script>` in a junctioned worktree" rule) - 6 files, 122 tests, 0 failed, exit 0, run
against the exact `aa1e982` tree. `node node_modules/electron-vite/bin/electron-vite.js build` -
exit 0, all three targets built.

Both hashes above are computed over the exact captured output of these runs. The wider CI checks
(full 267-file suite, typecheck, lint, format:check, skill-sync --check, and the per-file test
census) were not re-run in this bounded pass; the orchestrator already reports them green on this
exact `aa1e982` HEAD, and nothing touched by this bounded pass (a fixture scrub, one `Math.max`
term, one object-literal field, four table entries, and their tests) plausibly regresses them.

### Real-Store Smoke Check - retention behaviour, re-run

Read-only, same method as the first pass (Node 24.11.1 native type-stripping, `DatabaseSync(...,
{ readOnly: true })`, no session started, no write), executed inside the isolated `aa1e982`
worktree so the imported modules are the fixed code, not whatever the shared tree happened to hold.

| Measurement                                 | First pass (hours earlier)           | This re-verification                                                               |
| ------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| `dwarfSilenceWindowMs('foreman','unknown')` | not printed numerically              | 3,600,000 ms (60 min) - the long/attended window, confirmed live from the contract |
| `dwarfSilenceWindowMs('worker','unknown')`  | not printed numerically              | 1,800,000 ms (30 min)                                                              |
| Non-archived sessions published             | 4                                    | 3                                                                                  |
| Roles/status published                      | 2 foreman settled/mid-turn, 2 worker | 2 foreman (1 busy/no lastMessage, 1 idle/has lastMessage), 1 worker busy           |
| `attendance` on every published dwarf       | not a field yet (WARNING 1 open)     | `'unknown'` on all three - WARNING 1's fix visible against the live store          |

The published count dropped from 4 to 3 over the hours between the two checks, on a store whose
WAL kept advancing throughout (other sessions/agents were actively writing on this machine the
entire time) - precisely the direction CRITICAL 2's fix predicts and the opposite of what the bug
would have produced (under the bug, that WAL activity would have kept every session's `activityMs`
pinned to "now" and the count could only grow). This is directional corroboration, not a
byte-for-byte controlled comparison: the first-pass report recorded categories, not session ids, so
which specific session dropped cannot be confirmed by identity - only that dropping is now
observably happening at all, which the bug made impossible. No session was started, prompted, or
written to; `git status` in the smoke worktree was clean before and after.

### Verdict

The machine-readable verdict above is `fail`, per this validator's own completeness rule: a
`pass` verdict requires full requirement/scenario coverage (17/17, 39/39), and four PARTIAL
scenario rows still remain (unchanged this batch, listed above). That rule is stricter than the
narrative judgment below, and this report defers to it rather than overriding it.

In narrative terms: both CRITICAL findings and the one GAP are resolved and evidenced by tests
re-run against the exact `aa1e982` commit in an isolated worktree; three of five WARNINGs are
resolved the same way. Zero CRITICAL findings and zero blockers remain. WARNING 4 (test-hygiene)
and WARNING 5 (a stale doc comment) stay open by design, and the four remaining PARTIAL rows were
already SUGGESTION-level coverage gaps in the first pass, not CRITICAL/WARNING findings - none of
the seven items still open changes runtime behavior or contradicts a spec scenario.

Per this system's own rule, a canonical `fail` with incomplete-but-non-critical evidence is valid
and persistable but not archive-ready. Closing the four remaining SUGGESTIONs (an `sdd-apply` pass
over `DET-R1` x2, `DET-R2`, `DET-R6`) would make the next re-verification pass cleanly. Absent
that, the maintainer may instead choose to accept the residual gaps as a documented exception
before archiving, the same way this change already accepted its PR-slicing deviation (D9).

---

_(What follows is the first pass's report, preserved verbatim and unedited below this line.)_

```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:3a28c155854c10326b260d79b30b91d1dd189fc155820515c0036a0d6e878fb3
verdict: fail
blockers: 0
critical_findings: 2
requirements: 9/17
scenarios: 30/39
test_command: pnpm exec vitest run src/main/providers/opencode src/main/providers/feedWindow.test.ts src/main/providers/pathPortability.test.ts src/main/config/config.test.ts src/main/config/configFile.test.ts src/shared/contracts.test.ts src/main/domain/agentModelCatalog.test.ts src/main/domain/launchProviders.test.ts src/main/domain/launchTuning.test.ts src/main/sessionLaunch/launch.test.ts src/main/sessionLaunch/launchRunner.test.ts src/main/runtime/runtime.test.ts
test_exit_code: 0
test_output_hash: sha256:fa617c6ec73a03f298282a633aac4778b588b0373aae16a7310fc8ed262fe8f8
build_command: pnpm build
build_exit_code: 0
build_output_hash: sha256:663b040b402b7dc7a47e55f744083dd8019070636365d4efa045f3e04603c674
```

`evidence_revision` is the SHA-256 over the exact bytes of `git diff main...HEAD` in this
session (UTF-8, host line endings), i.e. over the change's own patch. HEAD is
`dff6a8fc52323f175f4aa78a2408605cf149d134` on `feat/opencode-observer`; `main` is
`3d8fb3be74e852f675a64e0d996ced9d6c50a51c`.

## Verification Report

**Change**: opencode-observer · **Version**: N/A (delta specs, no released spec version) ·
**Mode**: Strict TDD · **Attempt**: no `sdd-attempt acquire` call was made — the attempt token was
not available in this session's context (redacted by the orchestrator), and the attempt was
already acquired; no `settle` call was made either.

### Verdict

**FAIL.** The implementation is complete, well-structured and green, and 30 of 39 spec scenarios
are fully evidenced. Two findings break stated scenarios and must be resolved before merge:

1. **The real user-configured OpenCode agent name is committed, and the fixture README claims it
   was replaced** (`opencode-store-evidence`, scenario "A captured value carries a machine
   identifier"). Confirmed against the live store read-only: the value in
   `session-parent.json` equals the live `session.agent` value byte for byte.
2. **The retention window is neutralised by the store-level `opencode.db-wal` mtime**
   (`opencode-session-detection`, scenario "Session quits and goes stale"): while any session in
   the same store writes, every other session's `activityMs` is refreshed, so no dwarf is ever
   dropped. Static analysis; the fixtures cannot produce the state that shows it.

Neither is an implementation-quality problem in the provider's core reads; both are narrow and
cheap to fix. Findings and proposed fixes are below.

### Completeness

| Metric           | Value                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Tasks total      | 49                                                                                                                                  |
| Tasks complete   | 49 (every box checked, PR 1–4)                                                                                                      |
| Tasks incomplete | 0                                                                                                                                   |
| Work units       | 4 declared (PR 1–4) collapsed into ONE PR by the apply run's declared `exception-ok` / `size:exception` decision — see SUGGESTION 8 |

### Build & Tests Execution

**Build**: ✅ Passed (exit 0) — `pnpm build`, `✓ built in 938ms` (electron-vite, all three targets).
Output hash `sha256:663b040b…`. `out/` is gitignored; the tree stayed clean after the run.

**Tests**: ✅ 941 passed / ❌ 0 failed / ⚠️ 0 skipped, in 16 files (exit 0). The command is the
focused set covering **every** test file this change created or amended (all 16 files the census
lists). Output hash `sha256:fa617c6e…`.

**Delegated checks (not re-run by this verification, reported by the orchestrator on the same
HEAD `dff6a8f`, all green):** privacy guard, `pnpm test` (267 files / 7135 passed / 5 skipped),
`node skills/skill-sync/assets/sync.mjs --check`. The orchestrator's full-suite figure is the only
whole-suite evidence in this report; every scenario row below names the test that this
verification ran and saw pass, except where the row says "inspection".

**Re-run by this verification:** `pnpm typecheck` ✅ exit 0 (node + web), `pnpm lint` ✅ exit 0,
`node skills/skill-sync/assets/sync.mjs --check` ✅ `AGENTS.md already up to date (10 skill(s))`,
the focused vitest set above, `pnpm build`, and the per-file test census (below).

**Coverage**: ➖ Not available — `openspec/config.yaml` declares `coverage.available: false` and
no coverage tool is installed. Coverage analysis was skipped as required, never as a failure.

### Spec Compliance Matrix

Statuses: ✅ COMPLIANT (every clause evidenced by a passing test, or by an unambiguous static fact
where no test layer can exist) · ⚠️ PARTIAL (a clause lacks direct evidence) · ❌ GAP (no evidence)
· ❌ FAILING (a clause is contradicted).

Requirement totals: **17** requirements, **39** scenarios (store-evidence 4/8, session-detection
6/14, session-feed 4/8, session-topology 3/9).

#### opencode-store-evidence — 7/8 complete

| Req   | Scenario                                                     | Test / evidence                                                                                                                                                                                                      | Result             |
| ----- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| SE-R1 | A claim carried over from exploration without being observed | Inspection: `docs/opencode-format.md:10-12` carries the `[V]`/`[I]` legend and no `[I]` key is read by `parse.ts`/`state.ts` (grep: only measured names appear)                                                      | ✅ COMPLIANT       |
| SE-R1 | Build changes under the fixtures later                       | Inspection: `docs/opencode-format.md:1-16` (build 1.18.31, date 2026-09-17, host OS) + `__fixtures__/opencode/README.md:3`                                                                                           | ✅ COMPLIANT       |
| SE-R2 | The measured install wrote SQLite only                       | Inspection of the fixture set (DDL + row fixtures + unknown-schema DB, no JSON tree) plus the tests that seed `MemorySqlite` from it (`state.test.ts`) and the recorded negative row (`docs/opencode-format.md:154`) | ✅ COMPLIANT       |
| SE-R2 | A row set is captured before any session has run             | N/A — the GIVEN never held: the row set was captured from a real turn (measurements row 3), so the requirement's own "waits for a real turn" branch was never reached                                                | ✅ COMPLIANT (N/A) |
| SE-R2 | A captured value carries a machine identifier                | Fixture README claims the agent nickname was replaced; it was not — the value equals the live `session.agent` byte for byte (see CRITICAL 1)                                                                         | ❌ **FAILING**     |
| SE-R3 | A row comes back negative                                    | Superseded by the stated amendment in task 1.11 (`specs/opencode-session-topology/spec.md:48-57`), row 4 is positive and recorded with its consequence (`docs/opencode-format.md:95-112`)                            | ✅ COMPLIANT       |
| SE-R3 | The native Windows binary misbehaves                         | Inspection: `docs/opencode-format.md:121-129` records both the broken pnpm shim (negative) and the working `npx opencode-ai` path (positive)                                                                         | ✅ COMPLIANT       |
| SE-R4 | A parser is attempted from the exploration document alone    | Inspection: commit order `ef02e6c` (evidence/fixtures) precedes `a02e44f` (parser); the parsers are fixture-driven only                                                                                              | ✅ COMPLIANT       |

No test layer exists for this capability by design (`tasks.md` PR 1 header: "nothing compiles
against this slice; RED/GREEN does not apply"), so its rows are evidenced by inspection of the
committed artifacts. That exception is recorded here rather than silently converted into a test
claim.

#### opencode-session-detection — 8/14 complete

| Req    | Scenario                                            | Test                                                                                                                                                                                                                                                                                                                                                                      | Result         |
| ------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| DET-R1 | All three layers are present                        | `configFile.test.ts > applies OPENCODE_STORE_ROOT from the file…`, `> lets a real OPENCODE_STORE_ROOT environment variable win over the file`, `config.test.ts > falls through to the default when OPENCODE_STORE_ROOT is blank…` — but blank-env-over-a-file-value is not asserted for this key (the shared mechanism is pinned generically at `configFile.test.ts:109`) | ⚠️ PARTIAL     |
| DET-R1 | The default shape is the same on every OS           | `config.test.ts > defaults the OpenCode store to the same OS-invariant path, whatever the host` proves the unexpanded default string; no test expands `~/.local/share/opencode` with a fixed `home` for win32/darwin/linux, and no test asserts `process.platform` is unread (grep: the provider and config read it nowhere)                                              | ⚠️ PARTIAL     |
| DET-R2 | The measured store shape                            | `opencodeProvider.test.ts > appears within one scan` (one snapshot per `session` row, id `opencode:ses_a`); the `directory`-as-cwd half is proven at the state layer only (`state.test.ts > reads a non-archived session, including its parent_id`) — `snapshot.cwd` is asserted nowhere                                                                                  | ⚠️ PARTIAL     |
| DET-R2 | Legacy JSON tree and no database                    | `opencodeProvider.test.ts > returns no snapshots and does not throw when no store exists` + static: `store.ts` builds only `opencode.db`/`opencode.db-wal` and no module in `opencode/` lists a directory, so a `storage/` tree is unobservable by construction; the 1.18.31 floor is stated at `docs/opencode-format.md:14`                                              | ✅ COMPLIANT   |
| DET-R3 | Machine without OpenCode installed                  | `opencodeProvider.test.ts > returns no snapshots and does not throw when no store exists`; no warning can be emitted — the module contains no logging call at all; the scan costs one `stat` pair per poll                                                                                                                                                                | ✅ COMPLIANT   |
| DET-R3 | Database with an unknown schema                     | `opencodeProvider.test.ts > returns no snapshots and does not throw against an unknown schema` + `state.test.ts`'s four "answers an unknown schema with … and no throw" cases                                                                                                                                                                                             | ✅ COMPLIANT   |
| DET-R4 | Database mtime frozen while the session works       | `opencodeProvider.test.ts > is working when only event.seq advanced since the previous poll` (file mtimes unchanged, `seq` 1→2, status `busy`)                                                                                                                                                                                                                            | ✅ COMPLIANT   |
| DET-R4 | An assistant message is still streaming             | `opencodeProvider.test.ts > is working while the newest assistant message lacks time.completed` (`snapshot.status === 'busy'`, dwarf `working`)                                                                                                                                                                                                                           | ✅ COMPLIANT   |
| DET-R4 | A turn stops between tool calls                     | `opencodeProvider.test.ts > is still working after a completed intermediate step (finish: tool-calls)`                                                                                                                                                                                                                                                                    | ✅ COMPLIANT   |
| DET-R4 | The turn finishes                                   | `opencodeProvider.test.ts > turns waiting once time.completed is set with finish: stop` + `> never reports SessionStatus waiting — only busy or idle`                                                                                                                                                                                                                     | ✅ COMPLIANT   |
| DET-R4 | Session quits and goes stale                        | `opencodeProvider.test.ts > keeps a root (foreman) dwarf past the short window, up to the long one` proves the single-session happy path; the THEN is violable in a shared store because `activityMs` includes the store-wide WAL mtime (see CRITICAL 2)                                                                                                                  | ❌ **FAILING** |
| DET-R5 | A finished turn with token columns filled           | No test seeds real token columns and asserts their absence from the dwarf. The live smoke check showed `hasTokensObserved: false`/`hasCost: false` with populated columns in the store, but that is not a committed test                                                                                                                                                  | ❌ **GAP**     |
| DET-R6 | Panel offers actions for an observed OpenCode dwarf | `opencodeProvider.test.ts > never returns a transcriptPath and never offers a delivery channel` (channel `null`); the panel half is proven generically for an observed-only provider (`actionBar.test.ts > never names a launch command for a dwarf the panel observes itself`), not for an `opencode` dwarf specifically                                                 | ⚠️ PARTIAL     |
| DET-R6 | Add Panel shows OpenCode                            | `launchProviders.test.ts > marks a detected OpenCode installed but not launchable, with NOT_LAUNCHABLE as its reason` (+ `> offers no refusal copy for an OpenCode nobody has installed`)                                                                                                                                                                                 | ✅ COMPLIANT   |

#### opencode-session-feed — 7/8 complete

| Req     | Scenario                                                  | Test                                                                                                                                                                                                                                                   | Result       |
| ------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| FEED-R1 | Session has replied at least once                         | `opencodeProvider.test.ts > carries the newest assistant text as lastMessage, absent when none exists` (second half asserts the exact text)                                                                                                            | ✅ COMPLIANT |
| FEED-R1 | Session has not replied yet                               | Same test's first half — `expect(noReplyYet[0]?.dwarfs[0]?.lastMessage).toBeUndefined()` also passes when `scan()` returns nothing, so "the dwarf is STILL PUBLISHED" is not proven (see WARNING 2)                                                    | ⚠️ PARTIAL   |
| FEED-R2 | Unknown dwarf id                                          | `opencodeProvider.test.ts > returns null from feed and feedPage for an id the latest scan does not know`                                                                                                                                               | ✅ COMPLIANT |
| FEED-R2 | The session row was deleted between the scan and the read | `opencodeProvider.test.ts > answers feed [] and feedPage an empty reachedStart page when the store vanished after the scan`; a deleted `session` row (cascade) reaches the same returns through `readOpenCodeMessages` → `[]` and `cursorIndex` → `-1` | ✅ COMPLIANT |
| FEED-R2 | Paging older than the panel's oldest row                  | `opencodeProvider.test.ts > redacts a secret in a feed row, and a cursor built from the redacted row still matches` (second half: one older row, `reachedStart: true`) + `feedWindow.test.ts > cursorIndex… > composes with feedPageOf…`               | ✅ COMPLIANT |
| FEED-R3 | A secret appears in a user turn                           | `opencodeProvider.test.ts > redacts a secret in a feed row…`                                                                                                                                                                                           | ✅ COMPLIANT |
| FEED-R3 | A cursor names a row that contained a secret              | Same test (`feedPage` with the redacted row's own cursor matches and returns no gap/repeat) + `feedWindow.test.ts > cursorIndex… > resolves a cursor against rows already redacted`                                                                    | ✅ COMPLIANT |
| FEED-R4 | A terminal tail is requested for an OpenCode dwarf        | `opencodeProvider.test.ts > never returns a transcriptPath and never offers a delivery channel`; `transcriptPath()` is a constant `undefined` with no branch                                                                                           | ✅ COMPLIANT |

Note: `lastMessage` redaction (`opencodeProvider.ts:228`) is not directly asserted — every
`lastMessage` test uses text with no secret in it. See SUGGESTION 6.

#### opencode-session-topology — 8/9 complete

| Req     | Scenario                                                    | Test                                                                                                                                                                                                                                                                                      | Result       |
| ------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| TOPO-R1 | Row 4 positive — a subagent is spawned                      | `opencodeProvider.test.ts > ranks a child below the root and promotes the parent to foreman — the measured row-4 pair` (fixtures `session-parent.json`/`session-child.json`)                                                                                                              | ✅ COMPLIANT |
| TOPO-R1 | A root session whose assistant messages carry a reply edge  | `parse.test.ts > never surfaces message.data.parentID as a parent — it is a reply edge, not topology` + `opencodeProvider.test.ts > publishes a null parent_id session as a root foreman`                                                                                                 | ✅ COMPLIANT |
| TOPO-R1 | Row 4 closed positive — a Task subagent populates the field | Same measured-pair test + `docs/opencode-format.md:95-112` (row 4 positive, with its consequence)                                                                                                                                                                                         | ✅ COMPLIANT |
| TOPO-R1 | A parent edge points at a session this scan did not see     | `opencodeProvider.test.ts > publishes a child whose parent is absent from the store, inventing no parent`                                                                                                                                                                                 | ✅ COMPLIANT |
| TOPO-R2 | Worker beside foreman                                       | `opencodeProvider.test.ts > ranks a child below the root…` (child `worker`, parent `foreman`)                                                                                                                                                                                             | ✅ COMPLIANT |
| TOPO-R2 | The crew finishes                                           | `opencodeProvider.test.ts > keeps a foreman rank after its crew has gone home`                                                                                                                                                                                                            | ✅ COMPLIANT |
| TOPO-R3 | Unproven root                                               | `opencodeProvider.test.ts > keeps a root (foreman) dwarf past the short window, up to the long one` asserts `dwarfSilenceWindowMs('foreman','unknown') > dwarfSilenceWindowMs('worker','unknown')` and the long-window drop                                                               | ✅ COMPLIANT |
| TOPO-R3 | A child session's window                                    | `opencodeProvider.test.ts > drops a worker (parent_id set) past the short window`                                                                                                                                                                                                         | ✅ COMPLIANT |
| TOPO-R3 | Nothing records a decision from unknown                     | No test asserts `attendance` at all; the built dwarf does not carry the field (`opencodeProvider.ts:230-237`), which the contract reads as 'unknown' (`contracts.ts:1145-1147,582-588`) — behaviourally inert, but D4 and task 3.6 both say the dwarf reports `'unknown'` (see WARNING 1) | ⚠️ PARTIAL   |

**Compliance summary**: 30/39 scenarios fully evidenced; 6 PARTIAL, 1 GAP, 2 FAILING.
Requirements fully satisfied: 9/17 (store-evidence 3/4, detection 1/6, feed 3/4, topology 2/3).

### Correctness (Static Evidence)

| Requirement                                                    | Status         | Notes                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `'opencode'` on the wire, no new symbol                        | ✅ Implemented | `contracts.ts:140` adds the array member only; no type added, so no barrel symbol needed, and `DWARF_PROVIDERS` reaches both barrels (`main/domain/types.ts:131`, `renderer/src/types.ts:128`)                           |
| Store root through three layers, OS-invariant                  | ✅ Implemented | `OpenCodeConfig`, `readOpenCodeConfig` (`readTrimmed`), `defaultConfig`/`loadConfig`; `~` expanded by `expandPath → expandHomePath(path, home)` (`runtime.ts:531,1011`); no `Platform`, no `process.platform`            |
| DB-only read, read-only handle                                 | ✅ Implemented | `state.ts` runs all four queries through `SqliteDb`; the only other read is `fs.stat` of the two files; no `listDir` anywhere in `opencode/`                                                                             |
| Unknown schema / missing store degrade                         | ✅ Implemented | `all()` → `[]` at the seam; `openReadOnly` → `null`; every helper tolerates empty; `JSON.parse` inside `parse.ts`'s `parseJsonRecord` `try/catch`                                                                        |
| Liveness from rows and `event.seq`, mtime last                 | ✅ Implemented | `busy = streaming \|\| seqAdvanced \|\| (intermediateStep && !stalled)`; `BUSY_WINDOW_MS = 120_000`; `SessionStatus` is `busy`/`idle` only                                                                               |
| Retention per dwarf via `dwarfSilenceWindowMs(role,'unknown')` | ⚠️ With defect | The window is read through the contract's own function, never restated locally — but the activity it is measured against includes the store-wide WAL mtime (CRITICAL 2)                                                  |
| Topology from `session.parent_id` alone                        | ✅ Implemented | `parentSessions` populated from the same single read; `message.data.parentID` is not modelled in `OpenCodeMessage`                                                                                                       |
| Feed assembled from rows, redacted, paged                      | ✅ Implemented | `readOpenCodeMessages` → `openCodeFeedRows` → `redactSecrets` → `trimFeed`/`cursorIndex`+`feedPageOf`; cursor resolved against the same redacted rows                                                                    |
| No channel, no transcript, no ore                              | ✅ Implemented | `textDelivery()` → `null`; `transcriptPath()` → `undefined`; token and cost columns are never selected by any SQL; neither field reaches the `Dwarf`                                                                     |
| The launch gate refuses before detection                       | ✅ Implemented | `launchRunner.ts:617-621` checks `LAUNCHABLE_PROVIDERS.includes(options.provider)` before `detector.detect`; `LAUNCHABLE_PROVIDERS` did not grow; `buildLaunchArgs`'s `throw NOT_LAUNCHABLE` arm documents the invariant |

### Coherence (Design)

| Decision                              | Followed?                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 module layout and reuse            | ✅ Yes (one justified deviation) | `store.ts`, `parse.ts`, `state.ts`, `stateSeed.ts`, `opencodeProvider.ts`, fixtures, `docs/opencode-format.md` all present and mirrored on their Codex/Antigravity counterparts; no JSON reader, no `merge.ts`, no `normalizePathKey`; `cursorIndex` exported, `pollProfiler.measureSync` used. **Deviation**: `domain/permissionSummary.ts`'s `TOOL_ACTIVITY_KINDS` gained `glob: 'search'` — justified in shape, weak in effect (see WARNING 3) |
| D2 single-source read and degradation | ✅ Yes                           | Exactly the `stat → openReadOnly → four reads → per-session build → swap` shape; generation swap only after the loop; `publishNothing()` swaps to empty on both early returns                                                                                                                                                                                                                                                                     |
| D3 liveness without a probe           | ⚠️ Deviates in one term          | The busy rule, `BUSY_WINDOW_MS`, the `busy`/`idle`-only rule, the absence of a probe seam and the per-dwarf retention rule all match. The `activityMs` term list adds `walStat.mtimeMs`, which D3's own "Store growth … proves writes somewhere, not which session. It only gates cost" contradicts (CRITICAL 2)                                                                                                                                  |
| D4 topology                           | ✅ Yes (field omitted)           | `session.parent_id` is the only source; non-null → `worker` + `parentId`; parent promoted via a persistent `parentSessions` set; null → root `foreman`; the rank survives the crew. The `attendance: 'unknown'` column of D4's table is not implemented as a field (WARNING 1)                                                                                                                                                                    |
| D5 contract growth: every site        | ✅ Yes                           | All six compile sites, `agentModelCatalog`'s `unavailableOpenCodeModelCatalog()` and `runtime.listAgentModels`' fourth entry exist; `contracts.test.ts:62` amended (delta 0 in the census — an amendment, not an addition); `launchProviders.ts:84` unchanged; every exhaustive `Record<DwarfProvider>` compiles with its arm; the two `Partial` maps are the loose sites the design already named                                                |
| D5 launch gate                        | ✅ Yes                           | The gate is exactly where D5 puts it, with the RED pair the design named; `launchRunner.test.ts` proves **zero** `detect` calls                                                                                                                                                                                                                                                                                                                   |
| D6 configuration                      | ✅ Yes                           | `readProviderConfig` + `readTrimmed`, blank = unset, no value-level validation to add (a path has no invalid value at load time), reachable through the `userData` file, no `XDG_DATA_HOME` read                                                                                                                                                                                                                                                  |
| D7 measurement rows as design inputs  | ✅ Yes                           | Rows 1, 2, 3, 4, 5 and 10 each carry a verdict and a consequence in `docs/opencode-format.md`; row 4's positive result is stated where users read it (`docs/guide.md`, `docs/session-topology-and-roles.md`)                                                                                                                                                                                                                                      |
| D8 test strategy                      | ⚠️ With gaps                     | Fakes are the named hand-written ones (`FakeFs`, `MemorySqlite`), clocks are injected, `vi.mock` appears in none of the changed test files, jsdom is not opted into (correct for a main-process slice). Four gaps relative to D8: no token-column case, no `snapshot.cwd` case, no panel-level action case, no `lastMessage` redaction case                                                                                                       |
| D9 PR slicing (800-line budget)       | ➖ Declared deviation            | The change landed as ONE PR (~1,900 authored lines added, 68 files) under the apply run's `exception-ok`/`size:exception` decision, which apply-progress states. Review-load risk is real but declared, not silent                                                                                                                                                                                                                                |
| D10 rollback and privacy              | ❌ Not met                       | Fixtures use `j`, `placeholder-host`, `Sample-Project` and repeated-digit ids as designed — but the user-configured agent name was not redacted, and the README's redaction statement is therefore inaccurate (CRITICAL 1)                                                                                                                                                                                                                        |

### Boundary Checks

| Check                                                                | Result                                                                                                                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/contracts.ts` free of Electron and Node imports          | ✅ Its only import is `import type { ShortcutPlatform } from './accelerator'` (pre-existing)                                                                                                   |
| `'opencode'` reaches both barrels                                    | ✅ The array is re-exported as a value by `src/main/domain/types.ts:131` and `src/renderer/src/types.ts:128`; no new symbol was added, so no barrel omission was possible and none exists      |
| No renderer-only type leaked into `contracts.ts`                     | ✅ Nothing but the `DWARF_PROVIDERS` member changed; no type was added, copied or widened                                                                                                      |
| Main barrel gap the apply run declares (`dwarfSilenceWindowMs`)      | ✅ Verified: `main/domain/types.ts:152` now re-exports the function the provider calls; the omission was pre-existing and is stated in apply-progress                                          |
| Nothing under `skills/` changed, so `sync.mjs --check` is unaffected | ✅ No `skills/` path in the diff; the generated `main/` tree bullet lists `providers` one level deep, so the nested `opencode/` directory does not change it (verified with `--check`, exit 0) |

### TDD Compliance

| Check                             | Result | Details                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TDD Evidence reported             | ✅     | `apply-progress.md`'s "TDD Cycle Evidence" table, 14 rows covering PR 2–PR 3; PR 1 is documents/fixtures and says so                                                                                                                                                                                                                |
| All tasks have tests              | ✅     | 49/49 tasks checked; the five new test files exist (`store`, `parse`, `state`, `opencodeProvider`, `opencodeProviderRegistry`) and every amended file contains a stated amendment comment                                                                                                                                           |
| RED confirmed (tests exist)       | ✅     | Every test file the table names exists and is non-trivial (25 + 13 + 4 + 25 + 3 statements, census below); the reported RED reasons ("Cannot find module", missing export, wrong count) are consistent with a test-first order                                                                                                      |
| GREEN confirmed (tests pass)      | ✅     | 941/941 pass in this verification's focused run, including every amended file                                                                                                                                                                                                                                                       |
| Triangulation adequate            | ⚠️     | Good variance where it matters (6 liveness cases, 4 topology cases, 6 parse cases, 4 retention/feed boundary cases). But four groups were **GREEN on first run** — topology (3.9/3.10), `pathPortability` (3.13), the `installed && !launchable` case (3.14) — and a test that never failed has not demonstrated it can (WARNING 4) |
| Safety Net for modified files     | ✅     | The census (below) shows no file lost test statements; each amended assertion is commented in place with the issue that moved it; the two value-changing amendments (`contracts.test.ts` 3→4 entries, five `runtime.test.ts` length/order assertions) are stated out loud                                                           |
| Assertion quality (Step 5f audit) | ⚠️     | One vacuous optional-chain assertion found (WARNING 2); no tautologies, no ghost loops, no `vi.mock`-heavy files (0 `vi.mock` occurrences across the changed tests), no CSS/implementation-detail coupling                                                                                                                          |

**TDD Compliance**: 5/6 checks pass, 1 warning.

### Test Layer Distribution

| Layer       | Tests   | Files  | Tools                                                                             |
| ----------- | ------- | ------ | --------------------------------------------------------------------------------- |
| Unit        | 941     | 16     | vitest 4 + hand-written fakes (`FakeFs`, `MemorySqlite`), injected clocks         |
| Integration | 0       | 0      | not installed (`openspec/config.yaml` `test_layers.integration.available: false`) |
| E2E         | 0       | 0      | not installed (`test_layers.e2e.available: false`)                                |
| **Total**   | **941** | **16** |                                                                                   |

Every scenario in this change is unit-level. That is the only layer the project has, and the
capability's own spec is about pure parsing plus SQL over a fake seam, so no scenario is left
stranded at a layer the repository cannot run. A real-store, read-only smoke check was performed
instead of an integration suite (see below).

### Changed File Coverage

Coverage analysis skipped — no coverage tool detected (`openspec/config.yaml`
`coverage.available: false`).

### Assertion Quality

| File                                                   | Line | Assertion                                                         | Issue                                                                                                                                  | Severity   |
| ------------------------------------------------------ | ---- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `src/main/providers/opencode/opencodeProvider.test.ts` | 420  | `expect(noReplyYet[0]?.dwarfs[0]?.lastMessage).toBeUndefined()`   | Passes vacuously when `scan()` publishes nothing, so the scenario's "the dwarf is still published" half is unproven                    | WARNING    |
| `src/main/runtime/runtime.test.ts`                     | 5268 | `expect(cliDetector.detect).not.toHaveBeenCalledWith('opencode')` | Weaker than the sibling `launchRunner.test.ts` assertion (`not.toHaveBeenCalled()`); it would not catch a call with any other argument | SUGGESTION |

**Assertion quality**: 0 CRITICAL, 1 WARNING (+1 SUGGESTION). No tautologies, no empty-collection
assertions without a non-empty companion, no type-only assertions used alone, no assertions
outside a production call, no ghost loops (every loop in these files is over an explicitly
constructed collection), and no mock-heavy file (no `vi.mock` at all; the registry test's
`vi.fn` platform stub is one seam, with 6 assertions beside it).

### Quality Metrics

**Linter**: ✅ `pnpm lint` exit 0 (re-run by this verification).
**Type Checker**: ✅ `pnpm typecheck` exit 0, node + web (re-run by this verification).
**Formatter / skill-sync**: ✅ reported green by the orchestrator on HEAD `dff6a8f`; `sync.mjs
--check` re-run green here. `--check` on prettier was not re-run by this verification (the
orchestrator reports it green, and the sixth commit `dff6a8f` exists precisely to format what the
planner had left unformatted).

### Test Census

`node skills/test-safety/assets/test-census.mjs --base main` — exit **0** ("No file lost test
statements"):

```text
file                                                          before   after  delta
------------------------------------------------------------------------------------
src/main/config/config.test.ts                                    56      59  +3
src/main/config/configFile.test.ts                                28      30  +2
src/main/domain/agentModelCatalog.test.ts                         18      19  +1
src/main/domain/launchProviders.test.ts                           11      13  +2
src/main/domain/launchTuning.test.ts                              20      21  +1
src/main/providers/feedWindow.test.ts                             45      48  +3
src/main/providers/opencode/opencodeProvider.test.ts               0      25  +25  (new file)
src/main/providers/opencode/opencodeProviderRegistry.test.ts       0       3  +3   (new file)
src/main/providers/opencode/parse.test.ts                          0      25  +25  (new file)
src/main/providers/opencode/state.test.ts                          0      13  +13  (new file)
src/main/providers/opencode/store.test.ts                          0       4  +4   (new file)
src/main/providers/pathPortability.test.ts                         6       8  +2
src/main/runtime/runtime.test.ts                                 377     378  +1
src/main/sessionLaunch/launch.test.ts                             35      36  +1
src/main/sessionLaunch/launchRunner.test.ts                       57      58  +1
src/shared/contracts.test.ts                                      94      94  0

net +87 across 16 file(s).

No file lost test statements.
```

Eleven existing files were amended (the brief said ten; the eleventh is `contracts.test.ts`,
whose delta is **0** — it is a value-changing amendment, an existing assertion whose expected
array gained a member, which is exactly the kind of change the census cannot show as a delta).
No test was removed anywhere.

### Real-Store Smoke Check (bounded, read-only)

A scratch script **outside the repository** loaded this change's own modules without touching the
working tree — `src/main/providers/opencode/state.ts`, `parse.ts`, `opencodeProvider.ts` and
`NodeSqlite`/`NodeFs` — through Node 24.11.1's native type stripping plus a 12-line resolve hook
that appends `.ts` to extensionless relative specifiers (Node's stripper does not add extension
resolution, which is the only reason the hook exists). The store was opened with
`DatabaseSync(..., { readOnly: true })`; OpenCode was never started, prompted or written to. The
fixtures' placeholder root was used as the only path string; the live store path is not reproduced
here.

| Measurement                                     | Result                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-archived sessions the provider publishes    | **4** snapshots (`session` rows: 4 total, 0 archived — the archived filter is therefore not exercised by this machine, but `state.test.ts` covers it)                                                                                                                                                                                                     |
| Parent/child edge found                         | **Yes — 2 sessions carry `parent_id`**; the provider published 2 `foreman` roots and 2 `worker` children, each child carrying `parentId` and each parent promoted `foreman`. Row 4 is positive on the current store, not only on the captured fixture pair                                                                                                |
| Newest assistant's `time.completed` / `finish`  | 2 sessions settled (`completed` set, `finish: "stop"` → published `idle`/`waiting`); 1 root with **no** `time.completed` and **no** `finish` on its newest assistant message (the interactive TUI quit mid-turn) → published `busy`/`working`, which is exactly what the liveness rule requires; 1 child with no assistant message yet → `busy`/`working` |
| Last assistant text length (content never read) | 1935 / 129 / 46 / none — lengths only; no message text, title, path or identifier was recorded                                                                                                                                                                                                                                                            |
| `tokensObserved` / `cost` on a real dwarf       | `hasTokensObserved: false`, `hasCost: false` on all four — the token columns ARE populated in the store, so the "no ore" rule holds against real data                                                                                                                                                                                                     |
| `feed` / `feedPage` over the real store         | `feed(id, 5)` → 3 rows (lengths 162 / 74 / 1935); `feedPage` with the newest row's own cursor → 2 rows, `reachedStart: true`; unknown id → `null`; `transcriptPath` → `undefined`; `textDelivery` → `null`                                                                                                                                                |
| Real tool-name histogram (supporting evidence)  | `bash` 37, `read` 36, `grep` 4, `task` 2, `glob` 2, `write` 1 over 254 `part` rows; 81 parts carry `state.input`; both `glob` parts carry `input: { pattern: <string> }`, which the shared `toolActivityLine` table can name                                                                                                                              |
| Parse failures                                  | **None.** No query threw, no row was unreadable, and the store was closed cleanly. `readOpenCodeSessions`, `readOpenCodeEventSeqs`, `readOpenCodeNewestAssistant` and `readOpenCodeMessages` all answered against the live 1.18.31 schema                                                                                                                 |

One transparency note: the scratch directory already contained helper files from an earlier
session (`smoke.mjs`, `resolve-ts.mjs`, …). This verification overwrote `resolve-ts.mjs` with an
equivalent 12-line hook. Nothing inside the repository was created, modified or deleted by the
smoke check; `git status --porcelain` was empty before and after it.

### Privacy Grep (fixtures and `docs/opencode-format.md`)

`PRIVACY_GUARD_PATTERN` is a repository secret and is **not** available in this session, so the
guard could not be run as CI runs it — this is a manual reading against the project's placeholder
table, exactly as `skills/privacy-guard/SKILL.md` prescribes, not a substitute for it.

| Surface                                                 | Result                                                                                                                                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home paths / account names in the fixtures              | ✅ Clean: `j`, `/home/j/Sample-Project`, `~/Sample-Project`, `placeholder-host` (README), `prj_placeholder`, `ses_placeholder_*`, `call_placeholder_*`, synthetic 40-hex snapshot ids, synthetic epoch-ms timestamps |
| Home paths / account names in `docs/opencode-format.md` | ✅ Clean: the store root is written `~/.local/share/opencode`, the log is `…/log/opencode.log`; no absolute path, no account name, no hostname, and no guard pattern reproduced                                      |
| Machine identifiers in the same surfaces                | ❌ **One real value found** — the user-configured OpenCode agent name. See CRITICAL 1 for the exact files and the live-store confirmation                                                                            |
| Guard patterns reproduced anywhere                      | ✅ None — this report describes the guard, never its literals                                                                                                                                                        |

### Findings

**CRITICAL 1 — a real user-configured agent name is committed, and the fixture README states a
redaction that did not happen.**

- Failing scenario: `opencode-store-evidence` → "A captured value carries a machine identifier"
  ("THEN the project placeholders replace them AND the fixture README states that the redaction
  happened").
- Evidence: `src/main/providers/__fixtures__/opencode/README.md:12-15` says, in the sentence that
  names the value outright, that it "was the maintainer's own configured agent nickname and is
  replaced here with the same placeholder throughout". It was not replaced. The name appears
  verbatim in `session-parent.json:17`, `message-user.json:4`, `message-assistant-streaming.json:5`,
  `message-assistant-toolcalls.json:5`, `message-assistant-stop.json:5`,
  `src/main/providers/opencode/parse.test.ts` (7 occurrences), `docs/opencode-format.md:58` and
  `openspec/changes/opencode-observer/measurements-2026-09-17.md:99,126`. A read-only query of the
  live store (distinct `session.agent` values, compared without printing them) returned
  `equalsFixtureValue: true` — the committed string is the machine's real configured agent name,
  not a placeholder: 19 characters, lowercase and hyphenated, SHA-256 prefix `85b896e1`. That
  fingerprint and the line list above identify it without this report adding a second copy of the
  value to the repository (the fix itself should remove every copy, not one more). CI's guard
  cannot see it: it greps four hardcoded literals and this is not one of them, which is precisely
  the class `privacy-guard` warns a green build does not cover.
- Proposed fix: choose a neutral placeholder (e.g. `sample-agent`) and use it in the five fixture
  files, `parse.test.ts`, `docs/opencode-format.md:58` and the two measurements lines — or, if the
  maintainer deliberately publishes the real nickname, delete the sentence claiming it was
  replaced and say so in the commit body. Either way the false redaction claim must go, and the
  fixtures README's per-file table should state the replacement the way it states `j` and
  `placeholder-host`. This must land before the branch is merged, not after: `privacy-guard`
  documents that scrubbing history afterwards is not the same as removing the value.

**CRITICAL 2 — the store-wide WAL mtime neutralises the per-dwarf retention window.**

- Failing scenario: `opencode-session-detection` → "Session quits and goes stale" ("THEN the dwarf
  is dropped on the first scan after that window and never before it").
- Evidence: `opencodeProvider.ts:213-221` computes `activityMs` as the maximum of the session's own
  seq/message times, `session.updatedMs` **and `walStat?.mtimeMs`**, then drops the session only
  when `nowMs - activityMs > dwarfSilenceWindowMs(role, 'unknown')`. `opencode.db-wal` is one file
  for the whole store, so any write by any session refreshes the mtime and every other session's
  `activityMs` with it. In the normal case — one OpenCode install, several sessions, one of them
  active — no session is ever dropped, and the board accumulates dwarfs for every session ever
  seen. This also contradicts D3's own rule for store-level signals ("growth proves writes
  somewhere, not which session. It only gates cost") and the Codex precedent it cites, where the
  mtime belongs to a per-session rollout file.
- Why the fixtures cannot show it: `FakeFs.addFile` stamps a fixed mtime, so the retention tests
  advance the injected clock while the fake WAL's mtime stands still. The tests pass for the right
  reason on a quiet store and cannot fail on a busy one.
- Proposed fix: keep the WAL mtime out of the per-session decision. Compute `activityMs` from the
  session's own facts (`seqAdvanced ? nowMs : 0`, the newest message's `time.completed`/`created`,
  `session.updatedMs`) and leave `walStat` to the cost gate only. Add the test the fixtures are
  missing: two sessions, one's rows and events frozen, the WAL's mtime advanced past the frozen
  session's window, assert the frozen dwarf is dropped and the active one is not. Static analysis
  only — this finding was not reproduced at runtime in this verification.

**WARNING 1 — the dwarf does not report `attendance: 'unknown'`, which D4 and task 3.6 both say it
should.**

- Failing scenario: `opencode-session-topology` → "Nothing records a decision from unknown" (the
  scenario's clause about attendance being reported).
- Evidence: `opencodeProvider.ts:230-237` builds the `Dwarf` with `id`, `provider`, `role`, `name`,
  `status`, `sessionId` and conditionally `model`, `parentId`, `lastMessage` — never `attendance`.
  The live smoke check confirms `attendance: undefined`. `design.md` D4's table gives
  `attendance: 'unknown'` for every case and `tasks.md` 3.6 lists "'unknown' attendance" in the
  build. The field is optional and `contracts.ts:1145-1147` documents absent-as-'unknown', so the
  behaviour (the long window for a root) is correct either way — this is a stated-versus-actual
  mismatch, not a live defect.
- Proposed fix: either set `attendance: 'unknown'` explicitly (one line, mirroring
  `claudeProvider.ts`'s explicit field) with a test asserting it, or amend D4/tasks 3.6 to record
  that the field is deliberately omitted because the contract reads absence as unknown. Do not
  leave the two saying different things.

**WARNING 2 — one feed assertion cannot fail the way its scenario needs.**

- Failing scenario: `opencode-session-feed` → "Session has not replied yet" (the "the dwarf is still
  published" half).
- Evidence: `opencodeProvider.test.ts:419-420` — `expect(noReplyYet[0]?.dwarfs[0]?.lastMessage)
.toBeUndefined()` is also satisfied by `scan()` returning `[]`, so the test does not distinguish
  "published without a `lastMessage`" from "nothing published".
- Proposed fix: assert `expect(noReplyYet).toHaveLength(1)` (and the dwarf id) before the
  `toBeUndefined()` check.

**WARNING 3 — the `TOOL_ACTIVITY_KINDS` deviation is justified in shape but reaches almost none of
the real tool calls.**

- Affected artefact: apply-progress's declared PR 2 deviation (`glob: 'search'`) and D1's "tool
  parts become tool lines … spelled as Codex's are".
- Evidence: the live store's tool histogram over 254 `part` rows is `bash` 37, `read` 36, `grep` 4,
  `task` 2, `glob` 2, `write` 1. `TOOL_ACTIVITY_KINDS` is keyed by exact tool name; OpenCode's names
  are lowercase where Claude's are capitalised, so none of `bash`, `read`, `grep`, `write` (81 of
  82 tool calls) produces a line. The entry that was added is the one name row 4 happened to show,
  and it does work (both real `glob` parts carry `input: { pattern }`, which `namedSubject` reads).
  The deviation is honest and harmless — an unmatched name falls through to no line exactly as
  designed — but the design's claim that tool parts become lines is effectively unmet for this
  provider.
- Proposed fix: decide and state one of the two. Either (a) add the measured lowercase names
  (`bash: 'run'`, `read: 'read'`, `grep: 'search'`, `write: 'edit'`; leave `task` out as agent
  traffic already drawn as a dwarf, matching Claude's `Agent`/Codex's `spawn_agent`) with a test
  per name, or (b) keep one entry and say in `docs/opencode-format.md` that only `glob` maps in
  this change, so a reader is not told the feed shows OpenCode's work when it mostly does not.
  Note that (a) can only be written from a measurement: the evidence for the input shapes exists on
  this machine (81 parts carry `state.input`) but is not in the committed fixtures.

**WARNING 4 — four test groups were green on their first run, so they never demonstrated they can
fail (Strict TDD).**

- Evidence: `apply-progress.md` states it openly — 3.9/3.10 topology "ran GREEN immediately",
  3.13 `pathPortability` likewise, and 3.14's `installed && !launchable` case "passed even before
  the GREEN step". `skills/tdd/SKILL.md` is explicit: "A test that passes before the fix is testing
  nothing", and "when a choice is load-bearing, break it deliberately and confirm the specific test
  that should fail does fail".
- Proposed fix: for the load-bearing one, prove it by mutation and record the result — remove the
  `if (session.parentSessionId !== undefined) this.parentSessions.add(...)` line, confirm
  `opencodeProvider.test.ts > ranks a child below the root and promotes the parent to foreman` goes
  red, and restore it. The others are pins against future edits and can be recorded as such.

**WARNING 5 — `NOT_LAUNCHABLE`'s documentation comment is now false, and this change's own test
proves it.**

- Evidence: `launchProviders.ts:55-66` still says "That case is gone now that every
  `DWARF_PROVIDERS` member is also a `LAUNCHABLE_PROVIDERS` member — so this string is, once again,
  unreachable through any real provider in this build." Both halves are false after this change:
  `DWARF_PROVIDERS` gained `'opencode'`, `LAUNCHABLE_PROVIDERS` did not, and
  `launchProviders.test.ts > marks a detected OpenCode installed but not launchable, with
NOT_LAUNCHABLE as its reason` exercises exactly the reachable case. The tests' own comments say
  the string now has a real provider again.
- Proposed fix: rewrite that paragraph to name OpenCode as the provider that reaches it, and keep
  the "honest copy waiting" sentence, which is still true.

**SUGGESTIONS (coverage polish, none blocking)**

1. `DET-R1` blank-env-over-file for `OPENCODE_STORE_ROOT`: add the one case beside
   `configFile.test.ts:109` with the OpenCode key, so the key's own fall-through is pinned.
2. `DET-R1` OS-invariant default: add `expandHomePath(defaultConfig().providers.opencode.storeRoot,
'/home/j')` asserted through `node:path.join` (the `pathPortability.test.ts:8-15` idiom) so the
   spec's "built for win32, darwin and linux with a fixed `home`" is exercised rather than argued.
3. `DET-R2` measured store shape: assert `snapshot.cwd` equals the normalised `session.directory`
   in `opencodeProvider.test.ts > appears within one scan`.
4. `DET-R5` no ore: seed `tokens_input`/`cost` and assert `'tokensObserved' in dwarf === false` and
   `'cost' in dwarf === false`. (`sessionInsert` hardcodes the token columns to 0; a small seed
   option or a raw INSERT would do.)
5. `DET-R6` panel actions: add an `opencode` case to `actionBar.test.ts` asserting the disabled
   Chat/Kick entries carry `NO_CHANNEL_REASON`, so the scenario is proven for this provider and not
   only for its sibling.
6. `FEED-R3`: assert `lastMessage` redaction (a secret in the newest assistant text) — the code
   does it at `opencodeProvider.ts:228`; only the feed rows are tested today.
7. `runtime.test.ts:5268`: strengthen `not.toHaveBeenCalledWith('opencode')` to
   `not.toHaveBeenCalled()`, as `launchRunner.test.ts` already does (the runtime path in that test
   performs no other detection).
8. Declared delivery deviation: the whole change is one PR of ~1,900 added lines, against D9's
   forecast of four PRs each under 800. The apply run declared `exception-ok`/`size:exception`, so
   this is recorded rather than discovered — but the review load is real, and if the fix for
   CRITICAL 1 or 2 touches the provider again, splitting that follow-up off would be cheaper than
   growing this one.

### Open Maintainer Decisions

1. **Tokens / ore (proposal Q3).** `tokensObserved` is deliberately omitted; the columns are read
   into no field. The live store confirms the columns are populated, so this is a settled
   omission, not a measurement gap. Decide whether a future change publishes raw per-session tokens
   (materials never convert; nothing sums units across materials).
2. **Poll cost of `readOpenCodeEventSeqs` and of `readOpenCodeNewestAssistant`.** Only
   `readOpenCodeEventSeqs` is wrapped in `pollProfiler.measureSync('opencode.eventSeqs', …)`; the
   widening fallback (`WHERE aggregate_id IN (…live ids…)`) is documented and not applied. Also
   note that `readOpenCodeNewestAssistant` selects every `message` row for every live session
   (no `LIMIT`) on each re-read, which the design's cost question does not name — worth a second
   profiler line on a store that has grown for months.
3. **Privacy disposition for the agent nickname (CRITICAL 1).** Scrub it, or publish it on purpose
   and drop the claim. Whichever is chosen, the fixtures README must describe what is actually in
   the files.
4. Row 3 residue (`session_message`/`session_input` for an interactive TUI) is treated as closed
   per the measurements addendum; nothing in the provider reads either table, so re-opening it is
   an enrichment, not a correction.
5. The `BUSY_WINDOW_MS` guard covers a completed-but-not-`stop` row. A session that dies while
   still streaming (`time.completed` never set) stays `busy` until its silence window elapses —
   which the live store demonstrates today (one root is in exactly that state). That is what the
   spec asks for; decide separately whether an hour of "working" for a quit-mid-stream session is
   the reading the panel should keep.

### Verdict

**FAIL** — 30/39 scenarios fully evidenced, no command failures, and two findings that break
stated scenarios (CRITICAL 1 confirmed against the live store, CRITICAL 2 by static analysis).
Both are narrow: scrubbing one identifier and rewording one README paragraph, and removing one
term from one `Math.max`. Fix those, add the two tests they imply, and this change is a clean pass
— the provider itself, its boundaries, its launch gate and its degradation paths all hold up.
