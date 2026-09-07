import type { SimulationConfig } from '../../config/config'
import type {
  Dwarf,
  DwarfProvider,
  DwarfStatus,
  MineTier,
  ProviderSnapshot
} from '../../domain/types'
import { hashInt, hashPick, hashString } from './rng'

/**
 * The invented valley (issue #42): pure functions from a seed and a tick number
 * to exactly the snapshots a real provider would have returned.
 *
 * Everything here is pure and clock-free. The provider that wraps it owns the
 * clock and turns it into a `tick`; this module owns only "what does the world
 * look like at tick N". That split is what makes a reported layout bug
 * reproducible: a seed and a tick number is the whole bug report.
 *
 * Two shapes of determinism live here, and the difference matters.
 *
 * Hash-derived choices (names, shifts, chatter) are the ordinary kind: spread
 * out, seed-dependent, and free to differ between runs with different seeds.
 *
 * The interesting limits, though, are deliberately NOT left to a hash. Tier
 * spread is round-robin and the showcase mine's crew is a fixed pattern,
 * because a simulation whose overcrowding depends on a lucky seed proves
 * nothing on the unlucky ones. Every documented limit this exists to exercise
 * is reached at EVERY seed, or it is not being exercised at all.
 */

/**
 * The mine whose crew is always full and always crowded.
 *
 * Ordinary mines churn — dwarfs arrive and leave, crews thin out — which is
 * exactly what the lifecycle grace window needs and exactly what makes a
 * guarantee impossible. So one mine is exempt: it holds the full configured
 * crew at every tick, arranged so that its workers outnumber the cave's veins,
 * its resting dwarfs outnumber the rest spots, and somebody is always at the
 * exit. The crowded-anchor paths of #19 and #43 are therefore on screen from
 * the first frame of every run, at every seed.
 */
export const SHOWCASE_MINE_INDEX = 0

/**
 * The showcase mine's worker statuses, one full turn of the cycle.
 *
 * Its length is deliberately the default worker count (maxCrew 12 minus the
 * foreman), which makes rotating it by the tick a PERMUTATION: individual
 * dwarfs change status every tick — so walk transitions and the grace window
 * are exercised — while the counts stay exactly 6 working, 3 waiting and 2
 * leaving. Against 4 veins, 2 rest spots and 1 exit, every anchor pool in
 * `sceneLayout.ts` is oversubscribed at every tick.
 */
const SHOWCASE_STATUS_CYCLE: readonly DwarfStatus[] = [
  'working',
  'working',
  'waiting',
  'working',
  'leaving',
  'working',
  'waiting',
  'working',
  'working',
  'waiting',
  'leaving'
]

/**
 * Ordinary mines' worker statuses. Weighted towards working, because a valley
 * where half the crew is idle reads as broken rather than as busy.
 */
const STATUS_CYCLE: readonly DwarfStatus[] = [
  'working',
  'working',
  'working',
  'waiting',
  'working',
  'waiting',
  'working',
  'leaving'
]

/** Ticks in one shift cycle: how long an ordinary dwarf's comings and goings take to repeat. */
const SHIFT_CYCLE_TICKS = 12

/** The shortest shift, in ticks. Below this a dwarf would flicker rather than visit. */
const MIN_SHIFT_TICKS = 3

/** Smallest crew an ordinary mine may hold, as a fraction of the configured maximum. */
const MIN_CREW_FRACTION = 0.5

/*
 * Name parts. Combined they give 80 distinct valley names, comfortably more
 * than the 60-mine cap in config.ts, so a run never has to fall back on a
 * numeric suffix to keep names unique.
 */
const MINE_ADJECTIVES = [
  'Iron',
  'Ember',
  'Frost',
  'Deep',
  'Copper',
  'Hollow',
  'Storm',
  'Amber',
  'Grim',
  'Silver'
] as const

const MINE_NOUNS = [
  'vein',
  'reach',
  'delve',
  'hollow',
  'shaft',
  'barrow',
  'gate',
  'quarry'
] as const

const DWARF_NAMES = [
  'Brann',
  'Dorin',
  'Grimla',
  'Halvar',
  'Ketil',
  'Mordi',
  'Nalla',
  'Orik',
  'Rurik',
  'Sigrun',
  'Thrain',
  'Ulfa',
  'Vigdis',
  'Yorin',
  'Balin',
  'Freya'
] as const

const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku'] as const
const CODEX_MODELS = ['gpt-5-codex', 'gpt-5'] as const
const EFFORTS = ['low', 'medium', 'high'] as const

/** Flavour chatter, rotated by tick so speech bubbles actually fire (#43). */
const CHATTER = [
  'Cutting a fresh gallery along the east seam.',
  'Timbering the roof before we go deeper.',
  'This rock is harder than the survey promised.',
  'Hauling the last cart up to the sorting floor.',
  'Waiting on the foreman before I break through.',
  'Found a pocket of ore behind the old face.',
  'Resetting the lantern line, it keeps guttering.',
  'Almost through — one more pass should do it.'
] as const

/** One invented project: a place on the map, with a tier that never changes. */
export interface SimulatedMine {
  index: number
  path: string
  name: string
  tier: MineTier
}

/**
 * Every mine in the valley. Tick-independent on purpose: mines are places, and
 * a place that changed tier or name between two polls would look to the vault
 * like a project being re-measured and to the map like a mound teleporting.
 */
export function simulatedMines(config: SimulationConfig): SimulatedMine[] {
  const names = valleyNames(config.seed, config.mines)
  return names.map((name, index) => ({
    index,
    // Visibly not a real checkout. Anyone who sees this path in a log or a
    // tooltip should know at a glance that none of it happened.
    path: `/simulated-valley/${name}`,
    name,
    // Round-robin, NOT hashed: with five tiers over twenty mines a hash would
    // quite often leave one tier unrepresented, and a tier spread nobody can
    // see is a tier spread that tests nothing.
    tier: config.tiers[index % config.tiers.length] as MineTier
  }))
}

/**
 * The whole valley at one tick, in the exact shape the real providers report.
 *
 * `nowMs` is the wall clock only for `updatedAt`. Everything else comes from
 * the tick, so two runs at the same tick differ in nothing but that timestamp —
 * which is precisely how a real, quiet provider behaves between turns.
 */
export function simulatedSnapshots(
  config: SimulationConfig,
  mines: readonly SimulatedMine[],
  tick: number,
  nowMs: number
): ProviderSnapshot[] {
  // The crew is frozen at tick 0 when animation is off, while tokens and
  // chatter keep following the real tick: a still layout, not a dead panel.
  const crewTick = config.animate ? tick : 0
  return mines.map((mine) => {
    const dwarfs = crewOf(config, mine, crewTick, tick)
    return {
      // One of the two real provider identities; see SimulatedProvider.kind.
      provider: 'claude',
      sessionId: `sim-session-${mine.index}`,
      cwd: mine.path,
      status: dwarfs.some((dwarf) => dwarf.status === 'working') ? 'busy' : 'idle',
      dwarfs,
      // Staggered a little per mine so the map's recency ordering is stable and
      // meaningful rather than a twenty-way tie broken by array order.
      updatedAt: nowMs - hashInt(`${config.seed}:${mine.index}:recency`, 120_000)
    }
  })
}

/** How many dwarfs this mine's roster holds, foreman included. */
function rosterSize(config: SimulationConfig, mine: SimulatedMine): number {
  if (mine.index === SHOWCASE_MINE_INDEX) return config.maxCrew
  const min = Math.max(1, Math.ceil(config.maxCrew * MIN_CREW_FRACTION))
  return min + hashInt(`${config.seed}:${mine.index}:roster`, config.maxCrew - min + 1)
}

/**
 * Whether an ordinary dwarf is on shift at this tick.
 *
 * A dwarf leaving the roster is how the runtime's grace window gets exercised
 * for real: it disappears from the scan, the lifecycle tracker holds it as
 * 'leaving' for dwarfLeaveGraceS, and the renderer walks it to the exit. Faking
 * a 'leaving' status would skip the very code the simulation exists to drive.
 */
function onShift(
  config: SimulationConfig,
  mine: SimulatedMine,
  index: number,
  tick: number
): boolean {
  // The foreman holds the mine open; a mine with nobody in it would simply
  // vanish from the map, and an empty valley demonstrates nothing.
  if (index === 0) return true
  if (mine.index === SHOWCASE_MINE_INDEX) return true
  const key = `${config.seed}:${mine.index}:${index}`
  const start = hashInt(`${key}:shift-start`, SHIFT_CYCLE_TICKS)
  const length =
    MIN_SHIFT_TICKS + hashInt(`${key}:shift-length`, SHIFT_CYCLE_TICKS - MIN_SHIFT_TICKS)
  const intoCycle = (((tick - start) % SHIFT_CYCLE_TICKS) + SHIFT_CYCLE_TICKS) % SHIFT_CYCLE_TICKS
  return intoCycle < length
}

function statusOf(
  config: SimulationConfig,
  mine: SimulatedMine,
  index: number,
  crewTick: number
): DwarfStatus {
  if (index === 0) {
    // A foreman never walks out mid-shift: he is the mine's anchor, and his
    // single post is the one anchor that must not go empty.
    return hashInt(`${config.seed}:${mine.index}:foreman`, 4) === crewTick % 4
      ? 'waiting'
      : 'working'
  }
  if (mine.index === SHOWCASE_MINE_INDEX) {
    const worker = index - 1
    return SHOWCASE_STATUS_CYCLE[(worker + crewTick) % SHOWCASE_STATUS_CYCLE.length] as DwarfStatus
  }
  const offset = hashInt(`${config.seed}:${mine.index}:${index}:status`, STATUS_CYCLE.length)
  return STATUS_CYCLE[(offset + crewTick) % STATUS_CYCLE.length] as DwarfStatus
}

/**
 * Which CLI a dwarf belongs to, assigned by position rather than by hash so
 * both sprite sets are guaranteed on screen at any seed.
 *
 * Deliberately still the two that can be LAUNCHED (#237). Antigravity joined
 * `DWARF_PROVIDERS` as an observer, and inventing one here would invent the
 * facts an observed Antigravity session cannot have: the model line below
 * would fall through to Claude's list, and the crew would carry tokens the
 * real provider never reports. A simulated dwarf that lies about a provider is
 * worse than one this valley simply has none of.
 */
function providerOf(mine: SimulatedMine, index: number): DwarfProvider {
  return (mine.index + index) % 3 === 0 ? 'codex' : 'claude'
}

function crewOf(
  config: SimulationConfig,
  mine: SimulatedMine,
  crewTick: number,
  tokenTick: number
): Dwarf[] {
  const dwarfs: Dwarf[] = []
  for (let index = 0; index < rosterSize(config, mine); index++) {
    if (!onShift(config, mine, index, crewTick)) continue
    const key = `${config.seed}:${mine.index}:${index}`
    const provider = providerOf(mine, index)
    dwarfs.push({
      id: `sim:${mine.index}:${index}`,
      provider,
      role: index === 0 ? 'foreman' : 'worker',
      name: hashPick(`${key}:name`, DWARF_NAMES),
      model: hashPick(`${key}:model`, provider === 'codex' ? CODEX_MODELS : CLAUDE_MODELS),
      effort: hashPick(`${key}:effort`, EFFORTS),
      status: statusOf(config, mine, index, crewTick),
      lastMessage:
        CHATTER[(hashInt(`${key}:chatter`, CHATTER.length) + tokenTick) % CHATTER.length],
      sessionId: `sim-session-${mine.index}-${index}`,
      // Deliberately NO pid. A pid is the one field the panel would act on —
      // click-to-focus calls focusPid with it — and a made-up number pointing
      // at some unrelated process on the developer's machine is the one way
      // this simulation could do real damage.
      tokensObserved: tokensObservedAt(config, key, tokenTick)
    })
  }
  return dwarfs
}

/**
 * A dwarf's cumulative token counter at this tick.
 *
 * Monotonic per dwarf, because the ledger reads exactly this field as a
 * cumulative counter (see domain/ledger.ts): a counter that fell would look
 * indistinguishable from a session restart and would silently rebaseline the
 * vault in the middle of a demo.
 */
function tokensObservedAt(config: SimulationConfig, key: string, tick: number): number {
  const base = hashInt(`${key}:tokens-base`, 500_000)
  return base + (tick + 1) * config.tokensPerStep
}

/**
 * Distinct valley names, shuffled by seed.
 *
 * Sorting the full adjective/noun product by a seeded hash is a deterministic
 * shuffle: uniqueness comes free from the product being a set, so no mine ever
 * needs an index glued onto its name to stay distinct.
 */
function valleyNames(seed: string, count: number): string[] {
  const combos: string[] = []
  for (const adjective of MINE_ADJECTIVES) {
    for (const noun of MINE_NOUNS) combos.push(`${adjective}${noun}`)
  }
  return combos
    .map((name) => ({ name, order: hashString(`${seed}:${name}`) }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .slice(0, count)
    .map((entry) => entry.name)
}
