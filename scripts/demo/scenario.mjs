import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The demo's scripted scenarios (docs/demo.md). Each is one data file, `scenarios/<name>.json`, so its mine and dwarf
 * names, prompts and replies change without code; this module reads it and gives the pure functions the runner and
 * the stubs use. `scenario.test.mjs` checks the showcase's promises without starting the app.
 *
 * The crew shape is the app's own (`crew/domain/rank.ts`): each mine has ONE launched dwarf, its `foreman`; every
 * other dwarf is one of the foreman CLI's own subagents (Claude) or sub-threads (Codex), which the Host observes from
 * the transcripts the stub writes, exactly as it observes a real CLI's (`observation/adapters/claude/subagents.ts`,
 * `observation/adapters/codex/parse.ts`). A worker whose `parent` is the foreman is a `worker`; one whose parent is a
 * worker is a `worker2` (`wiring/routes/crew.ts`). Workers run inside their foreman's CLI, so they share its provider.
 *
 * The file's shape:
 *
 * - `mines`, in the order Valle's Control room and Veta's strip show them: `name` is the folder name (the mine's
 *   label), `tier` the band its generated source weighs into (`tierFiles.mjs`), `enterable: false` a crewless mine
 *   whose folder is removed once measured.
 * - `foreman`: `key`, `name` (set through the app's own rename, or `null` to keep the app's name), `provider` (`claude`
 *   or `codex`), `prompt`, `reply`, `behavior` (a key of `behaviors`) and `asks` when its behaviour asks.
 * - `workers`: `key`, `name`, `parent` (its foreman's or another worker's key), `startMs` (after the foreman's first
 *   turn starts), `prompt`, `reply`, `behavior`, and `end`: `complete` (one pass, then the task notification that ends
 *   it, so it walks out), `stay` (one pass, then silence, so it falls asleep) or `loop` (works until the demo ends).
 * - `tokens` is the usage each reported message carries; the Host credits each message as one unit,
 *   `floor(tokens / TOKENS_PER_UNIT[material])` (`ledger/domain/materials.ts`), so ore shows in every tier.
 * - `sleepers` (workers that `stay`), `followUps` and `followUpReplies` (what the hold loop sends a foreman that
 *   finished a while ago, and its answer).
 */

/** The Host's sleep rule (`crew/domain/status.ts` ASLEEP_AFTER_MS): idle this long, a dwarf is asleep. */
export const ASLEEP_AFTER_MS = 60_000

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Reads `scenarios/<name>.json`. */
export function loadScenario(name) {
  return Object.freeze(
    JSON.parse(readFileSync(path.join(HERE, 'scenarios', `${name}.json`), 'utf8'))
  )
}

export const SCENARIOS = Object.freeze({ showcase: loadScenario('showcase') })

/** How many levels below its mine's foreman a dwarf is: 0 for the foreman. */
export function depthOf(scenario, key) {
  for (const mine of scenario.mines) {
    if (mine.foreman?.key === key) return 0
    const worker = mine.workers.find((w) => w.key === key)
    if (worker !== undefined) return 1 + depthOf(scenario, worker.parent)
  }
  throw new Error(`no dwarf ${key}`)
}

const RANKS = ['foreman', 'worker', 'worker2']

/** Every dwarf, mine by mine (foreman first, then its workers), each with its `mine`, `rank` and `provider`. */
export function dwarfsOf(scenario) {
  return scenario.mines.flatMap((mine) =>
    mine.foreman === undefined
      ? []
      : [
          { asks: false, ...mine.foreman, mine: mine.key, rank: 'foreman' },
          ...mine.workers.map((worker) => ({
            asks: false,
            ...worker,
            provider: mine.foreman.provider,
            mine: mine.key,
            rank: RANKS[Math.min(2, depthOf(scenario, worker.key))]
          }))
        ]
  )
}

/** The foremen, in mosaic order: the only dwarfs the demo launches. */
export function foremenOf(scenario) {
  return dwarfsOf(scenario).filter((d) => d.rank === 'foreman')
}

/** The dwarfs that ever work in `mineKey`. */
export function crewOf(scenario, mineKey) {
  return dwarfsOf(scenario).filter((d) => d.mine === mineKey)
}

/**
 * The scripted events in time order, every time divided by `speed`: `launch` (a foreman with its prompt; its workers
 * come from its CLI), and `remove-folder` (a shut mine's folder, removed once it was measured).
 */
export function timelineOf(scenario, speed) {
  const at = (ms) => Math.round(ms / speed)
  const events = foremenOf(scenario).map((d, index) => ({
    kind: 'launch',
    atMs: at(index * scenario.launchEveryMs),
    dwarf: d
  }))
  for (const mine of scenario.mines.filter((m) => !m.enterable)) {
    events.push({ kind: 'remove-folder', atMs: at(scenario.removeFolderAtMs), mine: mine.key })
  }
  return events.sort((a, b) => a.atMs - b.atMs)
}

/** The steps, delay and tokens of a behaviour of the file, at `speed`. */
function stepsOf(scenario, name, speed) {
  const template = scenario.behaviors[name]
  if (template === undefined) throw new Error(`no behaviour named "${name}"`)
  return {
    steps: template.steps.map(([tool, target]) => ({ tool, target })),
    stepMs: Math.round(template.stepMs / speed),
    tokens: template.tokens,
    template
  }
}

/** One foreman behaviour with its reply and the subagents its CLI spawns, at `speed`. */
function foremanBehavior(scenario, foreman, speed) {
  const { steps, stepMs, tokens, template } = stepsOf(scenario, foreman.behavior, speed)
  const mine = scenario.mines.find((m) => m.foreman?.key === foreman.key)
  const spawns = (mine?.workers ?? []).map((worker) => {
    const work = stepsOf(scenario, worker.behavior, speed)
    return {
      key: worker.key,
      parent: worker.parent === foreman.key ? null : worker.parent,
      description: worker.prompt,
      prompt: worker.prompt,
      reply: worker.reply,
      startMs: Math.round(worker.startMs / speed),
      steps: work.steps,
      stepMs: work.stepMs,
      tokens: work.tokens,
      end: worker.end
    }
  })
  return {
    steps,
    stepMs,
    ask: template.ask ?? null,
    reply: foreman.reply,
    ...(template.replyDenied === undefined ? {} : { replyDenied: template.replyDenied }),
    tokens,
    spawns
  }
}

/**
 * What `provider`'s stub answers, at `speed`: `{ behaviors: { <text>: behaviour }, fallback }` for its foremen's
 * prompts (each with the `spawns` its CLI makes) and every follow-up. The stub reads it from its world folder.
 */
export function stubScriptOf(scenario, provider, speed) {
  const behaviors = {}
  for (const foreman of foremenOf(scenario).filter((d) => d.provider === provider)) {
    if (Object.hasOwn(behaviors, foreman.prompt)) {
      throw new Error(`two foremen share the prompt "${foreman.prompt}"`)
    }
    behaviors[foreman.prompt] = foremanBehavior(scenario, foreman, speed)
  }
  scenario.followUps.forEach((text, index) => {
    const { steps, stepMs, tokens } = stepsOf(scenario, 'follow-up', speed)
    behaviors[text] = {
      steps,
      stepMs,
      ask: null,
      reply: scenario.followUpReplies[index],
      tokens,
      spawns: []
    }
  })
  const { fallback } = scenario
  return {
    behaviors,
    fallback: {
      steps: fallback.steps.map(([tool, target]) => ({ tool, target })),
      stepMs: Math.round(fallback.stepMs / speed),
      ask: null,
      reply: fallback.reply,
      tokens: fallback.tokens,
      spawns: []
    }
  }
}

/**
 * Which observed worker rows are which scripted workers: `ids` holds the dwarf id of every key named so far (the
 * foremen from their launch). A row with no key yet, whose `parentDwarfId` is a known dwarf, is the next scripted
 * child of that parent, children by `startMs`, rows by `arrivedAt`. Answers only the new pairs.
 */
export function assignWorkers(scenario, ids, rows) {
  const named = new Set(Object.values(ids))
  const keyOf = new Map(Object.entries(ids).map(([key, id]) => [id, key]))
  const assigned = {}
  const byParent = new Map()
  for (const row of rows) {
    if (row.owned || named.has(row.id) || row.parentDwarfId == null) continue
    const parentKey = keyOf.get(row.parentDwarfId)
    if (parentKey === undefined) continue
    byParent.set(parentKey, [...(byParent.get(parentKey) ?? []), row])
  }
  const everyone = dwarfsOf(scenario)
  for (const [parentKey, found] of byParent) {
    const waiting = everyone
      .filter((d) => d.parent === parentKey && ids[d.key] === undefined)
      .sort((a, b) => a.startMs - b.startMs)
    found.sort((a, b) => a.arrivedAt - b.arrivedAt)
    found.slice(0, waiting.length).forEach((row, index) => {
      assigned[waiting[index].key] = row.id
    })
  }
  return assigned
}

/**
 * The hold loop's sends for this look: `views` are the dwarfs as the Host shows them (`key`, `status`, `idleSince`,
 * `busyUntil`). Only a foreman is ever sent anything (its workers are its CLI's): one idle or asleep for at least
 * `holdIdleMs` (divided by `speed`) gets the follow-up of this `round`, offset by its place in the scenario; an asking
 * foreman gets its own prompt again, so its ask comes back. Nothing goes to a foreman working, asking, or whose last
 * scripted turn cannot have ended yet (`busyUntil`): the Host can show a dwarf idle before it observed the turn.
 */
export function holdPlan(scenario, views, now, speed, round) {
  const everyone = dwarfsOf(scenario)
  const sends = []
  for (const view of views) {
    const index = everyone.findIndex((d) => d.key === view.key)
    if (index < 0 || everyone[index].rank !== 'foreman') continue
    if (view.busyUntil !== undefined && now < view.busyUntil) continue
    if (view.status !== 'idle' && view.status !== 'asleep') continue
    if (now - view.idleSince < scenario.holdIdleMs / speed) continue
    const d = everyone[index]
    const text = d.asks ? d.prompt : scenario.followUps[(round + index) % scenario.followUps.length]
    sends.push({ key: view.key, text })
  }
  return sends
}

/** How long the turn `text` runs in `provider`'s stub at `speed`: its steps, plus 5 s for the ask and the reply. */
export function scriptedLengthMs(scenario, provider, text, speed) {
  const behavior = stubScriptOf(scenario, provider, speed).behaviors[text]
  return behavior === undefined ? 5_000 : behavior.steps.length * behavior.stepMs + 5_000
}
