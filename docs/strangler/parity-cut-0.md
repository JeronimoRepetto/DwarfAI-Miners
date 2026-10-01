# Parity exceptions — step cut-0

The parity record of cut 0 (`21-migration-plan.md` §1 item 3, §2 cut 0 and note 1; ISSUE-056). Append-only: one entry
per PR (`22-roadmap.md` §5).

## Step and internal build

| Field              | Value                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Step               | `cut-0`                                                                                                         |
| Internal build     | branch `feat/issue-056-cut-0-route-switch` (ISSUE-056); the internal build artifact is recorded when it is made |
| Route-switch issue | ISSUE-056                                                                                                       |
| Pre-cut build      | `origin/main` at `73193605`, built with `pnpm build`; its Electron entry is the legacy `out/main/index.js`      |

## Parity suite and run evidence

The suite `21` §2 names for this step: the **legacy seam-A replay** (note 1). Every row the cut-0 table serves `legacy`
(`src/ui-main/ipc/routes.ts`) is called, or for a push listened to, through the renderer's own `window.api` in the
app's window, against the simulated fixture world (`fixtures/ipc/seam-a-replay/cut-0/scenario.json`: 41 calls over the
39 `legacy` call rows and 4 push rows, A-12…A-20, A-23, A-25…A-27, A-30…A-44, A-47…A-55, A-P2…A-P5 and the two
`14` §8 I-21 rows). The answers and pushes, recorded on the pre-cut build by `scripts/strangler/record-seam-a.mjs`,
must be byte-equal on the cut-0 build in canonical form (keys sorted; per push row, its distinct payloads in the order
first seen).

- The one masked field is `updatedAt`, the wall clock at which the simulated world dates its mines
  (`WALL_CLOCK_KEYS`, `scripts/strangler/seamAReplay.ts`). Nothing else is masked.
- A run is isolated from the machine: the per-user folders point into the profile, `PATH` holds only the ISSUE-313 stub
  CLIs, the Node that runs them and the OS's own folders, and the OS pickers answer "cancelled" (A-30), so no run reads
  a person's data and every machine detects the same providers.
- The recording is per OS (`recording.<platform>.json`): the simulated world's mine ids carry the OS's path separator.
- The Windows recording was made twice on the pre-cut build with the same bytes. Breaking the hop on purpose (today's
  answers given an extra field through `LegacyRuntimeRoute`) failed the replay; undone, it passed again.

| Suite                                                | Command                                                                 | Internal build | OS                   | Result                             | Date       |
| ---------------------------------------------------- | ----------------------------------------------------------------------- | -------------- | -------------------- | ---------------------------------- | ---------- |
| Legacy seam-A replay (recorded on the pre-cut build) | `node scripts/strangler/record-seam-a.mjs --app <pre-cut build folder>` | `73193605`     | Windows 11 Pro 26200 | recorded (`recording.win32.json`)  | 2026-10-01 |
| Legacy seam-A replay                                 | `pnpm test:e2e` (`e2e/cut-0/seam-a-replay.e2e.ts`)                      | ISSUE-056      | Windows 11 Pro 26200 | passed                             | 2026-10-01 |
| Legacy seam-A replay                                 | the same, after `record-seam-a.mjs` on the pre-cut build of the OS      | ISSUE-056      | macOS                | pending: recording and run (owner) |            |
| Legacy seam-A replay                                 | the same, after `record-seam-a.mjs` on the pre-cut build of the OS      | ISSUE-056      | Linux                | pending: recording and run (owner) |            |
| Router and registry (L6)                             | `pnpm vitest run src/ui-main/ipc/ipc-routing.contract.test.ts`          | ISSUE-056      | Windows 11 Pro 26200 | passed                             | 2026-10-01 |
| The moved L9 cases (TC-056-06)                       | `pnpm test:e2e` (`e2e/cut-0/**`)                                        | ISSUE-056      | Windows 11 Pro 26200 | passed (18 of 18 in the lane)      | 2026-10-01 |
| The moved L9 cases (TC-056-06)                       | `pnpm test:e2e`, CI release lane (`e2e` label)                          | ISSUE-056      | macOS, Linux         | pending (CI)                       |            |

### The cut-0 exit list (TC-056-05; `21` §2 cut 0 "Exit criteria")

| Exit item                                                                                                              | Evidence (all run on Windows 11 Pro 26200, 2026-10-01; macOS and Linux run in CI and on the owner's machines)                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L3 contracts of every kernel port                                                                                      | `pnpm test` (the `run*Contract` suites of `src/host/kernel/**`): passed                                                                                                                       |
| L5 schema suite (snapshot, pragmas, FK coverage, STRICT, tamper, future file, `NOT_A_DWARFAI_DB`, dev guard, template) | `pnpm test` (`src/host/platform/sqlite/**`): passed                                                                                                                                           |
| L6 seam B transport suite in-process, and over a real pipe or socket                                                   | `pnpm test` (in-process) and `pnpm test:os` after `pnpm build:native --arch x64` (real pipe): passed                                                                                          |
| ADR-002 L8 tests and the D8 upgrade handshake, the older-UI rule                                                       | `pnpm test:os` (`src/ui-main/hostLauncher/*.os.test.ts`) and `pnpm test`: passed                                                                                                              |
| Stop everything and quit with a fixture legacy-launched session                                                        | `e2e/cut-0/stop-all-legacy-first.e2e.ts` and `e2e/cut-0/tray-stop-everything.e2e.ts`: passed                                                                                                  |
| A session that cannot be ended keeps the Host, the windows and the tray                                                | `e2e/cut-0/stop-all-legacy-first.e2e.ts` (today's runtime finds its probe but not its kill, so its end is refused and nothing is signalled): passed; also L2 `src/ui-main/index.cut0.test.ts` |
| Registry completeness and router tests, with the `shape` of every route                                                | `src/ui-main/ipc/ipc-routing.contract.test.ts`, `src/contracts/ipc/channels.contract.test.ts`, `src/preload/preload.contract.test.ts`: passed                                                 |
| Canary job R1–R19                                                                                                      | `pnpm test:canaries`: 23 of 23 canaries report exactly their rule                                                                                                                             |
| The legacy seam-A replay                                                                                               | above                                                                                                                                                                                         |
| Census shows no silent loss                                                                                            | `node skills/test-safety/assets/test-census.mjs --base 73193605`: no file lost test statements                                                                                                |

## Intended differences

| Behaviour                                            | Legacy build                                                                                                      | This step                                                                                                                                                                  | Decided by                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| The renderer's sandbox                               | `sandbox: false`, ES-module preload                                                                               | the Panel runs with `sandbox: true` and the generated CommonJS preload, on Windows (record `S-019-1`, verdict partial: macOS and Linux are its owner steps)                | ADR-019 item 1; `spike-results/S-019-1.md` Decision                                                              |
| The tray                                             | "Show/Hide Panel", "Start with the system" and "Instant updates" checkboxes, Quit (ends the app); a click toggles | the rebuilt `ElectronTray`: Open, Quit (windows close, the app, the icon and every session stay), Stop everything and quit; a click opens (Windows, Linux)                 | ADR-018 item 5; ADR-002 D7; `16` §4.14 `TrayController`; OQ-44, OQ-47                                            |
| "Start with the system" and Claude "Instant updates" | toggled from the tray                                                                                             | not offered in cut 0 (the frozen tray menu has no such items); their stored states keep applying (the login entry is unchanged; the installed hooks are restored at start) | `16` §4.14 `TrayMenuModel`; `21` §2 (cut 1: "Start with the system", machine 40; cut 2: the Claude-hooks toggle) |
| A background process                                 | none                                                                                                              | the DwarfAI Host runs for the profile, owns nothing yet and never exits on its own; the tray's Stop everything and quit stops it                                           | ADR-002 D1, D7; OQ-63                                                                                            |
| The Stop everything confirmation's count             | (no Stop everything)                                                                                              | counts the Host-owned sessions only, so through cut 4 it omits the sessions today's runtime launched, which are still ended first                                          | OQ-78 (amendment A10-03 declined); `14` §2.2 A-N25 Notes; `21` §3 `LegacyEndFirstAdapter`                        |
| The tray's Quit and the Panel window                 | Quit ended the app                                                                                                | Quit hides the Panel (its page stays loaded) and the app keeps running; nothing ends                                                                                       | ADR-018 item 5; OQ-44, OQ-47 (hiding rather than closing: see "A note on Quit" below)                            |

A note on Quit. ADR-018's Quit "closes every window". The Panel use case now reads whether its window is shown back
from the window (the visibility read-back of the owner-approved amendment to `16` §4.14, 2026-10-01), so a Panel the OS
closed no longer reads as shown. Its other read-backs (`bounds`, `applyZoom`) still act on "the Panel window the factory
built, building it if there is none", and the use case keeps re-fitting a window it built once, so after a real close a
display change would build a new hidden Panel. Cut 0 has one mode window, no window-bound `ui` connection and no UI-main
session store yet (ISSUE-059), so the tray's Quit hides the Panel: the person sees every window go, as the ADR asks. A
"closed" signal or an "exists" read-back for the window module is a lead decision.

## Routes moved in this step

Rows of `src/ui-main/ipc/routes.ts` this step changes (ids of `14-ipc-contract.md` §2). Every other row stays `legacy`
with `shape: 'today'`, the RETIRE rows included; A-N33 stays unrouted (`'generation-2'`).

| Row                                                                                                        | Qualifier | Route before                           | Route after                                                            | Shape    |
| ---------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------- | ---------------------------------------------------------------------- | -------- |
| A-01…A-11, A-21, A-22, A-24, A-28, A-29, A-45, A-46, A-56, A-57, A-P1, A-P6, A-X1 (KEEP)                   | none      | `legacy` (`today`)                     | `ui-local`, `since: 'cut-0'`, `parity: 'passed'`                       | `target` |
| A-N03, A-N04, A-N05, A-N30, A-N25, A-N27, A-N34 (NEW; A-N34 by the owner-approved amendment of 2026-10-01) | none      | unrouted (`unrouted.ts`, step `cut-0`) | `ui-local`, `since: 'cut-0'`, `parity: 'n/a'`                          | `target` |
| A-N26 (NEW)                                                                                                | none      | unrouted (`unrouted.ts`, step `cut-0`) | `host` through `LegacyEndFirstAdapter`, B-M05 only, `parity: 'passed'` | `target` |

A KEEP row's target shape is today's (`14` §2.1), so the renderer calls it unchanged and the generated preload keeps
today's coercions for it. The Electron entry moved with the rows: `package.json` `main` is `out/ui-main/index.js`,
built from `src/ui-main/index.ts`; the legacy `src/main/index.ts` stays in the tree, unbuilt, and today's runtime is
reached only through `LegacyRuntimeRoute`, which composes it without its window, tray and shortcut while the table
serves the window family `ui-local`.

## Spikes and variant recorded

| Spike   | Record                     | Outcome                                                                                                                              |
| ------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| S-019-1 | `spike-results/S-019-1.md` | partial: passed on Windows; the renderer runs sandboxed; macOS and Linux are owner steps                                             |
| SP-03   | `spike-results/SP-03.md`   | partial: the copy rule of ADR-002 D5 is confirmed as written on Windows; the signed `.app`, AppImage and deb layouts are owner steps |
| S-015-2 | `spike-results/S-015-2.md` | partial: ADR-015 item 4 is used as written, every decision logged; the proposed table awaits owner steps W1–W7 and P0–P3             |
| SP-02   | `spike-results/SP-02.md`   | partial: the Windows start path stays ADR-002 D6 as written                                                                          |
| SP-04   | `spike-results/SP-04.md`   | partial: `node:sqlite` kept under `ELECTRON_RUN_AS_NODE` (no `better-sqlite3` fallback)                                              |
| SP-05   | `spike-results/SP-05.md`   | partial: the native DACL helper adopted for the Host's pipe (ADR-003 item 2's own fallback)                                          |

The owner decided on 2026-10-01 that the partial records (Windows only) are enough for this step to merge; the macOS and
Linux steps run after cut 0, and a failure there goes back to the lead as each record says.

Variant: the cut-0 build ships no driver and no provider route: every provider row stays `legacy`.

## Soak record for the deletion

The step's retirement work unit (ISSUE-058) merges only after this internal build met the step's exit criteria on the
three OSes and then ran for 7 days of normal use with no blocking problem (the soak, OQ-71).

| Field                        | Value          |
| ---------------------------- | -------------- |
| Exit criteria met on Windows | the runs above |
| Exit criteria met on macOS   | pending        |
| Exit criteria met on Linux   | pending        |
| Soak build                   | pending        |
| Soak start                   | pending        |
| Soak end                     | pending        |
| Blocking problems            | pending        |
| Retirement or deletion issue | ISSUE-058      |
