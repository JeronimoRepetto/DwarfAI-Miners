// `LaunchCommands.launchCustom`'s own steps (ISSUE-165; 16 §4.5 `launchCustom` row; 14 §2.3 B-M34;
// ADR-020 item 3; 18 C-17, T-19; UC-010; 11 F3). The use case itself is `LaunchUseCase.launchCustom`
// (application/launch.ts): it shares the acceptance and the settlement of `launch` whole, so an
// "Other…" dwarf is launched, bound, owned and published exactly like a supplier dwarf (BR-08,
// US-LAUNCH-002.AC08). What differs is only what this file holds:
//
// - the typed command is parsed at acceptance with `parseHostedCommand`, no shell (NFR-SEC-09); the
//   `launches` row keeps it as `custom_command_json` (`raw` as typed, `argv` as parsed, empty when
//   refused);
// - a refusal (a metacharacter, an unclosed quote, a `.cmd`/`.bat` shim) settles `could-not-start`
//   without reaching any driver, so nothing is spawned (ADR-020 item 3); the parser's sentence is
//   the diagnostic `detail` only (the `launch.failed` record's fixed `msg`), never notice copy;
// - otherwise the "Other…" driver gets the parsed argv as `customArgv`, its program as the install's
//   `binaryPath` (the one executable `HostedCommandDriver` may spawn, ADR-008 item 1), and no
//   permission mode (ADR-011 item 1). The OS spawn resolves the program: a program that is not
//   found is the driver's `ENOENT`, `not-installed` (S5.16).
import type { LaunchId, MineId, ProviderId } from '../../../kernel/domain/values'
import type { InstalledProvider } from '../../suppliers'
import { parseHostedCommand } from '../domain/hostedCommand'
import type { CustomCommand } from '../domain/launch'

/** 16 §4.5 `launchCustom(req)`: 14 `LaunchCustomParams` without the transport's `requestId`. */
export interface LaunchCustomInput {
  mineId: MineId
  command: string
  prompt: string
  retryOf?: LaunchId
}

/** The typed command, parsed: what the launch runs, or why it is refused before any spawn. */
export type CustomCommandCheck =
  { ok: true; command: CustomCommand } | { ok: false; command: CustomCommand; detail: string }

/** Parses `raw` with no shell (18 C-17); a refusal keeps no argv and carries the parser's sentence. */
export function checkCustomCommand(raw: string): CustomCommandCheck {
  const parsed = parseHostedCommand(raw)
  if (!parsed.ok) return { ok: false, command: { raw, argv: [] }, detail: parsed.reason }
  return { ok: true, command: { raw, argv: [parsed.program, ...parsed.args] } }
}

/**
 * The install a custom launch runs: its own program, as typed. "Other…" has no install detection
 * (15 §3 H1 `installDetection: 'none'`); the spawn looks the program up on PATH, hence `'path'`.
 */
export function customInstall(providerId: ProviderId, argv: readonly string[]): InstalledProvider {
  return {
    providerId,
    binaryPath: argv[0] ?? '',
    version: null,
    resolvedVia: 'path',
    statMtimeMs: 0
  }
}
