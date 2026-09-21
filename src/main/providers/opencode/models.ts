import { execFile } from 'node:child_process'
import type { FsLike } from '../../adapters/fsLike'
import type { OpenCodeModelInfo } from '../../domain/agentModelCatalog'
import { describeShimRefusal, resolveProgram } from '../../platform/cliDetection'

/**
 * OpenCode's own live model list, over one read-only `opencode models
 * --verbose` spawn (#534) — the fourth leg of what #239 started for Claude
 * and #282 gave Antigravity: a provider-specific ask, bounded by
 * `MODEL_CATALOG_TIMEOUT_MS` at the caller (runtime.ts's own race, exactly as
 * the other three ports are), and degraded to `unavailableOpenCodeModel-
 * Catalog()` on any failure.
 *
 * Unlike Antigravity's spawn (`execFile(executablePath, ...)` directly), this
 * one goes through `resolveProgram` first — the same program resolution
 * `launchClaudeSession` already uses for every launch. OpenCode's npm-global
 * install is a `.cmd` shim on Windows (measured on this machine:
 * `opencode.cmd` → a launch wrapper), the same shape every other
 * npm-distributed CLI here reads through a shim before spawning; `execFile`'s
 * own silent cmd.exe routing for a bare `.cmd` is exactly the shell hop the
 * measurement report's own trap names (M3 addendum: a session recorded under
 * the PARENT directory, 2/2, when spawned through `cmd.exe`) — reading the
 * shim and spawning its node entry directly is what avoids it here too.
 *
 * Pure builder, thin runner, on the same shape `antigravity/models.ts`
 * already uses: the argv is a value a test asserts without a process, and
 * only the spawn itself is integration territory. `run` is injected for
 * exactly that reason — no unit test may start a real `opencode`.
 */

/** One resolved `opencode models --verbose` invocation, never through a shell. */
export interface OpenCodeModelsCommand {
  command: string
  args: string[]
}

/**
 * The command for one resolved program — `resolveProgram`'s own shape (the
 * shim's node entry on win32, the bare detected path on POSIX) — plus the
 * `models --verbose` subcommand appended after whatever argv the program
 * resolution already carries, the same order `launchClaudeSession` builds a
 * launch's own argv in.
 */
export function buildOpenCodeModelsCommand(program: {
  command: string
  args: string[]
}): OpenCodeModelsCommand {
  return { command: program.command, args: [...program.args, 'models', '--verbose'] }
}

/** Runs one `opencode models --verbose` command and resolves its stdout. */
export type OpenCodeModelsRunner = (command: OpenCodeModelsCommand) => Promise<string>

function runOpenCodeModelsCommand(command: OpenCodeModelsCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command.command, command.args, { windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

/** A bare `provider/model` id line, with no other characters — M1's own confirmed delimiter. */
const ID_LINE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/

/**
 * Brace-counts one JSON object out of `lines`, starting at `startIndex`
 * (whose trimmed text opens with `{`) — M1's own confirmed method (34/34
 * blocks parsed off the real captured output this way). String-aware, so a
 * `{`/`}` inside a JSON string value (a model's own name, say) is never
 * mistaken for structure.
 */
function readBraceBlock(
  lines: readonly string[],
  startIndex: number
): { text: string; nextIndex: number } {
  let depth = 0
  let inString = false
  let escaped = false
  const collected: string[] = []
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]!
    collected.push(line)
    for (const ch of line) {
      if (escaped) {
        escaped = false
        continue
      }
      if (inString && ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    if (depth === 0) return { text: collected.join('\n'), nextIndex: index + 1 }
  }
  throw new Error('opencode models: an unterminated JSON block (unbalanced braces)')
}

/** One id line's JSON block, turned into the domain's shape — or a throw. */
function toModelInfo(id: string, parsed: unknown): OpenCodeModelInfo {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`opencode models: the block for "${id}" is not a JSON object`)
  }
  const record = parsed as Record<string, unknown>
  const displayName = typeof record.name === 'string' ? record.name : ''
  const variants =
    typeof record.variants === 'object' && record.variants !== null
      ? (record.variants as Record<string, unknown>)
      : {}
  // M1: presence check is `Object.keys(variants).length > 0`; do not assume
  // only paid models have it — 19 of 34 measured models carry one, several
  // free.
  return { value: id, displayName, effortLevels: Object.keys(variants) }
}

/**
 * `opencode models --verbose`'s own shape (M1): one bare `provider/model` id
 * line, then a `{ ... }` JSON object, repeated per model — confirmed
 * parseable by splitting on id lines and brace-counting the object that
 * follows, 34/34 blocks against the real captured output.
 *
 * Throws rather than degrading to an empty list — unlike Antigravity's
 * `parseAgyModelsOutput`, which returns null for its own caller to fold into
 * a refusal. A JSON block this cannot brace-match or parse, or output naming
 * no id line at all, is evidence of a format change or an error/login
 * message printed instead of the list, never "this provider honestly has
 * zero models" (M1 measured 34 on a real install); `createOpenCodeModel-
 * Catalog` has only the one path to its own caller's fallback either way, so
 * throwing here keeps that a single branch there too.
 */
export function parseOpenCodeModelsOutput(stdout: string): OpenCodeModelInfo[] {
  const lines = stdout.split('\n')
  const models: OpenCodeModelInfo[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!.trim()
    if (!ID_LINE.test(line)) {
      index += 1
      continue
    }
    const id = line
    index += 1
    // Blank lines between the id and its JSON block are tolerated, on the
    // same "degrade rather than assume a rigid format" terms as the
    // Antigravity parser beside this one.
    while (index < lines.length && lines[index]!.trim() === '') index += 1
    const openLine = lines[index]
    if (openLine === undefined || !openLine.trim().startsWith('{')) {
      throw new Error(`opencode models: no JSON block followed the id line "${id}"`)
    }
    const block = readBraceBlock(lines, index)
    index = block.nextIndex
    let parsed: unknown
    try {
      parsed = JSON.parse(block.text)
    } catch (error) {
      throw new Error(`opencode models: the block for "${id}" is not valid JSON (${String(error)})`)
    }
    models.push(toModelInfo(id, parsed))
  }
  if (models.length === 0) {
    throw new Error('opencode models produced no readable model list')
  }
  return models
}

/** Ask the OpenCode CLI, read-only, for its own model list (#534). */
export type OpenCodeModelCatalogPort = (options: {
  executablePath: string
}) => Promise<OpenCodeModelInfo[]>

export interface OpenCodeModelCatalogOptions {
  /** Reads a batch shim for the detected binary — the same fs detection probes with. */
  fs: FsLike
  /** Injected for tests; defaults to a real spawn. */
  run?: OpenCodeModelsRunner
}

/**
 * The real model-catalogue port: `resolveProgram` first (win32 shim → its
 * node entry, POSIX → the bare detected path, never `execFile`'s own silent
 * cmd.exe routing for a `.cmd`), then one read-only `opencode models
 * --verbose` spawn, parsed by `parseOpenCodeModelsOutput`.
 *
 * Rejects — never resolves with an empty array — when the shim could not be
 * read, the spawn itself fails, OR the output could not be read as a model
 * list, on the same one-path terms `createAntigravityModelCatalog` documents.
 */
export function createOpenCodeModelCatalog(
  options: OpenCodeModelCatalogOptions
): OpenCodeModelCatalogPort {
  const { fs } = options
  const run = options.run ?? runOpenCodeModelsCommand
  return async ({ executablePath }) => {
    const program = await resolveProgram(executablePath, fs)
    if ('kind' in program) {
      throw new Error(
        `opencode models could not be started: ${executablePath} — ${describeShimRefusal(program)}`
      )
    }
    const stdout = await run(buildOpenCodeModelsCommand(program))
    return parseOpenCodeModelsOutput(stdout)
  }
}
