# Soak record — retirements and cut 5

The one soak of the strangler rebuild (OQ-71; owner decision 2026-10-18): after cuts 3a–4b shipped, one internal build
meets every step's exit criteria on the three OSes and then runs for 7 days of normal use with no blocking problem. Only
then do the retirement and deletion work units land, in a row: ISSUE-142, ISSUE-187, ISSUE-189, ISSUE-185, ISSUE-184,
ISSUE-236, ISSUE-239, ISSUE-240, ISSUE-241 and the cut-5 deletions (`21` §2, §2.1 item 4).

Each parity file's "Soak record for the deletion" points here; the soak is recorded once, by the owner.

| Field                        | Value                                                           |
| ---------------------------- | --------------------------------------------------------------- |
| Exit criteria met on Windows | not recorded: soak waived (CI lanes green on PR #1452)          |
| Exit criteria met on macOS   | not recorded: soak waived (CI lanes green on PR #1452)          |
| Exit criteria met on Linux   | not recorded: soak waived (CI lanes green on PR #1452)          |
| Soak build                   | CI package run 39233075231 on main 55f461e3 (built, not soaked) |
| Soak start                   | waived                                                          |
| Soak end                     | waived                                                          |
| Blocking problems            | none known at the waiver                                        |

**Waived by the owner on 2026-10-19.** The owner chose to merge cut 5 (PR #1452) without the 7-day soak. From this
merge on there is no rollback to legacy routes, only forward fixes (AGENTS §5). Problems found in later use are filed as
bugs.
