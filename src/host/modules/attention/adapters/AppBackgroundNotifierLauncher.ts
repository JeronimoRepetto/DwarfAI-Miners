// `AppBackgroundNotifierLauncher` (16 §4.11 adapter of attention's driven port `NotifierLauncher`;
// ADR-018 item 5; OQ-40 A): one call is one start of the app `--background` (tray only, no window).
// The wait and the 3-per-5-minutes budget are machine 12C's (application/notifierSupervisor.ts).
//
// - It starts `AppPaths.execPath` through `ProcessControl.spawn`, which never uses a shell and hides
//   the window (R17, AMENDMENT-10); `appArgs` come first (a development build's app folder, since
//   its executable is Electron itself), then `--background`. Argv carries no token or secret.
// - The app runs detached from the Host's own handles: its own process group, no stdio. The Host
//   never ends it (ADR-014: a process is ended only by its identity, and only by its owner); the
//   tray process outlives nothing of the Host's (S12.C09 is the UI side's).
// - The environment is the Host's own without what makes it the Host: `ELECTRON_RUN_AS_NODE` (with
//   it the app would start as plain Node, with no tray) and every `DWARFAI_*` name, which the UI and
//   its Host launcher set for themselves (spawnHost.ts), except `DWARFAI_LOG`, the log level the UI
//   was started with (19 §6). Names compare ignoring case, as Windows compares them.
// - It settles `'attached'` once a `notifier` client attaches (fed by the connection registry,
//   wired by ISSUE-119), and `'spawn-failed'` when the spawn is refused, the process exits first,
//   or no notifier attached within NOTIFIER_ATTACH_BOUND_MS (a process left running then is not
//   ended: if it attaches later, 12C sees that attach). It never answers `'gave-up'`.
import { dirname } from 'node:path'
import type { AppPaths } from '../../../kernel/ports/appPaths'
import type { ProcessControl, SpawnedProcess } from '../../../kernel/ports/processControl'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { NotifierLauncher } from '../ports/notifierLauncher'

/** The flag the app's `--background` start path reads (ISSUE-053; ADR-018 item 5). */
export const BACKGROUND_FLAG = '--background'
/** How long a started app has to attach as `notifier` before the start counts as failed. */
export const NOTIFIER_ATTACH_BOUND_MS = 30_000

export interface AppBackgroundNotifierLauncherDeps {
  processes: ProcessControl
  paths: Pick<AppPaths, 'execPath'>
  /** Arguments before `--background`: a development build's app folder; empty when packaged. */
  appArgs?: readonly string[]
  /** The Host's own environment, from which the app's is derived. */
  env: Readonly<Record<string, string | undefined>>
  scheduler: Scheduler
  /** Calls `listener` on each `notifier` attach from now on; returns the unsubscribe. */
  onNotifierAttach(listener: () => void): () => void
}

type LaunchOutcome = 'attached' | 'spawn-failed' | 'gave-up'

export class AppBackgroundNotifierLauncher implements NotifierLauncher {
  constructor(private readonly deps: AppBackgroundNotifierLauncherDeps) {}

  ensureNotifier(): Promise<LaunchOutcome> {
    return new Promise((resolve) => {
      let done = false
      let bound: { cancel(): void } | null = null
      const finish = (outcome: LaunchOutcome): void => {
        if (done) return
        done = true
        unsubscribe()
        bound?.cancel()
        resolve(outcome)
      }
      // Listening first: a notifier that attaches while the spawn is still settling is not missed.
      const unsubscribe = this.deps.onNotifierAttach(() => finish('attached'))
      const started = this.spawn()
      if (started === null) {
        finish('spawn-failed')
        return
      }
      bound = this.deps.scheduler.after(NOTIFIER_ATTACH_BOUND_MS, () => finish('spawn-failed'))
      const failed = (): void => finish('spawn-failed')
      started.identity.catch(failed)
      started.exited.then(failed, failed)
    })
  }

  private spawn(): SpawnedProcess | null {
    const { execPath } = this.deps.paths
    try {
      return this.deps.processes.spawn({
        executable: execPath,
        args: [...(this.deps.appArgs ?? []), BACKGROUND_FLAG],
        cwd: dirname(execPath),
        env: appEnvironment(this.deps.env),
        processGroup: 'own',
        stdio: 'ignore'
      })
    } catch {
      return null
    }
  }
}

/** The Host's environment without `ELECTRON_RUN_AS_NODE` and the Host's `DWARFAI_*` names. */
function appEnvironment(
  hostEnv: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue
    const upper = name.toUpperCase()
    if (upper === 'ELECTRON_RUN_AS_NODE') continue
    if (upper.startsWith('DWARFAI_') && upper !== 'DWARFAI_LOG') continue
    env[name] = value
  }
  return env
}
