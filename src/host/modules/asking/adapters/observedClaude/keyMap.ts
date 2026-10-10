// The keys the observed-Claude keystroke channel presses (ADR-012 item 3; 15 §2.7 row "Observed
// Claude keystroke"), version-pinned (NFR-OBS-04; 15 §5.4; 13 FM-083).
//
// Evaluated candidate: the legacy `textDelivery/permissionKeys.ts` (found tree). Adapted: its
// measured pair, its types and `permissionKeystrokeFor` are kept as they were (its test runs
// unchanged, keyMap.transplanted.test.ts); what ADR-012 item 3 adds is the version pin:
//
// - `KEY_MAP_MEASUREMENTS` records each measurement with the Claude Code version and the date. A
//   measurement whose `keys` is null records a measured change of the dialog's shape: no key is
//   safe on that version.
// - `resolveKeyMap(version)`: the exact version measured answers `measured`; any other version is
//   governed by the newest measurement at or below it (the oldest when it is older than all of
//   them, the newest when it cannot be read) and answers `unmeasured`, which keeps working with
//   that map and is logged as drift by the channel (HO-33); a governing measurement with no keys
//   answers `disabled` (the card shows only "Jump to terminal") until the map is measured again.
//
// What follows is the legacy module's own record of the measurement, kept verbatim.
//
// ## The dialog is a selector, and its options are not fixed
//
// The keybindings reference documents a `Confirmation` context taking `y` or Enter to confirm and
// `n` or Esc to decline. It is wrong for this dialog. Measured on Claude Code **2.1.261**, Windows
// console, 2026-09-05:
//
// - The prompt is a SELECTOR. A lone `y` does nothing at all.
// - A DIGIT picks that option and fires it immediately — no Enter.
// - `Esc` cancels the prompt, and the tool is declined.
// - The option COUNT varies by tool. Two options in some places, three for a file write, and four
//   for a Bash `rm`: 1 "Yes", 2 "Yes, and always allow …", 3 "Yes, and switch to auto mode", 4 "No".
//
// Two invariants survive that variation, and they are the whole basis of the pair below: **"Yes" is
// always option 1**, and **"No" is always last**.
//
// ## So allow is a digit and deny cannot be
//
// `allow` is `1`, because the first option is Yes on every variant seen. `deny` is `Esc`, because
// "No" is LAST and the panel cannot know how many options this particular dialog drew. A positional
// digit would eventually mean "Yes, and always allow …" to somebody who pressed Deny: a standing
// permission granted by the button meant to refuse.
//
// ## What a LATE keystroke does, which is the risk this channel carries
//
// - A late `1` lands in the session's idle input box as one stray character. Nothing is sent,
//   because nothing here ever presses Enter.
// - A late `Esc` INTERRUPTS the running turn (`staleAnswerSafe: false`, 13 FM-082). Accepted and
//   bounded; the panel says so in the status line under a deny (ADR-012 item 3).
//
// That is why neither key may ever be pressed on a dialog that was not just re-read
// (ObservedClaudeKeystrokeChannel.ts).
import type { PermissionDecision } from '../../domain/permissionOptions'

/**
 * One key press. `text` is sent with no Enter, always — a digit fires the selection by itself;
 * `escape` is a raw Esc.
 */
export type PermissionKeystroke =
  | {
      kind: 'text'
      /** Sent with no Enter, always — a digit fires the selection by itself. */
      text: string
    }
  | { kind: 'escape' }

/**
 * The key each decision is answered with on the measured build, or null where none has been
 * measured for it. Two values, two independent measurements.
 */
export const PERMISSION_KEYSTROKES: Record<PermissionDecision, PermissionKeystroke | null> = {
  // Measured: picks "Yes", the first option, and fires it. The first option is Yes on the two-,
  // three- and four-option variants alike.
  allow: { kind: 'text', text: '1' },
  // Measured: cancels the prompt, and the tool is declined. The one answer that does not depend on
  // counting rows in a dialog this app cannot see.
  deny: { kind: 'escape' }
}

/**
 * The key that answers `decision`, or null while nothing this build accepts has been measured for
 * it. Null rather than a throw, so the one caller has a plain branch to refuse on.
 */
export function permissionKeystrokeFor(decision: PermissionDecision): PermissionKeystroke | null {
  return keystrokeIn(PERMISSION_KEYSTROKES, decision)
}

/** The keys of one measurement: per decision, or null for a decision left unmeasured. */
export type PermissionKeyMap = Readonly<Record<PermissionDecision, PermissionKeystroke | null>>

/** One measurement of the dialog on one Claude Code version (ADR-012 item 3; NFR-OBS-04). */
export interface KeyMapMeasurement {
  /** The Claude Code version measured (`major.minor.patch`). */
  readonly version: string
  /** The day of the measurement (ISO 8601 date). */
  readonly measuredOn: string
  /** The keys measured; null when the dialog's shape changed and no key is safe. */
  readonly keys: PermissionKeyMap | null
}

/** Every measurement, oldest version first. Re-measured on each supported Claude Code release. */
export const KEY_MAP_MEASUREMENTS: readonly KeyMapMeasurement[] = [
  { version: '2.1.261', measuredOn: '2026-09-05', keys: PERMISSION_KEYSTROKES }
]

/** What a version's key map is (ADR-012 item 3). */
export type KeyMapResolution =
  | { kind: 'measured'; keys: PermissionKeyMap; measurement: KeyMapMeasurement }
  | { kind: 'unmeasured'; keys: PermissionKeyMap; measurement: KeyMapMeasurement }
  | { kind: 'disabled'; measurement: KeyMapMeasurement }

/** The key map governing `version` (null: the version could not be read). */
export function resolveKeyMap(
  version: string | null,
  measurements: readonly KeyMapMeasurement[] = KEY_MAP_MEASUREMENTS
): KeyMapResolution {
  const sorted = [...measurements].sort((a, b) => compareVersions(a.version, b.version))
  const newest = sorted.at(-1)
  const oldest = sorted[0]
  if (newest === undefined || oldest === undefined) {
    throw new RangeError('the keystroke channel needs at least one key-map measurement')
  }
  const parsed = version === null ? null : parseVersion(version)
  const exact = parsed === null ? undefined : sorted.find((m) => m.version === version)
  const governing =
    exact ??
    (parsed === null
      ? newest
      : ([...sorted].reverse().find((m) => compareVersions(m.version, version!) <= 0) ?? oldest))
  if (governing.keys === null) return { kind: 'disabled', measurement: governing }
  return exact === undefined
    ? { kind: 'unmeasured', keys: governing.keys, measurement: governing }
    : { kind: 'measured', keys: governing.keys, measurement: governing }
}

/** The key of `decision` in `keys`, or null when it is unmeasured or empty. */
export function keystrokeIn(
  keys: PermissionKeyMap,
  decision: PermissionDecision
): PermissionKeystroke | null {
  const keystroke = keys[decision]
  if (keystroke === null) return null
  return keystroke.kind === 'text' && keystroke.text === '' ? null : keystroke
}

/** `major.minor.patch` as numbers, or null for anything else. */
function parseVersion(version: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Orders two versions; an unreadable one sorts first. */
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === null || pb === null) return pa === null ? (pb === null ? 0 : -1) : 1
  for (let i = 0; i < 3; i += 1) {
    const d = pa[i]! - pb[i]!
    if (d !== 0) return d
  }
  return 0
}
