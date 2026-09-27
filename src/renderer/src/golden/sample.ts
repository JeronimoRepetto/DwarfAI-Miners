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
  MATERIALS,
  MATERIAL_TOKENS_PER_UNIT,
  MINE_TIERS,
  type Dwarf,
  type DwarfProvider,
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
  mines: Mine[]
  /**
   * The sample's own illustrative tier floors (`DM.TIER_FLOOR`), in the app's threshold shape, for
   * the explainer a golden draws from the sample; absent when the sample carries none.
   */
  tierThresholds?: TierThresholds
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

/** Adapts `window.DM` after the design's sample-data.js has run. */
export function adaptSample(dm: unknown): GoldenSample {
  const data = (dm as { data?: Row } | undefined)?.data
  if (!data || typeof data !== 'object') {
    throw new Error('golden sample: window.DM.data is missing; the sample script did not run')
  }
  const config = (data.config ?? {}) as Row
  const mines = ((data.mines ?? []) as Row[]).map(mine)
  const byId = new Map(mines.map((m) => [m.id, m]))
  for (const row of (data.dwarfs ?? []) as Row[]) {
    const home = byId.get(String(row.mine)) ?? fail('mine', row.mine)
    home.dwarfs.push(dwarf(row, home))
  }
  const floor = (dm as { TIER_FLOOR?: Record<string, unknown> }).TIER_FLOOR
  return {
    config: {
      shortcutFailed: config.shortcutFailed === true,
      guildEnabled: config.guildEnabled === true
    },
    mines,
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
