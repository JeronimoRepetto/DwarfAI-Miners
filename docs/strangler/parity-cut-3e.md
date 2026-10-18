# Parity exceptions — step cut-3e

The step-3e switch (ISSUE-188; `21` §2 cut 3 row 3e) moves Antigravity's send, console and catalog rows (A-23, A-13,
A-36) to the Host, qualified by provider, in every build, and its launch row (A-35 with its Retry path) in development
builds only: `DEVELOPMENT_BUILD_ROUTES`, added by `routesForBuild` from the one build flag (ADR-009 D6; R-03, OQ-15).
Public builds keep Antigravity `publicLaunch: 'gated'`: no chip, no Jev candidate, no default provider, no delegated
worker, while its sessions are still observed. After 3e, OpenCode (moved in 4b) is the only provider whose launch, send
and stop rows are still `legacy`. This file lists the step's evidence, every intended difference with what decides it,
and the owner-only runs still pending.

## Step and internal build

| Field              | Value                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Step               | `cut-3e`                                                                                                                    |
| Internal build     | branch `feat/issue-188-route-switch-3e` (ISSUE-188); the internal build artifact is recorded when it is made                |
| Route-switch issue | ISSUE-188                                                                                                                   |
| Pre-cut build      | the 3d table as it shipped (`src/ui-main/ipc/testing/cut3dRoutes.ts` pins it), over the step-3e Host of the issues upstream |

## Parity suite and run evidence

The exit list of step 3e (`21` §2 cut 3 row 3e "Parity / exit", `21-migration-plan.md:219`, with the common rules of
cut 3), each item with its criterion and its named evidence (TC-188-04). Every issue that produces this evidence is
upstream of the switch: ISSUE-156 (`AntigravityNdjsonDriver`, its fixtures and its public-build test), ISSUE-182 (the
wired Host the flows boot) and ISSUE-186 (the 3d switch, which holds 3a and 3b).

- **C-01…C-05, C-16, C-18 for `AntigravityNdjsonDriver`** (TC-188-03):
  `src/host/modules/suppliers/adapters/drivers/antigravity-ndjson/AntigravityNdjsonDriver.conformance.test.ts`
  (ISSUE-156): the generic `driverConformance` cases over `fixtures/antigravity/ndjson/1.1.26-synthetic/` and the
  driver's own cases (`[C-05]` the prompt and every turn on stdin, never `-p`; `[C-16]` resume with
  `agy --conversation <id>`, AMENDMENT-13; `[C-01, ADR-020]` readiness once `init` named the conversation; `[C-23,
INV-59]` the `childEnv` allowlist; `[ADR-008]` no print or auto-approve flag). ISSUE-188 adds `[C-02, ADR-029]` a
  Windows script entry started by the person's `node`, never through a shell (the E2E stub is one).
- **C-22** (TC-188-03): **not applicable**: SP-10 records no deny policy for Antigravity (below), so the profile offers
  no permission mode and no `policy-only` launch exists to test; the conformance options name the reason, and the
  driver's own `[C-22, SP-10]` case proves a launch has permission `none` and no deny flag.
- **The public-build test** (TC-188-02): `src/ui-main/ipc/publicBuild.3e.test.ts` "[ADR-009] a 3e public build offers
  Antigravity on no launch surface, as no Jev candidate, no default provider and no delegated worker, and still
  observes it" (the router's half: no `host` A-35 route for Antigravity, the merged A-36 catalog without Antigravity,
  A-50 the Host's, A-13/A-23 the Host's, the legacy feed down to legacy-launched sessions), with the Host's half
  `src/host/modules/suppliers/adapters/drivers/antigravity-ndjson/publicBuild.test.ts` (ISSUE-156: no launchable
  Antigravity entry, no Jev candidate, no attached driver in a public build; the observation adapter still reads it)
  and `src/host/wiring/flows/suppliers.test.ts` (the build flag per build kind). Routing A-35 `host` for Antigravity in
  a public build makes the public-build test fail (proven on 2026-10-18, then undone).
- **Router cases** (TC-188-01): `src/ui-main/ipc/ipc-routing.contract.test.ts` `describe('release 3e (21 §2 cut 3e)')`:
  the Antigravity-qualified rows `host` in a development build, "A-27, A-P3 and A-P4 route legacy qualified to OpenCode
  only" in either build, seam-B births and parity, the legacy feed, and the 3e rollback; with the 3e rollback case of
  `src/ui-main/ipc/rollbackTable.test.ts`.
- **L2 flow**: `src/host/wiring/flows/antigravity-step-3e.test.ts` "[ADR-001, C-01, C-05] in a development build an
  Antigravity launch through the wired Host runs a turn, takes a sent message and stops", over the wired Host
  (`flows/testing/cut3aHost.ts`), now that `createSuppliers` attaches `AntigravityNdjsonDriver` as `host/main.ts`
  composes it. Without that attachment the launch never succeeds, so it bites.
- **L9 E2E** (`17` §1.9): `e2e/cut-3e/antigravity-dev-launch.e2e.ts` "[ADR-001] in a development build an Antigravity
  stub dwarf launches, receives a message and stops through the Host": the renderer's A-35 starts the stub `agy`
  (`e2e/cut-3e/agyStreamStub.mjs`) through the Host, the dwarf is Owned, A-23 is a second stream-json turn, and A-N29
  ends the stub's process with the dwarf departing `stopped`. On the 3d table it fails at the catalog (no Host entry).

| Suite                                         | Command                                                                          | Internal build                   | OS                    | Result          | Date       |
| --------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------- | --------------------- | --------------- | ---------- |
| Router cases, public-build test, rollback     | `pnpm vitest run src/ui-main/ipc`                                                | `feat/issue-188-route-switch-3e` | Windows               | passed          | 2026-10-18 |
| `AntigravityNdjsonDriver` conformance, public | `pnpm vitest run src/host/modules/suppliers/adapters/drivers/antigravity-ndjson` | `feat/issue-188-route-switch-3e` | Windows               | passed          | 2026-10-18 |
| L2 Antigravity flow                           | `pnpm vitest run src/host/wiring/flows/antigravity-step-3e.test.ts`              | `feat/issue-188-route-switch-3e` | Windows               | passed          | 2026-10-18 |
| L9 E2E (Antigravity stub `agy`)               | `pnpm exec playwright test -c playwright.config.ts e2e/cut-3e`                   | `feat/issue-188-route-switch-3e` | Windows               | passed          | 2026-10-18 |
| The release lanes (TC-188-03)                 | `pnpm test:e2e`, `pnpm test:os`                                                  | the 3e internal build            | Windows, macOS, Linux | pending (owner) |            |
| Real-CLI conformance (recorded agy fixtures)  | `pnpm test:real-cli`                                                             | the 3e internal build            | Windows, macOS, Linux | pending (owner) |            |

## Intended differences

| Behaviour                                      | Legacy build                                                                                     | This step                                                                                                                                                                                 | Decided by                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Launching Antigravity in a development build   | today's held agy session (`antigravityHeldSession.ts`), held by the window's main process        | the Host's `AntigravityNdjsonDriver`: a Host-owned session that survives closing the window, with the five ADR-020 causes and Retry                                                       | `21` §2 row 3e; ADR-009 D4, D6; ADR-020 D1                          |
| Antigravity in a public (packaged) build       | every build before cut 5 offered it (`CatalogMergeAdapter` listed today's launchable agy, OQ-66) | offered on no launch surface: the public Host lists no gated entry, so no chip, no "Default provider" option, no Jev candidate and no delegated worker; its sessions are still observed   | ADR-009 D6 (PO #82); R-03; OQ-15                                    |
| Antigravity's launch row in a public build     | today's runtime                                                                                  | no `host` route (`DEVELOPMENT_BUILD_ROUTES` is a development build's only); A-35 for it reaches `PerProviderShapeAdapter` until the 3e deletion, though no surface offers it              | `21` §2 row 3e "launch rows only in development builds"; ADR-009 D6 |
| A gated entry on the Add panel                 | the renderer kept a `publicLaunch: 'gated'` entry off the chips                                  | every installed entry the Host lists is a chip: the Host already leaves gated ones out of a public build, and development builds keep them launchable (`supplierEntries.ts`)              | ADR-009 D6 "Development builds keep it launchable"                  |
| Jev candidates                                 | Claude, Codex                                                                                    | Claude, Codex; Antigravity in development builds only (Codex; Antigravity in development builds only, in the observe-only variant)                                                        | `21` §2 "Let Jev choose (each step)", row 3e; OI-21-4               |
| Permission modes for Antigravity               | today's held session ran agy with its own settings                                               | none offered: SP-10 records no deny policy (`15` §2.8); agy hands no ask on this stream, so every answer is `ask-closed`                                                                  | `15` §4.8; SP-10; ADR-008 item 3                                    |
| Send, console and stop of an Antigravity dwarf | today's runtime (A-23, A-13), and A-N29 through the Host since 3a                                | the Host for each, in either build: A-23 `conversation.send` (one stream-json user line), A-13 `conversation.resolveConsole` (`log`), A-N29 `crew.stop` (close stdin, then the tree kill) | `21` §2 cut 3 common rules; `15` §4.8; ADR-014                      |
| Antigravity sessions in today's feed           | every Antigravity session today's runtime discovered                                             | only the sessions today's runtime launched (for `LegacyEndFirstAdapter`); the Host observes the rest                                                                                      | `21` §3 `LegacyAgentRegistryFeed`                                   |
| A-27, A-P3, A-P4 for an Antigravity dwarf      | `legacy`, qualified to Antigravity                                                               | no route: their successors are B-F10, B-F19 and B-F12; the three rows are qualified to OpenCode only                                                                                      | `21` §2 cut 3 common rules, row 3e                                  |
| Windows script entry of agy                    | not applicable (today's held session spawned `agy` through `node:child_process`)                 | a resolved script entry is started by the person's `node` (`adapterLaunch`), never through a shell; agy's own `agy.exe` is started as it is                                               | ADR-029 row 8 (#1360); R17                                          |

## Routes moved in this step

Rows of `src/ui-main/ipc/routes.ts` this step changes (ids of `14-ipc-contract.md` §2).

| Row              | Qualifier               | Route before                               | Route after                                                                          | Shape  |
| ---------------- | ----------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ | ------ |
| A-35 (and Retry) | `provider: antigravity` | `legacy` through `PerProviderShapeAdapter` | `host` (`launching.launch`, B-M33) in a development build; unchanged in a public one | target |
| A-36             | `provider: antigravity` | `legacy` through `CatalogMergeAdapter`     | `host` (`suppliers.launchable`, B-M37)                                               | target |
| A-23             | `provider: antigravity` | `legacy` through `PerProviderShapeAdapter` | `host` (`conversation.send`, B-M24)                                                  | target |
| A-13             | `provider: antigravity` | `legacy` through `PerProviderShapeAdapter` | `host` (`conversation.resolveConsole`, B-M29)                                        | target |
| A-N29            | none                    | `host` since 3a, every dwarf               | unchanged: its one `host` route serves Antigravity dwarfs                            | target |
| A-27, A-P3, A-P4 | `provider: antigravity` | `legacy` (today's runtime, today's shape)  | no route (OpenCode's row only)                                                       | today  |

No seam B member and no NEW row is born in 3e; `unrouted.ts` is unchanged. Today's Antigravity launch
(`antigravityHeldSession.ts` composition in `runtime.ts`) is no longer reachable through the router in a development
build and is deleted after the soak by ISSUE-189. A 3e rollback build is the 3d table again, from either build's table
(`docs/strangler/rollback.md` "Step 3e note").

## Spikes and variant recorded

| Spike                    | Record                                                                   | Outcome                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SP-10 (Antigravity part) | `spike-results/SP-10.md` "Antigravity part" and "Antigravity 1.4.2 help" | **not run**: the owner cannot log in to Antigravity (owner waiver 2026-10-18); agy 1.4.2's help lists no deny option, so no deny policy is recorded and no permission mode is offered. The launch row stays development-only anyway (`21` §2 row 3e entry, R-03) |

Variant: **Antigravity launched through `AntigravityNdjsonDriver`** (`ndjson`, `15` §4.8), development builds only.
Its fixtures are synthetic (`fixtures/antigravity/ndjson/1.1.26-synthetic/meta.json`); a real recording is pending.

## Pending, owner-only

Items of the step's exit that neither CI nor an agent can complete (AGENTS §0.3). Each is filled in this file when its
run exists.

- **TC-188-03, the 3e internal build on Windows, macOS and Linux:** C-01…C-05, C-16, C-18 of `AntigravityNdjsonDriver`
  and the cut-3e E2E in the release lanes, each run linked in the table above.
- **A real agy recording** to replace the synthetic fixtures, and a real-CLI launch of a development build, once the
  owner can log in to Antigravity (owner waiver 2026-10-18).
- **SP-10 (Antigravity part)** with a real agy session; until then no permission mode is offered.
- **A-13 "Open console" live check per OS** for a Host-launched Antigravity dwarf (ADR-031).
- **The soak** (OQ-71), below.

| Item                        | OS      | Run by and date | Evidence |
| --------------------------- | ------- | --------------- | -------- |
| 3e internal build lanes     | Windows |                 |          |
| 3e internal build lanes     | macOS   |                 |          |
| 3e internal build lanes     | Linux   |                 |          |
| Real agy launch (dev build) | Windows |                 |          |
| Real agy launch (dev build) | macOS   |                 |          |
| Real agy launch (dev build) | Linux   |                 |          |
| A-13 console live check     | Windows |                 |          |
| A-13 console live check     | macOS   |                 |          |
| A-13 console live check     | Linux   |                 |          |

## Soak record for the deletion

The step's deletion work unit (ISSUE-189) merges only after this internal build met the step's exit criteria on the
three OSes and then ran for 7 days of normal use with no blocking problem (the soak, OQ-71).

| Field                        | Value     |
| ---------------------------- | --------- |
| Exit criteria met on Windows | pending   |
| Exit criteria met on macOS   | pending   |
| Exit criteria met on Linux   | pending   |
| Soak build                   | pending   |
| Soak start                   | pending   |
| Soak end                     | pending   |
| Blocking problems            | pending   |
| Retirement or deletion issue | ISSUE-189 |
