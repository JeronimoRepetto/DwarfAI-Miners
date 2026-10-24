import { describe, expect, it } from 'vitest'
import {
  ASLEEP_AFTER_MS,
  assignWorkers,
  crewOf,
  depthOf,
  dwarfsOf,
  foremenOf,
  holdPlan,
  SCENARIOS,
  scriptedLengthMs,
  stubScriptOf,
  timelineOf
} from './scenario.mjs'
import { behaviorFor, replyOf } from './stubs/behavior.mjs'

const showcase = SCENARIOS.showcase
const behaviorOf = (dwarf, speed = 1) =>
  stubScriptOf(showcase, dwarf.provider, speed).behaviors[dwarf.prompt]
const workers = () => dwarfsOf(showcase).filter((d) => d.rank !== 'foreman')
const spawnsOf = (foreman, speed = 1) => behaviorOf(foreman, speed).spawns

describe('the showcase scenario (scenarios/showcase.json)', () => {
  it('declares five to eight mines, exactly one named like a software project, of at least four tiers', () => {
    const { mines } = showcase
    expect(mines.length).toBeGreaterThanOrEqual(5)
    expect(mines.length).toBeLessThanOrEqual(8)
    expect(new Set(mines.map((mine) => mine.name)).size).toBe(mines.length)
    expect(mines.filter((mine) => /^[a-z]+(-[a-z]+)+$/.test(mine.name))).toHaveLength(1)
    const enterable = mines.filter((mine) => mine.enterable)
    expect(new Set(enterable.map((mine) => mine.tier)).size).toBeGreaterThanOrEqual(4)
    expect(mines[0].tier, 'the first mine is the richest').toBe('uranium')
  })

  it('gives every mine exactly one launched foreman, and every worker a parent in its own mine', () => {
    for (const mine of showcase.mines) {
      const crew = crewOf(showcase, mine.key)
      expect(
        crew.filter((d) => d.rank === 'foreman').map((d) => d.key),
        mine.name
      ).toEqual([mine.foreman.key])
      for (const worker of crew.filter((d) => d.rank !== 'foreman')) {
        expect(
          crew.map((d) => d.key),
          worker.key
        ).toContain(worker.parent)
        expect(worker.provider, `${worker.key} runs inside its foreman's CLI`).toBe(
          mine.foreman.provider
        )
      }
    }
    expect(foremenOf(showcase).map((d) => d.key)).toEqual(
      showcase.mines.map((mine) => mine.foreman.key)
    )
  })

  it('ranks workers by depth: workers under the foreman, worker² under a worker, in at least two mines', () => {
    for (const worker of workers()) {
      const depth = depthOf(showcase, worker.key)
      expect([1, 2]).toContain(depth)
      expect(worker.rank).toBe(depth === 1 ? 'worker' : 'worker2')
    }
    const minesWithWorker2 = new Set(
      workers()
        .filter((d) => d.rank === 'worker2')
        .map((d) => d.mine)
    )
    expect(minesWithWorker2.size).toBeGreaterThanOrEqual(2)
  })

  it('gives the mines crews of many sizes, from a pair to a crowd, and no crew to a mine that cannot be entered', () => {
    const sizes = showcase.mines
      .filter((m) => m.enterable)
      .map((mine) => crewOf(showcase, mine.key).length)
    expect(new Set(sizes).size).toBeGreaterThanOrEqual(4)
    expect(Math.max(...sizes)).toBeGreaterThanOrEqual(6)
    for (const mine of showcase.mines.filter((m) => !m.enterable)) {
      expect(crewOf(showcase, mine.key)).toEqual([])
    }
  })

  it('names every dwarf at most once, each name short enough for the app (24 characters)', () => {
    const everyone = dwarfsOf(showcase)
    expect(new Set(everyone.map((d) => d.key)).size).toBe(everyone.length)
    const named = everyone.filter((d) => d.name !== null).map((d) => d.name)
    expect(new Set(named).size).toBe(named.length)
    for (const name of named) expect(name.length).toBeLessThanOrEqual(24)
  })

  it('scripts each foreman’s turn with its workers as the subagents its CLI spawns, each with its own reply', () => {
    for (const foreman of foremenOf(showcase)) {
      const behavior = behaviorOf(foreman)
      expect(behavior.reply).toBe(foreman.reply)
      const spawned = spawnsOf(foreman)
      const own = workers().filter((w) => w.mine === foreman.mine)
      expect(spawned.map((s) => s.key).sort()).toEqual(own.map((w) => w.key).sort())
      for (const spawn of spawned) {
        const worker = own.find((w) => w.key === spawn.key)
        expect(spawn.parent).toBe(worker.parent === foreman.key ? null : worker.parent)
        expect(spawn.reply).toBe(worker.reply)
        expect(spawn.prompt).toBe(worker.prompt)
        expect(spawn.steps.length).toBeGreaterThan(0)
        expect(spawn.ask, `${spawn.key}: a subagent's ask is never matched`).toBeUndefined()
      }
    }
  })

  it('raises asks only from foremen: Moria’s foreman a permission, Codex foremen the questions', () => {
    const kinds = foremenOf(showcase).map((f) => [f, behaviorOf(f).ask?.kind ?? null])
    expect(kinds.find(([f]) => f.mine === 'moria')[1]).toBe('permission')
    const questioners = kinds.filter(([, kind]) => kind === 'question').map(([f]) => f)
    expect(questioners.length).toBeGreaterThanOrEqual(2)
    for (const foreman of questioners) expect(foreman.provider).toBe('codex')
    for (const [foreman, kind] of kinds) expect(foreman.asks, foreman.key).toBe(kind !== null)
    for (const foreman of kinds.filter(([, k]) => k !== null).map(([f]) => f)) {
      const behavior = behaviorOf(foreman)
      expect(behavior.steps.length * behavior.stepMs).toBeGreaterThanOrEqual(20_000)
    }
  })

  it('lets the sleepers do one short job and stay, while some workers finish and walk out and others keep working', () => {
    expect(showcase.sleepers.length).toBeGreaterThan(0)
    for (const key of showcase.sleepers) {
      const sleeper = workers().find((d) => d.key === key)
      expect(sleeper, key).toBeDefined()
      expect(sleeper.end).toBe('stay')
      const template = showcase.behaviors[sleeper.behavior]
      expect(template.steps.length * template.stepMs).toBeLessThan(20_000)
    }
    const ends = workers().map((w) => w.end)
    expect(ends.filter((end) => end === 'complete').length).toBeGreaterThanOrEqual(2)
    expect(ends.filter((end) => end === 'loop').length).toBeGreaterThanOrEqual(6)
  })

  it('starts a late worker after a minute in a mine past the first four columns', () => {
    const late = workers().filter((w) => w.startMs >= 60_000)
    expect(late).toHaveLength(1)
    const order = showcase.mines.map((mine) => mine.key)
    expect(order.indexOf(late[0].mine)).toBeGreaterThanOrEqual(4)
  })
})

describe('the timeline', () => {
  it('launches only the foremen, one after the other, and removes shut mines’ folders, in time order', () => {
    const timeline = timelineOf(showcase, 1)
    const times = timeline.map((event) => event.atMs)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    const launched = timeline.filter((e) => e.kind === 'launch').map((e) => e.dwarf.key)
    expect(launched).toEqual(foremenOf(showcase).map((d) => d.key))
    expect(timeline.filter((e) => e.kind === 'remove-folder').map((e) => e.mine)).toEqual(
      showcase.mines.filter((mine) => !mine.enterable).map((mine) => mine.key)
    )
  })

  it('divides every scripted delay by the speed, the stubs’ steps and spawns included, and keeps the token counts', () => {
    const normal = timelineOf(showcase, 1)
    expect(normal.length).toBeGreaterThan(0)
    expect(timelineOf(showcase, 2).map((e) => e.atMs)).toEqual(
      normal.map((e) => Math.round(e.atMs / 2))
    )
    const [foreman] = foremenOf(showcase)
    const slow = behaviorOf(foreman, 1)
    const quick = behaviorOf(foreman, 2)
    expect(quick.stepMs).toBe(Math.round(slow.stepMs / 2))
    expect(quick.tokens).toBe(slow.tokens)
    expect(slow.spawns.length).toBeGreaterThan(0)
    slow.spawns.forEach((spawn, index) => {
      expect(quick.spawns[index].startMs).toBe(Math.round(spawn.startMs / 2))
      expect(quick.spawns[index].stepMs).toBe(Math.round(spawn.stepMs / 2))
      expect(quick.spawns[index].tokens).toBe(spawn.tokens)
    })
  })
})

describe('naming the workers the Host observed', () => {
  const [foreman] = foremenOf(showcase)
  const row = (id, parentDwarfId, arrivedAt) => ({ id, parentDwarfId, arrivedAt, owned: false })

  it('gives each new worker under a known parent the next scripted name of that parent, in arrival order', () => {
    const children = workers().filter((w) => w.parent === foreman.key)
    expect(children.length).toBeGreaterThanOrEqual(2)
    const ids = { [foreman.key]: 'F' }
    const assigned = assignWorkers(showcase, ids, [row('b', 'F', 20), row('a', 'F', 10)])
    expect(assigned).toEqual({ [children[0].key]: 'a', [children[1].key]: 'b' })
  })

  it('leaves alone rows already named, rows of an unknown parent and the foremen themselves', () => {
    const children = workers().filter((w) => w.parent === foreman.key)
    const ids = { [foreman.key]: 'F', [children[0].key]: 'a' }
    const rows = [row('a', 'F', 10), row('x', 'nobody', 5), { ...row('F', null, 1), owned: true }]
    expect(assignWorkers(showcase, ids, rows)).toEqual({})
    expect(assignWorkers(showcase, ids, [...rows, row('b', 'F', 30)])).toEqual({
      [children[1].key]: 'b'
    })
  })
})

describe('the hold loop', () => {
  const now = 300_000
  const view = (key, status, idleSince = now - 60_000) => ({ key, status, idleSince })
  const held = () => foremenOf(showcase).find((d) => !d.asks)
  const asker = () => foremenOf(showcase).find((d) => d.asks)
  const offset = () => dwarfsOf(showcase).findIndex((d) => d.key === held().key)

  it('sends the next follow-up to a foreman idle for a while, never to a worker, a working or asking one', () => {
    const sends = holdPlan(
      showcase,
      [
        view(held().key, 'idle'),
        view('busy', 'working'),
        view('waiting', 'asking'),
        view(workers()[0].key, 'idle'),
        view(showcase.sleepers[0], 'asleep')
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

  it('cycles the follow-ups by round, and asks an asking foreman its question again once it was answered', () => {
    const count = showcase.followUps.length
    expect(
      holdPlan(showcase, [view(held().key, 'asleep'), view(asker().key, 'idle')], now, 1, 1)
    ).toEqual([
      { key: held().key, text: showcase.followUps[(1 + offset()) % count] },
      { key: asker().key, text: asker().prompt }
    ])
  })

  it('never sends to a foreman before its scripted turn could have ended, whatever the Host shows meanwhile', () => {
    const busy = { ...view(held().key, 'idle'), busyUntil: now + 1 }
    expect(holdPlan(showcase, [busy], now, 1, 0)).toEqual([])
    expect(holdPlan(showcase, [{ ...busy, busyUntil: now }], now, 1, 0)).toHaveLength(1)
    const behavior = behaviorOf(held(), 2)
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

describe('varied replies', () => {
  const sequence = (behavior, count) =>
    Array.from({ length: count }, (_, n) => replyOf(behavior, n))
  const noBackToBack = (list) => list.every((text, at) => at === 0 || text !== list[at - 1])

  it('never gives a foreman the same reply twice in a row, whatever it is asked', () => {
    for (const provider of ['claude', 'codex']) {
      for (const [text, behavior] of Object.entries(
        stubScriptOf(showcase, provider, 1).behaviors
      )) {
        expect(noBackToBack(sequence(behavior, 12)), `${provider}: ${text}`).toBe(true)
      }
    }
  })

  it('never gives a working worker the same reply twice in a row, pass after pass', () => {
    for (const foreman of foremenOf(showcase)) {
      for (const spawn of behaviorOf(foreman).spawns.filter((s) => s.end === 'loop')) {
        expect(noBackToBack(sequence(spawn, 12)), spawn.key).toBe(true)
      }
    }
  })

  it('sends a foreman a different follow-up each time, so its replies follow suit', () => {
    const held = foremenOf(showcase).find((d) => !d.asks)
    const texts = [0, 1, 2, 3, 4, 5].map(
      (sent) =>
        holdPlan(
          showcase,
          [{ key: held.key, status: 'idle', idleSince: 0, sent }],
          600_000,
          1,
          0
        )[0].text
    )
    expect(noBackToBack(texts)).toBe(true)
  })

  it('names every foreman and every worker', () => {
    for (const dwarf of dwarfsOf(showcase))
      expect(dwarf.name, dwarf.key).toEqual(expect.any(String))
  })
})

describe('varied replies over a whole hold', () => {
  it('gives a foreman a different reply each time the hold loop sends it the next follow-up', () => {
    const held = foremenOf(showcase).find((d) => !d.asks)
    const script = stubScriptOf(showcase, held.provider, 1)
    const seen = new Map()
    const replies = []
    for (let sent = 0; sent < 24; sent++) {
      const [send] = holdPlan(
        showcase,
        [{ key: held.key, status: 'idle', idleSince: 0, sent }],
        600_000,
        1,
        0
      )
      const n = seen.get(send.text) ?? 0
      seen.set(send.text, n + 1)
      replies.push(replyOf(script.behaviors[send.text], n))
    }
    expect(replies.every((text, at) => at === 0 || text !== replies[at - 1])).toBe(true)
  })
})
