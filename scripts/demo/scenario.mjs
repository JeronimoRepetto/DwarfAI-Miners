import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The demo's scripted scenarios (docs/demo.md). Each is one data file, `scenarios/<name>.json`, so its mine and dwarf
 * names, prompts and replies change without code; this module reads it and gives the pure functions the runner and
 * the stubs use. `scenario.test.mjs` checks the showcase's promises (asks, sleepers, a late start off screen, crews of
 * many sizes, exactly one mine named like a software project) without starting the app.
 *
 * The file's shape:
 *
 * - `mines`, in the order Valle's Control room and Veta's strip show them: `name` is the folder name (the mine's
 *   label), `tier` the band its generated source weighs into (`tierFiles.mjs`), `enterable: false` a crewless mine
 *   whose folder is removed once measured, so the Host marks it unenterable on its next folder check (30 s).
 * - `crew` and `late`: each dwarf's `key`, `name` (set through the app's own rename, or `null` to keep the app's
 *   name), `provider` (`claude` or `codex`, the demo's stubs), `prompt`, `reply` and `behavior`, a key of `behaviors`:
 *   the steps the stub reports, one every `stepMs`, then the ask, if any. `asks: true` marks a dwarf whose behaviour
 *   asks; the hold loop asks it again once answered. A late dwarf also names its `mine` and its `atMs`.
 * - `tokens` is the usage each reported message carries: the Host credits every message as one unit,
 *   `floor(tokens / TOKENS_PER_UNIT[material])` (`ledger/domain/materials.ts`, 250 000 a unit of Uranium), so the
 *   figures are large enough for ore to show in every tier.
 * - `sleepers` are never sent anything after their first turn: they fall asleep on the Host's own clock.
 * - `followUps` and `followUpReplies`: what the hold loop sends a dwarf that finished a while ago, and its answer.
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

/** Every dwarf of the scenario, first crews in mosaic order (each with its `mine`), then the late ones. */
export function dwarfsOf(scenario) {
  return [
    ...scenario.mines.flatMap((mine) =>
      mine.crew.map((d) => ({ asks: false, ...d, mine: mine.key }))
    ),
    ...scenario.late.map((d) => ({ asks: false, ...d }))
  ]
}

/** The dwarfs that ever work in `mineKey`, late ones included. */
export function crewOf(scenario, mineKey) {
  return dwarfsOf(scenario).filter((d) => d.mine === mineKey)
}

/**
 * The scripted events in time order, every time divided by `speed`: `launch` (a dwarf with its prompt), and
 * `remove-folder` (a shut mine's folder, removed once it was measured).
 */
export function timelineOf(scenario, speed) {
  const at = (ms) => Math.round(ms / speed)
  const everyone = dwarfsOf(scenario)
  const lateKeys = new Set(scenario.late.map((d) => d.key))
  const events = everyone
    .filter((d) => !lateKeys.has(d.key))
    .map((d, index) => ({ kind: 'launch', atMs: at(index * scenario.launchEveryMs), dwarf: d }))
  for (const mine of scenario.mines.filter((m) => !m.enterable)) {
    events.push({ kind: 'remove-folder', atMs: at(scenario.removeFolderAtMs), mine: mine.key })
  }
  for (const d of everyone.filter((dwarf) => lateKeys.has(dwarf.key))) {
    events.push({ kind: 'launch', atMs: at(d.atMs), dwarf: d })
  }
  return events.sort((a, b) => a.atMs - b.atMs)
}

/** One behaviour of the file, with its reply, at `speed`: steps as `{ tool, target }`, the step delay divided. */
function behavior(scenario, name, reply, speed) {
  const template = scenario.behaviors[name]
  if (template === undefined) throw new Error(`no behaviour named "${name}"`)
  return {
    steps: template.steps.map(([tool, target]) => ({ tool, target })),
    stepMs: Math.round(template.stepMs / speed),
    ask: template.ask ?? null,
    reply,
    ...(template.replyDenied === undefined ? {} : { replyDenied: template.replyDenied }),
    tokens: template.tokens
  }
}

/**
 * What `provider`'s stub answers, at `speed`: `{ behaviors: { <text>: behaviour }, fallback }` for the prompts of its
 * own dwarfs and every follow-up. The stub reads it from its world folder (`stubs/install.mjs`).
 */
export function stubScriptOf(scenario, provider, speed) {
  const behaviors = {}
  for (const d of dwarfsOf(scenario).filter((dwarf) => dwarf.provider === provider)) {
    if (Object.hasOwn(behaviors, d.prompt))
      throw new Error(`two dwarfs share the prompt "${d.prompt}"`)
    behaviors[d.prompt] = behavior(scenario, d.behavior, d.reply, speed)
  }
  scenario.followUps.forEach((text, index) => {
    behaviors[text] = behavior(scenario, 'follow-up', scenario.followUpReplies[index], speed)
  })
  const { fallback } = scenario
  return {
    behaviors,
    fallback: {
      steps: fallback.steps.map(([tool, target]) => ({ tool, target })),
      stepMs: Math.round(fallback.stepMs / speed),
      ask: null,
      reply: fallback.reply,
      tokens: fallback.tokens
    }
  }
}

/**
 * The hold loop's sends for this look: `views` are the dwarfs as the Host shows them (`key`, `status`, `idleSince`,
 * the moment the runner first saw it idle). A dwarf idle or asleep for at least `holdIdleMs` (divided by `speed`) gets
 * the follow-up of this `round`, offset by its place in the scenario; an asking dwarf gets its own prompt again, so its
 * ask comes back; the sleepers, anything working or asking, and a dwarf whose last scripted turn cannot have ended
 * yet (`busyUntil`, from `scriptedLengthMs`) get nothing: the Host can show a dwarf idle before it observed the turn.
 */
export function holdPlan(scenario, views, now, speed, round) {
  const everyone = dwarfsOf(scenario)
  const sends = []
  for (const view of views) {
    const index = everyone.findIndex((d) => d.key === view.key)
    if (index < 0 || scenario.sleepers.includes(view.key)) continue
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
