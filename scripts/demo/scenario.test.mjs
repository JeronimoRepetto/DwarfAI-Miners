import { describe, expect, it } from 'vitest'
import {
  ASLEEP_AFTER_MS,
  crewOf,
  dwarfsOf,
  holdPlan,
  SCENARIOS,
  scriptedLengthMs,
  stubScriptOf,
  timelineOf
} from './scenario.mjs'
import { behaviorFor } from './stubs/behavior.mjs'

const showcase = SCENARIOS.showcase
const firstCrew = () => showcase.mines.flatMap((mine) => mine.crew)
const behaviorOf = (dwarf, speed = 1) =>
  stubScriptOf(showcase, dwarf.provider, speed).behaviors[dwarf.prompt]

describe('the showcase scenario (scenarios/showcase.json)', () => {
  it('declares five to eight mines, exactly one named like a software project, of at least four tiers', () => {
    const { mines } = showcase
    expect(mines.length).toBeGreaterThanOrEqual(5)
    expect(mines.length).toBeLessThanOrEqual(8)
    expect(new Set(mines.map((mine) => mine.name)).size).toBe(mines.length)
    const projectLike = mines.filter((mine) => /^[a-z]+(-[a-z]+)+$/.test(mine.name))
    expect(projectLike).toHaveLength(1)
    const enterable = mines.filter((mine) => mine.enterable)
    expect(new Set(enterable.map((mine) => mine.tier)).size).toBeGreaterThanOrEqual(4)
    expect(mines[0].tier, 'the first mine is the richest').toBe('uranium')
  })

  it('gives the mines crews of many sizes, from one dwarf to a crowd, and no crew to a mine that cannot be entered', () => {
    const sizes = showcase.mines.map((mine) => crewOf(showcase, mine.key).length)
    expect(new Set(sizes).size).toBeGreaterThanOrEqual(4)
    expect(Math.min(...sizes)).toBe(1)
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(6)
    for (const mine of showcase.mines.filter((m) => !m.enterable)) {
      expect(crewOf(showcase, mine.key)).toEqual([])
    }
  })

  it('names every dwarf at most once, each name short enough for the app (24 characters)', () => {
    const everyone = dwarfsOf(showcase)
    expect(new Set(everyone.map((d) => d.key)).size).toBe(everyone.length)
    const named = everyone.filter((d) => d.name !== null).map((d) => d.name)
    expect(named.length).toBeGreaterThan(0)
    expect(new Set(named).size).toBe(named.length)
    for (const name of named) expect(name.length).toBeLessThanOrEqual(24)
  })

  it('gives every prompt it sends a scripted behaviour in its dwarf’s provider stub, with the dwarf’s own reply, and questions only to Codex', () => {
    const scripts = {
      claude: stubScriptOf(showcase, 'claude', 1),
      codex: stubScriptOf(showcase, 'codex', 1)
    }
    for (const dwarf of dwarfsOf(showcase)) {
      expect(scripts[dwarf.provider].behaviors[dwarf.prompt]?.reply, dwarf.key).toBe(dwarf.reply)
    }
    for (const [index, text] of showcase.followUps.entries()) {
      for (const script of Object.values(scripts)) {
        expect(script.behaviors[text].reply).toBe(showcase.followUpReplies[index])
      }
    }
    const questions = (provider) =>
      Object.values(scripts[provider].behaviors).filter((b) => b.ask?.kind === 'question')
    expect(questions('claude')).toEqual([])
    expect(questions('codex').length).toBeGreaterThan(0)
  })

  it('raises a permission and a question in the richest mine, and more asks elsewhere, after the dwarfs worked a while', () => {
    const kindsIn = (mine) =>
      mine.crew.map((d) => behaviorOf(d).ask?.kind).filter((kind) => kind !== undefined)
    expect(kindsIn(showcase.mines[0]).sort()).toEqual(['permission', 'question'])
    const askers = firstCrew().filter((d) => behaviorOf(d).ask !== null)
    expect(askers.length).toBeGreaterThan(2)
    for (const dwarf of askers) {
      expect(dwarf.asks, dwarf.key).toBe(true)
      const behavior = behaviorOf(dwarf)
      expect(behavior.steps.length * behavior.stepMs).toBeGreaterThanOrEqual(20_000)
    }
  })

  it('lets the sleepers finish early and never asks them anything, while the other turns vary in length', () => {
    expect(showcase.sleepers.length).toBeGreaterThan(0)
    for (const key of showcase.sleepers) {
      const sleeper = firstCrew().find((d) => d.key === key)
      expect(sleeper, key).toBeDefined()
      const behavior = behaviorOf(sleeper)
      expect(behavior.ask).toBeNull()
      expect(behavior.steps.length * behavior.stepMs).toBeLessThan(20_000)
    }
    const lengths = firstCrew()
      .filter((d) => !showcase.sleepers.includes(d.key))
      .map((d) => behaviorOf(d).steps.length * behaviorOf(d).stepMs)
    expect(Math.min(...lengths)).toBeLessThan(Math.max(...lengths) / 2)
  })

  it('starts a late dwarf, after a minute, in a mine past the first four columns', () => {
    expect(showcase.late).toHaveLength(1)
    const [late] = showcase.late
    const order = showcase.mines.map((mine) => mine.key)
    expect(order.indexOf(late.mine)).toBeGreaterThanOrEqual(4)
    const launch = timelineOf(showcase, 1).find(
      (e) => e.kind === 'launch' && e.dwarf.key === late.key
    )
    expect(launch.atMs).toBeGreaterThanOrEqual(60_000)
  })
})

describe('the timeline', () => {
  it('launches every dwarf, the first crews one after the other, removes shut mines’ folders, in time order', () => {
    const timeline = timelineOf(showcase, 1)
    const times = timeline.map((event) => event.atMs)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    const launched = timeline.filter((e) => e.kind === 'launch').map((e) => e.dwarf.key)
    expect(launched.length).toBeGreaterThan(0)
    expect(launched.sort()).toEqual(
      dwarfsOf(showcase)
        .map((d) => d.key)
        .sort()
    )
    expect(timeline.filter((e) => e.kind === 'remove-folder').map((e) => e.mine)).toEqual(
      showcase.mines.filter((mine) => !mine.enterable).map((mine) => mine.key)
    )
  })

  it('divides every scripted delay by the speed, the stubs’ steps included, and keeps the token counts', () => {
    const normal = timelineOf(showcase, 1)
    expect(normal.length).toBeGreaterThan(0)
    const fast = timelineOf(showcase, 2)
    expect(fast.map((e) => e.atMs)).toEqual(normal.map((e) => Math.round(e.atMs / 2)))
    const slow = stubScriptOf(showcase, 'claude', 1)
    const quick = stubScriptOf(showcase, 'claude', 2)
    expect(Object.keys(slow.behaviors).length).toBeGreaterThan(0)
    for (const [text, behavior] of Object.entries(slow.behaviors)) {
      expect(quick.behaviors[text].stepMs).toBe(Math.round(behavior.stepMs / 2))
      expect(quick.behaviors[text].tokens).toBe(behavior.tokens)
    }
  })
})

describe('the hold loop', () => {
  const now = 300_000
  const view = (key, status, idleSince = now - 60_000) => ({ key, status, idleSince })
  const held = () => dwarfsOf(showcase).find((d) => !showcase.sleepers.includes(d.key) && !d.asks)
  const sleeper = showcase.sleepers[0]
  const offset = () => dwarfsOf(showcase).findIndex((d) => d.key === held().key)

  it('sends the next follow-up to a dwarf idle for a while, never to one working, asking or meant to sleep', () => {
    const sends = holdPlan(
      showcase,
      [
        view(held().key, 'idle'),
        view('busy', 'working'),
        view('waiting', 'asking'),
        view(sleeper, 'asleep')
      ],
      now,
      1,
      0
    )
    expect(sends).toEqual([
      { key: held().key, text: showcase.followUps[offset() % showcase.followUps.length] }
    ])
  })

  it('waits until a finished turn has been seen for a while, at the scripted speed', () => {
    expect(holdPlan(showcase, [view(held().key, 'idle', now - 1_000)], now, 1, 0)).toEqual([])
    expect(
      holdPlan(showcase, [view(held().key, 'idle', now - showcase.holdIdleMs / 2)], now, 2, 0)
    ).toHaveLength(1)
  })

  it('cycles the follow-ups by round, and asks an asking dwarf its question again once it was answered', () => {
    const asker = dwarfsOf(showcase).find((d) => d.asks)
    const count = showcase.followUps.length
    expect(
      holdPlan(showcase, [view(held().key, 'asleep'), view(asker.key, 'idle')], now, 1, 1)
    ).toEqual([
      { key: held().key, text: showcase.followUps[(1 + offset()) % count] },
      { key: asker.key, text: asker.prompt }
    ])
  })

  it('never sends to a dwarf before its scripted turn could have ended, whatever the Host shows meanwhile', () => {
    const busy = { ...view(held().key, 'idle'), busyUntil: now + 1 }
    expect(holdPlan(showcase, [busy], now, 1, 0)).toEqual([])
    expect(holdPlan(showcase, [{ ...busy, busyUntil: now }], now, 1, 0)).toHaveLength(1)
    const behavior = stubScriptOf(showcase, held().provider, 2).behaviors[held().prompt]
    expect(scriptedLengthMs(showcase, held().provider, held().prompt, 2)).toBe(
      behavior.steps.length * behavior.stepMs + 5_000
    )
  })

  it('names the Host’s own sleep rule', () => {
    expect(ASLEEP_AFTER_MS).toBe(60_000)
  })
})

describe('the stub behaviour lookup', () => {
  it('answers the scripted behaviour for a known text, and the script’s fallback for any other', () => {
    const script = stubScriptOf(showcase, 'claude', 1)
    const [text, behavior] = Object.entries(script.behaviors)[0]
    expect(behaviorFor(script, text)).toEqual(behavior)
    expect(behaviorFor(script, `  ${text}\n`)).toEqual(behavior)
    expect(behaviorFor(script, 'Something nobody scripted.')).toEqual(script.fallback)
    expect(behaviorFor(null, 'anything')).toMatchObject({ ask: null, steps: [] })
  })
})
