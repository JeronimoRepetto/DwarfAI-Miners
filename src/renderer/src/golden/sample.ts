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
  type PanelEdge,
  MATERIALS,
  MATERIAL_TOKENS_PER_UNIT,
  MINE_TIERS,
  type Dwarf,
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
  type MineTier
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
  /** The messages the sample marks failed, as the app records a send: by mine id, then dwarf id. */
  failedSends: Record<string, Record<string, FailedSend[]>>
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

// An asking dwarf's questions, as the app carries an ask it can see: the sample writes each as its
// text and its option labels.
function pendingQuestion(row: Row): Pick<Dwarf, 'pendingQuestion'> {
  if (!Array.isArray(row.question)) return {}
  return {
    pendingQuestion: {
      toolUseId: String(row.id),
      channel: 'terminal',
      questions: (row.question as Row[]).map((q) => ({
        question: String(q.text),
        multiSelect: false,
        options: ((q.options ?? []) as unknown[]).map((label) => ({ label: String(label) }))
      }))
    }
  }
}

// The sample's status words: working, asking (for an answer, or for a permission when `need`
// says so) and asleep, a session at rest with nobody asked anything. A permission is the app's
// approval wait, not a question, so only an answer's ask carries the questions.
function status(row: Row): Pick<Dwarf, 'status' | 'waitingReason' | 'pendingQuestion'> {
  switch (row.status) {
    case 'working':
      return { status: 'working' }
    case 'asking':
      return row.need === 'permission'
        ? { status: 'waiting', waitingReason: 'approval' }
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
      typeof row.worktree === 'string' ? { path: mine.path, branch: row.worktree } : undefined
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

// A step's verb names its kind, as the app's own activity lines spell them ("Read a.ts"). A step
// no kind names ("Drafted a migration") is drawn as a plain step with nothing to open, which is
// what a run draws.
const STEP_KIND: Record<string, FeedActivityKind> = {
  Read: 'read',
  Edited: 'edit',
  Ran: 'run',
  Searched: 'search'
}

// The sample writes a message's clock time ("09:07"); the day is arbitrary and local, as the panel's.
function at(time: unknown): number {
  const m = /^(\d{2}):(\d{2})$/.exec(String(time))
  if (!m) return fail('time', time)
  return new Date(2026, 8, 27, Number(m[1]), Number(m[2])).getTime()
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

/** Adapts `window.DM` after the design's sample-data.js has run. */
export function adaptSample(dm: unknown): GoldenSample {
  const data = (dm as { data?: Row } | undefined)?.data
  if (!data || typeof data !== 'object') {
    throw new Error('golden sample: window.DM.data is missing; the sample script did not run')
  }
  const config = (data.config ?? {}) as Row
  const mines = ((data.mines ?? []) as Row[]).map(mine)
  const byId = new Map(mines.map((m) => [m.id, m]))
  const failedSends: Record<string, Record<string, FailedSend[]>> = {}
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
    if (failed.length > 0) (failedSends[home.id] ??= {})[adapted.id] = failed
  }
  const floor = (dm as { TIER_FLOOR?: Record<string, unknown> }).TIER_FLOOR
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
    failedSends,
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
