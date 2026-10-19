# Parity exceptions — step cut-5

Cut 5 (ISSUE-249; `21` §2 cut 5) moves no row: every seam-A row was already routed `host` or `ui-local` when the 4b
deletions and the cut-5 legacy-area deletions (ISSUE-242 … ISSUE-248, ISSUE-331 … ISSUE-341) removed today's runtime,
`src/main`, `src/shared` and `src/legacy-bridge`. The switch moves only the release marker of `src/ui-main/ipc/routes.ts`
to `cut-5`. This file lists the step's evidence, the intended differences and the soak record of the deletions. The
intended differences recorded by the cut-0 and later deletions stay where they were recorded (for ISSUE-243:
`parity-cut-0.md`).

## Step and internal build

| Field              | Value                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| Step               | `cut-5`                                                                                                   |
| Internal build     | the merge commit of the cut-5 landing PR of `cut5/legacy-deletions` (pending: the owner's internal build) |
| Route-switch issue | ISSUE-249 (GitHub #962)                                                                                   |
| Pre-cut build      | the release table at the `cut-4b` marker (the same rows; ISSUE-249 moved only the marker)                 |

## Parity suite and run evidence

The exit list of `21` §2 cut 5: router test (no `legacy` owner, no adapter), lint (exclude list empty, `runtime.ts`
canary), registry test, census against the cut-0 base, full L1–L9 on the three OSes. Results observed on Windows 11 Pro
26200 on the integration branch; the macOS and Linux legs run in CI.

| Exit item                                      | Suite                                                                                 | Command                                                                     | Result                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Router test: every row `host` or `ui-local`    | `src/ui-main/ipc/ipc-routing.contract.test.ts`, `describe('release 5 (21 §2 cut 5)')` | `pnpm vitest run src/ui-main/ipc/ipc-routing.contract.test.ts`              | passed (Windows)                                              |
| Router test: no legacy-bridge or shape adapter | same describe (ISSUE-247, ISSUE-249 cases)                                            | same                                                                        | passed (Windows)                                              |
| Lint: legacy exclude list empty                | `scripts/checks/depcruise-rules.test.mjs` (ISSUE-248)                                 | `pnpm vitest run scripts/checks/depcruise-rules.test.mjs`; `pnpm depcruise` | passed; no dependency violation (Windows)                     |
| Lint: `runtime.ts` canary                      | `lint-canaries/R16-runtime` (ISSUE-248)                                               | `pnpm test:canaries`                                                        | passed (Windows)                                              |
| Legacy trees gone                              | `scripts/checks/legacy-trees.test.mjs` (ISSUE-245 … ISSUE-341, ISSUE-246, ISSUE-247)  | `pnpm vitest run scripts/checks/legacy-trees.test.mjs`                      | passed (Windows)                                              |
| Registry test: RETIRE rows and the facade size | the registry cases of ISSUE-249 (`describe('registry after cut 5 (14 §6.5)')`)        | —                                                                           | pending: see "Open exit items" below                          |
| Census against the cut-0 base                  | `docs/test-removals.md`                                                               | `node scripts/checks/census-gate.mjs --base 73193605`                       | passed: 198 losses, each with its `docs/test-removals.md` row |
| Full L1–L9 on three OSes                       | `pnpm test`, `pnpm test:os`, `pnpm test:e2e`                                          | CI release lanes                                                            | pending: the CI runs of the landing PR                        |

The cut-0 base `73193605` is the pre-cut build of `parity-cut-0.md`.

## Intended differences

| Behaviour                           | Legacy build                                                                                      | This step                                                                                                                                                                                           | Decided by                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| The legacy app database             | today's runtime opened `projects-v1.db` at start                                                  | no code opens, reads, converts or deletes `projects-v1.db`; the file stays on the person's disk untouched                                                                                           | ADR-005 item 1, NFR-PERS-15, `21` §5.3 (ISSUE-244; `scripts/checks/no-legacy-db.mjs`) |
| One revert restores one legacy area | each cut-5 issue deletes one legacy area, so one revert restores it                               | the provider, session-launch and text-delivery trees import each other, so they left in one commit and one revert restores the three together; each issue keeps its own static test and census rows | foreman decision D1 (2026-10-18), owner-accepted (`docs/strangler/rollback.md`)       |
| The one-time secret migration       | the 3a and 4a builds moved today's `safeStorage` Jev key and OpenCode password into the Host once | no build reads a legacy `safeStorage` secret file; a profile that never ran a 3a or 4a build keeps that file unread and the person enters the secret again in Settings                              | ADR-017 item 8, `21` §3 row `SecretMigrationBridge` (ISSUE-247)                       |

## Routes moved in this step

None: no row changes owner in cut 5 (`21` §2 cut 5). Only the release marker moved, `cut-4b` → `cut-5`.

## Spikes and variant recorded

None for this step. Variant: the 4b build's.

## Open exit items

- **Registry test after cut 5 (TC-249-02).** Seven RETIRE rows of `14` §2.1 still have a preload member, because the
  renderer still calls them (they answer as a channel with no route): A-14 `getDwarfFeed`, A-16 `watchDwarfFeed`, A-17
  `refreshDwarfTelemetry`, A-18 `setDwarfTuning`, A-P5 (`panel:mine:show`), A-37 `listAgentModels` and A-38
  `launchHeldSession` (`src/contracts/ipc/unrouted.ts` `RETIRED` without a `MEMBER_REMOVED` step). The registry declares
  78 live members, not the 84 of `14` §7 after cut 5: six NEW rows are not declared yet. Both need work outside this
  switch (the renderer readers, the issues that declare the NEW rows), so the two registry cases are not written yet.
- **Full L1–L9 on the three OSes.** The CI runs of the landing PR.

## Soak record for the deletion

The cut-5 deletion work units merge only after the internal build met every step's exit criteria on the three OSes and
then ran for 7 days of normal use with no blocking problem (the soak, OQ-71; owner 2026-10-18: one soak at the end of
cuts 3a–4b, recorded once in [`soak-record.md`](soak-record.md)).

| Field                        | Value                                                   |
| ---------------------------- | ------------------------------------------------------- |
| Soak record                  | [`soak-record.md`](soak-record.md)                      |
| Retirement or deletion issue | ISSUE-242 … ISSUE-248, ISSUE-331 … ISSUE-341, ISSUE-249 |
