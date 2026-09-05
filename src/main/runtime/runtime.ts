import { homedir } from 'node:os'
import { join } from 'node:path'
import { NodeFs, type FsLike } from '../adapters/fsLike'
import { NodeSqlite, type SqliteLike } from '../adapters/sqliteLike'
import { cliOverridesFrom, type AppConfig, type ConfigEnv } from '../config/config'
import { agentProviderList } from '../domain/launchProviders'
import { MineHistoryReader, type MineHistorySource } from '../history/mineHistory'
import { DwarfLifecycleTracker } from '../domain/lifecycle'
import { attributeIssuedMessages, launchingAgentOf } from '../domain/messageIssuer'
import {
  DWARF_PROVIDERS,
  MAX_DWARF_TEXT_CHARS,
  type AgentLaunchRequest,
  type AgentLaunchResult,
  type AgentProviderList,
  type DwarfActivation,
  type DwarfFeedResult,
  type DwarfKickRequest,
  type DwarfKickResult,
  type DwarfPermissionAnswerRequest,
  type DwarfQuestionAnswerRequest,
  type DwarfQuestionAnswerResult,
  type DwarfTextRequest,
  type DwarfTextResult,
  type HeldSessionLaunchRequest,
  type HeldSessionLaunchResult,
  type HostedLaunchRequest,
  type HostedLaunchResult,
  type MaterialTotals,
  type MetricsResetResult,
  type Mine,
  type MineDeclareResult,
  type MineHistoryResult,
  type MineTier,
  type MineUndeclareResult,
  type ProjectQuery,
  type ProjectQueryResult,
  type ProjectSummary,
  type TextDeliveryChannel
} from '../domain/types'
import {
  collapseDuplicateMines,
  mergeDeclaredMines,
  stampMapSites,
  stampUnrecorded,
  type DeclaredProject
} from '../domain/aggregate'
import { nullLedgerStore } from '../ledger/ledgerStore'
import { MaterialLedger } from '../ledger/materialLedger'
import { pollProfiler } from './perf'
import type { CliDetector } from '../platform/cliDetection'
import { createPlatformAdapters, type PlatformAdapters } from '../platform/platformAdapters'
import { ProjectObserver } from '../projects/projectObserver'
import type { ProjectRecord, ProjectsStore } from '../projects/projectsStore'
import { Poller } from './poller'
import { PublishGate } from './publishGate'
import {
  stampHeldConversation,
  stampHeldCrew,
  stampHeldQuestions,
  stampHeldRank,
  stampHeldTelemetry
} from '../sessionLaunch/heldSession'
import { HeldSessionRegistry } from '../sessionLaunch/heldSessionRegistry'
import { stampHostedProcesses } from '../sessionLaunch/hostedBoard'
import { HostedProcessRegistry } from '../sessionLaunch/hostedProcesses'
import { createNodeHostedProcess } from '../sessionLaunch/nodeHostedProcess'
import { LaunchedSessionRegistry } from '../sessionLaunch/launchedSessions'
import { createSdkHeldSession } from '../sessionLaunch/sdkHeldSession'
import { prepareLaunchPrompt } from '../sessionLaunch/launch'
import {
  launchClaudeSession,
  runLaunchProcess,
  type SessionLauncher
} from '../sessionLaunch/launchRunner'
import type { Provider } from '../providers/provider'
import { PROVIDER_REGISTRY, createProviders, type ProviderRegistry } from '../providers/registry'
import { createSimulation } from '../providers/simulated/simulation'
import type { ViewerPathOptions } from '../platform/terminalLauncher'
import type {
  TextDeliveryOutcome,
  TextDeliveryPort,
  TextDeliveryTarget
} from '../textDelivery/port'
import {
  resolveKickDelivery,
  resolveTextDelivery,
  stampTextDelivery
} from '../textDelivery/resolve'
import { createStageTimer, formatStageTimings, type StageTimings } from '../textDelivery/timing'
import { TierService } from '../tier/tierService'

const FEED_LIMIT = 12

/** No transcript this app can read — never the same claim as one that is empty. */
function unreadableFeed(): DwarfFeedResult {
  return { readable: false, messages: [] }
}

/** No history this app could read for the mine — never "nobody has spoken here" (#192). */
function unreadableHistory(): MineHistoryResult {
  return { readable: false, speakers: [] }
}

/** Refusals that never reach the delivery port, phrased for the panel. */
const NO_SUCH_DWARF = 'That dwarf has left the mine.'
const NO_CHANNEL = "This session type can't receive messages yet."
const EMPTY_MESSAGE = 'Type a message first.'
const NO_KICK_CHANNEL = "This session type can't be canceled yet."
const NO_QUEUE_TIER = "This build can't reach a Codex session's message queue."
/**
 * The two held-session refusals (#210).
 *
 * Both are terminal: the channel that failed IS the session, so there is no
 * second one to try and nothing to promise. Phrased as what happened rather
 * than as a fault, because a stream that will not take a message is usually a
 * session on its way out — and the alternative was a relay ✓ that could not be
 * true (see reaction.ts on what `delivered` may ever claim).
 */
const HELD_STREAM_CLOSED = 'That session is no longer taking messages.'
const HELD_KICK_REFUSED = "That session didn't take the interrupt."
/**
 * The three refusals for a session this panel LAUNCHED and can only end
 * (#217).
 *
 * NO_LAUNCH_INBOX replaces the generic no-channel string for these dwarfs, and
 * the difference is the whole point: "this session type can't receive messages
 * yet" reads as a gap in the app, and a session started with one prompt that
 * exits with its turn has no inbox to reach — a fact about the world. The
 * panel's own copy for the disabled composer names the exact command (see
 * actionBar.ts), which it can do because it knows the provider; this one is
 * the race's fallback and stays provider-neutral.
 *
 * The other two are what an ending can honestly answer. Neither ever reads as
 * an ended session: a kill the platform refused leaves the process running,
 * and a process already gone was not ended by this kick.
 */
const NO_LAUNCH_INBOX =
  'That session takes no messages: it was launched with a single prompt and exits with its turn.'
const LAUNCH_ALREADY_ENDED = 'That session has already ended.'
const LAUNCH_END_REFUSED = 'That session could not be ended.'
/**
 * The refusals for a process this panel is HOLDING over stdio (#194).
 *
 * A hosted process is the mirror image of a launched one, and the copy has to
 * say so: it takes messages until its pipe closes, and the only kick available
 * to it ends the whole process. There is no interrupt to offer, because this
 * app knows nothing about what somebody else's program treats as one — a byte
 * it happened to accept would be the panel guessing at another program's key
 * bindings.
 */
const HOSTED_PIPE_CLOSED = 'That process is no longer taking input.'
const HOSTED_ALREADY_ENDED = 'That process has already ended.'
const HOSTED_END_REFUSED = 'That process could not be ended.'
const NO_SUCH_MINE = 'That mine is no longer on the map.'
const EMPTY_PROMPT = 'Type a prompt first.'
const LAUNCH_FAILED = 'The agent could not be started.'

/**
 * Refusals for adding and removing a mine (#85), phrased for the panel.
 *
 * Every one of them is stated rather than swallowed: the control that triggers
 * them is a button the user just pressed, and a button that sometimes does
 * nothing at all reads as broken rather than as declined.
 */
const NO_PROJECT_STORE = "The projects database didn't open, so mines can't be added right now."
const NO_PICKER = "This build can't open a folder picker."
const PICKER_FAILED = 'The folder picker could not be opened.'
const DECLARE_FAILED = 'That folder could not be saved as a mine.'
const UNDECLARE_FAILED = 'That mine could not be removed.'
const NOT_DECLARED = 'That mine is not one you added.'
/** Settings' "Reset metrics" refusal (#138). */
const RESET_FAILED = 'The metrics could not be reset. Nothing was deleted.'
/** #92's browse refusal. Stated for the same reason: a list that is empty because nothing could be read looks like a list with nothing in it. */
const QUERY_FAILED = 'The projects could not be read.'

/**
 * Refusals for held sessions (#86, #94), phrased for the panel.
 *
 * NO_SIMULATED_LAUNCH is the same rule the ledger and the projects store hold
 * (#42), one step further: those refuse to WRITE during a demo, and this
 * refuses to reach out of one at all. A simulated mine's folder is not on
 * anybody's disk, so a launch there is not a phantom total but a real agent
 * started in the wrong place — or in no place.
 */
const NO_SIMULATED_LAUNCH =
  "A simulated valley's mines are not folders, so nothing can start in one."

/**
 * Fixed instructions Kick delivers over the relay tier. Never user text, so
 * unlike sendDwarfText's payload there is nothing here to keep out of the log
 * beyond what the existing terse verdict line already omits.
 */
const CANCEL_INSTRUCTION =
  'The user asks you to STOP your current work now. Interrupt what you are doing, ' +
  'leave things in a safe state, and wait for further instructions.'
/** Addressed at a specific worker through its foreman; resolveKickDelivery's '[cancel agent X] ' prefix already names which one. */
const CANCEL_WORKER_INSTRUCTION =
  'Stop that agent now. Interrupt its work, leave things in a safe state, and wait for further instructions.'

/** Stands in for a channel that failed without saying why, so the combined verdict never reads 'undefined'. */
const NO_REASON_GIVEN = 'It failed without a reason.'

/**
 * Both channels were tried and both failed: the panel's ✕ tooltip must carry
 * both stories — terminal first, since that is the channel the user expected —
 * each on its own labeled line so neither reason reads as the other's.
 */
function combineFallbackErrors(
  terminalError: string | undefined,
  relayError: string | undefined
): string {
  return (
    `Terminal: ${terminalError ?? NO_REASON_GIVEN}\n` +
    `Relay fallback: ${relayError ?? NO_REASON_GIVEN}`
  )
}

/**
 * The stage breakdown appended to a delivery's log line, e.g.
 * ` [focus=12ms spawn=30ms total=45ms]` (issue #21).
 *
 * A Kick or Send that "feels slow" used to be unfalsifiable: the log carried a
 * verdict and nothing else, so every latency discussion started from a guess.
 * These are durations only — the privacy rule is unchanged, and there is
 * nothing in a StageTimings that could carry a payload even by accident.
 */
function stageSuffix(timings: StageTimings): string {
  const formatted = formatStageTimings(timings)
  return formatted === '' ? '' : ` [${formatted}]`
}

/** Expand only a leading home shorthand; other paths are passed through. */
export function expandHomePath(path: string, home: string = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(home, path.slice(2))
  }
  return path
}

export interface RuntimeOptions {
  config: AppConfig
  /**
   * Publishes one poll's result. `materials` is the WHOLE vault, not the sum
   * of these mines: it includes projects with no crew right now, which is what
   * makes backfilled coal visible in the global chip.
   */
  onMinesUpdated: (mines: Mine[], materials: MaterialTotals) => void
  home?: string
  fs?: FsLike
  /** Read-only SQLite access for the Codex registry; injected for tests. */
  sqlite?: SqliteLike
  providers?: Provider[]
  /**
   * Which providers to build, instead of the real registry (#78).
   *
   * Injected for tests, and narrower than `providers` above on purpose: that
   * one hands the runtime finished providers and skips the composition
   * entirely, while this one goes THROUGH it — the context, the config blocks,
   * the expanded paths — which is what makes "registering a provider is one
   * entry" a claim a test can hold this file to.
   */
  providerRegistry?: ProviderRegistry
  focus?: (pid: number) => Promise<boolean>
  /** Electron packaging info, used only to resolve the transcript-viewer script path. */
  appPaths?: ViewerPathOptions
  /** Opens a terminal tailing a dwarf's transcript; injected for tests. */
  launchTerminal?: (dwarfName: string, transcriptPath: string) => Promise<boolean>
  /** Writes a typed message into a live session; injected for tests. */
  textDelivery?: TextDeliveryPort
  /**
   * Starts a NEW session in a folder (#86); injected for tests, which must
   * never spawn a real agent. The default drives Claude through its own
   * headless interface, over the binary CLI detection (#91) found.
   */
  launchSession?: SessionLauncher
  /**
   * Sessions the panel STARTS and HOLDS over the Agent SDK (#86, #94) —
   * injected already composed, exactly as the ledger and the tier service are,
   * so no test can reach the SDK. The default drives the real one over the
   * binary CLI detection found (#91).
   */
  heldSessions?: HeldSessionRegistry
  /**
   * Sessions the panel STARTED detached and still holds the process of, so
   * that it can end one (#217). Injected for tests, which must never end a
   * real process tree; the default ends it through the platform port.
   */
  launchedSessions?: LaunchedSessionRegistry
  /**
   * Every command of the person's own this panel is holding (#194). Injected
   * for tests, which must never spawn a process; the default holds real ones.
   */
  hostedProcesses?: HostedProcessRegistry
  /** Every per-OS adapter, already selected; injected for tests. */
  platformAdapters?: PlatformAdapters
  /** Injected for deterministic lifecycle-grace tests; defaults to Date.now. */
  now?: () => number
  /**
   * The persistent material vault (see #22). Omitted means an in-memory vault
   * that writes nothing: src/main/index.ts owns the userData path, so the
   * runtime stays testable and disk-free without one.
   */
  ledger?: MaterialLedger
  /**
   * Complexity-tier authority. Injected so tests can decide exactly when the
   * first walk finishes, which is the whole subject of #41; the default builds
   * one over the configured thresholds.
   */
  tiers?: TierService
  /**
   * What a mine's transcripts on disk remember (#192), for the Mine History
   * panel. Injected so a test never reaches a real Claude or Codex home; the
   * default reads the same roots and registry the providers do.
   */
  history?: MineHistorySource
  /**
   * The REAL process environment, consulted for the development-only simulated
   * provider (#42) and for nothing else.
   *
   * Deliberately NOT `config`: AppConfig is fed by the userData config file a
   * packaged app reads (#38), and a switch that invents mines must not be
   * expressible there. Injected so tests can drive the gate without touching
   * the ambient environment; defaults to `process.env`.
   */
  simulationEnv?: ConfigEnv
  /**
   * Every project the app remembers (#93), or null when its database refused
   * to open. Null is a real state rather than an error: index.ts turns a
   * locked, corrupt or unknown-schema store into one, and the panel goes on
   * showing discovered mines without it. Omitted has the same effect.
   */
  projects?: ProjectsStore | null
  /**
   * Opens the operating system's folder picker and resolves with the chosen
   * directory, or null when the user closed it (#85).
   *
   * Injected exactly as `focus` and `launchTerminal` are, and for the same
   * reason: this module knows no Electron, and `dialog` is Electron's. Absent
   * means the app has no picker to offer, which is a refusal with a reason —
   * never a silently missing control.
   */
  chooseDirectory?: () => Promise<string | null>
}

/**
 * Runtime bridge between disk-backed providers and Electron IPC. Keeping it
 * independent from Electron makes its lifecycle and activation behavior testable.
 */
export class AgentRuntime {
  private readonly providers: Provider[]
  private readonly poller: Poller
  private readonly focus: (pid: number) => Promise<boolean>
  private readonly launchTerminal: (dwarfName: string, transcriptPath: string) => Promise<boolean>
  private readonly textDelivery: TextDeliveryPort
  private readonly launchSession: SessionLauncher
  /** Sessions this panel started and still holds (#86, #94). */
  private readonly heldSessions: HeldSessionRegistry
  /** Sessions this panel started and let go of, but can still end (#217). */
  private readonly launched: LaunchedSessionRegistry
  /**
   * Every command of the person's own this panel is holding (#194).
   *
   * A third way to own a child and deliberately not a fourth: it takes its
   * per-OS half from the same `processEnd` port `launched` does, and its spawn
   * seam is the same shape `heldSessions` uses for the Agent SDK.
   */
  private readonly hosted: HostedProcessRegistry
  /** Which agent CLIs this machine has (#91), asked when the Add Panel opens. */
  private readonly cliDetector: CliDetector
  /** Whether this run is a simulated valley, which nothing real may be started in. */
  private readonly simulated: boolean
  /** Shared by the lifecycle grace window and the delivery stage timings. */
  private readonly now: () => number
  private readonly ledger: MaterialLedger
  /** Keeps an unchanged poll from waking the renderer (see PublishGate). */
  private readonly publishGate = new PublishGate()
  /** Owns both the 'leaving' grace window and the retirement record (#46). */
  private readonly lifecycle: DwarfLifecycleTracker
  /** Null whenever the projects database will not open, or a demo is running. */
  private readonly projects: ProjectsStore | null
  /**
   * Complexity-tier authority, held onto past the constructor so queryProjects
   * can join a project's measured byte weight the same live way it joins
   * materials off the ledger (#140) — read on demand, never persisted to the
   * projects store the way `knownTier` is. A query never triggers or waits on
   * a walk; it reads whatever this service already has cached.
   */
  private readonly tiers: TierService
  /** Reads a mine's transcripts on disk for the history panel (#192). */
  private readonly history: MineHistorySource
  /** Writes a row per observed project, throttled (#93); null without a store. */
  private readonly projectObserver: ProjectObserver | null
  /**
   * Serializes the fire-and-forget project writes, and is what settleProjects()
   * hands back. The poll loop must never await a disk write, so without this
   * there is nothing a test can wait on and no ordering between two polls.
   */
  private projectWrites: Promise<void> = Promise.resolve()
  /** Opens the OS folder picker; null when this build was given none. */
  private readonly chooseDirectory: (() => Promise<string | null>) | null
  /**
   * The projects the user declared, as of the last read of the store (#85).
   *
   * Cached because the poll loop is synchronous and the store is not, and
   * because re-reading a table on a two-second interval to learn something that
   * changes only when the user clicks would be the same mistake the observer's
   * throttle exists to avoid. Refreshed on load and after every declaration.
   */
  private declared: DeclaredProject[] = []
  /**
   * Where each project's mine stands on the world map, as the store remembers
   * it (#136).
   *
   * Cached for the same reason `declared` is — the poll loop is synchronous and
   * the store is not — but refreshed from two places rather than one: the whole
   * table on load and after a declaration, and one row at a time as the
   * observer writes, since a project the app has only just discovered is placed
   * DURING that write and would otherwise be missing its location until the
   * next launch.
   */
  private readonly mapSites = new Map<string, number>()
  /**
   * Every project id the store holds a row for (#165), or null when the store
   * has never answered.
   *
   * The join that makes the map and the Mines list one world: the map draws the
   * board, the list draws store rows, and this is how main can say which board
   * mines have no row behind them so the panel can list those too.
   *
   * REBUILT from the whole-table read `loadDeclared` already makes — no second
   * query — and added to one id at a time as the observer writes, for exactly
   * the reason `mapSites` is: a project the app has only just discovered would
   * otherwise read as unrecorded for the rest of the session.
   *
   * Null and empty are different answers. Null is "no reading at all": no store
   * configured, or a store that refused. An empty set is a store that answered
   * and holds nothing. Only the second is grounds for calling a mine
   * unrecorded — see stampUnrecorded.
   */
  private recorded: Set<string> | null = null
  private mines: Mine[] = []
  /**
   * Where a held session's own crew can be written to, rebuilt every poll by
   * stampHeldCrew (#157).
   *
   * Kept here rather than asked of the registry because the ids are the STAMP's
   * own construction — it names each crew member after the session dwarf it
   * found on the board, and the registry has never seen a dwarf id. Replaced in
   * one assignment per poll, the way claudeProvider swaps its own two maps, so
   * a click landing mid-poll reads a whole generation rather than half of one.
   */
  private heldCrewTargets: ReadonlyMap<string, TextDeliveryTarget> = new Map()

  constructor(options: RuntimeOptions) {
    const home = options.home ?? homedir()
    const fs = options.fs ?? new NodeFs()
    const appPaths: ViewerPathOptions = options.appPaths ?? {
      isPackaged: false,
      resourcesPath: process.resourcesPath ?? '',
      appPath: process.cwd()
    }
    // The one place the running operating system is consulted: everything
    // below depends on ports, never on process.platform.
    const platform =
      options.platformAdapters ??
      createPlatformAdapters({
        home,
        appPaths,
        relayModel: options.config.sendTextRelayModel,
        relayTimeoutMs: options.config.sendTextTimeoutS * 1_000,
        // CLI detection (#91) reads the same fs the providers do, and honours an
        // explicit override path per CLI; blank means "detect it". Derived from
        // the provider blocks (#78), so a backend added to the table has its
        // override honoured here without a line of its own.
        fs,
        cliOverrides: cliOverridesFrom(options.config)
      })

    this.now = options.now ?? Date.now

    // The development-only simulated valley (#42). Null in every ordinary run,
    // and null in EVERY packaged run whatever the environment says — the two
    // locks live in createSimulation, which is the only place a simulation can
    // come into existence. Built here because everything below branches on it.
    const simulation = createSimulation({
      env: options.simulationEnv,
      isPackaged: appPaths.isPackaged,
      // Shares the runtime's clock, so simulated ticks and the lifecycle grace
      // window are measured against the same time in tests and in the app.
      now: this.now,
      warn: (message) => console.warn(message)
    })

    // Every real detector, built from the registry (#78) rather than listed
    // here: this file owns the poll loop and the wiring around it, and which
    // backends exist is the registry's subject. Deferred behind a function
    // because a simulated run must not construct them at all.
    const realProviders = (): Provider[] =>
      createProviders(
        {
          config: options.config,
          fs,
          sqlite: options.sqlite ?? new NodeSqlite(),
          platform,
          expandPath: (path) => expandHomePath(path, home),
          // Read at scan time, never now: the held registry is composed a few
          // lines below this, and no scan runs before the constructor returns.
          isHeldSession: (sessionId) => this.heldSessions.holds(sessionId)
        },
        options.providerRegistry ?? PROVIDER_REGISTRY
      )

    // A simulated valley REPLACES the real detectors rather than joining them:
    // a demo that also reported the developer's own live sessions would be
    // neither an honest demo nor an honest reading of their machine, and the
    // two crews would end up sharing one map.
    this.providers = options.providers ?? (simulation ? [simulation.provider] : realProviders())
    this.focus = options.focus ?? ((pid) => platform.focusPid(pid))
    this.launchTerminal =
      options.launchTerminal ??
      ((dwarfName, transcriptPath) => platform.launchTranscriptViewer(dwarfName, transcriptPath))
    this.textDelivery = options.textDelivery ?? platform.textDelivery
    this.simulated = simulation !== null
    // Composed here rather than in platformAdapters: holding a session is the
    // same act on all three platforms, so there is no per-OS branch to own.
    // Model and turn ceiling are deliberately left to the CLI's own defaults —
    // guessing either would bake an answer into a wire contract before the
    // question is settled, and it would have meant a config value (#95).
    this.cliDetector = platform.cliDetector
    this.heldSessions =
      options.heldSessions ??
      new HeldSessionRegistry({
        detector: platform.cliDetector,
        start: createSdkHeldSession(),
        now: this.now,
        log: (message) => console.log(message)
      })
    // Ending a process tree is NOT the same act on all three platforms, so
    // unlike the two registries around it this one takes its per-OS half from
    // platformAdapters — the single composition point — and keeps only the
    // policy here (#217).
    this.launched =
      options.launchedSessions ??
      new LaunchedSessionRegistry({
        endProcessTree: (pid) => platform.processEnd.endProcessTree(pid),
        log: (message) => console.log(message)
      })
    // The same per-OS half as `launched` above, for the same reason: ending a
    // tree differs by platform and that difference has exactly one owner. The
    // spawn seam is composed here rather than in platformAdapters because
    // starting a process is the same act everywhere — see nodeHostedProcess on
    // why a hosted child needs no console-hosting intermediary (#194, #208).
    this.hosted =
      options.hostedProcesses ??
      new HostedProcessRegistry({
        start: createNodeHostedProcess(),
        endProcessTree: (pid) => platform.processEnd.endProcessTree(pid),
        // The plain environment, and no `buildRelayEnv` beside it: that helper
        // leads PATH with the DETECTED CLI's own directory so a re-exec inside
        // the child reaches the install detection found. There is no detected
        // install here — the program is a name somebody typed — so leading PATH
        // with anything would be this app deciding which of their programs they
        // meant.
        env: process.env,
        now: this.now,
        log: (message) => console.log(message)
      })
    // Composed here rather than in platformAdapters: starting a CLI is the same
    // act on all three platforms, so there is no per-OS branch to own — only
    // the PATH spelling, which arrives as the already-selected platform.
    this.launchSession =
      options.launchSession ??
      ((request) =>
        launchClaudeSession({
          provider: request.provider,
          minePath: request.minePath,
          prompt: request.prompt,
          detector: platform.cliDetector,
          env: process.env,
          platform: platform.platform,
          fs,
          run: runLaunchProcess
        }))
    /*
     * A demo must never put phantom ore in a real vault (#42).
     *
     * While simulating, the persisted ledger index.ts handed in is dropped on
     * the floor: never observed, never saved, never even opened. What takes its
     * place is a full MaterialLedger over a store that writes nothing, so the
     * panel gets a live vault that fills fast enough to overflow the 21-nugget
     * pile cap (#22) — the real accrual code, running on real deltas, with the
     * one wire to disk cut. Bypassing accrual altogether would have been the
     * simpler fix and would have left #22 exactly as unobserved as it was.
     */
    this.ledger = simulation
      ? new MaterialLedger({ store: nullLedgerStore() })
      : (options.ledger ?? new MaterialLedger({ store: nullLedgerStore() }))

    const tiers =
      options.tiers ??
      new TierService({
        fs,
        thresholds: options.config.tierThresholds,
        ttlS: options.config.tierCacheTtlS
      })
    this.tiers = tiers
    /*
     * The history panel's reader (#192), over the SAME roots and registry the
     * providers scan — composed here rather than handed a provider, because a
     * provider answers for the sessions running now and this reads the ones
     * that are not. A simulated valley's folders are on nobody's disk, so its
     * mines simply have no history; nothing here needs to know it is a demo.
     */
    this.history =
      options.history ??
      new MineHistoryReader({
        fs,
        claudeRoots: options.config.providers.claude.configDirs.map((path) =>
          expandHomePath(path, home)
        ),
        codex: {
          sqlite: options.sqlite ?? new NodeSqlite(),
          stateDbPath: expandHomePath(options.config.providers.codex.stateDb, home)
        },
        platform: platform.platform
      })
    /*
     * Who decides what a mine is made of.
     *
     * Normally TierService, which weighs the project's source on disk. A
     * simulated mine has no disk: TierService would walk `/simulated-valley/...`,
     * find nothing, and call all twenty of them bronze — flattening the tier
     * spread the demo exists to show and leaving the vault with a single
     * material. So the simulation answers for its own geology, and reports
     * every tier as already measured because there is no walk to wait for
     * (#41's confirmed-tier rule would otherwise mean a permanently empty vault).
     */
    const tierOf = simulation ? simulation.tierOf : (path: string): MineTier => tiers.tierOf(path)
    const confirmedTierOf = simulation
      ? (mine: Mine): MineTier | undefined => simulation.knownTierOf(mine.path)
      : (mine: Mine): MineTier | undefined => tiers.knownTierOf(mine.path)
    /*
     * A demo must never write into real persistence (#42), and the reasoning
     * is the ledger's one line for line: the store index.ts handed in is
     * dropped on the floor for the whole simulated run. It is also narrower
     * here — /simulated-valley/... is not a project on anybody's disk, so a row
     * for one would be a false memory rather than merely a phantom total, and
     * the declared mines a real user added must not be shown inside a demo
     * whose whole point is that its valley is invented.
     */
    this.projects = simulation ? null : (options.projects ?? null)
    this.chooseDirectory = options.chooseDirectory ?? null
    this.projectObserver =
      this.projects === null
        ? null
        : new ProjectObserver({
            store: this.projects,
            // knownTierOf, exactly as the ledger below: the column takes a
            // MEASURED tier only, and mine.tier is a provisional bronze until
            // the project's first walk finishes (#41).
            knownTierOf: confirmedTierOf,
            // The location the store just chose for a project it had never seen
            // (#136). Taken from the row that was actually written, never
            // guessed here, so the panel draws a new mine where it will still
            // be after a restart.
            onRecorded: (record) => {
              if (record.mapSite !== null) this.mapSites.set(record.id, record.mapSite)
              // The row now exists, so the mine is recorded from this poll on
              // (#165). Only ever added here: a write proves one row, never the
              // absence of the rest, so it cannot turn a null reading into a set.
              this.recorded?.add(record.id)
            },
            onError: (message, detail) => console.warn(message, detail)
          })

    const lifecycle = new DwarfLifecycleTracker({
      graceMs: options.config.dwarfLeaveGraceS * 1_000,
      now: options.now
    })
    this.lifecycle = lifecycle
    this.poller = new Poller({
      providers: this.providers,
      intervalMs: options.config.pollIntervalMs,
      tierOf,
      onUpdate: (rawMines) => {
        const now = this.now()
        // The board is discovery PLUS declaration (#85), and this is the one
        // place that knows it — aggregateMines stays a projection of the
        // snapshots alone. Merged before the lifecycle and the ledger see it,
        // so a declared mine is stamped with its persisted material like any
        // other and a crew arriving in one lands in the mine already there.
        const merged = mergeDeclaredMines(rawMines, this.declared, tierOf)
        // Every command of the person's own this panel is holding (#194) —
        // dwarfs no provider can see either, and for a stronger reason than a
        // held session's crew: nothing observes these at all except this
        // process. Stamped HERE, beside mergeDeclaredMines, because it is the
        // other step that may put a mine on the board which discovery did not
        // find: a hosted process has no provider snapshot, so there is no
        // `cwd` for aggregateMines to group, and a mine nobody is working is
        // not on the board at all. Before the lifecycle, like the crew stamp,
        // so a process that has gone gets the same leaving grace and walks out
        // to a spawn point.
        const withHosted = stampHostedProcesses(
          merged,
          this.hosted.states(),
          tierOf,
          platform.platform
        )
        // A held session's own subagents (#157), which no provider can see:
        // they run in the foreground, so the transcript carries no
        // `async_launched` record for the poll to read (see heldCrew.ts for
        // the measurement). Stamped HERE, before the lifecycle and everything
        // after it, so a crew member is an ordinary dwarf from that point on —
        // it gets the leaving grace and walks out to a spawn point, it is
        // placed by the same solver, and its send route is resolved by the
        // same stamp as everyone else's.
        const crew = stampHeldCrew(withHosted, (sessionId) =>
          this.heldSessions.crewState(sessionId)
        )
        this.heldCrewTargets = crew.targets
        const mines = crew.mines
        // Accrual happens on the lifecycle's output, which is exactly what
        // gets published: a dwarf held back by the grace window reports the
        // counter it last had, so it contributes a zero delta rather than a
        // phantom one, and every published mine carries a stamped breakdown.
        //
        // knownTierOf, NOT the mine.tier the poller stamped: that one is what
        // the mound is drawn as, and it is a provisional bronze until the
        // project's first walk finishes. The vault waits for a measured tier
        // (#41) — mine.path is the very string aggregateMines handed to
        // tierOf, so this asks about exactly the mine in hand.
        //
        // Placement and the one-mine-per-project invariant are stamped LAST, on
        // the lifecycle's own output (#156). The tracker is the one step that
        // can put a mine on the board which was not on it a moment before: when
        // the last session in a project ends, the whole mine leaves the
        // snapshot and the tracker rebuilds it so the departing dwarf has
        // somewhere to walk out of. Stamped before that, as it was, the rebuilt
        // mine carried no location at all — so for the length of the grace
        // window the panel placed it itself, and one project stood in two
        // different places on the map within a second. Where a mine STANDS is a
        // remembered fact off the projects store, and it joins by the same
        // mineIdForPath id everything else here does (#136).
        const withMaterials = pollProfiler.measureSync('ledger', () =>
          this.ledger.observe(
            // Whether the store holds a row is stamped LAST, on the collapsed
            // board (#165): the flag is per project id, and a mine that was
            // still two entries a step earlier would carry it twice.
            stampUnrecorded(
              collapseDuplicateMines(stampMapSites(lifecycle.apply(mines), this.mapSites)),
              this.recorded
            ),
            now,
            confirmedTierOf
          )
        )
        // Which session each launch of ours became (#217), decided against the
        // board this poll produced and BEFORE the channels below are stamped:
        // a session claimed on this poll is offered its exit on this poll,
        // rather than a poll later. Claims are made once and kept, so this
        // costs a lookup per launch still waiting for one.
        this.launched.observe(withMaterials)
        // The panel decides which actions to offer per dwarf, so the resolved
        // delivery channel travels with the snapshot instead of costing an
        // extra IPC round trip per sprite.
        const delivered = pollProfiler.measureSync('stamp', () =>
          stampTextDelivery(withMaterials, (dwarfId) => this.deliveryTargetOf(dwarfId))
        )
        // What a session the panel HOLDS is asking, live (#94). This runs after
        // the provider has already stamped whatever its transcript tail
        // derived, and supersedes it for held sessions only — including
        // clearing it, because for those the held stream is the complete truth
        // and the tail's version is the post-hoc one. See stampHeldQuestions.
        const withQuestions = stampHeldQuestions(delivered, (sessionId) =>
          this.heldSessions.questionState(sessionId)
        )
        // What a session the panel HOLDS has reported about itself, live
        // (issue #96) — model, MCP status and running cost, off the same
        // init/result messages the ask loop above already reads. Same
        // supersession rule: only a held session has any of this, so an
        // observed session's own tail-derived read (model, above all) stands
        // untouched. See stampHeldTelemetry.
        const withTelemetry = stampHeldTelemetry(withQuestions, (sessionId) =>
          this.heldSessions.telemetryState(sessionId)
        )
        // The words that session's own stream carried (#159), which is the
        // only conversation this app has first-hand. Same supersession rule
        // once more, and the same reason it can only ever ADD: a session the
        // panel does not hold has no conversation here at all, and the panel
        // reads its transcript on its own channel instead (see dwarfFeed).
        const withConversation = stampHeldConversation(withTelemetry, (sessionId) =>
          this.heldSessions.conversationState(sessionId)
        )
        // What a held session's dwarf actually IS, last of all (#157). Role is
        // topology, and for a session this panel holds the stream is the
        // topology: it digs alone until it coordinates something and is the
        // foreman from the moment it has a crew out. Last because all three
        // stamps above find the session's own dwarf by the rank its provider
        // gave it, and this is the step that changes it — a solo held session
        // ranked here first would be a worker by the time they looked, and
        // would keep neither its question, nor its telemetry, nor its words.
        const published = stampHeldRank(withConversation, (sessionId) =>
          this.heldSessions.crewState(sessionId)
        )
        this.mines = published
        pollProfiler.count(
          'dwarfs',
          published.reduce((total, mine) => total + mine.dwarfs.length, 0)
        )
        // A poll that re-observed an unchanged world does not wake the panel
        // (#25). getMines() still answers from this.mines, so a renderer that
        // starts or reloads mid-quiet-spell gets the current state regardless.
        const totals = this.ledger.totals()
        if (this.publishGate.shouldPublish(published, totals)) {
          pollProfiler.count('push')
          pollProfiler.measureSync('ipc', () => options.onMinesUpdated(published, totals))
        } else {
          pollProfiler.count('skip')
        }
        // A hosted process whose dwarf has now left the published board is
        // forgotten (#194). Held until here rather than dropped at its exit,
        // because the lifecycle's grace window is what walks it out — a record
        // removed the moment the process died would make its dwarf blink off
        // instead.
        for (const state of this.hosted.states()) {
          if (state.running) continue
          const stillDrawn = published.some((mine) =>
            mine.dwarfs.some((dwarf) => dwarf.id === state.hostedId)
          )
          if (!stillDrawn) this.hosted.forget(state.hostedId)
        }
        // Throttled inside the ledger, and deliberately not awaited: the panel
        // must never wait on a disk write to see its dwarfs move.
        void this.ledger.save(now)
        // Same discipline for the projects store, and on the published list so
        // a mine held back by the grace window is judged by what the panel was
        // actually shown. Throttled inside the observer for the reason the
        // ledger throttles: node:sqlite is synchronous and this is the thread
        // the panel paints from.
        this.recordProjects(published, now)
      },
      logError: (message, error) => console.warn(message, error)
    })
  }

  start(): void {
    this.poller.start()
  }

  /**
   * Also releases whatever the delivery tier keeps alive between actions — the
   * long-lived console shell, today. index.ts already calls this on
   * 'before-quit', so a quit never leaves a stray powershell.exe behind.
   */
  stop(): void {
    this.poller.stop()
    this.textDelivery.dispose?.()
    // A held session's child dies with the panel, so this is where that
    // happens deliberately rather than as a stray process being reaped. Every
    // question still open is dissolved on the way out — told that nobody
    // answered, never handed a fabricated one (see HeldSessionRegistry).
    this.heldSessions.closeAll()
    // And so does a hosted process, for a stronger reason than a held session:
    // this panel IS its stdio, so one left running would have nobody reading
    // its output or writing its input (#194). Not awaited — quitting must not
    // wait on a kill — and the same act a person can take deliberately on one
    // process through Kick.
    void this.hosted.closeAll()
    // The launched register is deliberately NOT ended here (#217). A detached
    // session outliving the panel is the whole point of detaching it — #212
    // watched a turn finish after the parent had gone — so quitting ends
    // nothing it started. The exit added for #217 is one a person takes on
    // purpose, on one session, never a reaping.
    // Forced past the save throttle: whatever the last poll accrued would
    // otherwise be lost, and quitting is exactly when that is most likely.
    void this.ledger.save(this.now(), true)
  }

  /** The whole vault by material, including projects with no crew right now. */
  materialTotals(): MaterialTotals {
    return this.ledger.totals()
  }

  /**
   * Settings' "Reset metrics" action (#138), behind its typed confirmation.
   *
   * PRODUCT DECISION (#138): this wipes METRICS only — the material ledger
   * (mined totals and session marks) — and never the projects store. A
   * declared or discovered mine is the user's remembered project list, not a
   * metric, and this method never calls into `this.projects`. The panel side,
   * the shortcut, the pin and autostart preferences are untouched for the
   * same reason: none of them are metrics either.
   *
   * `outcome: 'reset'` is only returned once the wipe is actually persisted —
   * see MaterialLedger.reset(), which forces the write past the throttle and
   * reports whether it reached the store. The next ordinary poll republishes
   * the (now empty) totals like any other ledger change; this method does not
   * force one, because a confirm click is not itself a reason to skip ahead
   * of the poll interval.
   */
  async resetMetrics(): Promise<MetricsResetResult> {
    const succeeded = await this.ledger.reset(this.now())
    return succeeded ? { outcome: 'reset' } : { outcome: 'failed', reason: RESET_FAILED }
  }

  /**
   * Read the declarations already on disk into the cache the poll loop merges
   * from (#85), and every project's map placement with them (#136).
   *
   * Awaited by index.ts BEFORE start(), exactly as the ledger is loaded before
   * the runtime exists: the very first published poll then already carries the
   * user's mines instead of drawing an empty valley and filling it a moment
   * later. Never throws — a store that refuses leaves the cache as it was.
   */
  async loadDeclared(): Promise<void> {
    const store = this.projects
    if (store === null) return
    const result = await store.list()
    if (!result.ok) {
      console.warn(
        `[projects] Could not read the declared mines (${result.failure}):`,
        result.message
      )
      return
    }
    // Placements come off the SAME read, and from every row rather than only
    // the declared ones: a project the app discovered is on the map too, and
    // its location is as persisted as a declared one's. Entries are only ever
    // added — a store that has stopped answering must not blank the board's
    // placements, and a location is never withdrawn once chosen (#136).
    for (const project of result.value) {
      if (project.mapSite !== null) this.mapSites.set(project.id, project.mapSite)
    }
    // REPLACED rather than added to, unlike the placements above: this answers
    // "which projects does the store hold", and a row that has gone must stop
    // counting as one (#165). The read succeeded, so it is the whole truth.
    this.recorded = new Set(result.value.map((project) => project.id))
    // Keeping the previous cache on a failure rather than emptying it: a
    // momentary lock must not sweep the user's mines off the board.
    this.declared = result.value
      .filter((project) => project.origin === 'declared')
      .map((project) => ({
        path: project.path,
        // null means never measured, and mergeDeclaredMines falls back to the
        // provisional tier for drawing (#41).
        ...(project.knownTier === null ? {} : { knownTier: project.knownTier })
      }))
  }

  /**
   * Adopt a folder the user picks as a mine (#85).
   *
   * The picker is opened HERE, in the main process, and the renderer only asks:
   * a channel that accepted a path would be a channel that accepts any path.
   * Every refusal carries a reason, because an Add button that sometimes does
   * nothing is indistinguishable from one that is broken.
   */
  async declareMine(): Promise<MineDeclareResult> {
    const store = this.projects
    // Asked before the picker on purpose: making the user choose a folder and
    // then dropping it is worse than refusing before they start.
    if (store === null) return { outcome: 'failed', reason: NO_PROJECT_STORE }
    if (this.chooseDirectory === null) return { outcome: 'failed', reason: NO_PICKER }

    let path: string | null
    try {
      path = await this.chooseDirectory()
    } catch (error) {
      console.warn('[projects] The folder picker failed', error)
      return { outcome: 'failed', reason: PICKER_FAILED }
    }
    // Backing out of the picker is a decision, not a fault (#127): 'outcome'
    // says the whole thing on its own, so unlike the four returns above this
    // one carries no reason — there is nothing left for a string to add.
    if (path === null || path.trim() === '') return { outcome: 'cancelled' }

    const result = await store.declare({ path, at: this.now() })
    if (!result.ok) {
      console.warn(`[projects] Could not add a mine (${result.failure}):`, result.message)
      return { outcome: 'failed', reason: DECLARE_FAILED }
    }

    await this.loadDeclared()
    // AWAITED rather than nudged. Both reuse the same already-tested scan path
    // and neither can produce a state the next ordinary poll would not have,
    // but a nudge leaves its scan in flight, and the poller drops an
    // overlapping tick — so the panel could ask for the mines, be answered from
    // the board this very declaration is not on yet, and sit on it until the
    // interval came round. The user has just spent seconds in a folder picker;
    // one scan is not the cost worth saving here.
    await this.refresh()
    // The row travels with the verdict (#156). The panel reloads its first page
    // after an adopt, and that reload cannot be relied on to hold the new card:
    // a project keeps the date it was FIRST seen, so re-declaring a folder the
    // store already knows leaves it exactly where it already sat in the order.
    // Shaped by the same toSummary the browse itself answers with, so the card
    // the panel draws from this is the card it would have drawn from a query.
    // Read after the refresh above, so `live` is stamped from the board this
    // declaration is now on.
    return {
      outcome: 'added',
      mineId: result.value.id,
      project: this.toSummary(result.value, new Set(this.mines.map((mine) => mine.id)))
    }
  }

  /**
   * Undo a declaration, by mine id and never by path (#85).
   *
   * The ledger is never touched: the ore that mine produced is history, and
   * history is immutable here (#22). A mine a session is still working simply
   * goes back to being a discovered one — the user asked to undo their
   * declaration, not to hide a running agent.
   */
  async undeclareMine(mineId: string): Promise<MineUndeclareResult> {
    const store = this.projects
    if (store === null) return { outcome: 'failed', reason: NO_PROJECT_STORE }

    const result = await store.removeDeclared(mineId)
    if (!result.ok) {
      console.warn(`[projects] Could not remove a mine (${result.failure}):`, result.message)
      return { outcome: 'failed', reason: UNDECLARE_FAILED }
    }
    if (result.value === 'unchanged') return { outcome: 'unchanged', reason: NOT_DECLARED }

    await this.loadDeclared()
    // Awaited for the reason declareMine's rescan is.
    await this.refresh()
    return { outcome: result.value === 'removed' ? 'removed' : 'reverted' }
  }

  /**
   * Browse every project the app remembers, filtered and ordered in SQL (#92).
   *
   * Nothing is filtered, sorted or paged here: the store answers the whole
   * question, because a browse spans a table with no bound on its length and
   * reading it into this process to trim it would use none of the indexes it
   * was given. What this method adds is the one fact the database deliberately
   * does not hold — whether each project is on the board RIGHT NOW — plus two
   * joins against state that lives outside the projects table entirely:
   * `materials` off the ledger and `weightBytes` off TierService's own cache
   * (#140), both read live rather than persisted here, and both absent rather
   * than a placeholder for a project neither has measured yet.
   *
   * `live` is poll-truth, stamped as the answer is assembled and never stored.
   * Two readings of `false` are worth separating: a project that is remembered
   * and has no session in it, and any project at all before the first poll has
   * published, when `this.mines` is still empty. The second is a window of one
   * tick at startup and resolves itself; nothing acts on `live` but the drawing.
   *
   * A declared mine reads as live even with no crew, and that is not an
   * exception — #85 keeps it on the board as a steady state, so "on the board"
   * and "live" still say the same thing.
   */
  async queryProjects(query: ProjectQuery): Promise<ProjectQueryResult> {
    const store = this.projects
    if (store === null) return { answered: false, projects: [], reason: NO_PROJECT_STORE }

    const result = await store.query(query)
    if (!result.ok) {
      console.warn(`[projects] Could not read the projects (${result.failure}):`, result.message)
      return { answered: false, projects: [], reason: QUERY_FAILED }
    }

    // A set rather than a scan per row: the board is small but a page is not
    // one id, and a find() inside the map would be O(page × board).
    const onBoard = new Set(this.mines.map((mine) => mine.id))
    return {
      answered: true,
      projects: result.value.map((project) => this.toSummary(project, onBoard))
    }
  }

  /**
   * One stored project as the browse lists it.
   *
   * Extracted from queryProjects when the declare verdict started carrying the
   * project it adopted (#156): the panel has to be able to put that card on
   * screen itself, and a second shaping of the same row here is a second place
   * for the wire's absent-means-unmeasured rules to drift.
   */
  private toSummary(project: ProjectRecord, onBoard: ReadonlySet<string>): ProjectSummary {
    // O(1) per row off the ledger already held in memory (#90) — no query,
    // same id scheme (mineIdForPath) the board and the ledger both key by.
    const materials = this.ledger.knownMineTotals(project.id)
    // Same live-join shape as materials, off TierService's own cache
    // instead of the ledger — keyed by PATH, the same key tierOf/
    // knownTierOf use, never mineIdForPath (#140). Absent exactly when no
    // walk has measured this path yet; a stale measurement still counts.
    const weightBytes = this.tiers.knownWeightBytesOf(project.path)
    return {
      id: project.id,
      path: project.path,
      name: project.name,
      declared: project.origin === 'declared',
      // Absent, never null and never a placeholder: the wire says "nobody has
      // measured this" by saying nothing at all (#41).
      ...(project.knownTier === null ? {} : { knownTier: project.knownTier }),
      ...(weightBytes === undefined ? {} : { weightBytes }),
      addedAt: project.addedAt,
      ...(project.lastOpenedAt === null ? {} : { lastOpenedAt: project.lastOpenedAt }),
      ...(project.lastProvider === null ? {} : { lastProvider: project.lastProvider }),
      // Absent exactly when the ledger has no row for this id — never an
      // invented zero breakdown for a project the vault has not mined.
      ...(materials === undefined ? {} : { materials }),
      // Straight off the row, so a browse and the map can never disagree
      // about where a mine stands (#136).
      ...(project.mapSite === null ? {} : { mapSite: project.mapSite }),
      live: onBoard.has(project.id)
    }
  }

  /**
   * Resolve once every project write this poll started has finished.
   *
   * A test seam, mirroring TierService.settle(): the writes are deliberately
   * not awaited by the poll loop, so a test that asserted on the store right
   * after refresh() would be racing them.
   */
  async settleProjects(): Promise<void> {
    await this.projectWrites
  }

  /**
   * Queue one poll's worth of project observations behind the last (#93).
   *
   * Serialized rather than fired in parallel because node:sqlite is
   * synchronous: two overlapping polls would interleave writes on the main
   * thread for no benefit, and the throttle's own bookkeeping assumes the
   * previous decision has been made.
   */
  private recordProjects(mines: Mine[], now: number): void {
    const observer = this.projectObserver
    if (observer === null) return
    this.projectWrites = this.projectWrites.then(() => observer.observe(mines, now))
  }

  /** Execute a deterministic scan for IPC/tests without starting an interval. */
  async refresh(): Promise<void> {
    await this.poller.tick()
  }

  /**
   * Report that something outside the poller says the state just changed —
   * today, a Claude Code hook arriving on the loopback listener.
   *
   * Deliberately fire-and-forget and deliberately coarse: it asks for a full
   * rescan rather than trying to update one session, so the push channel reuses
   * the same already-tested scan path and can never produce a state the regular
   * poll would not have produced two seconds later.
   */
  nudge(): void {
    this.poller.nudge()
  }

  getMines(): Mine[] {
    return this.mines
  }

  /**
   * Ask whichever provider owns `dwarfId` how a message could reach it. A
   * provider that predates the capability surface (or does not implement it)
   * simply reports no channel.
   *
   * A 'terminal' target is degraded on platforms whose delivery port cannot
   * type into a console (macOS until its osascript path is verified, Linux
   * always): to its relay address when the session carries one — the relay
   * spawns a CLI, so it works on every platform — and to no channel at all
   * otherwise. Providers answer from what the SESSION offers, which is a fact
   * about the session, not about this machine; intersecting the two here is
   * what makes the panel show a working relay Send (or a disabled button with
   * a reason) instead of a Send that quietly types nowhere.
   *
   * ONLY a 'terminal' target is degraded, and the reason matters: it is the one
   * kind that claims a console this machine may be unable to type into. A
   * 'codex-queue' target claims no console at all — it spawns a CLI, like the
   * relay — so intersecting it with console support would delete a working
   * channel from macOS and Linux, the two platforms with the fewest to spare
   * (#97).
   */
  private deliveryTargetOf(dwarfId: string): TextDeliveryTarget | null {
    const consoleSupported = this.textDelivery.supportsConsoleInput !== false
    // A held session's crew first, because no provider knows these dwarfs
    // exist: the panel put them on the board off the session's own stream
    // (#157). Every one of them relays — a running subagent has no channel of
    // its own — and resolve.ts follows the hops to the session that can be
    // written to.
    //
    // This ordering is load-bearing against the ownership check below, not
    // merely historical: a crew dwarf carries its ROOT's sessionId
    // (heldCrewDwarfs), so an ownership check reached first would answer
    // 'held-session' for a subagent and write the message straight to the
    // session — losing both the hop and the '[for agent X] ' prefix that names
    // which agent it was for. Crew targets and crew dwarfs are rebuilt from the
    // same crew on the same poll, so a crew dwarf is never missing from here.
    const heldTarget = this.heldCrewTargets.get(dwarfId)
    if (heldTarget !== undefined) return heldTarget
    // Ownership BEFORE endpoint kind (#210). A session this panel holds is
    // written to through the stream this process is holding, and no provider
    // can know that: an SDK-hosted session's registry entry records
    // `kind: "interactive"`, so claudeSessionDeliveryTarget answers with the SDK
    // child's pid — a process that owns no window — and the relay name beside
    // it addresses a queue no REPL drains. Both were tried live and both
    // reported the wrong thing, one by failing focus and one by exiting 0.
    const heldSessionId = this.heldSessionIdOf(dwarfId)
    if (heldSessionId !== undefined) return { kind: 'held-session', sessionId: heldSessionId }
    // Ownership again, and the same reason as the line above: this process is
    // holding that pipe, and no provider can know it because no provider ever
    // saw this dwarf at all (#194). Ahead of the provider loop because it can
    // never collide with one — a hosted dwarf's id is this register's own — and
    // placed here so both ownership answers read as one rule rather than two.
    if (this.hosted.states().some((state) => state.hostedId === dwarfId)) {
      return { kind: 'hosted-stdin', hostedId: dwarfId }
    }
    for (const provider of this.providers) {
      const target = provider.textDelivery?.(dwarfId)
      if (target === undefined || target === null) continue
      if (target.kind === 'terminal' && !consoleSupported) {
        return target.sessionName === undefined
          ? null
          : { kind: 'claude-relay', sessionName: target.sessionName }
      }
      return target
    }
    // LAST, and deliberately: this is the channel of last resort (#217). It
    // can only end the session, so any real channel — one that can carry a
    // message, or interrupt a turn and leave the session standing — is a
    // better answer than this one, and a session whose provider offers
    // anything at all never reaches here. What it replaces is not a channel
    // but a dead end: no send, no kick, and no way out of a process this app
    // started.
    const launchId = this.launched.launchIdOfDwarf(dwarfId)
    return launchId === undefined ? null : { kind: 'launched-process', launchId }
  }

  /**
   * The session id of a dwarf whose own session this panel is HOLDING, or
   * undefined (#210).
   *
   * Read off the board rather than taken from the wire, exactly as
   * answerDwarfQuestion reads it, so the two processes keep agreeing on one id
   * instead of two. Undefined covers both "no such dwarf" and "a session this
   * panel merely observes"; neither is a held session, and the caller wants the
   * same answer for both.
   */
  private heldSessionIdOf(dwarfId: string): string | undefined {
    const dwarf = this.mines.flatMap((mine) => mine.dwarfs).find((item) => item.id === dwarfId)
    if (dwarf === undefined) return undefined
    return this.heldSessions.holds(dwarf.sessionId) ? dwarf.sessionId : undefined
  }

  /**
   * The held-session tier for a message, and for a worker's cancel (#210).
   *
   * Synchronous underneath: the registry pushes onto a queue this process owns,
   * so there is nothing to await and nothing to time. A refusal means the
   * stream would not take it — a session already closing, above all — and it
   * stops there rather than reaching for the relay, which for this session
   * would exit 0 into a queue nothing reads. `delivered` still means exactly
   * what it means everywhere else: handed to a queue something drains.
   */
  private sendToHeldSession(sessionId: string, text: string): TextDeliveryOutcome {
    return this.heldSessions.sendText(sessionId, text)
      ? { delivered: true }
      : { delivered: false, error: HELD_STREAM_CLOSED }
  }

  /**
   * The held-session tier for a kick: a real interrupt of the running turn,
   * leaving the session open for the next one (#210).
   *
   * Nothing harsher exists behind it and nothing escalates — the same policy
   * every other channel's kick holds. A refusal is reported as one; the panel
   * must not show a ✓ for a turn that is still running.
   */
  private async interruptHeldSession(sessionId: string): Promise<TextDeliveryOutcome> {
    const interrupted = await this.heldSessions.interrupt(sessionId)
    return interrupted ? { delivered: true } : { delivered: false, error: HELD_KICK_REFUSED }
  }

  /**
   * Ending a session this panel launched — Kick's harshest tier, and the only
   * one that is not an interrupt (#217).
   *
   * It ends the SESSION rather than the turn, so the verdict has to be read as
   * that act and not as a delivered interrupt: `delivered: true` here means the
   * process tree is gone, which is a fact this process observed rather than a
   * message handed to somebody who may act on it. Nothing is watched for
   * afterwards and nothing may be inferred — there is no session left to react
   * (see reaction.ts on what a marker may claim), which is why the panel says
   * the session was ended instead of watching for a stop.
   */
  private async endLaunchedSession(launchId: string): Promise<TextDeliveryOutcome> {
    const verdict = await this.launched.end(launchId)
    if (verdict === 'ended') return { delivered: true }
    return {
      delivered: false,
      error: verdict === 'already-ended' ? LAUNCH_ALREADY_ENDED : LAUNCH_END_REFUSED
    }
  }

  /**
   * The hosted-process tier for a message: straight onto the stdin this
   * process is holding (#194).
   *
   * Synchronous underneath, exactly as the held tier is, and for the same
   * reason: this is a write onto a stream this process owns, so there is
   * nothing to await and nothing to time. A refusal means the pipe would not
   * take it — a process on its way out, above all — and it stops there rather
   * than reaching for a second channel, because there has never been one.
   *
   * `delivered` claims what it claims everywhere else and no more: the bytes
   * went into the pipe. Whether the program read them is a fact no hosted
   * process can report, so nothing here ever promotes to a reaction (see
   * reaction.ts).
   */
  private sendToHostedProcess(hostedId: string, text: string): TextDeliveryOutcome {
    return this.hosted.sendText(hostedId, text)
      ? { delivered: true }
      : { delivered: false, error: HOSTED_PIPE_CLOSED }
  }

  /**
   * Ending a process this panel is HOLDING — the only kick it has (#194).
   *
   * It ends the process rather than a turn, exactly as the launched tier does,
   * and for a reason that is stronger rather than weaker: this app knows
   * nothing about what somebody else's program treats as an interrupt, and a
   * byte it happened to accept as one would be the panel guessing at another
   * program's key bindings. So the harsh act is the honest one, and the panel
   * has to say which act it performed.
   */
  private async endHostedProcess(hostedId: string): Promise<TextDeliveryOutcome> {
    const verdict = await this.hosted.end(hostedId)
    if (verdict === 'ended') return { delivered: true }
    return {
      delivered: false,
      error: verdict === 'already-ended' ? HOSTED_ALREADY_ENDED : HOSTED_END_REFUSED
    }
  }

  /**
   * The Codex queue tier, with the one thing the port may honestly not have.
   *
   * queueToCodexThread is optional on TextDeliveryPort, so a port built without
   * it reports a reason rather than a silent no-op — the same discipline as a
   * platform with no console input. Both shipped ports implement it.
   */
  private async queueToCodexThread(threadId: string, text: string): Promise<TextDeliveryOutcome> {
    const queue = this.textDelivery.queueToCodexThread
    if (queue === undefined) return { delivered: false, error: NO_QUEUE_TIER }
    return queue.call(this.textDelivery, { threadId, text })
  }

  /**
   * Second attempt behind a failed console delivery (issue #24): an
   * interactive session with a registry name is also relay-addressable, so a
   * window that cannot be focused or typed into no longer swallows the
   * payload — the exact same text goes over the relay instead. On success the
   * verdict names 'claude-relay', the channel that actually delivered, so the
   * panel's ✓ stays honest; on a double failure it carries both reasons,
   * terminal first. Logs the verdict only, never the text.
   */
  private async relayFallback(options: {
    dwarfId: string
    /** Only for the log line — the payload is already the right one for the attempt. */
    attempt: 'message' | 'kick'
    /** The channel the verdict reports when the fallback fails too. */
    channel: TextDeliveryChannel
    sessionName: string
    text: string
    terminalError: string | undefined
  }): Promise<DwarfTextResult> {
    // A second attempt is a second attempt: it gets its own timings rather than
    // being folded into the console attempt that failed before it.
    const timer = createStageTimer(this.now)
    const relay = await timer.measure('total', () =>
      timer.measure('relay', () =>
        this.textDelivery.relayToClaudeSession({
          sessionName: options.sessionName,
          text: options.text
        })
      )
    )
    timer.absorb(relay.stages)
    console.log(
      `[runtime] Relay fallback (${options.attempt}) for ${options.dwarfId}: ` +
        `${relay.delivered ? 'delivered' : 'failed'}${stageSuffix(timer.timings())}`
    )
    return relay.delivered
      ? { delivered: true, via: 'claude-relay' }
      : {
          delivered: false,
          via: options.channel,
          error: combineFallbackErrors(options.terminalError, relay.error)
        }
  }

  /**
   * Start a session the panel HOLDS, in a mine's folder (#86, #94).
   *
   * The request names a mine and the folder is resolved HERE, from the board
   * the panel is already being shown, so this can never be talked into starting
   * a process somewhere the panel is not showing. `cwd` is the whole trick
   * besides: aggregation groups by it, so the new session's dwarf appears in
   * the mine it was launched from with no second observation path — and it
   * arrives on an ordinary poll, up to `pollIntervalMs` later, which is why the
   * verdict says a session started and refuses to claim a dwarf.
   *
   * Held is not the only mode a session can be started in. The detached one
   * (#86's first cut) hands the session over and lets go, so it outlives the
   * panel; a held session's child dies with the panel, and in exchange its asks
   * arrive live rather than post-hoc. Neither replaces the other.
   */
  async launchHeldSession(request: HeldSessionLaunchRequest): Promise<HeldSessionLaunchResult> {
    // Refused before the mine is even looked up: a demo's mines are invented,
    // so there is no folder for one to start in (#42).
    if (this.simulated) return { launched: false, error: NO_SIMULATED_LAUNCH }

    const mine = this.mines.find((item) => item.id === request.mineId)
    if (mine === undefined) return { launched: false, error: NO_SUCH_MINE }

    return this.heldSessions.launch({
      mineId: mine.id,
      provider: request.provider,
      minePath: mine.path,
      prompt: request.prompt
    })
  }

  /**
   * Start the command somebody typed into Add > Other, and hold it (#194).
   *
   * The third launch mode, and the only one whose subject is not a CLI this app
   * knows: what arrives is a string, parsed here into a program and an argv
   * array with no shell anywhere (see hostedCommand.ts for that whole posture).
   *
   * **Unlike the other two, this DOES imply a dwarf is coming** — on the next
   * poll, through the ordinary pipeline, because for a hosted process this
   * panel is the observer. There is still no second observation path and
   * nothing is invented in this verdict: the dwarf is drawn from the fact that
   * this process is holding that pipe, which is a fact rather than a guess.
   *
   * The poll is not woken for it, and that is deliberate. All three launch
   * modes acknowledge on the verdict and let the ordinary poll deliver the
   * dwarf, which is what makes ONE arrival rule serve all of them (see
   * launchArrival.ts). `nudge()` would buy at most one poll interval and cost
   * the guarantee: its leading-edge tick is unawaited and an overlapping one is
   * dropped, so the verdict's relationship to the board would become a race
   * rather than a promise.
   *
   * The request names a mine, never a directory, and that guard matters more
   * here than on either other channel: the program is the caller's too, so the
   * one thing this must never be talked into is starting it somewhere the
   * panel is not showing. Nothing here logs the prompt — only its length.
   */
  async launchHostedProcess(request: HostedLaunchRequest): Promise<HostedLaunchResult> {
    // Refused before the mine is even looked up, exactly as a held launch is:
    // a demo's mines are invented, so there is no folder to start in (#42).
    if (this.simulated) return { launched: false, error: NO_SIMULATED_LAUNCH }

    const mine = this.mines.find((item) => item.id === request.mineId)
    if (mine === undefined) return { launched: false, error: NO_SUCH_MINE }

    const outcome = await this.hosted.launch({
      mineId: mine.id,
      minePath: mine.path,
      command: request.command,
      prompt: request.prompt
    })
    return outcome.started
      ? { launched: true }
      : { launched: false, ...(outcome.error === undefined ? {} : { error: outcome.error }) }
  }

  /**
   * Answer a question a held session asked (#94).
   *
   * Addressed by DWARF, like every other action the panel offers, because a
   * question can only be answered from where it was shown — and it is shown on
   * a dwarf. The session id the held stream is keyed by is read off that dwarf
   * here rather than travelling on the wire, so the two processes keep agreeing
   * on one id instead of two.
   *
   * Synchronous on purpose: releasing a blocked tool call is a local handover,
   * not a delivery over a channel that can fail slowly. What happens next is
   * the agent's own business, and the verdict says only that it was handed the
   * choice — the same narrowness `delivered` has for a message.
   */
  answerDwarfQuestion(request: DwarfQuestionAnswerRequest): DwarfQuestionAnswerResult {
    const dwarf = this.mines
      .flatMap((mine) => mine.dwarfs)
      .find((item) => item.id === request.dwarfId)
    if (dwarf === undefined) return { answered: false, error: NO_SUCH_DWARF }

    return this.heldSessions.answer({
      sessionId: dwarf.sessionId,
      toolUseId: request.toolUseId,
      answers: request.answers
    })
  }

  /**
   * Decide a permission prompt a held session raised (#203).
   *
   * Same shape as answerDwarfQuestion, and for the same reasons: addressed by
   * DWARF because a prompt can only be decided from where it was shown, the
   * session id is read off that dwarf rather than travelling on the wire, and
   * the call is synchronous because releasing a blocked tool call is a local
   * handover, never a delivery that can fail slowly.
   */
  answerDwarfPermission(request: DwarfPermissionAnswerRequest): DwarfQuestionAnswerResult {
    const dwarf = this.mines
      .flatMap((mine) => mine.dwarfs)
      .find((item) => item.id === request.dwarfId)
    if (dwarf === undefined) return { answered: false, error: NO_SUCH_DWARF }

    return this.heldSessions.decidePermission({
      sessionId: dwarf.sessionId,
      toolUseId: request.toolUseId,
      decision: request.decision
    })
  }

  /**
   * Hand a typed message to a dwarf's live session.
   *
   * Refusals are explicit and cheap (unknown dwarf, a session already leaving,
   * an empty message, no channel at all) so the panel can explain itself
   * instead of leaving the user wondering whether the text landed. Nothing
   * here logs the message: only its length, the channel and the verdict.
   */
  async sendDwarfText(request: DwarfTextRequest): Promise<DwarfTextResult> {
    const dwarf = this.mines
      .flatMap((mine) => mine.dwarfs)
      .find((item) => item.id === request.dwarfId)
    // A 'leaving' dwarf's agent has already finished: its pid is stale (and
    // could have been reused) and its session name no longer resolves, so
    // there is nothing safe to write to.
    if (dwarf === undefined || dwarf.status === 'leaving') {
      return { delivered: false, via: 'none', error: NO_SUCH_DWARF }
    }

    const text = request.text.trim().slice(0, MAX_DWARF_TEXT_CHARS)
    if (text === '') return { delivered: false, via: 'none', error: EMPTY_MESSAGE }

    const resolved = resolveTextDelivery(request.dwarfId, (id) => this.deliveryTargetOf(id))
    if (resolved === null) {
      // Two different refusals, because they are two different facts (#217).
      // A session this panel launched HAS no inbox — it read one prompt and
      // exits with its turn — and saying "not yet" about it would describe a
      // missing feature rather than the shape the session is. Reachable only
      // by a race, since the composer for such a dwarf is already disabled
      // with the same fact in the panel's own words.
      const launched = this.launched.launchIdOfDwarf(request.dwarfId) !== undefined
      return { delivered: false, via: 'none', error: launched ? NO_LAUNCH_INBOX : NO_CHANNEL }
    }

    const payload = `${resolved.prefix}${text}`
    const endpoint = resolved.endpoint
    const timer = createStageTimer(this.now)
    try {
      // 'total' is everything the caller waited for; the tier below reports the
      // stages only it can see (focus, spawn), and the relay call is timed here
      // because the runtime is what makes it.
      const outcome = await timer.measure('total', () => {
        if (endpoint.kind === 'held-session') {
          // No stage of its own, and none to measure: this is a push onto an
          // in-process queue, not a focus, a spawn or a model turn. It is also
          // why #196's relay floor does not apply to a channel we own.
          //
          // request.pressEnter is dropped for the reason the queue tier drops
          // it: there is no console line here to leave unsent.
          return Promise.resolve(this.sendToHeldSession(endpoint.sessionId, payload))
        }
        if (endpoint.kind === 'hosted-stdin') {
          // No stage of its own, for the reason the held tier has none: a write
          // onto a pipe this process owns is not a focus, a spawn or a model
          // turn. request.pressEnter is dropped because the line terminator is
          // not optional here — a program reading a line is waiting for it, so
          // nodeHostedProcess appends exactly one either way.
          return Promise.resolve(this.sendToHostedProcess(endpoint.hostedId, payload))
        }
        if (endpoint.kind === 'terminal') {
          return this.textDelivery.sendToConsole({
            pid: endpoint.pid,
            text: payload,
            pressEnter: request.pressEnter
          })
        }
        if (endpoint.kind === 'codex-queue') {
          // 'spawn' rather than 'relay': this is a local process submitting one
          // RPC, not a model turn, and the two costs differ by three orders of
          // magnitude — folding them into one stage would make the log line
          // useless for the thing it exists to answer.
          //
          // request.pressEnter is deliberately dropped. A queue item has no
          // console line to leave unsent: the message is either handed over or
          // it is not, exactly as the relay tier already works.
          return timer.measure('spawn', () => this.queueToCodexThread(endpoint.threadId, payload))
        }
        return timer.measure('relay', () =>
          this.textDelivery.relayToClaudeSession({
            sessionName: endpoint.sessionName,
            text: payload
          })
        )
      })
      timer.absorb(outcome.stages)
      console.log(
        `[runtime] Message to ${request.dwarfId} via ${resolved.channel}: ` +
          `${outcome.delivered ? 'delivered' : 'failed'} (${payload.length} chars)` +
          stageSuffix(timer.timings())
      )
      if (outcome.delivered) return { delivered: true, via: resolved.channel }
      // The console attempt failed, but a session with a registry name is
      // also relay-addressable: same payload, second channel (issue #24).
      if (resolved.endpoint.kind === 'terminal' && resolved.endpoint.sessionName !== undefined) {
        return this.relayFallback({
          dwarfId: request.dwarfId,
          attempt: 'message',
          channel: resolved.channel,
          sessionName: resolved.endpoint.sessionName,
          text: payload,
          terminalError: outcome.error
        })
      }
      return { delivered: false, via: resolved.channel, error: outcome.error }
    } catch (error) {
      console.warn(`[runtime] Delivery to ${request.dwarfId} threw`, error)
      return {
        delivered: false,
        via: resolved.channel,
        error: 'The message could not be delivered.'
      }
    }
  }

  /**
   * Which providers the Add Panel may offer, and which of them it may start
   * (#86, over detection's #91).
   *
   * Asked when the panel opens rather than pushed with the board: what is
   * installed on a machine is not board state, and it changes when somebody
   * installs a CLI rather than every two seconds. Detection caches behind its
   * own TTL, so reopening the panel costs a map lookup and not a disk walk.
   *
   * The verdict is shaped by the pure rule in domain/launchProviders, which is
   * also where the reason nothing from the detector's own explanation crosses
   * the wire is written down.
   */
  async listAgentProviders(): Promise<AgentProviderList> {
    const detections = await Promise.all(
      DWARF_PROVIDERS.map((provider) => this.cliDetector.detect(provider))
    )
    return agentProviderList(detections)
  }

  /**
   * Start a new agent session in a mine's folder (#86).
   *
   * **This resolves when the process has been STARTED, not when its dwarf
   * appears.** Nothing is added to the board here: the launched session is
   * discovered by the ordinary poll like every other one, so up to
   * `pollIntervalMs` (2000ms by default) passes before a dwarf shows. The panel
   * therefore has to acknowledge the launch on this verdict alone — waiting for
   * the crew to change would look like nothing happened for two seconds, and
   * inventing a dwarf here would be the second observation path #86 refuses.
   *
   * The request names a mine, never a directory: the folder is read off the
   * board here, so a launch can only ever start in a place the panel is
   * already showing. Refusals are explicit and cheap for the reason
   * sendDwarfText's are, and nothing here logs the prompt — only its length.
   */
  async launchAgent(request: AgentLaunchRequest): Promise<AgentLaunchResult> {
    const mine = this.mines.find((item) => item.id === request.mineId)
    if (mine === undefined) return { launched: false, provider: 'none', error: NO_SUCH_MINE }

    const prompt = prepareLaunchPrompt(request.prompt)
    if (prompt === '') return { launched: false, provider: 'none', error: EMPTY_PROMPT }

    const timer = createStageTimer(this.now)
    try {
      const { retained, ...result } = await timer.measure('total', () =>
        this.launchSession({ provider: request.provider, minePath: mine.path, prompt })
      )
      // Keep hold of what was started, so this app can end what it starts
      // (#217). Decided here rather than behind the launcher because deciding
      // needs the board: which sessions were already on it is what tells the
      // claim below apart from somebody else's session in the same folder.
      // The handle stays in main — `result` is what crosses the wire, and it
      // says a process started and nothing more, exactly as it always has.
      if (retained !== undefined && result.launched) {
        this.launched.retain({
          provider: request.provider,
          minePath: mine.path,
          process: retained,
          knownSessionIds: this.mines.flatMap((item) => item.dwarfs.map((dwarf) => dwarf.sessionId))
        })
      }
      console.log(
        `[runtime] Launch of ${request.provider} in ${mine.id}: ` +
          `${result.launched ? 'started' : 'failed'} ` +
          `(${prompt.length} chars)${stageSuffix(timer.timings())}`
      )
      return result
    } catch (error) {
      console.warn(`[runtime] Launch in ${request.mineId} threw`, error)
      // The provider that was ASKED for, not a favourite: a verdict naming the
      // wrong CLI would have the panel report a failure against a chip nobody
      // pressed (#168).
      return { launched: false, provider: request.provider, error: LAUNCH_FAILED }
    }
  }

  /**
   * Cancel a dwarf's current work (Kick). Mirrors sendDwarfText's refusals and
   * channel routing, but never carries user text: a terminal-hosted session
   * gets a raw interrupt keystroke (ESC), and a relay tier gets one of the two
   * fixed instructions above — this session's own turn, or (through its
   * foreman) a named worker's.
   */
  async kickDwarf(request: DwarfKickRequest): Promise<DwarfKickResult> {
    const dwarf = this.mines
      .flatMap((mine) => mine.dwarfs)
      .find((item) => item.id === request.dwarfId)
    // Same reasoning as sendDwarfText: a 'leaving' dwarf's agent has already
    // finished, so its retained pid/session are stale and there is nothing
    // safe to interrupt.
    if (dwarf === undefined || dwarf.status === 'leaving') {
      return { delivered: false, via: 'none', error: NO_SUCH_DWARF }
    }

    const resolved = resolveKickDelivery(request.dwarfId, (id) => this.deliveryTargetOf(id))
    if (resolved === null) return { delivered: false, via: 'none', error: NO_KICK_CHANNEL }

    const endpoint = resolved.endpoint
    const timer = createStageTimer(this.now)
    try {
      // Note what this does NOT do: there is no harsher second tier here, and
      // no escalation flag to raise. A repeated kick repeats this exact polite
      // interrupt — see the kick escalation policy tests.
      const outcome = await timer.measure('total', () => {
        // The one channel where a kick is a real interrupt of the running turn
        // rather than a keystroke aimed at a window or an instruction a session
        // may decline (#210) — the panel holds this session's own stream.
        //
        // The prefix decides WHICH of the two acts it is, and getting that
        // backwards would cancel the wrong thing: an empty prefix is this
        // session's own turn, so it is interrupted; a non-empty one names a
        // WORKER, and interrupting here would abort the foreman's turn instead
        // of the agent the user pointed at. So a worker's cancel goes onto the
        // stream as the same instruction the relay tier sends, and the session
        // stops the agent it launched.
        if (endpoint.kind === 'held-session') {
          return resolved.prefix === ''
            ? this.interruptHeldSession(endpoint.sessionId)
            : Promise.resolve(
                this.sendToHeldSession(
                  endpoint.sessionId,
                  `${resolved.prefix}${CANCEL_WORKER_INSTRUCTION}`
                )
              )
        }
        // The one tier that ends the session rather than the turn it is in
        // (#217). Reached only where nothing weaker exists — see
        // deliveryTargetOf, which offers it last — and a worker's cancel never
        // arrives here at all, because ending a launched process would end its
        // foreman's whole session (resolveKickDelivery refuses that).
        if (endpoint.kind === 'launched-process') {
          return this.endLaunchedSession(endpoint.launchId)
        }
        // The other tier that ends rather than interrupts (#194). No prefix
        // branch beside it, unlike the held tier above: a hosted process has no
        // crew for a prefix to name — nothing observes children for it — so a
        // worker's cancel can never resolve here.
        if (endpoint.kind === 'hosted-stdin') {
          return this.endHostedProcess(endpoint.hostedId)
        }
        if (endpoint.kind === 'terminal') {
          return this.textDelivery.sendInterrupt({ pid: endpoint.pid })
        }
        return timer.measure('relay', () =>
          this.textDelivery.relayToClaudeSession({
            sessionName: endpoint.sessionName,
            text:
              resolved.prefix === ''
                ? CANCEL_INSTRUCTION
                : `${resolved.prefix}${CANCEL_WORKER_INSTRUCTION}`
          })
        )
      })
      timer.absorb(outcome.stages)
      console.log(
        `[runtime] Kick for ${request.dwarfId} via ${resolved.channel}: ` +
          `${outcome.delivered ? 'delivered' : 'failed'}${stageSuffix(timer.timings())}`
      )
      if (outcome.delivered) return { delivered: true, via: resolved.channel }
      // Same fallback as sendDwarfText, carrying the exact instruction the
      // relay tier already uses — a kick has no user text, only this message.
      // A 'held-session' endpoint carries no relay name and must not borrow
      // one: the failure is stated instead (#210). See the endpoint's own doc.
      if (resolved.endpoint.kind === 'terminal' && resolved.endpoint.sessionName !== undefined) {
        return this.relayFallback({
          dwarfId: request.dwarfId,
          attempt: 'kick',
          channel: resolved.channel,
          sessionName: resolved.endpoint.sessionName,
          text:
            resolved.prefix === ''
              ? CANCEL_INSTRUCTION
              : `${resolved.prefix}${CANCEL_WORKER_INSTRUCTION}`,
          terminalError: outcome.error
        })
      }
      return { delivered: false, via: resolved.channel, error: outcome.error }
    } catch (error) {
      console.warn(`[runtime] Kick for ${request.dwarfId} threw`, error)
      return {
        delivered: false,
        via: resolved.channel,
        error: 'The kick could not be delivered.'
      }
    }
  }

  /**
   * Retire a dwarf whose agent the panel WATCHED stop after a kick (issue #46).
   *
   * The trigger is deliberately the observed reaction and never the delivered
   * verdict: `delivered` only means the interrupt reached the session's queue,
   * and a dwarf removed on that would show an agent as gone while it is still
   * burning tokens. A kick nobody saw land removes nothing — the dwarf stays
   * until a provider rule ends it, because a ghost beats a lie.
   *
   * Fire-and-forget on purpose. The departure reaches the panel through the
   * next ordinary poll, so the renderer renders what main decided rather than
   * a removal it performed on its own authority.
   */
  retireDwarf(dwarfId: string): void {
    console.log(`[runtime] Retiring ${dwarfId}: its agent was seen stopping after a kick.`)
    this.lifecycle.retire(dwarfId)
  }

  /**
   * The last few messages of one dwarf's own transcript (#159).
   *
   * The same bounded tail `activateDwarf` falls back to, reached without the
   * two attempts in front of it: the message panel wants an observed session's
   * words whether or not its window could be focused, and a read that first
   * tried to raise a terminal would be an activation wearing a different name.
   *
   * Every failure answers `readable: false` rather than throwing, and that is
   * a different statement from an empty list: it means this session keeps
   * nothing this app can read, so the panel says so instead of drawing a
   * session that has never spoken.
   */
  async dwarfFeed(dwarfId: string): Promise<DwarfFeedResult> {
    const board = this.mines.flatMap((mine) => mine.dwarfs)
    const dwarf = board.find((item) => item.id === dwarfId)
    if (dwarf === undefined) return unreadableFeed()
    const provider = this.providers.find((item) => item.kind === dwarf.provider)
    if (provider === undefined) return unreadableFeed()
    try {
      const messages = await provider.feed(dwarfId, FEED_LIMIT)
      if (messages === null) return unreadableFeed()
      // WHO issued the user half of it (#175). A provider reads one transcript
      // and cannot see the tree the dwarf sits in; the board can, and the
      // launcher is a dwarf on it. Only ever ADDS a name — a dwarf whose
      // launcher the board cannot prove comes back exactly as the provider
      // read it, which is every session root and therefore every prompt a
      // human actually typed.
      return {
        readable: true,
        messages: attributeIssuedMessages(messages, launchingAgentOf(dwarf, board))
      }
    } catch (error) {
      console.warn(`[runtime] Failed to read feed for ${dwarfId}`, error)
      return unreadableFeed()
    }
  }

  /**
   * Every dwarf that has spoken in one mine, with its latest messages (#192).
   *
   * Resolved by MINE ID against the board, never by a path the renderer
   * names: the folder is the one the panel is already being shown for, so this
   * channel cannot be talked into reading transcripts for a folder it is not.
   * A mine the board does not hold, and a read that fails, both answer
   * `readable: false` rather than an empty list — the panel says "nobody has
   * spoken here yet" only about a folder it actually read.
   */
  async mineHistory(mineId: string): Promise<MineHistoryResult> {
    const mine = this.mines.find((item) => item.id === mineId)
    if (mine === undefined) return unreadableHistory()
    try {
      return { readable: true, speakers: await this.history.read(mine.path) }
    } catch (error) {
      console.warn(`[runtime] Failed to read the history of ${mineId}`, error)
      return unreadableHistory()
    }
  }

  async activateDwarf(dwarfId: string): Promise<DwarfActivation> {
    const dwarf = this.mines.flatMap((mine) => mine.dwarfs).find((item) => item.id === dwarfId)
    if (dwarf === undefined) return { focused: false, openedTerminal: false, feed: [] }

    // A 'leaving' dwarf's agent has already finished/disappeared: its
    // retained pid is stale, and on a long-running machine could even have
    // been reused by an unrelated process. There is nothing to focus, so
    // skip straight to the terminal/feed fallbacks below (which still read
    // from disk and work fine for as long as the dwarf stays in its grace
    // period) instead of risking a focus on the wrong window.
    if (dwarf.pid !== undefined && dwarf.status !== 'leaving') {
      try {
        if (await this.focus(dwarf.pid)) {
          return { focused: true, openedTerminal: false, feed: [] }
        }
      } catch (error) {
        console.warn(`[runtime] Failed to focus dwarf ${dwarfId}`, error)
      }
    }

    const provider = this.providers.find((item) => item.kind === dwarf.provider)
    if (provider === undefined) return { focused: false, openedTerminal: false, feed: [] }

    // No window to focus (or focusing it failed) — try opening a new terminal
    // tailing the transcript live before falling back to the static feed.
    const transcriptPath = provider.transcriptPath?.(dwarfId)
    if (transcriptPath !== undefined) {
      try {
        if (await this.launchTerminal(dwarf.name, transcriptPath)) {
          return { focused: false, openedTerminal: true, feed: [] }
        }
      } catch (error) {
        console.warn(`[runtime] Failed to open a terminal for ${dwarfId}`, error)
      }
    }

    try {
      return {
        focused: false,
        openedTerminal: false,
        feed: (await provider.feed(dwarfId, FEED_LIMIT)) ?? []
      }
    } catch (error) {
      console.warn(`[runtime] Failed to read feed for ${dwarfId}`, error)
      return { focused: false, openedTerminal: false, feed: [] }
    }
  }
}
