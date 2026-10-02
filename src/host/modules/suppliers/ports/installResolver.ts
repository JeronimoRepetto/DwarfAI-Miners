// The suppliers driven port `InstallResolver` (05 §3.4, 16 §4.4; frozen): the one resolver behind
// every driver's `detect()` (ADR-009 D5). It resolves Scoop shims, WinGet links and `.cmd`/`.bat`
// shims to their target (ADR-029 row 8), never through a shell; `null` = not installed. Type-only
// (R2).

export interface InstallResolver {
  // the one resolver behind every driver's detect() (ADR-009 D5)
  resolve(binaries: readonly string[]): Promise<{ path: string; version?: string } | null>
}
