import { spawn, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FsLike } from '../adapters/fsLike'
import {
  LAUNCHABLE_PROVIDERS,
  NOT_LAUNCHABLE,
  PRODUCT_NAME,
  notInstalledReason
} from '../domain/launchProviders'
import type { LaunchTuning } from '../domain/launchTuning'
import type { AgentLaunchResult, DwarfProvider, TurnOutcome } from '../domain/types'
import {
  describeProgramFailure,
  describeShimRefusal,
  resolveProgram,
  type CliDetector
} from '../platform/cliDetection'
import type { Platform } from '../platform/platform'
import { buildRelayEnv } from '../textDelivery/relay'
import {
  claudeDetachedExtraArgs,
  claudeMcpConfigJson,
  mergeOpenCodeConfigContent,
  type DelegationInjectionContext
} from '../mcp/delegationInjection'
import { ONE_SHOT_STDOUT_IS_TURN_TEXT, buildLaunchArgs, prepareLaunchPrompt } from './launch'
import type { LaunchedProcess, LaunchFailure } from './launchedSessions'
import { oneShotTurnOutcome } from './oneShotTurnOutcome'

/**
 * Running the launch: the spawn seam, and the mapping from every way it can go
 * wrong to a reason the panel can show.
 *
 * Like the relay this is platform-neutral — it spawns a CLI instead of talking
 * to a window server — so it is composed in the runtime rather than in
 * platformAdapters, and the only per-OS detail (how PATH is spelled) arrives as
 * a Platform parameter.
 */

/**
 * Refusals and failures, phrased for the panel. A path-less refusal
 * (`EMPTY_PROMPT`, `NOT_LAUNCHABLE`) stays fixed copy — there is nothing to
 * name. `couldNotStart` below is not fixed copy any more (#502): it names the
 * path this app tried and why, because a refusal that names nothing the
 * person can act on is a dead end, and the maintainer asked in #502 for the
 * path rather than the dead end.
 */
const EMPTY_PROMPT = 'Type a prompt first.'

/**
 * How long after `spawn` a non-clean exit still counts as the CLI refusing
 * to start, rather than an ordinary end of session (#263).
 *
 * The diagnosis behind this issue: after `spawn` succeeds there was no
 * failure channel at all — stderr discarded, the exit code never read — so a
 * `codex exec` that starts and dies at once (a concurrent instance already
 * holding its lock, a flag it does not recognise, an auth prompt with
 * nothing attached to answer it) was reported `launched: true` and the panel
 * parked on "the session started" forever.
 *
 * A CLI that declines does so almost immediately — milliseconds, not
 * seconds — because refusing is the FIRST thing it does, before any real
 * work. A session that is genuinely running can end at any later moment for
 * reasons that have nothing to do with the launch (the agent simply
 * finished its one turn), so the window has to be short enough that an
 * ordinary turn essentially never finishes inside it. Three seconds is
 * generous headroom past the immediate-refusal case while staying well
 * inside that bound — the two failure modes this constant exists to keep
 * apart.
 */
export const EARLY_FAILURE_WINDOW_MS = 3_000

/**
 * Bound on the stderr this app reads back from a launched child (#263).
 * Never unbounded: a CLI that floods stderr must not cost this process a
 * read of the whole file for words nobody but the last few lines of a
 * refusal will ever see.
 *
 * Real bytes, not an approximation — the file is read with a positioned
 * read exactly like `NodeFs.readTextTail`'s, and the two share that read's
 * own small caveat: a torn multi-byte UTF-8 sequence exactly at the
 * boundary is possible and left unhandled, on the same reasoning that
 * existing read already accepts it.
 */
export const STDERR_TAIL_BYTES = 4 * 1024

/**
 * Bound on the stdout this app reads back from a launched child (#510) —
 * the same reasoning as `STDERR_TAIL_BYTES`, sized differently on purpose. A
 * concluded turn's own final answer is ordinarily prose or code, not the
 * handful of lines an early refusal's stderr is, so this is 4x
 * `STDERR_TAIL_BYTES`: generous enough that a real answer almost never hits
 * the bound, while still refusing to read an unbounded flood into memory.
 * `boundTurnText` (contracts.ts, char-bounded at `MAX_DWARF_TEXT_CHARS`) is
 * the wire's own further cut; this is the byte-level floor beneath it, read
 * back exactly as `STDERR_TAIL_BYTES` already is.
 */
export const STDOUT_TAIL_BYTES = 16 * 1024

/**
 * Where a launched child's stderr is captured (#263) — a small, synchronous
 * port of its own rather than a `FsLike` member: that one is async and
 * read-oriented, built for providers reading a session's transcript, and
 * this needs a REAL fd resolved before `spawn` is even called, plus a
 * write-then-read-then-remove file this app owns start to finish.
 *
 * `path` and `openForWrite` are split so a caller can still name and clean
 * up the exact path it was given even if opening it somehow failed.
 */
export interface StderrFile {
  /** A fresh, unique path for one launch's own capture file. */
  path(): string
  /** Opens `path` for writing and returns the fd `buildLaunchSpawn` hands to `spawn`. */
  openForWrite(path: string): number
  /**
   * Closes the CALLER's copy of the fd — see `runLaunchProcess` on why this
   * is safe the instant `spawn` has taken it.
   */
  close(fd: number): void
  /**
   * The last `maxBytes` written to `path` right now, or `''` if it cannot be
   * read — already removed, never created, or a genuine I/O error all read
   * the same way here: nothing to show is not a fact worth failing over.
   */
  readTail(path: string, maxBytes: number): string
  /** Removes `path`; safe to call on one already gone. */
  remove(path: string): void
}

/**
 * `StderrFile`'s own twin for stdout (#510) — same shape, same lifecycle
 * (opened before `spawn`, this process's own fd closed the instant `spawn`
 * has taken it, read back bounded, removed after reading), a separate named
 * type rather than a shared one because a real launch opens two distinct
 * files for two distinct fds, and a reader should never have to check which
 * concept a `StderrFile` value stands for at a given call site.
 *
 * Also the port a Codex launch reads its OWN `-o` file back through
 * (`LaunchInvocation.outputFile`) — that file is never opened by this app
 * (Codex writes it directly), so only `readTail`/`remove` are ever called
 * against it, never `openForWrite`.
 */
export interface StdoutFile {
  /** A fresh, unique path for one launch's own capture file. */
  path(): string
  /** Opens `path` for writing and returns the fd `buildLaunchSpawn` hands to `spawn`. */
  openForWrite(path: string): number
  /**
   * Closes the CALLER's copy of the fd — see `runLaunchProcess` on why this
   * is safe the instant `spawn` has taken it.
   */
  close(fd: number): void
  /**
   * The last `maxBytes` written to `path` right now, or `''` if it cannot be
   * read — already removed, never created, or a genuine I/O error all read
   * the same way here: nothing to show is not a fact worth failing over.
   */
  readTail(path: string, maxBytes: number): string
  /** Removes `path`; safe to call on one already gone. */
  remove(path: string): void
}

/**
 * The real, disk-backed capture file both `createNodeStderrFile` and
 * `createNodeStdoutFile` are (#263, #510) — one private implementation
 * shared by both, since the two are identical apart from the filename that
 * says which fd a given temp file belongs to. Named on the same pattern
 * this project already uses for "the real implementation of a small port"
 * (`createNodeHostedProcess`, `createSdkModelCatalog`).
 *
 * `node:os`'s `tmpdir()`, never Electron's `app.getPath('temp')`: this
 * module has no Electron import anywhere in it, by design (see the module
 * comment — it is composed in the runtime rather than in
 * platformAdapters) — and a temp directory is a Node fact, not an app one.
 */
function createNodeCaptureFile(kind: 'stderr' | 'stdout'): StderrFile {
  return {
    path: () => join(tmpdir(), `dwarfai-launch-${kind}-${randomUUID()}.log`),
    openForWrite: (path) => openSync(path, 'w'),
    close: (fd) => {
      try {
        closeSync(fd)
      } catch {
        // Already closed, or never really open — nothing left to release.
      }
    },
    readTail: (path, maxBytes) => {
      let fd: number
      try {
        fd = openSync(path, 'r')
      } catch {
        return ''
      }
      try {
        const size = fstatSync(fd).size
        const length = Math.min(size, maxBytes)
        const buffer = Buffer.alloc(length)
        readSync(fd, buffer, 0, length, size - length)
        return buffer.toString('utf8')
      } catch {
        return ''
      } finally {
        closeSync(fd)
      }
    },
    remove: (path) => {
      try {
        unlinkSync(path)
      } catch {
        // Already gone, or never created — nothing left to remove.
      }
    }
  }
}

export function createNodeStderrFile(): StderrFile {
  return createNodeCaptureFile('stderr')
}

export function createNodeStdoutFile(): StdoutFile {
  return createNodeCaptureFile('stdout')
}

/**
 * Where a detached Claude launch's own `--mcp-config` file lives (#511 T4) —
 * a small port on the same shape `StderrFile`/`StdoutFile` are, but simpler:
 * this app WRITES the whole file once, synchronously, before `spawn`, rather
 * than opening an fd for a child to stream into. Removed on exit through the
 * same `StdoutFile` port that already owns the stdout capture and Codex's
 * `-o` file — see `TurnOutcomeWatch`'s own comment on why one more path
 * belongs there rather than a fourth file lifecycle.
 */
export interface DelegationConfigFile {
  /** A fresh, unique path for one launch's own mcp-config file. */
  path(): string
  /** Writes `contents` to `path`, synchronously, before `spawn` is called. */
  write(path: string, contents: string): void
  /** Removes `path`; safe to call on one already gone. */
  remove(path: string): void
}

/**
 * The low-level write primitive `createNodeDelegationConfigFile` calls,
 * injectable so a test can pin the exact OPTIONS this app passes without
 * depending on the OS actually enforcing them (#511 M1b) — Windows has no
 * real per-class (owner/group/other) permission bits to read back, so a
 * test asserting the round-tripped file mode would pass or fail on the
 * wrong grounds depending on which OS runs it. What this app controls, and
 * what is worth pinning, is the CALL: `{ mode: 0o600, flag: 'wx' }`.
 */
type WriteFileSyncLike = (
  path: string,
  contents: string,
  options: { encoding: 'utf8'; mode: number; flag: string }
) => void

/**
 * The `--mcp-config` temp file's own permissions (#511 M1b) — an independent
 * verifier found this written with no `mode` at all, which is 0644 on
 * Linux/macOS: the file (this launch's own delegation endpoint AND token)
 * lands world-readable in a SHARED `/tmp`. `mode: 0o600` restricts it to
 * this app's own OS user; `flag: 'wx'` creates it exclusively (`O_CREAT |
 * O_EXCL`), refusing to write over a path that already exists rather than
 * silently truncating one a `randomUUID()` collision (or something else)
 * left behind — the same "fail rather than clobber" posture a secret file
 * deserves. Both apply on Windows too, where `flag: 'wx'` behaves
 * identically even though `mode`'s effect is limited to the read-only
 * attribute there — see this file's own `WriteFileSyncLike` comment for why
 * this is proven by pinning the CALL rather than the OS's own enforcement.
 */
export function createNodeDelegationConfigFile(
  writeFile: WriteFileSyncLike = writeFileSync
): DelegationConfigFile {
  return {
    path: () => join(tmpdir(), `dwarfai-launch-mcp-config-${randomUUID()}.json`),
    write: (path, contents) =>
      writeFile(path, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
    remove: (path) => {
      try {
        unlinkSync(path)
      } catch {
        // Already gone, or never created — nothing left to remove.
      }
    }
  }
}

/**
 * Watches one child for an early failure (#263): reads its stderr FILE (see
 * `buildLaunchSpawn` for why a file and never a pipe) once, on exit, and
 * latches at most one verdict — a clean 0 or an exit past the window is not
 * a failure, and nothing here fires twice.
 *
 * A latch rather than a bare event, because `retainedProcess` wires this up
 * the instant a launch is retained and the caller (the runtime, which has to
 * learn the receipt this launch was given first) subscribes a moment later.
 * A child that exits in between — vanishingly unlikely, but not impossible —
 * must not lose the failure to a listener that was not there yet.
 *
 * The file is removed unconditionally on exit, whatever the reason — nothing
 * writes to it again once the child is gone. Whenever this process is NOT
 * around to see that exit at all, the file is simply left behind: a detached
 * launch is meant to survive the panel quitting (#231), and there is nothing
 * left in this process by then to clean anything up with. That is an
 * accepted, honest trade-off — a small stray file in the OS temp directory —
 * rather than a reason to keep the pipe hazard `buildLaunchSpawn` documents.
 */
class EarlyFailureWatch {
  private latched: LaunchFailure | null = null
  private listener: ((failure: LaunchFailure) => void) | null = null
  private withinWindow = true

  constructor(
    child: LaunchChild,
    private readonly stderrPath: string,
    private readonly stderrFile: StderrFile
  ) {
    const timer = setTimeout(() => {
      this.withinWindow = false
    }, EARLY_FAILURE_WINDOW_MS)
    // This launch is already detached and unref'd (see runLaunchProcess); a
    // timer of this watch's own must not be the one thing left keeping the
    // main process's event loop alive.
    timer.unref?.()
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (this.withinWindow && code !== 0) {
        this.latch({
          exitCode: code,
          signal,
          stderrTail: this.stderrFile.readTail(this.stderrPath, STDERR_TAIL_BYTES)
        })
      }
      this.stderrFile.remove(this.stderrPath)
    })
  }

  private latch(failure: LaunchFailure): void {
    this.latched = failure
    this.listener?.(failure)
  }

  /** Told now if the failure already latched, or whenever it does. At most once either way. */
  subscribe(listener: (failure: LaunchFailure) => void): void {
    if (this.latched !== null) {
      listener(this.latched)
      return
    }
    this.listener = listener
  }
}

/**
 * Watches one child for what its own turn concluded (#510) — the one-shot
 * twin of a held session's `turn: 'ended'` signal. Reads the stdout and
 * stderr this launch captured on exit, maps them through the pure
 * `oneShotTurnOutcome`, and latches the result the same way
 * `EarlyFailureWatch` latches its own — a subscriber (the launch registry)
 * attaches after `retainedProcess` has already returned, and a fast-exiting
 * child must not lose the outcome to a listener that has not arrived yet.
 *
 * Registered BEFORE `EarlyFailureWatch` inside `retainedProcess`, which
 * matters and is not a race: Node calls `once('exit', …)` listeners on one
 * EventEmitter in the order they were added, and `EarlyFailureWatch` removes
 * the stderr file on EVERY exit regardless of the failure window. Reading
 * the stderr tail here first is what lets that removal, wherever it runs,
 * find nothing left to do rather than a race over who reads it first.
 *
 * Codex's own `-o` file (`outputFile`, when the invocation carries one) is
 * preferred over the piped stdout tail whenever it actually has something in
 * it — stdout also carries whatever the run printed along the way, where the
 * output file carries only the clean final message. Both `stdoutPath` and
 * `outputFile` are removed unconditionally on exit, the same discipline
 * `EarlyFailureWatch` already holds for stderr.
 */
class TurnOutcomeWatch {
  private latched: TurnOutcome | null = null
  private listener: ((outcome: TurnOutcome) => void) | null = null

  constructor(
    child: LaunchChild,
    private readonly stdoutPath: string,
    private readonly stdoutFile: StdoutFile,
    private readonly stderrPath: string,
    private readonly stderrFile: StderrFile,
    private readonly outputFile: string | undefined,
    private readonly stdoutIsTurnText: boolean,
    private readonly now: () => number,
    /** #511 T4: a delegating Claude launch's own `--mcp-config` temp file, or absent. */
    private readonly delegationConfigFile: string | undefined = undefined
  ) {
    child.once('exit', (code, signal) => {
      const stderrTail = this.stderrFile.readTail(this.stderrPath, STDERR_TAIL_BYTES)
      const outputText =
        this.outputFile === undefined
          ? ''
          : this.stdoutFile.readTail(this.outputFile, STDOUT_TAIL_BYTES)
      const stdoutTail =
        outputText !== ''
          ? outputText
          : this.stdoutFile.readTail(this.stdoutPath, STDOUT_TAIL_BYTES)
      this.stdoutFile.remove(this.stdoutPath)
      if (this.outputFile !== undefined) this.stdoutFile.remove(this.outputFile)
      // #511 T4: removed unconditionally on every exit, the same discipline
      // `outputFile` above already holds — through the SAME `StdoutFile`
      // port, since this is just another path this app owns, never a fourth
      // file lifecycle.
      if (this.delegationConfigFile !== undefined) this.stdoutFile.remove(this.delegationConfigFile)
      this.latch(
        oneShotTurnOutcome({
          exitCode: code,
          signal,
          stdoutTail,
          stderrTail,
          // #510 correction. The file is still read back the same mechanical
          // way regardless — removing an unread capture is still this
          // watch's job — but whether that capture may become `text` is
          // decided by the pure function below, never here.
          stdoutIsTurnText: this.stdoutIsTurnText,
          now: this.now()
        })
      )
    })
  }

  private latch(outcome: TurnOutcome): void {
    this.latched = outcome
    this.listener?.(outcome)
  }

  /** Told now if the outcome already latched, or whenever it does. At most once either way. */
  subscribe(listener: (outcome: TurnOutcome) => void): void {
    if (this.latched !== null) {
      listener(this.latched)
      return
    }
    this.listener = listener
  }
}

/*
 * `PRODUCT_NAME` moved to domain/launchProviders.ts for #237, step 5: the held
 * registry needs the same table now that a second provider can be held, and
 * two copies is how the same missing CLI comes to be named two ways.
 */

/**
 * Names the product, the path this app tried and why (#502) — the shape
 * `notInstalledReason` already set for "not installed", carried to the two
 * remaining ways a launch can go nowhere: a `resolveProgram` refusal and a
 * spawn error, whichever this launch's `catch` below caught.
 */
function couldNotStart(provider: DwarfProvider, path: string, cause: string): string {
  return `${PRODUCT_NAME[provider]} could not be started: ${path} — ${cause}.`
}

export interface LaunchInvocation {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** The mine's folder. This, and nothing else, is what puts the new dwarf in the right mine. */
  cwd: string
  /** The first prompt, written to the child's stdin and never placed in argv. */
  stdin: string
  /**
   * Whether `command` is an interpreter running a JS entry rather than the
   * console program itself (#208). It decides console hosting, not argv: a
   * program that IS the console program needs no host, and one that will go on
   * to spawn one does. Set where the answer is known — `resolveProgram` in
   * platform/cliDetection.ts, which is what read the shim.
   */
  viaNodeEntry: boolean
  /**
   * Whether THIS launch's stdout capture is its provider's own turn TEXT, or
   * an opaque machine envelope `oneShotTurnOutcome` must not read as one
   * (#510 correction) — `ONE_SHOT_STDOUT_IS_TURN_TEXT` (launch.ts)'s verdict
   * for `options.provider`, read once by `launchClaudeSession` and carried
   * here unchanged.
   *
   * A required field rather than an optional one defaulting to `true`, on
   * the same reasoning `viaNodeEntry` above already is: this app does not
   * invent an answer it has not measured for a provider a future caller
   * forgets to name, the same discipline `buildLaunchArgs`'s own exhaustive
   * switch (launch.ts) already holds for argv. `buildLaunchSpawn` itself
   * never reads this field — the CAPTURE stays provider-agnostic, on
   * purpose — only `TurnOutcomeWatch`'s exit handler does.
   */
  stdoutIsTurnText: boolean
  /**
   * A path some CLIs write their own final message to directly (#510) — set
   * today only for Codex, whose `-o, --output-last-message <FILE>` this
   * app's own argv includes when it is present (see `launchClaudeSession`).
   * `TurnOutcomeWatch` prefers this file's content over the piped stdout
   * tail whenever it has anything in it. This app never opens the file for
   * writing — the CLI creates and writes it itself — only reads it back
   * bounded and removes it on exit, through the same `StdoutFile` port.
   */
  outputFile?: string
  /**
   * The `--mcp-config` temp file this launch wrote for a delegating Claude
   * session (#511 T4), so `TurnOutcomeWatch` can remove it on exit the same
   * unconditional way it already removes Codex's own `-o` file — never
   * opened for writing through this app's own `StdoutFile`/`StderrFile`
   * ports (see `DelegationConfigFile`, whose own `write` is synchronous and
   * runs before `spawn`), only read back for cleanup here.
   */
  delegationConfigFile?: string
}

/**
 * Resolves once the process is running; rejects when it could not be started
 * at all.
 *
 * What it resolves WITH is the handle on that process (#217), which is the
 * whole of how a detached launch stopped being a dead end: the panel now keeps
 * the pid it spawned and the notice of that process going, so a session
 * started here can be ended here. Undefined means the process started but
 * reported no pid — nothing to hold, so nothing is claimed.
 */
export type LaunchRunner = (invocation: LaunchInvocation) => Promise<LaunchedProcess | undefined>

/**
 * The slice of a ChildProcess the runner touches, so a test can hand it a
 * recording fake and assert the exact spawn call without starting a process
 * (#193).
 */
export interface LaunchChild {
  once(event: 'spawn', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  /**
   * Node's own 'exit' shape (#263): the child's own code, or null when it
   * went by signal instead. Split from 'error' and 'spawn' above rather than
   * kept in the old three-events-one-signature shape, because this is the
   * event `EarlyFailureWatch` reads to tell a launch failure from an
   * ordinary end of session — a listener that could not see the code could
   * not tell the two apart.
   */
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): unknown
  /**
   * The started process's own pid, which is what the panel retains so it can
   * end that tree later (#217). Optional because Node's is: a child that never
   * started has none, and neither does one this cannot hold onto.
   */
  readonly pid?: number
  stdin: { on(event: 'error', listener: () => void): unknown; end(chunk: string): unknown } | null
  unref(): void
}

/** `spawn`'s shape as the runner needs it; Node's own `spawn` satisfies it. */
export type SpawnLaunch = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => LaunchChild

/**
 * The port as the runtime holds it: a provider, a folder and a prompt in, a
 * verdict out.
 *
 * The provider is the caller's now (#168). It used to be decided behind this
 * port — "Claude is the only one wired today" — which meant the chip a user
 * pressed could not reach the engine at all, and every launch was a Claude one
 * whatever the panel said. Which CLIs this port can actually honour is still
 * the engine's answer, and it refuses the rest by name rather than substituting.
 */
export type SessionLauncher = (
  request: {
    provider: DwarfProvider
    minePath: string
    prompt: string
    /**
     * The MCP delegation server this launch's own gate check
     * (`delegationGate.ts`, evaluated in `runtime.ts`) already approved, or
     * absent when it declined (#511 T4) — read only by `launchClaudeSession`
     * for `claude`/`opencode`; every other provider's builder never sees it.
     */
    delegation?: DelegationInjectionContext
  } & LaunchTuning
) => Promise<SessionLaunchOutcome>

/**
 * The launcher's verdict, plus the handle on what it started (#217).
 *
 * `retained` is main-side only and never crosses the wire: what the renderer
 * is told is unchanged — a process started, and nothing more is claimed. The
 * runtime keeps the handle (see LaunchedSessionRegistry) and strips it from the
 * verdict it answers the panel with, so a pid is not something the panel holds
 * or could ask about.
 *
 * Absent means there is nothing to keep: a refused launch started no process,
 * and a started one that reported no pid cannot be held onto.
 */
export interface SessionLaunchOutcome extends AgentLaunchResult {
  retained?: LaunchedProcess
}

/**
 * The program that hosts the launched CLI's console (#208).
 *
 * A program text rather than a script file on purpose: it travels on `node -e`,
 * because the packaged app lives inside app.asar, which a plain node.exe cannot
 * read. There is no file to point at, so the argv IS the file. It carries no
 * user data — the prompt still travels only on stdin — and `stdio` is inherited
 * rather than read and rewritten, so the pipe the panel wrote reaches the CLI
 * untouched.
 *
 * It must not detach its child (that is the whole point, see
 * `buildLaunchSpawn`), must not unref it, and must not outlive it: libuv's job
 * handle is what keeps the child alive, and an intermediary that stayed behind
 * would leak an idle process for every session ever launched.
 */
export const CONSOLE_HOSTING_PROGRAM = [
  "const{spawn}=require('child_process');",
  'const argv=process.argv.slice(1);',
  "const child=spawn(argv[0],argv.slice(1),{stdio:['inherit','ignore','ignore'],windowsHide:true});",
  "child.on('error',()=>process.exit(1));",
  "child.on('exit',(code)=>process.exit(code===null?1:code));"
].join('')

/**
 * The exact spawn call, as a value (#208).
 *
 * ## Why a JS entry cannot be spawned the way a program can
 *
 * libuv turns `detached` into `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` and
 * `windowsHide` into `CREATE_NO_WINDOW`, and Win32 documents CREATE_NO_WINDOW
 * as IGNORED alongside DETACHED_PROCESS. So `windowsHide` on this spawn is
 * inert — it is kept because it states the intent, and because that flag is what
 * a reader reaches for first, which is exactly the trap that produced #208 —
 * and the child starts with NO console at all. Harmless for a program that is
 * itself the console program: it simply has none. Not harmless for a JS entry,
 * which is an interpreter that goes on to spawn the real CLI, because Windows
 * hands a console-subsystem program whose parent has no console a fresh VISIBLE
 * console. Measured on Windows 11 / Node v24.11.1: consoleVisible=true, owned
 * by the grandchild itself. Since #193 resolved a shim to `node <entry>`, every
 * npm/pnpm Codex launch took that path — hence the window that stayed on screen
 * for as long as the session ran.
 *
 * ## Why an intermediary, and why it waits
 *
 * A console cannot be hidden and detached in the same spawn, so the two are
 * split across two hops. The detached hop is console-less, as before, and its
 * only job is to spawn the real program NOT detached but WITH `windowsHide`:
 * with DETACHED_PROCESS gone, CREATE_NO_WINDOW is honoured and the program gets
 * an INVISIBLE console of its own, which the CLI it starts then inherits.
 * Measured: hasConsole=true, consoleVisible=false, owned by the intermediary's
 * child rather than by the grandchild.
 *
 * The intermediary has to stay alive, and that is a cost rather than an
 * oversight. libuv gives its job object KILL_ON_JOB_CLOSE and the handle
 * belongs to the spawning process, so a non-detached child dies when its
 * spawner exits — measured twice: an intermediary that spawned and returned had
 * its child killed before the child's first statement ran. That job's
 * SILENT_BREAKAWAY_OK only keeps the child out of the PANEL's job; it does not
 * save it from the intermediary's own. A hidden console therefore always needs
 * a live holder, and the price is one resident node process (~37 MB) per
 * shim-launched session, for that session's lifetime.
 *
 * Verified end to end on this machine with a real `codex exec` turn that ran a
 * shell tool after the panel process had already exited: no window appeared,
 * the turn completed, and the prompt had arrived on stdin.
 *
 * The road not taken: resolving one level deeper and spawning the native
 * codex.exe detached measures clean too — its own tool shells set
 * CREATE_NO_WINDOW, so a real turn popped no window either — but finding that
 * binary means reimplementing `@openai/codex`'s private resolution (a target
 * triple table, module resolution of an optional platform package from the
 * entry's REALPATH, and a vendor fallback that does not exist on this machine),
 * and wherever that copy misses, the window comes back unannounced.
 */
export function buildLaunchSpawn(
  invocation: LaunchInvocation,
  stdoutFd: number,
  stderrFd: number
): {
  command: string
  args: string[]
  options: SpawnOptions
} {
  const options: SpawnOptions = {
    cwd: invocation.cwd,
    env: invocation.env,
    detached: true,
    // stdout and stderr are each a FILE's own fd, never a pipe and never
    // 'ignore' (#263, #510).
    //
    // A pipe's PARENT end belongs to THIS process, and this launch is
    // detached and unref'd on purpose so the session survives the panel
    // quitting (#231) — that is the whole point of a detached launch, not
    // an edge case of it. The moment this process exits, the pipe's read
    // end goes with it, and the next time the still-running child writes to
    // stdout or stderr it gets EPIPE (or the Windows equivalent of a handle
    // that is simply gone) instead of the write it asked for — which can
    // kill a session that was never asked to end. "The panel restarted"
    // must never become "every launched session dies the next time it logs
    // a warning". 'ignore' has no such hazard, but for stdout it was the
    // ORIGINAL gap #510 exists to close: the very words a one-shot launch
    // concludes with were thrown away and nothing could ever say what it
    // answered — 'ignore' was there in the first place only to keep an
    // unread pipe from stalling the child, which a captured fd already does
    // not do (it is read from, not written to, by this app).
    //
    // A file has neither problem. There is no reader on the far end to
    // disappear — it is a plain file, opened by `runLaunchProcess` before
    // this call and closed on THIS process's own side the instant `spawn`
    // has taken it, which does not touch the child's own duplicate of the
    // fd — and the bytes are still sitting on disk whenever this app is
    // actually still around to read them.
    stdio: ['pipe', stdoutFd, stderrFd],
    windowsHide: true
  }
  if (!invocation.viaNodeEntry) {
    return { command: invocation.command, args: invocation.args, options }
  }
  // The same node twice: once to run the intermediary, once as the program the
  // intermediary starts. Nothing new is introduced into the chain.
  return {
    command: invocation.command,
    args: ['-e', CONSOLE_HOSTING_PROGRAM, invocation.command, ...invocation.args],
    options
  }
}

/**
 * Start the session and let go of it.
 *
 * Detached and unref'd so the agent outlives the panel: the panel is an
 * observer of sessions, and one that died whenever the tray icon quit would be
 * a worse thing than what a terminal already gives the user. stdin is the
 * prompt's only transport and is closed straight after writing — the child then
 * has no stream anyone here reads on stdin. Both stdout and stderr are
 * captured to a FILE, never ignored and never piped (#263, #510), for the
 * reason `buildLaunchSpawn` states at length — a pipe's parent end would
 * disappear the moment this process exits, and this launch exists
 * specifically to survive that (#231).
 *
 * No `shell`, ever, and `detached` is not negotiable — the two are linked. A
 * detached cmd.exe has no console and starts no external program (exit 0,
 * nothing run), and a non-detached child sits in libuv's kill-on-close job
 * object and dies with the panel; both verified on Windows 11 / Node v24.11.1
 * for #193. A batch shim therefore never reaches this function: the launcher
 * resolves it to the program it points at first (see `resolveShimTarget`).
 *
 * What is spawned is not always what was asked for: a JS entry is wrapped in a
 * console host first, for the reasons `buildLaunchSpawn` sets out (#208). The
 * prompt still goes to the process this function spawned, which passes that
 * pipe down the chain by inheritance.
 *
 * `now` (#510) is `Date.now` by default; a test injects a fixed clock so a
 * captured `TurnOutcome`'s `endedAt` is asserted exactly rather than merely
 * "close to now".
 */
export function runLaunchProcess(
  invocation: LaunchInvocation,
  spawnProcess: SpawnLaunch = spawn,
  stderrFile: StderrFile = createNodeStderrFile(),
  stdoutFile: StdoutFile = createNodeStdoutFile(),
  now: () => number = Date.now
): Promise<LaunchedProcess | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false
    let child: LaunchChild
    const stderrPath = stderrFile.path()
    const stderrFd = stderrFile.openForWrite(stderrPath)
    const stdoutPath = stdoutFile.path()
    const stdoutFd = stdoutFile.openForWrite(stdoutPath)
    const call = buildLaunchSpawn(invocation, stdoutFd, stderrFd)
    try {
      child = spawnProcess(call.command, call.args, call.options)
    } catch (error) {
      // Nothing will ever be spawned to write here now; clean up what was
      // opened for it rather than leaving an empty file behind.
      stderrFile.close(stderrFd)
      stderrFile.remove(stderrPath)
      stdoutFile.close(stdoutFd)
      stdoutFile.remove(stdoutPath)
      // #511 L1: nothing will ever spawn to read this delegation config file
      // back either — an independent verifier found it left behind on this
      // exact path (a synchronous spawn throw, before `options.run`'s
      // promise ever settles), and it carries this launch's own delegation
      // secret, so it is removed on every path that opened it, the same
      // discipline the two capture files above already hold.
      if (invocation.delegationConfigFile !== undefined) {
        stdoutFile.remove(invocation.delegationConfigFile)
      }
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    // This process's own copy of each fd is closed the instant `spawn` has
    // taken it (#263, #510) — see `buildLaunchSpawn`'s note on why that is
    // safe: the child keeps its own duplicate of the fd, and closing this
    // one does not touch that.
    stderrFile.close(stderrFd)
    stdoutFile.close(stdoutFd)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      stderrFile.remove(stderrPath)
      stdoutFile.remove(stdoutPath)
      // #511 L1: same reasoning as the synchronous spawn-throw branch above
      // — the child never reached `retainedProcess`, so nothing else will
      // ever remove this file.
      if (invocation.delegationConfigFile !== undefined) {
        stdoutFile.remove(invocation.delegationConfigFile)
      }
      reject(error)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      // A child that exits before reading breaks the pipe. That is its own
      // business by then — the process did start — but an unhandled EPIPE on
      // this stream would take the whole main process down with it.
      child.stdin?.on('error', () => {})
      child.stdin?.end(invocation.stdin)
      child.unref()
      resolve(
        retainedProcess(
          child,
          stdoutPath,
          stdoutFile,
          stderrPath,
          stderrFile,
          invocation.outputFile,
          invocation.stdoutIsTurnText,
          now,
          invocation.delegationConfigFile
        )
      )
    })
  })
}

/**
 * The handle the panel keeps on what this started (#217).
 *
 * Retaining a pid alone would be enough to signal something and not enough to
 * know it is still the right something: once that process has gone its number
 * can belong to anything on this machine. So the handle carries the notice of
 * the exit too, and the register that holds it stops signalling from there —
 * see LaunchedSessionRegistry.
 *
 * `unref` above is untouched by this, and deliberately: unref only stops the
 * child from keeping an event loop alive, and this main process has one for as
 * long as the app runs, so the exit still arrives.
 */
function retainedProcess(
  child: LaunchChild,
  stdoutPath: string,
  stdoutFile: StdoutFile,
  stderrPath: string,
  stderrFile: StderrFile,
  outputFile: string | undefined,
  stdoutIsTurnText: boolean,
  now: () => number,
  delegationConfigFile?: string
): LaunchedProcess | undefined {
  const pid = child.pid
  if (pid === undefined) {
    // Nothing to hold means nothing to watch either (#263, #510) — these
    // files will never be read, because there is no handle left to
    // correlate an exit to, so there is no reason to wait for one.
    //
    // AMENDED for #511 L1 (was: the mcp-config file left behind here as an
    // accepted tradeoff, on the reasoning that a launch with no pid to
    // retain is vanishingly rare). An independent verifier asked for it to
    // be cleaned up anyway: unlike the stdout/stderr capture files, this one
    // carries a live delegation secret, and "vanishingly rare" is still a
    // stray secret on disk rather than nothing. It goes through the SAME
    // `StdoutFile` port `outputFile`'s own cleanup already uses — never a
    // fourth file lifecycle of its own.
    stdoutFile.remove(stdoutPath)
    stderrFile.remove(stderrPath)
    if (delegationConfigFile !== undefined) stdoutFile.remove(delegationConfigFile)
    return undefined
  }
  // TurnOutcomeWatch is registered BEFORE EarlyFailureWatch, on purpose —
  // see TurnOutcomeWatch's own comment on why the order of these two exit
  // listeners matters. Both start now, unconditionally, rather than only
  // once a caller subscribes (#263): the failure EarlyFailureWatch exists to
  // catch can happen within milliseconds of spawning, and each watch's own
  // latch is what keeps a subscriber that arrives a tick later from losing
  // its answer.
  const turnOutcome = new TurnOutcomeWatch(
    child,
    stdoutPath,
    stdoutFile,
    stderrPath,
    stderrFile,
    outputFile,
    stdoutIsTurnText,
    now,
    delegationConfigFile
  )
  const earlyFailure = new EarlyFailureWatch(child, stderrPath, stderrFile)
  return {
    pid,
    onExit: (listener) => {
      child.once('exit', listener)
    },
    onEarlyFailure: (listener) => {
      earlyFailure.subscribe(listener)
    },
    onTurnOutcome: (listener) => {
      turnOutcome.subscribe(listener)
    }
  }
}

/**
 * What one detached launch needs.
 *
 * Extends `LaunchTuning` (#239), so the model and the effort arrive as the
 * request's own optional fields rather than as a nested object: both are
 * absent for an untuned launch, and an untuned launch is the one that has to
 * stay byte for byte what it was.
 */
export interface ClaudeLaunchOptions extends LaunchTuning {
  /** Which CLI to start (#168). Its argv comes from `buildLaunchArgs`. */
  provider: DwarfProvider
  /** The mine's path, resolved by the caller — never a path the renderer supplied. */
  minePath: string
  prompt: string
  detector: CliDetector
  env: NodeJS.ProcessEnv
  platform: Platform
  /** Reads a batch shim for the program it points at (#193); the same fs detection probes with. */
  fs: FsLike
  run: LaunchRunner
  /**
   * Where Codex's own `-o` flag will write the turn's final message directly
   * (#510) — ignored by every other provider. Defaults to a fresh real temp
   * path per call; a test injects a fixed one so it can assert argv and
   * `LaunchInvocation.outputFile` against a known value.
   */
  codexOutputPath?: () => string
  /**
   * The MCP delegation server this launch's own gate check
   * (`delegationGate.ts`, evaluated in `runtime.ts`) already approved, or
   * absent when it declined (#511 T4) — read only for `claude` (a temp
   * `--mcp-config` file) and `opencode` (`OPENCODE_CONFIG_CONTENT`); every
   * other provider's own builder simply never sees it, on the same
   * exhaustive-dispatch discipline `buildLaunchArgs` already holds for argv.
   */
  delegation?: DelegationInjectionContext
  /**
   * The `--mcp-config` temp-file port for a delegating Claude launch (#511
   * T4). Defaults to a real one; a test injects a deterministic fake so it
   * can assert the exact path and body written.
   */
  delegationConfigFile?: DelegationConfigFile
}

/**
 * The default `codexOutputPath` generator (#510) — a real, unique temp path,
 * on the same `dwarfai-launch-<kind>-<uuid>.log` naming `createNodeCaptureFile`
 * already uses for the stdout/stderr capture files. Not built from a
 * `StdoutFile`/`StderrFile` port: this app never opens the file for writing
 * (Codex does), so only a fresh name is needed here, never `openForWrite`.
 */
function defaultCodexOutputPath(): string {
  return join(tmpdir(), `dwarfai-launch-codex-output-${randomUUID()}.log`)
}

/**
 * What one detached provider's own per-invocation MCP mechanism needs,
 * given the gate's own approved injection context (#511 T4) — the ONE place
 * this function's caller (`launchClaudeSession`) has to branch on provider
 * for delegation, mirroring the exhaustive-dispatch discipline
 * `buildLaunchArgs` (launch.ts) already holds for argv: `codex` and
 * `antigravity` are never reached with a `delegation` context at all today
 * (`delegationGate.ts`'s own `DELEGATION_CAPABLE_PROVIDERS`), and simply
 * fall through unchanged if they ever were.
 *
 * The side effect (writing the temp file) lives here rather than in
 * `delegationInjection.ts`, which stays pure — this function is the one
 * impure seam that decides WHEN to write, and `configFile` is the injected
 * port a test replaces.
 */
function delegationInjectionFor(
  provider: DwarfProvider,
  delegation: DelegationInjectionContext | undefined,
  env: NodeJS.ProcessEnv,
  configFile: DelegationConfigFile
): { extraArgs: string[]; env: NodeJS.ProcessEnv; delegationConfigFile?: string } {
  if (delegation === undefined) return { extraArgs: [], env }
  if (provider === 'claude') {
    const path = configFile.path()
    configFile.write(path, claudeMcpConfigJson(delegation))
    return { extraArgs: claudeDetachedExtraArgs(path), env, delegationConfigFile: path }
  }
  if (provider === 'opencode') {
    // #511 L3: this env is inherited by the CLI process itself (never only
    // the server this app spawns from it), so `DWARFAI_DELEGATION_TOKEN`
    // sits in OpenCode's own process environment for the life of that
    // launch — readable by anything OpenCode itself spawns as a subprocess,
    // which this app has no visibility into. Left as a documented, deferred
    // risk (T5's own privacy doc covers it) rather than fixed here: unlike
    // the held-Claude argv exposure (#511 M1a) or the detached-Claude temp
    // file (#511 M1b), there is no narrower per-invocation mechanism
    // OpenCode's own docs expose that would keep this env off the CLI's own
    // process without also keeping it off the SERVER process that needs it.
    const merged = mergeOpenCodeConfigContent(env.OPENCODE_CONFIG_CONTENT, delegation)
    // #511 L4: `merged` is `undefined` only when this launch's OWN
    // `OPENCODE_CONFIG_CONTENT` was already present and this app could not
    // parse it as a JSON object — see `mergeOpenCodeConfigContent`'s own
    // comment. Skipping injection here (the launch proceeds exactly as an
    // ungated one would) is the safe default: REPLACING content this app
    // cannot see the reason for would silently discard it.
    if (merged === undefined) return { extraArgs: [], env }
    return { extraArgs: [], env: { ...env, OPENCODE_CONFIG_CONTENT: merged } }
  }
  return { extraArgs: [], env }
}

/**
 * Start one DETACHED session in a mine's folder, for whichever CLI was chosen.
 *
 * Detached is the whole of what this function does, and since #168 it is what a
 * Codex launch IS: Codex has no held-session engine in this app, so the only
 * shape available to it is start-and-let-go, with the ordinary poll discovering
 * the session afterwards through Codex's own rollout storage. Claude can be
 * launched either way; the held route lives in `heldSessionRegistry`.
 *
 * Every failure becomes a `launched: false` verdict with a reason, never a
 * silent no-op — the discipline deliverViaRelay already holds. "Not installed"
 * is deliberately its own reason rather than being folded into "could not be
 * started": it is the one failure the user can actually do something about,
 * and detection (#91) already knows how to say why. A batch shim used to be a
 * second refusal of that kind, naming CODEX_CLI_PATH; #193 removed it, because
 * the program behind the shim can be started (see `resolveProgram` in
 * platform/cliDetection.ts) and the exit it named was one a packaged user
 * could not take.
 *
 * A successful verdict says a process started and nothing more. No dwarf is
 * returned and none is invented: the poll discovers the session, on its own
 * schedule.
 */
export async function launchClaudeSession(
  options: ClaudeLaunchOptions
): Promise<SessionLaunchOutcome> {
  const prompt = prepareLaunchPrompt(options.prompt)
  // Cheapest refusal first, so an empty box never costs a disk probe.
  if (prompt === '') return { launched: false, provider: 'none', error: EMPTY_PROMPT }

  // #444. `parseLaunchRequest` admits any `isDwarfProvider`, and until this
  // gate a crafted request for a non-launchable provider (OpenCode observes
  // opencode.db and has no launch invocation this app has measured) reached
  // buildLaunchArgs inside the try below. Checked before detection — the
  // gate is absent for every non-launchable provider, not only OpenCode.
  if (!LAUNCHABLE_PROVIDERS.includes(options.provider)) {
    return { launched: false, provider: options.provider, error: NOT_LAUNCHABLE }
  }

  const detection = await options.detector.detect(options.provider)
  if (!detection.installed || detection.path === undefined) {
    const reason = notInstalledReason(options.provider)
    return {
      launched: false,
      provider: options.provider,
      error: detection.reason === undefined ? reason : `${reason} ${detection.reason}`
    }
  }

  try {
    // Inside the try because reading a shim is a disk read that can fail like
    // a spawn can, and it fails the same way for the user: nothing started.
    const program = await resolveProgram(detection.path, options.fs)
    if ('kind' in program) {
      return {
        launched: false,
        provider: options.provider,
        error: couldNotStart(options.provider, program.shimPath, describeShimRefusal(program))
      }
    }
    // #510. Only Codex has a `-o` flag; every other provider's builder
    // simply never sees this value (see `buildLaunchArgs`'s own comment).
    // Minted once, here, so the SAME path both lands in argv and travels on
    // the invocation for `TurnOutcomeWatch` to read back on exit — the two
    // must agree, and the caller (Codex itself) is who writes the file, so
    // this app decides the name and nothing else about it.
    const codexOutputPath =
      options.provider === 'codex'
        ? (options.codexOutputPath ?? defaultCodexOutputPath)()
        : undefined
    // #511 T4: the gate's own approved injection, or a no-op for an ordinary
    // launch — see `delegationInjectionFor`'s own comment. Computed AFTER
    // `buildLaunchArgs` decides argv is out of scope for it (delegation adds
    // to that argv, never replaces it), and BEFORE `options.run` so both the
    // extra argv and the possibly-merged env reach the same spawn call.
    const injection = delegationInjectionFor(
      options.provider,
      options.delegation,
      buildRelayEnv(options.env, detection.path, options.platform),
      options.delegationConfigFile ?? createNodeDelegationConfigFile()
    )
    const started = await options.run({
      command: program.command,
      // The tuning belongs to the CLI's own argv, so it lands AFTER a shim's
      // node entry (#239): in front of it, `--model` would be an argument to
      // node rather than to the program node is about to run. Delegation's
      // own extra argv (#511 T4) lands last: `claudeDetachedExtraArgs`
      // documents why `--strict-mcp-config` is never among it, so nothing
      // here narrows what the CLI's OWN config already grants this session.
      args: [
        ...program.args,
        ...buildLaunchArgs(
          options.provider,
          {
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.effort === undefined ? {} : { effort: options.effort })
          },
          codexOutputPath
        ),
        ...injection.extraArgs
      ],
      // The relay's env rule, for the relay's reason: a re-exec of the CLI
      // inside the child must reach the install detection found rather than
      // one that happens to sit earlier on PATH. The detected path, so a shim
      // launch still leads with the shim's own directory. `injection.env`
      // (#511 T4) is that SAME env, merged with `OPENCODE_CONFIG_CONTENT`
      // for a delegating OpenCode launch — see `delegationInjectionFor`.
      env: injection.env,
      cwd: options.minePath,
      stdin: prompt,
      viaNodeEntry: program.viaNodeEntry,
      // #510 correction. Read once here, from the table that decides it
      // beside each provider's own argv (`ONE_SHOT_STDOUT_IS_TURN_TEXT`,
      // launch.ts) — never re-derived at the point that reads the capture.
      stdoutIsTurnText: ONE_SHOT_STDOUT_IS_TURN_TEXT[options.provider],
      ...(codexOutputPath === undefined ? {} : { outputFile: codexOutputPath }),
      ...(injection.delegationConfigFile === undefined
        ? {}
        : { delegationConfigFile: injection.delegationConfigFile })
    })
    // Reported rather than kept: whoever asked for the launch decides whether
    // to hold onto it, because deciding needs the board and this does not have
    // one (#217). A refusal started nothing, so it carries nothing.
    return {
      launched: true,
      provider: options.provider,
      ...(started === undefined ? {} : { retained: started })
    }
  } catch (error) {
    return {
      launched: false,
      provider: options.provider,
      error: couldNotStart(options.provider, detection.path, describeProgramFailure(error))
    }
  }
}
