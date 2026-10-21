// The S-027-4 spike gate of the rebuilt login entry (spike register S-027-4; 21 §2 cut 1 entry criteria and its row
// "Login autostart entry"; 24-issues README §6 "Spike gates"). Pure data.
//
// While S-027-4 has not passed on an OS, today's candidate autostart stays the one writer of the login entry there
// until v1 (21 §2: "otherwise the candidate behaviour stays and the entry lands before v1"), so UI main composes no
// `ElectronAutostart`, applies no "Start with the system" at a start, and A-N20 / A-N21 do not offer the key (hidden
// until built, 21 §1 item 8). The candidate writer is UI main's shell start (window/application/candidateAutostart.ts,
// composed by the root only where this gate is closed). Once S-027-4 passes on an OS, its
// entry here turns `true` in the same change as its test expectation, which also switches that OS's candidate writer off (21 §1 item 4: one writer per entry).
export type LoginEntryPlatform = 'win32' | 'darwin' | 'linux'

export const LOGIN_ENTRY_PASSED: Readonly<Record<LoginEntryPlatform, boolean>> = {
  win32: false,
  darwin: false,
  linux: false
}

/** Whether UI main owns the login entry and "Start with the system" on `platform` (S-027-4 passed there). */
export function loginEntryOffered(platform: LoginEntryPlatform): boolean {
  return LOGIN_ENTRY_PASSED[platform]
}
