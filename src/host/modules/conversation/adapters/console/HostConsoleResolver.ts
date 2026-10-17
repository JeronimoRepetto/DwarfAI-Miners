// `HostConsoleResolver` (16 §4.6 `ConsoleResolver`, frozen; ADR-031 items 1–3; ADR-003 item 12;
// ADR-017 item 3; UC-036): the Host half of "Open console" and "Jump to terminal".
//
// For every dwarf it issues the `log` view: a per-view token (ViewTokenRegistry) written to
// `<hostDataDir>/run/viewers/<viewId>.token` (RunDirViewerTokenFiles; its two lines are the token
// and the dwarfId, viewer/viewerTokenFile.ts), and the viewer command
// `{ program: <versioned-copy executable>, args: [<viewer entry>, <token file path>], cwd }`. The
// token itself is never in the target: `args` and `credentialFile` carry the file's PATH only
// (ADR-003 item 12, ADR-017 item 3; security negative proven by consoleResolver.contract.ts).
// UI main runs the viewer on that executable with ELECTRON_RUN_AS_NODE=1 (TerminalConsoleRaiser),
// a value that is not a secret.
//
// The plan (application/resolveConsole.ts `consolePlan`) decides the mode: `focus-terminal` with
// the process identity observation recorded, `log` second, or `log` alone. A focus target still
// carries the `log` command, because whether a window of that process can be raised is known only
// to UI main, which falls back to it (ADR-031 item 1: "focus first, log second"). An unused token
// expires after 60 s; each issue first drops the expired tokens and their files.
//
// Candidate (21 §6): `src/main/platform/terminalLauncher.ts` tails a transcript file with a shell
// script and `platform/focus.ts` focuses a bare pid; neither resolves a target from a session's
// console capability nor issues a per-view token, so the Host half is replaced.
import type { DwarfId } from '../../../../kernel/domain/values'
import type { ConsolePlan, ConsoleSession } from '../../application/resolveConsole'
import type { ConsoleResolver, ConsoleTarget } from '../../ports/consoleResolver'
import type { RunDirViewerTokenFiles } from './RunDirViewerTokenFiles'
import type { ViewTokenRegistry } from './ViewTokenRegistry'
import { formatViewerTokenFile } from './viewer/viewerTokenFile'

export interface HostConsoleResolverDeps {
  /** What the Host knows of the dwarf's session, or null for a dwarf it does not know. */
  sessions: { sessionOf(dwarfId: DwarfId): ConsoleSession | null }
  /** The console rule (`consolePlan`). */
  plan(session: ConsoleSession | null): ConsolePlan
  tokens: Pick<ViewTokenRegistry, 'issue' | 'dropExpired'>
  files: Pick<RunDirViewerTokenFiles, 'write' | 'remove'>
  /** The versioned-copy executable, the viewer script beside the Host entry, and the viewer's cwd. */
  viewer: { program: string; entry: string; cwd: string }
}

export class HostConsoleResolver implements ConsoleResolver {
  constructor(private readonly deps: HostConsoleResolverDeps) {}

  async targetFor(dwarfId: DwarfId): Promise<ConsoleTarget> {
    const plan = this.deps.plan(this.deps.sessions.sessionOf(dwarfId))
    for (const viewId of this.deps.tokens.dropExpired()) {
      await this.deps.files.remove(viewId).catch(() => undefined)
    }
    const view = this.deps.tokens.issue(dwarfId)
    const credentialFile = await this.deps.files.write(
      view.viewId,
      formatViewerTokenFile({ token: view.token, dwarfId })
    )
    const command = {
      program: this.deps.viewer.program,
      args: [this.deps.viewer.entry, credentialFile],
      cwd: this.deps.viewer.cwd
    }
    if (plan.mode === 'focus-terminal') {
      return {
        mode: 'focus-terminal',
        focus: { pid: plan.focus.pid, startTime: plan.focus.processStartTimeMs },
        command,
        credentialFile
      }
    }
    return { mode: 'log', command, credentialFile }
  }
}
