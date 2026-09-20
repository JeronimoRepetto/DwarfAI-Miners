# Kick hands the terminal back sane — the CONOUT$ reset behind a forced kill (#504)

## Objective

After Kick force-kills an **observed** terminal session, write the DECSET resets into that session's
console so the terminal the person goes back to is usable, whichever tier ended the session.

## Problem

`attemptGracefulExit` (`src/main/textDelivery/windowsTextDelivery.ts:815`) refuses the clean
Ctrl+C-twice exit when `focus.reach === 'terminal-host'` — and `FocusReach`
(`src/main/platform/focus.ts:171`) classifies **Windows Terminal**, the Windows 11 default host, as
exactly that. So on a stock machine the clean tier #358 added is skipped, `taskkill /T /F` runs, and
the TUI's mouse-tracking modes are never reset. The person is left with a terminal that prints SGR
mouse reports on every pointer move and accepts no command.

#358 shipped its step 1 and closed; its **step 2 — put the terminal back where the kill was forced
anyway — was never implemented**. This is that step.

## Why this shape and not another

- **Not closing the terminal.** The panel never opened it, Windows Terminal exposes no
  close-tab-by-pid (the same wall #329 hit), and the tab may hold the person's own work. The damage
  to undo is the terminal's _mode_, not its existence.
- **Not weakening #329's refusal.** The keystroke stays forbidden in a tab strip. This repairs after
  the kill instead of typing into an unidentifiable tab.
- **`CONOUT$`, not `CONIN$`.** The existing write-by-pid path (`consoleInputWrite.ts`) writes key
  records into the console **input** buffer. A DECSET reset is **output**: it must reach the terminal
  through the console's output handle, with `ENABLE_VIRTUAL_TERMINAL_PROCESSING` on, or the ESC bytes
  render as literal glyphs — which is worse than the bug.
- **Attach to an ancestor, not the agent.** The agent's pid is gone by the time the reset is due, so
  the chain is captured _before_ the kill (`processChain`, `focus.ts:115`) and the surviving shell on
  that console is the attach target.

## Scope

**Authorized:** `src/main/textDelivery/` — the new `consoleReset.ts` and its test, plus
`windowsTextDelivery.ts` and its test — and `docs/console-hosting.md`. Nothing else.

**Out of scope, stated rather than silently dropped:**

- Making the clean exit work inside a tab strip (`AttachConsole` + `GenerateConsoleCtrlEvent` needs
  no focus and no tab identification). A better root fix, its own issue, its own measurement.
- **The POSIX escalation gap — a real parity debt.** `kill -TERM` lets the CLI restore its own
  terminal, so the leak is rare there rather than systemic; but when the `kill -KILL` escalation
  fires, macOS and Linux have the same defect and no reset. Not fixed here, and it needs a real Mac
  to measure. Must be raised with the maintainer, not buried.

## Constraints

- The restore is **best-effort repair, never part of the kick's verdict**. A failed reset may not
  turn an ended session into a failed kick; it is logged, never reported in `delivered`.
- `ESC[?1049l` (leave the alternate screen) stays **out** unless measured safe — a shell that was
  never on the alternate screen can be left cleared by it.
- The pure-builder / injected-`ShellRunner` house pattern holds: the builder is a value a test
  asserts on every platform, and only the spawn is integration territory.
- Windows-only act, behind the Windows adapter; no cross-platform contract changes.

## TDD

**Strict TDD is enabled for this session.** Resolved from the session configuration (`Strict TDD
Mode: enabled`) and the repo's own [`tdd`](../../skills/tdd/SKILL.md) skill. Runner: `npx vitest run
<path>`. Every task observes RED before GREEN.

## Tasks

- [x] **T1 — Measure the mechanism live, before any code relies on it.** ✅ 2026-09-20
      Prove on this Windows 11 host that `FreeConsole` → `AttachConsole(<shell pid>)` →
      `CreateFileW("CONOUT$")` → `SetConsoleMode(… | ENABLE_VIRTUAL_TERMINAL_PROCESSING)` →
      `WriteConsoleW(<resets>)` reaches a **Windows Terminal** tab the app did not spawn, and that a
      terminal left in mouse-reporting mode goes quiet after it. Record the reading in
      `docs/console-hosting.md` in the house register, dated, with what was and was not proven.
      _No code until this passes — an unmeasured restore is the exit-0-shaped lie this repo refuses._
      Route: inline (measurement, not a write).

- [x] **T2 — `consoleReset.ts`: the pure builder and its exit-code contract.** ✅ 2026-09-20
      `buildConsoleResetCommand(pids: readonly number[]): string | null` emitting the PowerShell
      P/Invoke script, mirroring `consoleInputWrite.ts`'s style exactly (decimal constants,
      `Add-Type -Namespace Win32 -MemberDefinition @'…'@`, numbered exits). Tries each candidate pid
      in order and stops at the first attach that takes. Null for an empty list or any pid that is
      not a real positive integer — the same fail-closed guard the input builder holds.
      Tests: `consoleReset.test.ts`. Route: delegated (writer).

- [x] **T3 — Wire it into `forceEndSession`, and only there.** ✅ 2026-09-20
      Capture the ancestor chain _before_ the kill, run the reset after `endProcessTree` reports the
      tree gone, log the outcome, never touch the verdict. The graceful path gets no reset: the TUI
      already restored its own terminal. Tests appended to `windowsTextDelivery.test.ts` — a reset
      after a forced kill, no reset after a clean exit, and a failed reset that still reports the
      session ended. Route: delegated (same writer as T2).

## Acceptance

On Windows 11 in Windows Terminal: `claude` in a tab, idle, Kick from the panel → the session ends,
the prompt returns, moving the mouse over that terminal prints nothing, and a new command runs. With
two Claude tabs in one window, Kick still refuses the keystroke (#329), still ends the process, and
the terminal it leaves behind is still clean.

## Checks

The seven CI checks in `CONTRIBUTING.md`'s order, plus the per-file test census from
[`test-safety`](../../skills/test-safety/SKILL.md) on every test file touched.

## Delivery

Strategy: `ask-on-risk` (default). Forecast: ~450 authored changed lines across T2 and T3, so the
~400-line delivery budget is expected to be reached — ask for the chain strategy before the second
work-unit commit rather than after.

## Progress

**T1 done, 2026-09-20.** Recorded in `docs/console-hosting.md` §6, "Handing the terminal back after
a forced kill". Observed on Windows 11 Pro 10.0.26200 against a Windows Terminal tab the app did not
spawn (`powershell.exe` whose parent is `WindowsTerminal.exe`):

- `FreeConsole` → `AttachConsole(22988)` → `CreateFileW("CONOUT$")` → `WriteConsoleW` → **54 of 54
  characters, exit 0**, with no focus, no keystroke and no window raised.
- `GetConsoleMode` → **7**: `ENABLE_VIRTUAL_TERMINAL_PROCESSING` is already on under ConPTY. The
  builder still sets and restores it for a legacy conhost that lacks it.
- Text selection **refused before** the write and **restored after** it, confirmed at the tab by the
  maintainer, who copied the buffer out as the evidence. Selection is the honest signal: the
  coordinate echo is a property of the reader, and PowerShell's prompt swallows those records
  silently even with the mode demonstrably on.
- A pid whose process had exited: `AttachConsole` → **false, `GetLastError` 87**, exit 2. This is
  the shape the caller must honour — the reset is best-effort and never changes the kick's verdict.

Two findings that bind T2 and T3:

1. **`CONOUT$` + `WriteConsoleW`**, not `CONIN$` + `WriteConsoleInputW`. A reset is output; written
   as key records the shell would _type_ the escape bytes instead of obeying them.
2. **The ancestor chain must be read before the kill**, because `taskkill /T /F` has already removed
   the agent's pid by the time the reset is due.

**T2 and T3 done, 2026-09-20.** Written under strict TDD, RED observed before each implementation.
Verified by the parent, not taken on report: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`node skills/skill-sync/assets/sync.mjs --check`, `pnpm test` (277 files, 7637 passed, 5 skipped —
the skips pre-existing and unrelated) and `pnpm build` all re-run here and observed green. Test
census: `consoleReset.test.ts` 0 → 11, `windowsTextDelivery.test.ts` 85 → 90, no file lost a test.

Two corrections the parent made on review:

- The builder's doc comment cited the host as 10.0.26100; the measured host is **10.0.26200**.
- The two amended assertions on the forced-kill path checked only `SendWait('^c')`. Narrowed to
  `SendKeys`, so a future keystroke that is not the clean exit's own cannot reach a console the
  panel is unsure of without a test noticing.

Disclosed under [`test-safety`](../../skills/test-safety/SKILL.md): two existing assertions in
`windowsTextDelivery.test.ts` were **amended, none deleted**. Both used to assert `runPowerShell`
was never called on the forced path; that seam is now legitimately read once, before the kill, to
resolve the ancestor chain. The guarantee they always owed — no keystroke reaches an unsure console
— is preserved and, after the correction above, is stated more strictly than before.

**Still unmeasured, and stated rather than implied:** VS Code's integrated terminal, a legacy
conhost with VT off, and the POSIX `kill -KILL` escalation. The end-to-end against the real panel —
launch a session, kick it, confirm the terminal comes back usable — is the maintainer's to run.

**T4 — the acceptance run, and what it caught. 2026-09-20.** The first implementation shipped a
reset that never ran. Every forced kick logged `[kick] no ancestor console to reset (#504)`, and the
terminal came back exactly as broken as before. Two defects behind it, both found by running the
real app and neither reachable from the test suite as it stood:

1. **The chain query rode a write-only seam.** `this.runPowerShell` is the long-lived console
   worker in production, and `buildWorkerRequest` pipes every command to `Out-Null`, reporting only
   an exit code through its sentinel (`consoleWorker.ts`). It answered `stdout: ''` with exit 0 — a
   success-shaped nothing. `runConsoleWrite` is no better: it spawns with stdout `'ignore'` on
   purpose. **Both seams on this port are deaf, and both look as though they are not**, because
   `ShellResult` carries a `stdout` field each fills with `''`. The query now has its own
   `runQuery` seam, the same plain `execFile` `platform/focus.ts` keeps privately for this identical
   query. Measured here: 24 KB over 372 rows in 228 ms, well inside `execFile`'s default buffer.
2. **The candidate bound was one rung from useless.** The real chain on this machine ran
   `claude.exe → python.exe → py.exe → cmd.exe → powershell.exe → WindowsTerminal.exe` — five rungs,
   clearing a budget of four with nothing to spare, and an npm `.cmd` shim in front is one ordinary
   rung more. The shell is always the deepest rung before the host, so truncating loses precisely
   the candidate that matters. Raised to 12; every rung shares the one console, so a surplus
   candidate is another `AttachConsole` inside a script already running, not a round trip.

Both were written test-first and both new tests fail against the previous commit.

**Acceptance: PASSED.** Confirmed by the maintainer against a real kick in the running app — the
session ends, the terminal stays open, and it comes back usable.

The lesson worth keeping past this change: a unit test that fakes a seam can only ever assert what
the fake does, and this one faked a seam answering stdout that the real one cannot produce. That is
why the acceptance run is a step in this document and not a formality.

Next step: the pull request.
