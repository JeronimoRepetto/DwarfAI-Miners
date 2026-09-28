/*
 * The design's sample data, adapted to the app's own contract types for the golden UI tests
 * (#634). The data itself never enters this repository (PO ruling G-03, 2026-09-26): the golden
 * page runs the design repository's `prototype/data/sample-data.js`, a classic script that fills
 * `window.DM.data`, and hands the result here. Only the mapping lives in the app.
 *
 * Every word the sample uses is mapped to the app's own, and a word the app has no mapping for
 * throws naming it: a golden rendered from a value the adapter silently dropped would grade a state
 * nobody asked for, and the throw is how a change to the design's sample shows up.
 */
import {
  DWARF_PROVIDERS,
  type AgentModelCatalog,
  type AgentProviderOption,
  type LaunchView,
  SHELL_AREAS,
  type ShellArea,
  type PanelEdge,
  MATERIALS,
  MATERIAL_TOKENS_PER_UNIT,
  MINE_TIERS,
  type Dwarf,
  type DwarfFeedResult,
  type DwarfPermissionRequest,
  type DwarfProvider,
  type FailedSend,
  type FeedActivityKind,
  type FeedMessage,
  type MineHistoryResult,
  type MineHistorySpeaker,
  type DwarfRole,
  type Material,
  type MaterialTotals,
  type Mine,
  type MineTier,
  type ProjectSummary
} from '../types'
import type { TierThresholds } from '../lib/browse/tierInfo'
import { MAP_SPAWN_POINTS } from '../lib/map/spawnPoints.generated'

/** The configuration flags a staged state reads; the sample's config has more. */
export interface SampleConfig {
  shortcutFailed: boolean
  guildEnabled: boolean
}

export interface GoldenSample {
  config: SampleConfig
  /** The installed version the sample's About prints (#635). */
  version?: string
  /** The screen edge the sample's panel docks to. */
  edge: PanelEdge
  /** The sample's providers, each launchable, in its order, for the default launch (#635). */
  providers: AgentProviderOption[]
  /** What each of those providers answers it can start on. */
  catalogs: AgentModelCatalog[]
  mines: Mine[]
  /**
   * The sample's own illustrative tier floors (`DM.TIER_FLOOR`), in the app's threshold shape, for
   * the explainer a golden draws from the sample; absent when the sample carries none.
   */
  tierThresholds?: TierThresholds
  /** Each mine's history, by mine id, as its dwarfs' transcripts would give it (#635). */
  histories: Record<string, MineHistoryResult>
  /**
   * Each dwarf's conversation as the feed main answers for it (#635, the MessagePanel slice), by
   * dwarf id: the messages its history speaker carries, and an empty readable feed for a dwarf with
   * nothing said.
   */
  feeds: Record<string, DwarfFeedResult>
  /** The messages the sample marks failed, as the app records a send: by mine id, then dwarf id. */
  failedSends: Record<string, Record<string, FailedSend[]>>
  /**
   * The sample's mines as the remembered projects a browse answers (#635, full-screen goldens),
   * in the sample's order: the full App draws its Mines page from these, not from a kit tree.
   */
  projects: ProjectSummary[]
  /**
   * The view the sample remembers the app last closed on (`DM.data.launch`, #635, PANEL-QUESTIONS
   * 25), as main would have stored it; absent when it remembers nothing, as the first-run sample
   * does. The mine is the sample's claim, never checked here: a remembered mine the board no longer
   * carries is the app's to let go of, exactly as a stored one is.
   */
  launch?: LaunchView
  /**
   * The sample's long permission request (`DM.data.longPermissionRequest`, #635), which the
   * question card's Long request state draws for its six-line cap; absent when it carries none.
   */
  longPermissionRequest?: DwarfPermissionRequest
}

type Row = Record<string, unknown>

const ROLES: readonly DwarfRole[] = ['foreman', 'worker', 'worker2']
const SILENCE_UNIT_MS: Record<'s' | 'm' | 'h', number> = { s: 1_000, m: 60_000, h: 3_600_000 }

function fail(what: string, value: unknown): never {
  throw new Error('golden sample: the app has no mapping for ' + what + ' ' + JSON.stringify(value))
}

function oneOf<T extends string>(what: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  return fail(what, value)
}

/** The sample writes a dwarf's silence as "12s", "6m" or "2h". */
export function silenceMs(text: string): number {
  const m = /^(\d+)([smh])$/.exec(text)
  if (!m) return fail('silence', text)
  return Number(m[1]) * SILENCE_UNIT_MS[m[2] as 's' | 'm' | 'h']
}

// Ore is counted in drawn units per material; the wire carries tokens per material. Each
// material goes through its own grain size, and nothing is summed across them.
function materials(ore: unknown): MaterialTotals {
  const totals = Object.fromEntries(MATERIALS.map((m) => [m, 0])) as MaterialTotals
  for (const [name, units] of Object.entries((ore ?? {}) as Row)) {
    const material = oneOf<Material>('material', name, MATERIALS)
    totals[material] = Number(units) * MATERIAL_TOKENS_PER_UNIT[material]
  }
  return totals
}

/*
 * An asking dwarf's questions, as the app carries an ask it can see: the sample writes each as its
 * text and its option labels. On the held channel (#635, the question card slice): the sample's
 * asks are ones the card answers, and the held channel is the one on which every question of a
 * walk is answerable — a several-question ask at a terminal is one the app can only show.
 */
function pendingQuestion(row: Row): Pick<Dwarf, 'pendingQuestion'> {
  if (!Array.isArray(row.question)) return {}
  return {
    pendingQuestion: {
      toolUseId: String(row.id),
      channel: 'held',
      questions: (row.question as Row[]).map((q) => ({
        question: String(q.text),
        multiSelect: false,
        // The agent's own description of an option, by option index, only where it sent one
        // (#635, decision log, Question option description).
        options: ((q.options ?? []) as unknown[]).map((label, k) => {
          const description = ((q.descriptions ?? []) as unknown[])[k]
          return typeof description === 'string'
            ? { label: String(label), description }
            : { label: String(label) }
        })
      }))
    }
  }
}

/*
 * A permission's request as the app carries it (#635, the question card slice). The sample writes
 * one line, "Bash · pnpm install in …", which is the card's request block exactly as the app
 * composes it from the tool's name and its input (permissionRequestText); so the tool is what
 * stands before the first " · " and the input is the rest, with no title or description, which the
 * sample never writes. The clock is the golden's own: nothing draws it.
 */
export function permissionOf(id: string, step: unknown): DwarfPermissionRequest {
  const text = String((step as Row | undefined)?.text)
  const at = text.indexOf(' · ')
  if (at <= 0) return fail('request', text)
  return {
    toolUseId: id,
    toolName: text.slice(0, at),
    input: text.slice(at + ' · '.length),
    channel: 'held',
    askedAt: '2026-09-28T09:00:00.000Z'
  }
}

// The sample's status words: working, asking (for an answer, or for a permission when `need`
// says so) and asleep, a session at rest with nobody asked anything. A permission is the app's
// approval wait, not a question: its one step is the request its pending permission carries.
function status(
  row: Row
): Pick<Dwarf, 'status' | 'waitingReason' | 'pendingQuestion' | 'pendingPermission'> {
  switch (row.status) {
    case 'working':
      return { status: 'working' }
    case 'asking':
      return row.need === 'permission'
        ? {
            status: 'waiting',
            waitingReason: 'approval',
            ...(Array.isArray(row.question)
              ? { pendingPermission: permissionOf(String(row.id), row.question[0]) }
              : {})
          }
        : { status: 'waiting', waitingReason: 'user-input', ...pendingQuestion(row) }
    case 'asleep':
      return { status: 'waiting' }
    default:
      return fail('status', row.status)
  }
}

function dwarf(row: Row, mine: Mine): Dwarf {
  // The sample writes the provider's label ("Claude"); the wire carries its id ("claude").
  const id = typeof row.provider === 'string' ? row.provider.toLowerCase() : ''
  const provider = (DWARF_PROVIDERS as readonly string[]).includes(id)
    ? (id as DwarfProvider)
    : fail('provider', row.provider)
  return {
    id: String(row.id),
    sessionId: String(row.id),
    name: String(row.name),
    provider,
    role: oneOf('role', row.role, ROLES),
    model: row.model === undefined ? undefined : String(row.model),
    effort: row.effort === undefined ? undefined : String(row.effort),
    ...status(row),
    silentForMs: typeof row.silence === 'string' ? silenceMs(row.silence) : undefined,
    workplace:
      typeof row.worktree === 'string' ? { path: mine.path, branch: row.worktree } : undefined,
    // The prototype's chat takes words and a file from every dwarf and stops any of them (#635):
    // each is a session on the console channel the app's terminal-held sessions use.
    textDelivery: 'terminal',
    capabilities: {
      sendText: 'terminal',
      cancel: 'terminal',
      adjustEffort: null,
      attach: 'terminal'
    }
  }
}

// The sample's site is one of the product's measured spawn points, named by its image percent.
function mapSite(site: unknown): Pick<Mine, 'mapSite'> {
  if (site === undefined) return {}
  const { x, y } = site as { x?: unknown; y?: unknown }
  const point = MAP_SPAWN_POINTS.find((p) => p.x === x && p.y === y)
  return point ? { mapSite: point.id } : fail('site', site)
}

function mine(row: Row): Mine {
  return {
    id: String(row.id),
    path: String(row.id),
    name: String(row.name),
    tier: oneOf<MineTier>('tier', row.tier, MINE_TIERS),
    dwarfs: [],
    tokensObserved: 0,
    materials: materials(row.ore),
    updatedAt: 0,
    unrecorded: row.state === 'unrecorded' ? true : undefined,
    ...mapSite(row.site)
  }
}

/*
 * A mine as the project a browse remembers (#635, full-screen goldens). The sample's score is its
 * weight in kilobytes, the unit its own tier floors are written in, and the wire carries bytes. A
 * mine being measured has no weight yet, which is how the app knows one; it keeps its earlier
 * reading's tier unless the sample marks it `measured: false`, a mine no walk has ever read
 * (PANEL-QUESTIONS 29). A mine not recorded yet has no ledger row, so no ore; one the sample
 * cannot enter has lost its folder, the one reason the app has. recentMines lists the last opened
 * first, a minute apart.
 */
function project(row: Row, mine: Mine, recent: readonly string[]): ProjectSummary {
  const measuring = row.state === 'measuring'
  const measuredBefore = row.measured !== false
  const opened = recent.indexOf(mine.id)
  return {
    id: mine.id,
    path: mine.path,
    name: mine.name,
    declared: true,
    ...(measuredBefore ? { knownTier: mine.tier } : {}),
    ...(measuring ? {} : { weightBytes: Number(row.score ?? 0) * 1024 }),
    addedAt: 0,
    ...(opened < 0 ? {} : { lastOpenedAt: at('09:00') - opened * 60_000 }),
    ...(row.state === 'unrecorded' ? {} : { materials: mine.materials }),
    ...(mine.mapSite === undefined ? {} : { mapSite: mine.mapSite }),
    live: true,
    ...(row.state === 'unenterable' ? { folderMissing: true as const } : {})
  }
}

// A step's verb names its kind, as the app's own activity lines spell them ("Read a.ts"). A step
// no kind names ("Drafted a migration") is drawn as a plain step with nothing to open, which is
// what a run draws.
const STEP_KIND: Record<string, FeedActivityKind> = {
  Read: 'read',
  Edited: 'edit',
  Ran: 'run',
  Searched: 'search'
}

/*
 * The sample writes a message's clock time ("09:07") on the day the page is on, as the prototype's
 * conversation is always today (its day divider reads TODAY). The capture runtime fixes the page's
 * clock, so the day is the same in every run. AMENDED for #635, the MessagePanel slice (was: a
 * fixed arbitrary day, which the history never showed and the MessagePanel's divider does).
 */
function at(time: unknown): number {
  const m = /^(\d{2}):(\d{2})$/.exec(String(time))
  if (!m) return fail('time', time)
  const today = new Date()
  return new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    Number(m[1]),
    Number(m[2])
  ).getTime()
}

/*
 * One dwarf's conversation as its transcript would carry it: the person's words and the dwarf's,
 * and each step as one activity row by its verb. A message the sample marks failed never reached
 * the session, so no transcript holds it; the marks the panel draws are its own reading.
 */
function speakerOf(
  row: Row,
  dwarf: Dwarf,
  failedOut: FailedSend[] = []
): MineHistorySpeaker | undefined {
  const messages: FeedMessage[] = []
  let last = 0
  let stepAt = 0
  for (const entry of (row.conversation ?? []) as Row[]) {
    if (entry.from === 'activity') {
      for (const step of (entry.steps ?? []) as string[]) {
        const verb = step.split(' ')[0] ?? ''
        const kind = STEP_KIND[verb] ?? 'run'
        const target = step.slice(verb.length + 1).replace(/^for /, '')
        messages.push({
          role: 'assistant',
          text: step,
          timestamp: new Date(stepAt).toISOString(),
          activity: { kind, target }
        })
      }
      continue
    }
    if (entry.mark === 'failed') {
      failedOut.push({ text: String(entry.md), sentAt: at(entry.time) })
      continue
    }
    const time = at(entry.time)
    stepAt = time
    last = Math.max(last, time)
    const role =
      entry.from === 'user'
        ? 'user'
        : entry.from === 'dwarf'
          ? 'assistant'
          : fail('from', entry.from)
    messages.push({ role, text: String(entry.md), timestamp: new Date(time).toISOString() })
  }
  if (messages.length === 0) return undefined
  return {
    id: dwarf.id,
    provider: dwarf.provider as DwarfProvider,
    role: dwarf.role,
    name: dwarf.name,
    lastMessageAt: last,
    messages
  }
}

// The sample writes the remembered view as `{ page, mine }`, a page by the nav's own area names.
function launchOf(row: unknown): LaunchView | undefined {
  if (row === null || row === undefined) return undefined
  const launch = row as Row
  return {
    area: oneOf<ShellArea>('page', launch.page, SHELL_AREAS),
    mineId: launch.mine === null || launch.mine === undefined ? null : String(launch.mine)
  }
}

/**
 * The sample a prototype control swapped in under a running app (#635): the panel page's First run
 * switch. It swaps the data and relaunches nothing (panel.js: the page shown stays, and the mine
 * column is dropped because its mine is gone), so the view the screen opened with is still the one
 * the app restored: the launch is the booted sample's, never the swapped one's. The references
 * confirm the reading: panel#mines-first-run opens on the Mines page with no mine in the column, and
 * both first-run full screens match theirs at 0.000% once the hidden mode lever is stood in.
 */
export function swapSample(booted: GoldenSample, swapped: GoldenSample): GoldenSample {
  const next: GoldenSample = { ...swapped }
  delete next.launch
  if (booted.launch !== undefined) next.launch = booted.launch
  return next
}

/** Adapts `window.DM` after the design's sample-data.js has run. */
export function adaptSample(dm: unknown): GoldenSample {
  const data = (dm as { data?: Row } | undefined)?.data
  if (!data || typeof data !== 'object') {
    throw new Error('golden sample: window.DM.data is missing; the sample script did not run')
  }
  const config = (data.config ?? {}) as Row
  const mineRows = (data.mines ?? []) as Row[]
  const mines = mineRows.map(mine)
  const recent = ((data.recentMines ?? []) as unknown[]).map(String)
  const byId = new Map(mines.map((m) => [m.id, m]))
  const failedSends: Record<string, Record<string, FailedSend[]>> = {}
  const feeds: Record<string, DwarfFeedResult> = {}
  const histories: Record<string, MineHistoryResult> = Object.fromEntries(
    mines.map((m) => [m.id, { readable: true, speakers: [] as MineHistorySpeaker[] }])
  )
  for (const row of (data.dwarfs ?? []) as Row[]) {
    const home = byId.get(String(row.mine)) ?? fail('mine', row.mine)
    const adapted = dwarf(row, home)
    home.dwarfs.push(adapted)
    const failed: FailedSend[] = []
    const speaker = speakerOf(row, adapted, failed)
    if (speaker) histories[home.id]!.speakers.push(speaker)
    feeds[adapted.id] = { readable: true, messages: speaker?.messages ?? [] }
    if (failed.length > 0) (failedSends[home.id] ??= {})[adapted.id] = failed
  }
  const floor = (dm as { TIER_FLOOR?: Record<string, unknown> }).TIER_FLOOR
  const launch = launchOf(data.launch)
  const providers = ((data.providers ?? []) as Row[]).map((row) =>
    oneOf<DwarfProvider>('provider', row.id, DWARF_PROVIDERS)
  )
  return {
    config: {
      shortcutFailed: config.shortcutFailed === true,
      guildEnabled: config.guildEnabled === true
    },
    ...(typeof config.version === 'string' ? { version: config.version } : {}),
    edge:
      config.dock === undefined
        ? 'right'
        : oneOf<PanelEdge>('dock', config.dock, ['left', 'right']),
    providers: providers.map((provider) => ({ provider, installed: true, launchable: true })),
    catalogs: ((data.providers ?? []) as Row[]).map((row, i) => ({
      provider: providers[i]!,
      models: ((row.models ?? []) as unknown[]).map((value) => ({ value: String(value) })),
      efforts: ((row.efforts ?? []) as unknown[]).map(String),
      source: 'provider' as const
    })),
    mines,
    histories,
    feeds,
    failedSends,
    projects: mineRows.map((row, i) => project(row, mines[i]!, recent)),
    ...(launch === undefined ? {} : { launch }),
    ...(Array.isArray(data.longPermissionRequest)
      ? {
          longPermissionRequest: permissionOf(
            'longPermissionRequest',
            data.longPermissionRequest[0]
          )
        }
      : {}),
    ...(floor === undefined
      ? {}
      : {
          tierThresholds: {
            copperKb: Number(floor.copper),
            silverKb: Number(floor.silver),
            goldKb: Number(floor.gold),
            uraniumKb: Number(floor.uranium)
          }
        })
  }
}
