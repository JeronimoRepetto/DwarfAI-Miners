// The suppliers driven port `InstallResolver` (05 §3.4, 16 §4.4; frozen): the one resolver behind
// every driver's `detect()` (ADR-009 D5). It resolves Scoop shims, WinGet links and `.cmd`/`.bat`
// shims to their target (ADR-029 row 8), never through a shell; `null` = not installed.
// Amended (owner-approved 2026-10-02, ISSUE-146; "Amendment for frozen 16 §4.4 InstallResolver"):
// the answer carries `resolvedVia` for 15 §1.2 `InstalledProvider`, and a file the OS quarantined
// is answered as `{ path; quarantined: true }` (15 §1.2 `DetectResult` `quarantined`), never
// spawned. Type-only (R2).

export interface InstallResolver {
  // the one resolver behind every driver's detect() (ADR-009 D5)
  resolve(binaries: readonly string[]): Promise<
    | {
        path: string
        version?: string
        resolvedVia: 'path' | 'package-manager-dir' | 'login-shell-path'
      }
    | { path: string; quarantined: true }
    | null
  >
}

/** One answer of `InstallResolver.resolve`. */
export type ResolvedInstall = NonNullable<Awaited<ReturnType<InstallResolver['resolve']>>>
