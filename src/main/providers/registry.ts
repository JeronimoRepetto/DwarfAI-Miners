import type { FsLike } from '../adapters/fsLike'
import type { SqliteLike } from '../adapters/sqliteLike'
import type { AppConfig } from '../config/config'
import type { DwarfProvider } from '../domain/types'
import type { PlatformAdapters } from '../platform/platformAdapters'
import { ClaudeProvider } from './claude/claudeProvider'
import { CodexProvider } from './codex/codexProvider'
import type { Provider } from './provider'

/**
 * Which providers this build composes, and the one place a new one is
 * registered (issue #78).
 *
 * `realProviders()` used to be an array literal inside the runtime's
 * constructor: a third backend meant a third `new XProvider({...})` written
 * inline among the wiring, next to the ledger, the tier service and the poll
 * loop. Reasonable at two, and the third of #78's four places.
 *
 * The composition stays explicit, on purpose and against the grain of what a
 * "registry" usually means. `platformAdapters.ts` is the model: a table this
 * file can be read top to bottom, no directory scanned for plugins, nothing
 * discovered at runtime, and every dependency a provider takes visible at the
 * point it is handed over. What the table buys is that adding a backend
 * touches one row here instead of the runtime's constructor.
 */

/**
 * Everything a provider may be built from.
 *
 * Deliberately the same context for every factory rather than one shaped per
 * provider: a factory that needs something absent here is telling us the
 * context is short a seam, which is a conversation, not a reason to reach past
 * it into module scope. `config` carries every provider's own settings block
 * (see ProviderConfigs), so a factory reads its own and never another's.
 */
export interface ProviderContext {
  config: AppConfig
  /** The filesystem seam every provider reads through; a fake in tests. */
  fs: FsLike
  /** Read-only SQLite, for a provider whose CLI keeps a database. */
  sqlite: SqliteLike
  /** The per-OS adapters, already selected — a provider never asks what it is running on. */
  platform: PlatformAdapters
  /**
   * Expands a leading `~` in a configured path against the home directory this
   * runtime was built for. Passed in rather than imported so a provider never
   * resolves a path against a different home than the rest of the poll.
   */
  expandPath: (path: string) => string
  /**
   * Whether the panel holds a live stream into a session (#191) — the held
   * registry's answer, for the provider whose registry entries say nothing
   * about an SDK-hosted session's status. A provider whose sessions this app
   * never holds simply does not read it.
   */
  isHeldSession: (sessionId: string) => boolean
  /**
   * Whether Claude Code has pushed word that a permission dialog is open for
   * that session (#203) — PermissionPromptRegistry's answer, for the provider
   * that can read what the session asked to do but never that anybody was
   * asked to approve it. A provider whose CLI pushes nothing simply does not
   * read it.
   */
  isPermissionPromptOpen: (sessionId: string) => boolean
}

/** How one provider is built. */
export type ProviderFactory = (context: ProviderContext) => Provider

/**
 * A table of factories keyed by the identity the provider reports.
 *
 * Loose in the key on purpose: `PROVIDER_REGISTRY` below is exhaustive over
 * `DwarfProvider`, and this is the shape `createProviders` accepts, so a test
 * can hand it a table with a row of its own and prove that one row is all a
 * provider needs (see registry.test.ts). Nothing in production builds one.
 */
export type ProviderRegistry = Readonly<Record<string, ProviderFactory>>

/**
 * Every provider a real run composes.
 *
 * A `Record` over `DwarfProvider`, so a member added to `DWARF_PROVIDERS`
 * stops this file compiling until its factory row exists — the same
 * enforcement `ProviderConfigs` gives the settings half. The simulated valley
 * (#42) is deliberately absent: it REPLACES the real detectors rather than
 * joining them, and the runtime owns that choice.
 */
export const PROVIDER_REGISTRY: Record<DwarfProvider, ProviderFactory> = {
  claude: ({ config, fs, platform, expandPath, isHeldSession, isPermissionPromptOpen }) =>
    new ClaudeProvider({
      fs,
      roots: config.providers.claude.configDirs.map(expandPath),
      // The pid-reuse guard's source of truth: a registry entry only counts
      // as alive when the pid's real creation time matches its procStart.
      processStartTimeMs: (pid) => platform.processProbe.processStartTimeMs(pid),
      isHeldSession,
      isPermissionPromptOpen
    }),

  codex: ({ config, fs, sqlite, platform, expandPath }) =>
    new CodexProvider({
      isCodexProcessRunning: () => platform.processProbe.isCodexProcessRunning(),
      fs,
      sessionsRoot: expandPath(config.providers.codex.sessionsRoot),
      livenessWindowS: config.providers.codex.livenessWindowS,
      scanDays: config.providers.codex.scanDays,
      idleRetentionS: config.providers.codex.idleRetentionS,
      heartbeatWindowS: config.providers.codex.heartbeatWindowS,
      sqlite,
      stateDbPath: expandPath(config.providers.codex.stateDb),
      logsDbPath: expandPath(config.providers.codex.logsDb)
    })
}

/**
 * Build every registered provider, in registration order.
 *
 * Order is the order the table is written in, which is the order snapshots
 * reach aggregation. Nothing depends on it today — mines are merged by path —
 * but a deterministic order is what keeps two runs of the same machine
 * producing the same feed.
 */
export function createProviders(
  context: ProviderContext,
  registry: ProviderRegistry = PROVIDER_REGISTRY
): Provider[] {
  return Object.values(registry).map((create) => create(context))
}
