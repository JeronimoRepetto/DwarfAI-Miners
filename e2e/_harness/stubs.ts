import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `withStubs`: puts stub CLIs "installed" for one E2E case (testing strategy `17` §1.9; the kit is
 * `fixtures/bin/`, `fixtures/README.md`).
 *
 * ```ts
 * const setup = withStubs(['claude'], { claude: 'claude-permission-request' })
 * const launched = await launchApp({ stubs: setup.stubs, env: setup.env })
 * // … and after teardown: setup.dispose()
 * ```
 *
 * - `stubs` is each named stub's folder, joined with the platform's `PATH` delimiter, for
 *   `launchApp`'s `stubs` option, which prepends it to the app's `PATH`. Each folder holds the stub
 *   under the real binary's name (`claude.cmd` on Windows, the executable `claude` on POSIX), so the
 *   app's detection and spawn take their production paths; no production code knows the kit.
 * - `scenario` picks a script of `fixtures/bin/_kit/scripts/` for a stub, by name without `.json`;
 *   a stub without one replays its default script. A script belongs to one provider (it replays
 *   into that provider's directory), so the scenario is a map from stub to script.
 * - `launchApp` already gives each case a temp `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. The OpenCode
 *   stub replays under `XDG_DATA_HOME` (OpenCode's store root, `<data home>/opencode/opencode.db`),
 *   so when `opencode` is named `env` carries a fresh temp `XDG_DATA_HOME`, which `dispose()`
 *   removes.
 */

/** The kit's root: `fixtures/bin/` of this repository. */
export const STUB_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'bin'
)

export type StubName = 'claude' | 'codex' | 'opencode'

/** A script name of `fixtures/bin/_kit/scripts/` (without `.json`) per stub. */
export type StubScenario = Partial<Readonly<Record<StubName, string>>>

export interface StubSetup {
  /** The stub folders, joined with `path.delimiter`, for `launchApp({ stubs })`. */
  readonly stubs: string
  /** The environment the stubs need, for `launchApp({ env })`. */
  readonly env: Readonly<Record<string, string>>
  /** Removes what `withStubs` created; a second call does nothing. */
  dispose(): void
}

const STUB_NAMES: readonly StubName[] = ['claude', 'codex', 'opencode']
const SCRIPTS_DIR = path.join(STUB_BIN, '_kit', 'scripts')

/** The variable a stub reads its script path from (`fixtures/bin/_kit/stubCli.mjs`). */
const scriptEnvVar = (name: StubName): string => `DWARFAI_STUB_${name.toUpperCase()}_SCRIPT`

export function withStubs(names: readonly StubName[], scenario: StubScenario = {}): StubSetup {
  if (names.length === 0) throw new Error('withStubs needs at least one stub name')
  for (const name of names) {
    if (!STUB_NAMES.includes(name)) throw new Error(`There is no stub named ${name}`)
  }
  if (new Set(names).size !== names.length) throw new Error('A stub is named twice')

  const env: Record<string, string> = {}
  for (const [name, script] of Object.entries(scenario) as Array<[StubName, string]>) {
    if (!names.includes(name)) {
      throw new Error(`The scenario names a script for ${name}, which is not among the stubs`)
    }
    const file = path.join(SCRIPTS_DIR, `${script}.json`)
    if (!existsSync(file)) throw new Error(`There is no stub script ${script} in ${SCRIPTS_DIR}`)
    env[scriptEnvVar(name)] = file
  }

  const created: string[] = []
  if (names.includes('opencode')) {
    const dataHome = mkdtempSync(path.join(tmpdir(), 'dwarfai-e2e-data-'))
    created.push(dataHome)
    env.XDG_DATA_HOME = dataHome
  }

  let disposed = false
  return {
    stubs: names.map((name) => path.join(STUB_BIN, name)).join(path.delimiter),
    env,
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const dir of created) rmSync(dir, { recursive: true, force: true })
    }
  }
}
