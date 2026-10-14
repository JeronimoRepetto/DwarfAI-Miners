// The cut-1 rollback setting (21 §2 cut 1 row "Rollback", `21-migration-plan.md:172`; §2.1 item 1; ADR-001 items 3,
// 6). A rollback of cut 1 is a new internal build whose cut-1 router rows route `legacy` again, with the legacy
// observer, ledger and notifier composed again, while the Host keeps running from the same generation. So that there
// is still one observer and one notifier (21 §1 item 4), that build also carries this setting: on, the Host observer
// writes nothing (no cursor, session, usage or ledger credit) and the Host sends no level-3 OS notification. Rows the
// Host wrote before stay (forward-only, 21 §5.1).
//
// Strangler-only and fixed at build time: never a person-facing option, never an environment variable, never a
// runtime command. Lead decision (2026-09-30, ISSUE-122): a build constant here, read by the Host composition
// (`src/host/wiring/cut1Rollback.ts`, the only Host file that reads it, R9) and by the router contract test
// (`src/ui-main/ipc/ipc-routing.contract.test.ts`), which pins it on exactly when the build's cut-1 rows route
// `legacy`, so the route rows and the Host setting cannot disagree in one build.

/** `false` in every normal build; only a cut-1 rollback build sets it `true`, with its rolled-back route table. */
export const CUT_1_ROLLBACK: boolean = false

// The cut-2 rollback setting (21 §2 cut 2 row "Rollback"; §2.1 item 1; §1 items 4 and 8; ADR-016 items 5, 6). A
// rollback of cut 2 is a new internal build whose table is `rollbackOf(cut-2 table, 'cut-2')`: A-40/A-41 route
// `legacy` again with today's Claude hook installer composed again, and A-N31 `setClaudeHooksEnabled` and A-N32
// `answerWelcome` are withdrawn (no route). So that the Claude hook entry keeps one writer (21 §1 item 4, §4) and the
// first-run step is never offered without its answer (hidden until built, 21 §1 item 8; ISSUE-141 lead decision
// 2026-10-14), that build also carries this setting: on, the Host offers no first-run option (the step is not due, 07
// S41.09) and its config writer refuses every install, so it writes no Claude hook entry. Fixed at build time like
// `CUT_1_ROLLBACK`: read in the Host only by `src/host/wiring/cut2Rollback.ts`, and pinned by the router contract test
// to the build's table.

/** `false` in every normal build; only a cut-2 rollback build sets it `true`, with its rolled-back route table. */
export const CUT_2_ROLLBACK: boolean = false
