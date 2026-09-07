import { spawn, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FsLike } from '../adapters/fsLike'
import type { LaunchTuning } from '../domain/launchTuning'
import type { AgentLaunchResult, DwarfProvider } from '../domain/types'
import { resolveShimTarget, type CliDetector } from '../platform/cliDetection'
import type { Platform } from '../platform/platform'
import { buildRelayEnv } from '../textDelivery/relay'
import { buildLaunchArgs, isShellShim, prepareLaunchPrompt } from './launch'
import type { LaunchedProcess, LaunchFailure } from './launchedSessions'

/**
 * Running the launch: the spawn seam, and the mapping from every way it can go
 * wrong to a reason the panel can show.
 *
 * Like the relay this is platform-neutral — it spawns a CLI instead of talking
 * to a window server — so it is composed in the runtime rather than in
 * platformAdapters, and the only per-OS detail (how PATH is spelled) arrives as
 * a Platform parameter.
 */

/** Refusals and failures, phrased for the panel. Fixed copy, and never a path. */
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
 * The real, disk-backed `StderrFile` (#263) — the seam `runLaunchProcess` is
 * written against, so no unit test other than the one proving THIS works
 * touches a real file. Named on the same pattern this project already uses
 * for "the real implementation of a small port" (`createNodeHostedProcess`,
 * `createSdkModelCatalog`).
 *
 * `node:os`'s `tmpdir()`, never Electron's `app.getPath('temp')`: this
 * module has no Electron import anywhere in it, by design (see the module
 * comment — it is composed in the runtime rather than in
 * platformAdapters) — and a temp directory is a Node fact, not an app one.
 */
export function createNodeStderrFile(): StderrFile {
  return {
    path: () => join(tmpdir(), `dwarfai-launch-stderr-${randomUUID()}.log`),
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
 * What each CLI is called when the panel has to name it.
 *
 * Per provider rather than one string, because these are the sentences a user
 * acts on: "Claude Code is not installed" shown for a Codex chip would send
 * somebody to install the wrong program at the one moment the message was
 * supposed to help (#168).
 */
const PRODUCT_NAME: Record<DwarfProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  // Reachable since #237 step 4: a detached Antigravity launch runs through
  // this same engine, and a refusal — not installed, could not be started —
  // must name the product, not its `agy` executable.
  antigravity: 'Antigravity CLI'
}

function notInstalled(provider: DwarfProvider): string {
  return `${PRODUCT_NAME[provider]} is not installed on this machine.`
}

function couldNotStart(provider: DwarfProvider): string {
  return `${PRODUCT_NAME[provider]} could not be started.`
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
   * to spawn one does. Set where the answer is known — `resolveLaunchProgram`,
   * which is what read the shim.
   */
  viaNodeEntry: boolean
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
    // stderr is a FILE's own fd, never a pipe and never 'ignore' (#263).
    //
    // A pipe's PARENT end belongs to THIS process, and this launch is
    // detached and unref'd on purpose so the session survives the panel
    // quitting (#231) — that is the whole point of a detached launch, not
    // an edge case of it. The moment this process exits, the pipe's read
    // end goes with it, and the next time the still-running child writes to
    // stderr it gets EPIPE (or the Windows equivalent of a handle that is
    // simply gone) instead of the write it asked for — which can kill a
    // session that was never asked to end. "The panel restarted" must never
    // become "every launched session dies the next time it logs a
    // warning". 'ignore' has no such hazard, but it is the ORIGINAL gap
    // this issue exists to close: the words are thrown away and nothing
    // here can ever say why a launch failed.
    //
    // A file has neither problem. There is no reader on the far end to
    // disappear — it is a plain file, opened by `runLaunchProcess` before
    // this call and closed on THIS process's own side the instant `spawn`
    // has taken it, which does not touch the child's own duplicate of the
    // fd — and the bytes are still sitting on disk whenever this app is
    // actually still around to read them.
    stdio: ['pipe', 'ignore', stderrFd],
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
 * has no stream anyone here reads on stdin, which is also why stdout is
 * ignored rather than piped: an unread pipe fills and stalls the child.
 * stderr is the one exception (#263): captured to a FILE, never ignored and
 * never piped, for the reason `buildLaunchSpawn` states at length — a pipe's
 * parent end would disappear the moment this process exits, and this launch
 * exists specifically to survive that (#231).
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
 */
export function runLaunchProcess(
  invocation: LaunchInvocation,
  spawnProcess: SpawnLaunch = spawn,
  stderrFile: StderrFile = createNodeStderrFile()
): Promise<LaunchedProcess | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false
    let child: LaunchChild
    const stderrPath = stderrFile.path()
    const stderrFd = stderrFile.openForWrite(stderrPath)
    const call = buildLaunchSpawn(invocation, stderrFd)
    try {
      child = spawnProcess(call.command, call.args, call.options)
    } catch (error) {
      // Nothing will ever be spawned to write here now; clean up what was
      // opened for it rather than leaving an empty file behind.
      stderrFile.close(stderrFd)
      stderrFile.remove(stderrPath)
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    // This process's own copy of the fd is closed the instant `spawn` has
    // taken it (#263) — see `buildLaunchSpawn`'s note on why that is safe:
    // the child keeps its own duplicate of the fd, and closing this one
    // does not touch that.
    stderrFile.close(stderrFd)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      stderrFile.remove(stderrPath)
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
      resolve(retainedProcess(child, stderrPath, stderrFile))
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
  stderrPath: string,
  stderrFile: StderrFile
): LaunchedProcess | undefined {
  const pid = child.pid
  if (pid === undefined) {
    // Nothing to hold means nothing to watch either (#263) — this file will
    // never be read, because there is no handle left to correlate an exit
    // to, so there is no reason to wait for one.
    stderrFile.remove(stderrPath)
    return undefined
  }
  // Watching starts now, unconditionally, rather than only once a caller
  // subscribes (#263): the failure this exists to catch can happen within
  // milliseconds of spawning, and EarlyFailureWatch's own latch is what
  // keeps a subscriber that arrives a tick later from losing it.
  const earlyFailure = new EarlyFailureWatch(child, stderrPath, stderrFile)
  return {
    pid,
    onExit: (listener) => {
      child.once('exit', listener)
    },
    onEarlyFailure: (listener) => {
      earlyFailure.subscribe(listener)
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
}

/**
 * A shim is a few hundred bytes; an entry that has not appeared by here is
 * not in a shim. Bounded so a wrong detection can never make this read a
 * large file.
 */
const SHIM_READ_BYTES = 8 * 1024

/**
 * The program to spawn for a detected path, and the argv that precedes the
 * CLI's own (#193). A real executable is itself. A batch shim is read for the
 * node entry it names, which is then run the way the shim would have run it —
 * the `node.exe` beside the shim if there is one, else `node` from PATH.
 * Undefined means the shim named nothing this can run; the caller says
 * "could not be started" rather than guessing.
 */
async function resolveLaunchProgram(
  binaryPath: string,
  fs: FsLike
): Promise<{ command: string; args: string[]; viaNodeEntry: boolean } | undefined> {
  if (!isShellShim(binaryPath)) return { command: binaryPath, args: [], viaNodeEntry: false }
  const target = resolveShimTarget(binaryPath, await fs.readTextHead(binaryPath, SHIM_READ_BYTES))
  if (target === undefined) return undefined
  const command = (await fs.exists(target.bundledNode)) ? target.bundledNode : 'node'
  return { command, args: [target.entry], viaNodeEntry: true }
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
 * the program behind the shim can be started (see `resolveLaunchProgram`) and
 * the exit it named was one a packaged user could not take.
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

  const detection = await options.detector.detect(options.provider)
  if (!detection.installed || detection.path === undefined) {
    const reason = notInstalled(options.provider)
    return {
      launched: false,
      provider: options.provider,
      error: detection.reason === undefined ? reason : `${reason} ${detection.reason}`
    }
  }

  try {
    // Inside the try because reading a shim is a disk read that can fail like
    // a spawn can, and it fails the same way for the user: nothing started.
    const program = await resolveLaunchProgram(detection.path, options.fs)
    if (program === undefined) {
      return { launched: false, provider: options.provider, error: couldNotStart(options.provider) }
    }
    const started = await options.run({
      command: program.command,
      // The tuning belongs to the CLI's own argv, so it lands AFTER a shim's
      // node entry (#239): in front of it, `--model` would be an argument to
      // node rather than to the program node is about to run.
      args: [
        ...program.args,
        ...buildLaunchArgs(options.provider, {
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.effort === undefined ? {} : { effort: options.effort })
        })
      ],
      // The relay's env rule, for the relay's reason: a re-exec of the CLI
      // inside the child must reach the install detection found rather than
      // one that happens to sit earlier on PATH. The detected path, so a shim
      // launch still leads with the shim's own directory.
      env: buildRelayEnv(options.env, detection.path, options.platform),
      cwd: options.minePath,
      stdin: prompt,
      viaNodeEntry: program.viaNodeEntry
    })
    // Reported rather than kept: whoever asked for the launch decides whether
    // to hold onto it, because deciding needs the board and this does not have
    // one (#217). A refusal started nothing, so it carries nothing.
    return {
      launched: true,
      provider: options.provider,
      ...(started === undefined ? {} : { retained: started })
    }
  } catch {
    return { launched: false, provider: options.provider, error: couldNotStart(options.provider) }
  }
}
