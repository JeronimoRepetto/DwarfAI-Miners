// The observed-Codex send path (15 §3.1 X3 `sendTurn` "`codex queue --thread`, #97", §3.3 "queues the
// text for the thread's next turn, never mid-turn"): one message handed to a Codex thread's OWN queue,
// which the thread drains at its next idle boundary — nothing is typed into its terminal, so nothing
// can land in the middle of a running turn.
//
// One run of the person's own codex (the binary suppliers' install detection resolved, ADR-009 D5;
// never one DwarfAI ships, ADR-008 item 1) through the kernel `ProcessControl.spawn` (R17: `shell:
// false`, `windowsHide: true`), an argv array, a named allowlist of the Host's environment (never a
// token or a provider key, ADR-013, INV-59), bounded by CODEX_QUEUE_TIMEOUT_MS.
//
// The text travels as ONE argv element: `codex queue` has no stdin form (`codex queue --help`,
// codex-cli 0.153.4, read 2026-09-16: `--thread <THREAD> --message <TEXT>`, no `-`, no file; legacy
// the console-hosting research "The Codex queue keeps a real command-line bound"). That departs from 15
// §1.2 `TurnInput.text` "never argv", which the X3 row itself requires; recorded as a known risk.
//
// Candidate decisions (21 §6; evidence: CodexThreadQueue.test.ts and the TurnSender contract run in
// ObservedSessionTurnSender.test.ts), against `src/main/textDelivery/codexQueue.ts`:
// - `buildCodexQueueArgs`, `CODEX_QUEUE_TIMEOUT_MS` and the exit reading (0 queued, 1 a thread the
//   store does not hold) — KEPT.
// - `runCodexQueueProcess` (`execFile`, inheriting the whole environment) and `resolveProgram` —
//   REPLACED by `ProcessControl.spawn` with an allowlisted environment and suppliers' resolved binary.
// - `MAX_CODEX_QUEUE_TEXT_CHARS` (`shared/contracts.ts`, #437: Windows' 32 767-char command line less
//   the fixed argv, halved for quoting) — KEPT, and a text past it is refused before any run.
// - `codexResume.ts` (`codex exec resume <thread> -`, a new turn on a thread DwarfAI launched
//   detached) and `codexHold.ts` (the panel holding messages while that turn runs) — not carried: they
//   serve a thread the legacy panel launched, which the Host's own Codex driver now holds
//   (CodexAppServerDriver, `turn/start`); an observed thread is the person's and gets its own queue.
// - `opencodeContinue.ts` / `opencodeHold.ts` (`opencode run --session <id>`, for a session the
//   legacy panel launched) — not carried: an observed OpenCode session has no recorded send path (15
//   §3.1 O3), so ObservedSessionTurnSender offers none.
// Nothing here logs the text or the thread id.
import type { ProcessControl } from '../../../../kernel/ports/processControl'
import type { Scheduler } from '../../../../kernel/ports/scheduler'
import { TOOL_ENV_NAMES, runTool, toolEnvironment } from './consoleTools'

/** A local process submitting one item to a SQLite-backed store: milliseconds, bounded at 20 s. */
export const CODEX_QUEUE_TIMEOUT_MS = 20_000

/** The longest text one queue run carries (#437); refused past it rather than split. */
export const MAX_CODEX_QUEUE_TEXT_CHARS = 15_359

/** A Codex thread id: the UUID the rollout's `session_meta` names (never a session NAME, #97). */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What codex needs besides the tools' basics: its own home, where the thread store lives. */
const CODEX_ENV_NAMES: readonly string[] = [
  ...TOOL_ENV_NAMES,
  'CODEX_HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME'
]

export type CodexQueueOutcome = 'queued' | 'unknown-thread' | 'not-installed' | 'refused' | 'failed'

export interface CodexThreadQueueDeps {
  processes: Pick<ProcessControl, 'probe' | 'spawn' | 'killTree'>
  /** The person's own codex, as suppliers' install detection resolved it, or null when absent. */
  executable(): Promise<string | null>
  /** The Host's environment; codex gets only CODEX_ENV_NAMES of it. */
  env: Readonly<Record<string, string | undefined>>
  cwd: string
  scheduler: Scheduler
  timeoutMs?: number
}

export class CodexThreadQueue {
  constructor(private readonly deps: CodexThreadQueueDeps) {}

  /**
   * Queues `text` on the thread `threadId`: `queued` once the item is persisted on its queue (a
   * hand-over, never a reaction), `unknown-thread` when the store does not hold it, `not-installed`
   * without a codex, `refused` (nothing run) for an id or a text it cannot carry, `failed` otherwise.
   */
  async queue(threadId: string, text: string): Promise<CodexQueueOutcome> {
    if (!THREAD_ID.test(threadId) || text.trim() === '') return 'refused'
    if (text.length > MAX_CODEX_QUEUE_TEXT_CHARS) return 'refused'
    let executable: string | null
    try {
      executable = await this.deps.executable()
    } catch {
      executable = null
    }
    if (executable === null) return 'not-installed'
    const run = await runTool(
      this.deps,
      { executable, prefix: [] },
      ['queue', '--thread', threadId, '--message', text],
      {
        env: toolEnvironment(this.deps.env, CODEX_ENV_NAMES),
        timeoutMs: this.deps.timeoutMs ?? CODEX_QUEUE_TIMEOUT_MS
      }
    )
    if (run.kind !== 'exited') return 'failed'
    if (run.code === 0) return 'queued'
    return run.code === 1 ? 'unknown-thread' : 'failed'
  }
}
