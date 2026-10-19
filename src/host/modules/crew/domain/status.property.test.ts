import { describe, expect, it } from 'vitest'
import { classifyDwarfStatus, type DwarfStatus, type StatusFacts } from './status'
import {
  arrivalFacts,
  askClosed,
  askOpened,
  nextWakeAt,
  otherActivity,
  turnEnded,
  turnStarted
} from './statusFacts'

// A seeded property run (no generator library in the repo): every case is reproducible from its seed.
const CASES = 500
const STEPS = 40
const STATUSES: readonly DwarfStatus[] = ['working', 'asking', 'idle', 'asleep']

/** mulberry32: a small deterministic PRNG, enough to spread fact sequences and clock instants. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

type Ask = { kind: 'question' | 'permission'; askedAt: number }

describe('machine 1 over any fact sequence (INV-23, INV-24)', () => {
  it('[INV-23, ADR-032] for any fact sequence and clock the status is one of the four values and asking iff an open ask exists', () => {
    for (let seed = 1; seed <= CASES; seed += 1) {
      const random = prng(seed)
      const pick = (n: number) => Math.floor(random() * n)
      // The clock may move forward or backward (FM-113): the facts only ever see the instants given.
      let now = 1_790_000_000_000 + pick(1_000_000)
      let facts: StatusFacts = arrivalFacts(now, random() < 0.5 ? 'working' : 'idle')
      // The broker's open asks of this dwarf, front first: the model INV-24 is checked against.
      const queue: Ask[] = []

      for (let step = 0; step < STEPS; step += 1) {
        now += pick(150_000) - 30_000
        const kind = random() < 0.5 ? 'question' : 'permission'
        switch (pick(6)) {
          case 0:
            facts = turnStarted(facts, now)
            break
          case 1:
            facts = turnEnded(facts, {
              at: now,
              reliability: random() < 0.5 ? 'reliable' : 'inferred',
              cancelledFromApp: random() < 0.2
            })
            break
          case 2:
            facts = otherActivity(facts, now)
            break
          case 3: {
            const autoDenied = random() < 0.3
            facts = askOpened(facts, {
              kind,
              askedAt: now,
              state: autoDenied ? 'auto-denied' : 'open'
            })
            if (!autoDenied) queue.push({ kind, askedAt: now })
            break
          }
          case 4:
            if (queue.length > 0) {
              queue.shift()
              facts = askClosed(facts, queue[0])
            }
            break
          default:
            break
        }

        for (const at of [now, now + pick(200_000), now - pick(200_000)]) {
          const status = classifyDwarfStatus(facts, at)
          const context = { seed, step, at, facts, status }
          expect(STATUSES, JSON.stringify(context)).toContain(status)
          expect(status === 'asking', JSON.stringify(context)).toBe(queue.length > 0)
        }
        const wake = nextWakeAt(facts)
        if (wake !== null) {
          expect(classifyDwarfStatus(facts, wake - 1)).toBe('idle')
          expect(classifyDwarfStatus(facts, wake)).toBe('asleep')
        }
      }
    }
  })
})
