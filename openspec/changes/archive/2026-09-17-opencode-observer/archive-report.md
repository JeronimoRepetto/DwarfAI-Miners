# Archive Report: opencode-observer

**Date**: 2026-09-17  
**Change**: opencode-observer  
**Issues**: #444 (proposal/design/spec), #453 (follow-up verification)

## Executive Summary

The opencode-observer change has been fully implemented, verified, and archived. The change
introduced four new OpenSpec capabilities for observing OpenCode sessions in the DwarfAI Miners
panel. All 17 requirements across 4 specs verified pass, with 39/39 scenarios confirmed. The change
merged to main in PR #452 (commit da6eeb5), followed by six follow-up commits in PR #453 that
addressed spec amendments and test corrections, all verified on 2026-09-17. Four new capability
specs were promoted from change deltas to authoritative main specs under `openspec/specs/`.

## What Shipped

### PRs and Commits

- **PR #452**: Initial opencode-observer merge to main (commit da6eeb5)
- **PR #453**: Follow-up verification and spec amendments (commits 16f07d3, 2021d6e, deb9b66,
  bd747a1, cefc836, 1eface1, HEAD 1ab817f)
- **Merged**: 2026-09-17 to main at `origin/main f61c6ed`
- **Total changes**: +300 / -15 lines (9 files touched)

### New Capabilities (4 specs created)

1. **opencode-store-evidence** (`SE-R1` through `SE-R4`)
   - Evidence bar for committed redacted fixtures and `docs/opencode-format.md`
   - Version stamp, confidence legend, fixture set, measurement verdicts recorded
   - 8/8 requirements verified pass (inspection-based; no test layer)

2. **opencode-session-detection** (`DET-R1` through `DET-R7`)
   - Live OpenCode session discovery from `opencode.db`
   - Configuration layering (env → file → default), OS-invariant home expansion
   - Graceful degradation when store is missing or unreadable
   - 14/14 requirements verified pass; 4 closed by #453 amendments

3. **opencode-session-feed** (`FEED-R1` through `FEED-R3`)
   - Last assistant reply, message paging, and feed redaction at provider boundary
   - No transcript path; data read only from `message` and `part` rows in `opencode.db`
   - 12/12 requirements verified pass (pre-existing evidence from prior phases)

4. **opencode-session-topology** (`TOPO-R1` through `TOPO-R4`)
   - Parent-child edges for session trees; foreman role for observed parents
   - Attendance always `'unknown'` until measured; silence window per role and attendance
   - Child session rank below root; edge applied after full scan
   - 10/10 requirements verified pass; 1 scenario removed as dead branch (#453 amendment)

**Total verified**: 17 requirements / 39 scenarios, 100% pass rate

### Implementation Test Coverage

Test run from verify-report:

```
node node_modules/vitest/vitest.mjs run \
  src/main/config/configFile.test.ts \
  src/main/providers/pathPortability.test.ts \
  src/main/providers/opencode \
  src/renderer/src/lib/delivery/actionBar.test.ts \
  src/main/domain/launchProviders.test.ts
```

**Result**: 9 test files, 183 tests, 0 failed, exit 0  
**Build**: electron-vite build, exit 0, all three targets  
**Census**: net +6 tests across 5 files, 0 lost (matches apply-progress)

## Spec Amendments in #453

Two spec amendments were recorded during final verification:

1. **DET-R6 (Panel actions for observed OpenCode dwarf)**: Updated scenario text to reflect that
   Kick was not disabled with `NO_CHANNEL_REASON` since #293. The control decides WHICH kick to
   offer (dismiss vs. interrupt), not WHETHER to offer a kick. Referenced in `contracts.ts`
   `DwarfCapabilities.cancel` doc comment. Updated spec now accurate; three new tests confirm
   behavior for `provider: 'opencode'`.

2. **TOPO-R1 (Row 4 closed positive)**: Scenario originally describing "Row 4 unobserved" (negative
   default) was removed as dead branch. A second interactive TUI turn on 2026-09-17 confirmed Row 4
   closed positive: a Task subagent's session row does carry `parent_id` naming the delegating
   session. The scenario is replaced by its positive counterpart with the measured evidence. Per
   `docs/opencode-format.md` row 4 and the Task implementation verified in #453, the negative
   default is no longer reachable.

## Domain Invariants Touched

The implementation respects and applies existing domain rules:

- **Silence windows differ by role and attendance, not by rank**: Unproven root keeps the long
  window; attendance `'unknown'` stays distinct from `'attended'`. See #47, #68.
- **Materials never convert**: `tokensObserved` is raw per-session tokens or nothing; no
  cross-material sums. See `vault.ts` invariant comment.
- **Delivered vs. reacted are different facts**: No delivery channel for OpenCode sessions; data
  read only from store, never approximated. Absence beats guessed.
- **Provisional tier must never seal a value**: Measurement verdicts recorded (positive/negative)
  before any provider code written. See #41.

## Deviations and Corrections

Two deviations discovered during #453 re-verification were judged correct:

1. **WARNING 4 mutation test**: `roleOf()` returns `'foreman'` when EITHER `parentSessions.has()`
   OR `parentSessionId === undefined`. The substitute test (promotes middle-tier worker to foreman)
   is load-bearing because it is the only case where the session HAS its own `parentSessionId` (so
   starts from `'worker'` branch) AND is simultaneously somebody else's parent.

2. **DET-R6 scenario correction**: `kickAction()` never returns `NO_CHANNEL_REASON` — that belongs
   to `chatAction` alone. When `capabilities.cancel` is null, `kickAction` returns DISMISS_HINT,
   ENDED_DISMISS_HINT, or OPEN_TURN_NO_INTERRUPT_HINT depending on turn state. The scenario
   amendment reflects the actual behavior decided in #293.

Both deviations were verified by direct source inspection and re-running tests in the dedicated
worktree.

## Deferred Items (Not Blocking Archive)

The following items are recorded in open issues and not owed by this archive:

- **#445**: Measurement completeness for other use cases (not blocking this change)
- **#446**: Future refinements to session state signals (SUGGESTION from verify-report)
- **#454**: Measurement-based optimizations for silent sessions (SUGGESTION from verify-report)

Three additional SUGGESTION items from the final verify-report are recorded in issues #445, #446,
#454 and do not delay archive.

## Verification Gate Status

- **Native Review Receipt**: Not applicable (no receipt-driven development for this change)
- **Task Completion Gate**: All implementation tasks checked in `tasks.md` (R7-R13); zero unchecked
  task lines remain
- **Spec Sync**: Complete. Four new specs promoted to `openspec/specs/`:
  - `openspec/specs/opencode-store-evidence/spec.md` (new)
  - `openspec/specs/opencode-session-detection/spec.md` (new)
  - `openspec/specs/opencode-session-feed/spec.md` (new)
  - `openspec/specs/opencode-session-topology/spec.md` (new)

## Archive Contents

```
openspec/changes/archive/2026-09-17-opencode-observer/
├── proposal.md                    (scope, approach, rollback plan)
├── exploration.md                 (measurements taken)
├── measurements-2026-09-17.md     (measurement verdicts per §6 rows)
├── design.md                      (architecture and decisions)
├── apply-progress.md              (implementation progress as of #452)
├── tasks.md                       (all tasks checked; R7-R13 complete)
├── verify-report.md               (final verification: 17/17 req, 39/39 scenarios, PASS)
├── specs/
│   ├── opencode-store-evidence/spec.md
│   ├── opencode-session-detection/spec.md
│   ├── opencode-session-feed/spec.md
│   └── opencode-session-topology/spec.md
└── archive-report.md              (this file)
```

## Audit Trail

**Final-State Authority Hierarchy Applied**:

1. Native review receipt: not applicable
2. Persisted tasks: all implementation tasks checked (#453, commit 1eface1)
3. Explicit final-state facts from orchestrator: all commits verified in dedicated worktree
4. Verify-report snapshot: used only for historical context; final state sourced from explicit
   facts

**Key dates and evidence**:

- Proposal: initial scope and questions (#444)
- Merged to main: 2026-09-17, PR #452, commit da6eeb5
- Follow-up #453: 2026-09-17, 6 commits, all addressed in dedicated verify worktree
- Final verification: 2026-09-17, in worktree `observer-453` on branch
  `fix/opencode-observer-verify-exceptions`, HEAD 1ab817f
- Spec amendments: 2 amendments recorded (DET-R6, TOPO-R1); both judged correct and incorporated

## Summary

The opencode-observer change is complete, verified (17/17 requirements, 39/39 scenarios pass), and
archived. Four new capability specs are now the authoritative source in `openspec/specs/`. All
artifacts are preserved in the archive folder for future reference. The change introduced no
regressions (CI: 7,089 tests green, +6 new tests, 0 lost). Work is closed; follow-up suggestions
are recorded in issues #445, #446, #454 for future consideration.

**Archive Status**: CLOSED ✓  
**Promoted Specs**: 4 (store-evidence, session-detection, session-feed, session-topology)  
**Ready for next change**: yes
