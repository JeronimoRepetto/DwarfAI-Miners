import { describe, expect, it } from 'vitest'
import { tailArrivals } from './entryArrival'

/**
 * `tailArrivals` is the one fact #566 T4b's list entrance needs: which keys,
 * if any, are a genuine arrival at the END of a list the reader was already
 * looking at. Everything else — a page paged in ahead of the reader (#430),
 * a reorder, a list that only shrank — must read as no arrivals at all, so
 * the shared `fadeVariants` entrance never stagger-animates rows a reader
 * has already seen.
 */
describe('tailArrivals', () => {
  it('is empty against an unchanged list', () => {
    expect(tailArrivals(['a', 'b'], ['a', 'b'])).toEqual(new Set())
  })

  it('names exactly the key appended after the list a reader was already looking at', () => {
    expect(tailArrivals(['a', 'b'], ['a', 'b', 'c'])).toEqual(new Set(['c']))
  })

  it('names every key appended when more than one arrived at once', () => {
    expect(tailArrivals(['a'], ['a', 'b', 'c'])).toEqual(new Set(['b', 'c']))
  })

  it('names nothing when the new keys landed in FRONT of the list — a page paged in (#430)', () => {
    expect(tailArrivals(['c', 'd'], ['a', 'b', 'c', 'd'])).toEqual(new Set())
  })

  it('names the new tail key even when the window also evicted its own oldest entry', () => {
    // The shape `speakerRows`' 50-message cap slides in: the array stays the
    // same length, the front falls away and one genuine arrival lands at the
    // tail (#566 T4b design point 4).
    expect(tailArrivals(['m1', 'm2', 'm3'], ['m2', 'm3', 'm4'])).toEqual(new Set(['m4']))
  })

  it('names nothing when the list only shrank', () => {
    expect(tailArrivals(['a', 'b', 'c'], ['a', 'b'])).toEqual(new Set())
  })

  it('names nothing when a row in the middle was replaced rather than merely appended after', () => {
    // An echo reconciled into its transcript row (#309): the echo's own key
    // disappears and a different key takes its place at the same position,
    // which is not the clean "everything before it survived" shape this
    // function insists on before it will call something a genuine arrival.
    expect(tailArrivals(['a', 'b', 'echo-e1'], ['a', 'b', 'msg-t5'])).toEqual(new Set())
  })

  it('names nothing against two lists that share no keys at all', () => {
    // The one shape this function cannot tell apart from an ordinary arrival
    // by keys alone — a wholesale swap, such as a history tab switching to a
    // different speaker. Callers with a selection of their own (MineHistoryPanel)
    // must detect that swap themselves and skip calling this function rather
    // than rely on it here.
    expect(tailArrivals(['x', 'y'], ['p', 'q', 'r'])).toEqual(new Set(['p', 'q', 'r']))
  })

  it('names nothing against two empty lists', () => {
    expect(tailArrivals([], [])).toEqual(new Set())
  })

  it('names every key the very first time a list has anything in it', () => {
    // Never actually reached in practice — components seed their own
    // "previous" snapshot from the list they already have at setup, so a
    // truly empty `previous` never happens after mount — but the function
    // itself is honest about what an empty history means: everything in
    // `next` looks like an arrival, because nothing says otherwise.
    expect(tailArrivals([], ['a', 'b'])).toEqual(new Set(['a', 'b']))
  })
})
