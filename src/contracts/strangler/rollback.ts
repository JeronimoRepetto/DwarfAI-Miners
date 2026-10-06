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
