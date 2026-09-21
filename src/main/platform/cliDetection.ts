import { posix, win32 } from 'node:path'
import type { FsLike } from '../adapters/fsLike'
import type { DwarfProvider } from '../domain/types'
import { isShellShim } from '../sessionLaunch/launch'
import { currentPlatform, type Platform } from './platform'

/**
 * Detecting which agent CLIs are installed, and where — a capability of its
 * own (#91), consumed later by the launcher (#86) and the command surface
 * (#96). v1 exposes the port, its composition and its config override; no IPC
 * channel and no renderer wiring land until a consumer needs them.
 *
 * "Installed" is a different question from "running": isCodexProcessRunning in
 * processProbe.ts answers the second one, this answers the first, and the two
 * must not be conflated.
 */

/**
 * The agent CLIs whose presence this app can detect.
 *
 * It used to MIRROR DwarfProvider — its own two-value copy, kept local because
 * detection never crosses the wire, with a comment saying widening it was
 * gated on #78. This is that gate: #78 made DWARF_PROVIDERS the one place a
 * provider identity is declared, so the alias reads from it instead of
 * restating the list. Detection still never crosses the wire; nothing here is
 * published, and the name stays because "which CLI is installed" is a
 * different question from "which provider found this dwarf".
 */
export type AgentCli = DwarfProvider

/** Where a detected CLI was found. Poorest proof last: an override is a stated
 *  instruction, a convention is a known install location, PATH is a guess that
 *  a third-party shim can answer wrongly (see resolveClaudeBinaryPath). */
export type CliDetectionSource = 'override' | 'convention' | 'path'

/**
 * One detection verdict. A CLI that cannot be found is reported as
 * `installed: false` with a reason, never omitted and never thrown — a silent
 * omission looks identical to "you have no agents", the most confusing
 * possible failure, and a throw inside a poll tick is the failure the
 * processProbe fail-safe convention exists to prevent.
 */
export interface CliDetection {
  cli: AgentCli
  installed: boolean
  path?: string
  source?: CliDetectionSource
  reason?: string
}

/** How this platform separates PATH entries. */
function pathDelimiter(platform: Platform): string {
  return platform === 'win32' ? ';' : ':'
}

function pathModule(platform: Platform): typeof win32 | typeof posix {
  return platform === 'win32' ? win32 : posix
}

/**
 * What a provider's binary is actually called, where that is not the provider's
 * own name (#237).
 *
 * Every provider until Antigravity was named after its executable, so the
 * filename was derived from the identity directly and the two questions never
 * came apart. Antigravity separates them on purpose: the identity is the
 * harness — what a dwarf carries on the wire — and the program is `agy`.
 * Deriving one from the other would have this detector look for a file nobody
 * ships, on every platform, and report a CLI that is installed as absent.
 *
 * A table rather than a rule, because there is no rule: what a vendor calls
 * its binary is a fact to be looked up, not derived. A provider absent here
 * spells its executable exactly like itself, which is still the common case.
 */
const CLI_EXECUTABLE_STEMS: Partial<Record<AgentCli, string>> = {
  antigravity: 'agy'
}

/** The filename stem (no extension) of one provider's executable. */
export function cliExecutableStem(cli: AgentCli): string {
  return CLI_EXECUTABLE_STEMS[cli] ?? cli
}

/**
 * The executable spellings to look for, most-native first. On Windows a CLI
 * installed by its own installer is an `.exe`, while an npm-global install is a
 * `.cmd` (or `.bat`) shim on PATH; POSIX has one bare name.
 */
export function cliExecutableNames(cli: AgentCli, platform: Platform): string[] {
  const stem = cliExecutableStem(cli)
  if (platform === 'win32') return [`${stem}.exe`, `${stem}.cmd`, `${stem}.bat`]
  return [stem]
}

/**
 * The known install locations to probe before falling back to PATH, in order.
 *
 * claude sits where its native installer puts it — `<home>/.local/bin`, the
 * exact path resolveClaudeBinaryPath already addresses, and the reason PATH is
 * not trusted first. codex is best-effort: the same native bin, plus the
 * npm-global shim directory on Windows, since codex is commonly an npm install.
 * These are conventions, not guarantees; the PATH fallback and the explicit
 * override are what make an unconventional install reachable.
 *
 * antigravity is the one whose Windows location the generic native bin does not
 * reach (#237). Its own installer writes `%LOCALAPPDATA%\agy\bin\agy.exe` —
 * documented by the vendor, and verified on this machine against CLI 1.1.26 —
 * so adding the provider name alone would have detected nothing on the only
 * platform the CLI was actually installed on. macOS and Linux are
 * `~/.local/bin/agy`, which is the shared convention with the executable's own
 * name (see cliExecutableStem), so they need no row of their own.
 *
 * codex's second Windows row is pnpm's own global bin, `%LOCALAPPDATA%\pnpm\bin`
 * (#413) — derived from `home` the same way the antigravity row derives
 * `AppData\Local`, never read from the live environment, so a test can assert
 * it without one. Verified on this machine (pnpm global `codex` 0.153.4):
 * `%LOCALAPPDATA%\pnpm\bin` holds `codex` (a POSIX sh script), `codex.CMD` and
 * `codex.ps1`, and nothing else — no `.exe` a plain PATH probe for that
 * spelling would have found. Without this row a pnpm install fell through to
 * the PATH guess, which is exactly the walk issue #413 traces the refusal to.
 *
 * No POSIX pnpm row is added. pnpm's own docs (pnpm.io/global-packages,
 * pnpm.io/cli/setup, pnpm.io/installation, checked 2026-09-16) say only that a
 * global bin lives in `$PNPM_HOME/bin` — none of them documents what
 * `PNPM_HOME` itself defaults to on Linux or macOS. `~/.local/share/pnpm` is
 * what several users' installs are observed to land on (e.g.
 * github.com/pnpm/pnpm issue #12319), but an observed default is not a
 * documented one, and this table is conventions the vendor states, not ones
 * this app has watched other people's machines pick.
 */
export function conventionalCliPaths(cli: AgentCli, home: string, platform: Platform): string[] {
  const path = pathModule(platform)
  const ext = platform === 'win32' ? '.exe' : ''
  const nativeBin = path.join(home, '.local', 'bin', `${cliExecutableStem(cli)}${ext}`)
  if (platform !== 'win32') return [nativeBin]
  if (cli === 'codex') {
    return [
      nativeBin,
      path.join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
      path.join(home, 'AppData', 'Local', 'pnpm', 'bin', 'codex.cmd')
    ]
  }
  if (cli === 'antigravity') {
    return [nativeBin, path.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe')]
  }
  return [nativeBin]
}

/** What a Windows batch shim runs (#193): the JS entry it names, and where its node.exe would sit. */
export interface ShimTarget {
  entry: string
  /** `<shim dir>\node.exe`: spawn it if it exists, else `node` from PATH — the shim's own IF/ELSE. */
  bundledNode: string
}

/**
 * Why `resolveShimTarget` found nothing to spawn (#502) — carrying the shim's
 * own path, so a caller can name what it tried without threading a second
 * copy of it alongside the refusal.
 *
 * The two used to collapse into one `undefined`, and a refusal that cannot
 * say which of two facts it is cannot be acted on: `dialect-not-understood`
 * means try a different install of the CLI, `needs-cmd-exe` means the
 * install is fine but this app cannot run it directly. Different fixes, so
 * they need different words.
 */
export type ShimRefusal =
  | {
      /** The shim's text names no quoted `.js` entry at all — not a dialect this app reads. */
      kind: 'dialect-not-understood'
      shimPath: string
    }
  | {
      /** The entry survived expansion still carrying a `%` variable only cmd.exe could resolve. */
      kind: 'needs-cmd-exe'
      shimPath: string
      entry: string
    }

/** `ShimRefusal`, in the words a refusal sentence can show beside the path it names. */
export function describeShimRefusal(refusal: ShimRefusal): string {
  return refusal.kind === 'dialect-not-understood'
    ? 'the shim was found but its dialect was not understood'
    : `its entry still names a variable only cmd.exe can expand: ${refusal.entry}`
}

/**
 * Read a `.cmd`/`.bat` shim for what it would run, so the launcher can run
 * that directly instead of the shim (#193).
 *
 * Why the shim is read and not run. The launcher needs its child detached, so
 * the session outlives the panel, and both ways of running a batch file fail
 * that need — verified on Windows 11 / Node v24.11.1 while fixing #193. A
 * DETACHED cmd.exe has no console and starts no external program at all: it
 * exits 0 having run nothing, which would be a `launched: true` with no
 * session behind it. A non-detached cmd.exe runs the shim, but libuv places
 * every non-detached child in a kill-on-close job object, so the session dies
 * the moment the panel quits. Spawning the program the shim points at,
 * detached, is the one shape that both runs and lets go.
 *
 * Two dialects exist and one reading covers both. npm's cmd-shim writes
 * `"%dp0%\node_modules\@openai\codex\bin\codex.js"`; pnpm's writes
 * `"%~dp0\..\global\<store>\node_modules\@openai\codex\bin\codex.js"`. The
 * entry is the first double-quoted `.js` token, and `%~dp0`/`%dp0%` — the
 * shim's own directory — is the one variable cmd.exe would have expanded that
 * this can expand too. Anything else still wrapped in `%` needs cmd.exe, and
 * the answer names which of the two happened, with the shim's own path,
 * rather than a guess (#502).
 *
 * Windows path rules unconditionally, because a batch shim is a Windows
 * artefact whichever host the suite runs on.
 */
export function resolveShimTarget(shimPath: string, shimText: string): ShimTarget | ShimRefusal {
  const quoted = /"([^"]+\.js)"/i.exec(shimText)
  if (quoted === null) return { kind: 'dialect-not-understood', shimPath }
  const shimDir = win32.dirname(shimPath)
  const expanded = quoted[1]!.replace(/%~dp0|%dp0%/gi, `${shimDir}\\`)
  if (expanded.includes('%')) return { kind: 'needs-cmd-exe', shimPath, entry: expanded }
  return { entry: win32.normalize(expanded), bundledNode: win32.join(shimDir, 'node.exe') }
}

/**
 * A shim is a few hundred bytes; an entry that has not appeared by here is not
 * in a shim. Bounded so a wrong detection can never make this read a large
 * file.
 */
const SHIM_READ_BYTES = 8 * 1024

/**
 * The program to spawn for a detected path, and the argv that precedes
 * whichever CLI argv a caller appends of its own (#193).
 *
 * A real executable is itself. A batch shim is read for the node entry it
 * names, then run the way the shim would have run it — the `node.exe` beside
 * the shim if one exists, else `node` from PATH (the shim's own IF/ELSE). A
 * `ShimRefusal` means the shim named nothing this can run; the caller names
 * the path tried and why (`describeShimRefusal`) rather than guessing (#502).
 *
 * Lifted out of sessionLaunch/launchRunner.ts for #413. Three callers need the
 * exact same resolution now: the launcher, because Node refuses to spawn a
 * `.cmd`/`.bat` without a shell, and the two Codex text-delivery tiers
 * (textDelivery/codexQueue.ts, codexResume.ts), because a shell would
 * re-parse the message. One function shared between them is what keeps them
 * from drifting the way `isShellShim`/`isShellShimPath` already had before
 * #413, and one refusal shape is what keeps their refusal copy from drifting
 * the way plain `undefined` already let it (#502).
 */
export async function resolveProgram(
  binaryPath: string,
  fs: FsLike
): Promise<{ command: string; args: string[]; viaNodeEntry: boolean } | ShimRefusal> {
  if (!isShellShim(binaryPath)) return { command: binaryPath, args: [], viaNodeEntry: false }
  const target = resolveShimTarget(binaryPath, await fs.readTextHead(binaryPath, SHIM_READ_BYTES))
  if ('kind' in target) return target
  const command = (await fs.exists(target.bundledNode)) ? target.bundledNode : 'node'
  return { command, args: [target.entry], viaNodeEntry: true }
}

/**
 * Node's own name for why a program failed to start or a shim failed to
 * read, never a guess (#502): the errno code when the platform set one
 * (`ENOENT`, `EACCES`, …), else the exception's own message. Shared by every
 * caller of `resolveProgram` so a spawn failure and a shim-read failure are
 * described in the same words wherever either is caught.
 */
export function describeProgramFailure(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === undefined ? error.message : code
  }
  return String(error)
}

/** Every `<PATH entry>/<executable name>` candidate, in PATH order then name order. */
export function pathLookupCandidates(
  cli: AgentCli,
  pathValue: string | undefined,
  platform: Platform
): string[] {
  if (pathValue === undefined || pathValue === '') return []
  const path = pathModule(platform)
  const names = cliExecutableNames(cli, platform)
  const candidates: string[] = []
  for (const dir of pathValue.split(pathDelimiter(platform))) {
    if (dir === '') continue
    for (const name of names) candidates.push(path.join(dir, name))
  }
  return candidates
}

/** What consumers ask: is this CLI installed, and where. */
export interface CliDetector {
  detect(cli: AgentCli): Promise<CliDetection>
  /** The cached verdict, or 'unprobed' when no walk has produced one yet — the
   *  distinct never-measured state, as knownTierOf is to tierOf (#41). */
  peek(cli: AgentCli): CliDetection | 'unprobed'
}

export interface CliDetectorOptions {
  home: string
  platform?: Platform
  fs: FsLike
  env?: NodeJS.ProcessEnv
  /** Explicit per-CLI binary paths that win over convention and PATH. */
  overrides?: Partial<Record<AgentCli, string>>
  now?: () => number
  /** A verdict is reused this long before the disk is consulted again. */
  ttlMs?: number
}

const DEFAULT_TTL_MS = 60_000

interface CacheEntry {
  verdict: CliDetection
  probedAt: number
}

/**
 * Detection order: an explicit override wins outright — if it is set and the
 * file is absent we report absent rather than second-guessing the user by
 * falling back — then the conventional locations, then a PATH lookup. Results
 * are cached with a TTL so this never rides the poll loop.
 */
export function createCliDetector(options: CliDetectorOptions): CliDetector {
  const platform = options.platform ?? currentPlatform()
  const env = options.env ?? process.env
  const overrides = options.overrides ?? {}
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const cache = new Map<AgentCli, CacheEntry>()

  async function firstExisting(paths: string[]): Promise<string | undefined> {
    for (const candidate of paths) {
      if (await options.fs.exists(candidate)) return candidate
    }
    return undefined
  }

  async function probe(cli: AgentCli): Promise<CliDetection> {
    const override = overrides[cli]?.trim()
    if (override !== undefined && override !== '') {
      if (await options.fs.exists(override)) {
        return { cli, installed: true, path: override, source: 'override' }
      }
      return {
        cli,
        installed: false,
        source: 'override',
        reason: `configured path not found: ${override}`
      }
    }

    const conventional = await firstExisting(conventionalCliPaths(cli, options.home, platform))
    if (conventional !== undefined) {
      return { cli, installed: true, path: conventional, source: 'convention' }
    }

    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    const onPath = await firstExisting(pathLookupCandidates(cli, env[pathKey], platform))
    if (onPath !== undefined) {
      return { cli, installed: true, path: onPath, source: 'path' }
    }

    return {
      cli,
      installed: false,
      reason: `${cli} not found in ~/.local/bin, a known install location, or PATH`
    }
  }

  return {
    async detect(cli: AgentCli): Promise<CliDetection> {
      const cached = cache.get(cli)
      if (cached !== undefined && now() - cached.probedAt < ttlMs) return cached.verdict
      const verdict = await probe(cli)
      cache.set(cli, { verdict, probedAt: now() })
      return verdict
    },
    peek(cli: AgentCli): CliDetection | 'unprobed' {
      return cache.get(cli)?.verdict ?? 'unprobed'
    }
  }
}
