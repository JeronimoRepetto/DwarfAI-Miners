# Test removals

The one place where a lost test statement is justified (testing strategy `17-testing-strategy.md` §2.6 of the
architecture package).

Every change runs the test census against its merge base:

```sh
node skills/test-safety/assets/test-census.mjs --base <merge-base>
```

When a test file loses statements (exit 1), the change passes only if it adds one row below for each losing file,
in the same change. The census gate reads this file, never the PR text, and a rising total never hides a loss. A
strangler cut runs the same census against its cut base (`--base <cut-base>`) and lists here every legacy test file
that leaves with its subject.

A row names:

- **File**: the test file that lost statements, as a repository path.
- **Statements removed**: the statements that left, with their count and test titles.
- **Reason**: why they went.
- **Removed by issue**: the issue whose change removed the subject.
- **Coverage now lives in**: the test file, and the test titles, that now prove the behaviour.

The file is append-only: add rows at the end, one entry per PR, and never edit or delete a row.

| File                                       | Statements removed                                                                                                                                   | Reason                                                                                                                                                                                                                                                                                                                                            | Removed by issue                                  | Coverage now lives in                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui-main/hostLauncher/windows.test.ts` | 1: "[ADR-002] each line the step prints is read as its fact, anything else is ignored" (the file's count does not drop: the same change adds a case) | The Windows PowerShell WMI step and the lines it printed are gone: the WMI create (ADR-002 D6 item 2) now runs in the UI process through the launch helper and answers a typed result, so there is no printed line left to parse. Its PowerShell cold start was the cause of the FM-009 `LAUNCHER_TIMEOUT` on windows-latest (CI run 36889737566) | fix: FM-009 launcher timeout (no issue; CI flake) | `src/ui-main/hostLauncher/windows.test.ts` "[ADR-002, FM-012] breakaway refused then WMI is launched; WMI failing too is in-job", "[ADR-002, FM-008] a slow PowerShell cannot fail the spawn when breakaway is refused either: WMI runs in-process and starts no launcher step"; `src/ui-main/hostLauncher/win-launch/nativeWinLaunch.os.test.ts` "[ADR-002, FM-012] a WMI create that Win32_Process.Create refuses answers refused with its ReturnValue and starts nothing" |
