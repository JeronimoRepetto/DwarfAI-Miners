import { execFile } from 'node:child_process'
import type { AntigravityModelInfo } from '../../domain/agentModelCatalog'

/**
 * Antigravity's own live model list, over one read-only `agy models` spawn
 * (#282) — the third leg of what #239 started for Claude (a short-lived Agent
 * SDK query) and Codex (its own SQLite registry): a provider-specific ask,
 * bounded by `MODEL_CATALOG_TIMEOUT_MS` at the caller (runtime.ts's own race,
 * exactly as Claude's port is bound — the timeout is part of what calling the
 * port promises, not enforced twice), and degraded to `unavailableAntigravity-
 * ModelCatalog()` on any failure.
 *
 * Pure builder, thin runner, on the same shape `processProbe.ts` and
 * `processEnd.ts` already use for a read-only per-OS spawn: the argv is a
 * value a test asserts without a process, and only the spawn itself is
 * integration territory. `run` is injected for exactly that reason — no unit
 * test may start a real `agy`.
 */

/** One `agy models` invocation, as an argv pair that never goes through a shell. */
export interface AgyModelsCommand {
  command: string
  args: string[]
}

/**
 * The command for one detected binary. The DETECTED path, never a bare
 * `'agy'` — the same rule every other spawn off cliDetection.ts's verdict
 * follows, because a third-party shim on PATH can answer a bare name wrongly
 * (see resolveClaudeBinaryPath's own reasoning).
 */
export function buildAgyModelsCommand(executablePath: string): AgyModelsCommand {
  return { command: executablePath, args: ['models'] }
}

/** Runs one `agy models` command and resolves its stdout. */
export type AgyModelsRunner = (command: AgyModelsCommand) => Promise<string>

function runAgyModelsCommand(command: AgyModelsCommand): Promise<string> {
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

/**
 * One line of `agy models`' own stdout, or undefined for a line this format
 * cannot be read from — a blank line, the leading "Fetching…" status line
 * (which carries no tab), or a half-written tail from a bounded read racing
 * the CLI's own write.
 *
 * The tab is the CLI's own field separator (verified byte-for-byte against
 * the captured fixture, #282), so a line with none is never assumed to be a
 * model — that is what lets the status line fall out for free, with no
 * string this format's own wording has to be matched against.
 */
function parseAgyModelLine(line: string): AntigravityModelInfo | undefined {
  const tabIndex = line.indexOf('\t')
  if (tabIndex === -1) return undefined
  const value = line.slice(0, tabIndex).trim()
  if (value === '') return undefined
  const displayName = line.slice(tabIndex + 1).trim()
  return { value, displayName }
}

/**
 * Every model `agy models`' own stdout named, or null when nothing readable
 * as one was found at all — an unparseable or empty answer, on the same
 * degrade-rather-than-throw terms `parse.ts`'s transcript reader already
 * holds to, because this is a private CLI answer with no compatibility
 * promise either.
 *
 * Null rather than `[]` for "found nothing": a real installed CLI answers
 * with a real, non-empty list on 1.1.26, so zero readable lines is evidence
 * something went wrong (wrong build, changed format, a login prompt printed
 * instead) rather than a provider honestly reporting no models — see
 * `createAntigravityModelCatalog`, which turns this into the same refusal a
 * spawn failure already is.
 *
 * Individual bad lines are skipped rather than failing the whole answer, on
 * the same terms `parseAgyModelLine` documents.
 */
export function parseAgyModelsOutput(stdout: string): AntigravityModelInfo[] | null {
  const models: AntigravityModelInfo[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const model = parseAgyModelLine(line)
    if (model !== undefined) models.push(model)
  }
  return models.length > 0 ? models : null
}

/** Ask the Antigravity CLI, read-only, for its own model list (#282). */
export type AntigravityModelCatalogPort = (options: {
  executablePath: string
}) => Promise<AntigravityModelInfo[]>

export interface AntigravityModelCatalogOptions {
  /** Injected for tests; defaults to a real `agy models` spawn. */
  run?: AgyModelsRunner
}

/**
 * The real model-catalogue port: one read-only `agy models` spawn, parsed by
 * `parseAgyModelsOutput`.
 *
 * Rejects — never resolves with an empty array — when the spawn itself fails
 * OR when the output could not be read as a model list, deliberately on one
 * path: the caller (runtime.ts's `listAgentModels`) already catches a
 * rejection from Claude's own port and answers `unavailableAntigravity-
 * ModelCatalog()` with one warn line, and folding "unparseable" into that same
 * catch is what keeps the caller to one branch instead of two.
 */
export function createAntigravityModelCatalog(
  options: AntigravityModelCatalogOptions = {}
): AntigravityModelCatalogPort {
  const run = options.run ?? runAgyModelsCommand
  return async ({ executablePath }) => {
    const stdout = await run(buildAgyModelsCommand(executablePath))
    const models = parseAgyModelsOutput(stdout)
    if (models === null) {
      throw new Error('agy models produced no readable model list')
    }
    return models
  }
}
