# Parity exceptions — step <step id>

<!--
Template for docs/strangler/parity-cut-<n>.md (migration plan `21-migration-plan.md` §1 item 3 and §2 of the
architecture package). The route-switch issue of each release step copies this file to
docs/strangler/parity-cut-<step id>.md (0, 1, 2, 3a, 3b, 3d, 3e, 4a, 4b, 5), fills every section and deletes
this comment. Rules:

- A family's legacy code is deleted only after its Host route reached `parity: 'passed'` in an internal build.
- Parity is measured by the suite that `21` §2 names for the step, against recorded fixtures.
- Every intended difference is a row of the table below, and its `Decided by` cell names the ADR item (for example
  `ADR-006 item 7`) or the owner answer (for example `OQ-78`) that decides it. A difference that is not listed fails
  parity.
- The file is append-only: one entry per PR (`22-roadmap.md` §5).
-->

## Step and internal build

| Field              | Value                                           |
| ------------------ | ----------------------------------------------- |
| Step               | `<step id>`                                     |
| Internal build     | `<commit or CI artifact of the internal build>` |
| Route-switch issue | `<ISSUE-nnn>`                                   |
| Pre-cut build      | `<commit or CI artifact compared against>`      |

## Parity suite and run evidence

The suite `21` §2 names for this step: `<suite, for example "Observer parity" and "Board parity" for cut 1>`.

| Suite     | Command     | Internal build | OS                      | Result              | Date           |
| --------- | ----------- | -------------- | ----------------------- | ------------------- | -------------- |
| `<suite>` | `<command>` | `<build>`      | `<Windows/macOS/Linux>` | `<passed / failed>` | `<YYYY-MM-DD>` |

## Intended differences

| Behaviour | Legacy build | This step | Decided by |
| --------- | ------------ | --------- | ---------- |

## Routes moved in this step

Rows of `src/ui-main/ipc/routes.ts` this step changes (ids of `14-ipc-contract.md` §2).

| Row      | Qualifier                       | Route before                 | Route after                  | Shape              |
| -------- | ------------------------------- | ---------------------------- | ---------------------------- | ------------------ |
| `<A-nn>` | `<provider or origin, or none>` | `<legacy / host / ui-local>` | `<legacy / host / ui-local>` | `<today / target>` |

## Spikes and variant recorded

| Spike     | Record                  | Outcome                               |
| --------- | ----------------------- | ------------------------------------- |
| `<SP-nn>` | `spike-results/<ID>.md` | `<passed / failed, fallback adopted>` |

Variant: `<the variant this build ships; for step 3a: the Claude driver offered, or the observe-only variant (OQ-67)>`.

## Soak record for the deletion

The step's retirement or deletion work unit merges only after this internal build met the step's exit criteria on
the three OSes and then ran for 7 days of normal use with no blocking problem (the soak, OQ-71).

| Field                        | Value                                      |
| ---------------------------- | ------------------------------------------ |
| Exit criteria met on Windows | `<evidence>`                               |
| Exit criteria met on macOS   | `<evidence>`                               |
| Exit criteria met on Linux   | `<evidence>`                               |
| Soak build                   | `<commit or CI artifact>`                  |
| Soak start                   | `<YYYY-MM-DD>`                             |
| Soak end                     | `<YYYY-MM-DD>`                             |
| Blocking problems            | `<none, or the issues that reported them>` |
| Retirement or deletion issue | `<ISSUE-nnn>`                              |
