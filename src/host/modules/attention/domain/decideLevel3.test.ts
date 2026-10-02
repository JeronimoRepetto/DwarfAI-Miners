// layer: L1
// L1 (17 §1.1): the ADR-018 level-3 rule as a table and as seeded properties, and the
// diagram-conformance walk of machine 17 (07 §17). No clock, no timer: every instant is passed in.
import { describe, expect, it } from 'vitest'
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import {
  decideLevel3,
  type AttentionFact,
  type AttentionKind,
  type Level3Names,
  type Level3TitleFormatter,
  nextAttentionKey,
  type AttentionKeyEvent,
  type AttentionKeyState,
  type Presence,
  turnFinishedFact,
  unionPresence
} from './decideLevel3'

const DWARF = 'dwarf-0001' as DwarfId
const MINE = 'mine-0001' as MineId
const OTHER_MINE = 'mine-0002' as MineId
const NAMES: Level3Names = { displayName: 'Gimli', mineName: 'Moria' }
// The titles come from the copy dictionary, injected by the composition side (owner rule
// 2026-10-02): this fake shows which kind and name reached the formatter.
const TITLE: Level3TitleFormatter = (kind, name) => `title(${kind}, ${name})`
const ON = { systemNotificationsOn: true }
const OFF = { systemNotificationsOn: false }

function fact(kind: AttentionKind, overrides: Partial<AttentionFact> = {}): AttentionFact {
  return {
    key: `${DWARF}:${kind}:ask-1`,
    kind,
    dwarfId: DWARF,
    mineId: MINE,
    at: 1_790_000_000_000,
    reannounce: true,
    ...overrides
  }
}

function presence(overrides: Partial<Presence> = {}): Presence {
  return {
    anyUiAttached: true,
    anyWindowVisible: true,
    onScreenMineIds: new Set<MineId>(),
    seq: 1,
    ...overrides
  }
}

const NONE: ReadonlySet<string> = new Set()

function turnEnd(overrides: Partial<TurnEnded> = {}): TurnEnded {
  return {
    dwarfId: DWARF,
    turnKey: 'turn-7',
    kind: 'concluded',
    at: 1_790_000_000_000,
    reliability: 'reliable',
    cancelledFromApp: false,
    ...overrides
  }
}
const KINDS: readonly AttentionKind[] = ['permission', 'question', 'turn-finished']
const MINES = ['mine-0001', 'mine-0002', 'mine-0003', 'mine-0004'] as MineId[]

// A seeded property run (no generator library in the repo, as in crew's status properties): every
// case reproduces from the seed printed with a failure.
const CASES = 500

/** mulberry32: a small deterministic PRNG. */
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

describe('decideLevel3 (ADR-018 Verification)', () => {
  it('[US-SHELL-010.AC03, US-SET-006.AC01] an ask in a mine not on screen with system notifications on shows a notification titled by kind with the mine name as body', () => {
    const elsewhere = presence({ onScreenMineIds: new Set([OTHER_MINE]) })
    const hidden = presence({ anyWindowVisible: false })
    const closed = presence({ anyUiAttached: false, anyWindowVisible: false })

    for (const [kind, title] of [
      ['question', 'title(question, Gimli)'],
      ['permission', 'title(permission, Gimli)']
    ] as const) {
      for (const where of [elsewhere, hidden, closed]) {
        expect(decideLevel3(fact(kind), ON, where, NONE, NAMES, TITLE)).toStrictEqual({
          show: {
            key: `${DWARF}:${kind}:ask-1`,
            kind,
            title,
            body: 'Moria',
            mineId: MINE,
            dwarfId: DWARF,
            sensitive: true
          }
        })
      }
    }
    expect(decideLevel3(fact('turn-finished'), ON, hidden, NONE, NAMES, TITLE).show?.title).toBe(
      'title(turn-finished, Gimli)'
    )
  })

  it('[US-SHELL-010.AC04, US-SET-006.AC02, INV-101] property: never a notification for a mine in the union of onScreenMineIds, whatever the setting and the window visibility', () => {
    for (let seed = 1; seed <= CASES; seed += 1) {
      const random = prng(seed)
      const pick = (n: number) => Math.floor(random() * n)
      // One to four attached clients, each reporting its own on-screen mines and visibility.
      const reports: Presence[] = Array.from({ length: 1 + pick(4) }, (_, i) => ({
        anyUiAttached: true,
        anyWindowVisible: random() < 0.5,
        onScreenMineIds: new Set(MINES.filter(() => random() < 0.3)),
        seq: i + pick(10)
      }))
      const onScreen = reports.flatMap((r) => [...r.onScreenMineIds])
      if (onScreen.length === 0) continue
      const mineId = onScreen[pick(onScreen.length)] as MineId
      const kind = KINDS[pick(KINDS.length)] as AttentionKind
      const prefs = { systemNotificationsOn: random() < 0.5 }

      const decision = decideLevel3(
        fact(kind, { mineId }),
        prefs,
        unionPresence(reports),
        NONE,
        NAMES,
        TITLE
      )

      expect(decision.show, `seed ${seed}`).toBeUndefined()
    }
  })

  it('[US-SET-006.AC03] with system notifications off nothing is shown, whatever is on screen', () => {
    const screens = [
      presence(),
      presence({ onScreenMineIds: new Set([MINE]) }),
      presence({ onScreenMineIds: new Set([OTHER_MINE]) }),
      presence({ anyWindowVisible: false }),
      presence({ anyUiAttached: false, anyWindowVisible: false })
    ]
    for (const kind of KINDS) {
      for (const where of screens) {
        expect(decideLevel3(fact(kind), OFF, where, NONE, NAMES, TITLE)).toStrictEqual({})
      }
    }
  })

  it('[US-SHELL-010.AC05] the level-3 decision reads only systemNotificationsOn, never notificationSoundsOn', () => {
    for (const notificationSoundsOn of [true, false]) {
      for (const systemNotificationsOn of [true, false]) {
        const { prefs, reads } = watched({ systemNotificationsOn, notificationSoundsOn })

        const decision = decideLevel3(fact('question'), prefs, presence(), NONE, NAMES, TITLE)

        expect(reads).toStrictEqual(['systemNotificationsOn'])
        expect(decision.show !== undefined).toBe(systemNotificationsOn)
      }
    }
  })

  it('[US-SET-006.AC04] toggling system notifications changes no UI preference', () => {
    // The decision's inputs hold no UI preference it could change: a UI preference placed beside
    // the Host one is neither read nor written, whichever way the toggle goes.
    for (const systemNotificationsOn of [true, false, true]) {
      const { prefs, writes } = watched({ systemNotificationsOn, notificationSoundsOn: true })

      decideLevel3(fact('permission'), prefs, presence(), NONE, NAMES, TITLE)

      expect(writes).toStrictEqual([])
      expect(prefs).toStrictEqual({ systemNotificationsOn, notificationSoundsOn: true })
    }
  })

  it('[US-SHELL-010.AC07, INV-102] a turn-finished fact that is inferred or cancelled from the app never shows', () => {
    const quiet = [
      turnEnd({ reliability: 'inferred' }),
      turnEnd({ cancelledFromApp: true }),
      turnEnd({ reliability: 'inferred', cancelledFromApp: true }),
      turnEnd({ reliability: 'inferred', kind: 'interrupted' })
    ]
    for (const turn of quiet) {
      expect(turnFinishedFact(turn, MINE)).toBeUndefined()
    }

    const reliable = turnFinishedFact(turnEnd(), MINE)
    expect(reliable).toStrictEqual({
      key: `${DWARF}:turn-finished:turn-7`,
      kind: 'turn-finished',
      dwarfId: DWARF,
      mineId: MINE,
      at: 1_790_000_000_000,
      reannounce: true
    })
    expect(
      decideLevel3(reliable as AttentionFact, ON, presence(), NONE, NAMES, TITLE).show?.title
    ).toBe('title(turn-finished, Gimli)')
  })

  it('[S17.08] a reliable turn-finished fact with no ui client attached is suppressed, never shown later', () => {
    const closed = presence({ anyUiAttached: false, anyWindowVisible: false })
    const finished = turnFinishedFact(turnEnd(), MINE) as AttentionFact

    expect(decideLevel3(finished, ON, closed, NONE, NAMES, TITLE)).toStrictEqual({})
    expect(
      nextAttentionKey(undefined, {
        type: 'fact',
        fact: finished,
        gate: { prefs: ON, presence: closed },
        emitted: NONE
      })
    ).toStrictEqual({ ok: true, value: 'suppressed' })
    // A window reopening never announces it: machine 17 lists no way out of `suppressed` but the end.
    expect(
      nextAttentionKey('suppressed', {
        type: 'gate-changed',
        fact: finished,
        gate: { prefs: ON, presence: presence() }
      })
    ).toStrictEqual({ ok: false, error: 'not-listed' })
    // An ask is not held back by the closed app (S17.01): it may notify through the notifier.
    expect(decideLevel3(fact('question'), ON, closed, NONE, NAMES, TITLE).show?.key).toBe(
      `${DWARF}:question:ask-1`
    )
  })

  it('[INV-100, BR-02] a key already emitted is never shown again and no decision depends on elapsed time', () => {
    for (const kind of KINDS) {
      const emitted = new Set([`${DWARF}:${kind}:ask-1`])
      expect(decideLevel3(fact(kind), ON, presence(), emitted, NAMES, TITLE)).toStrictEqual({})
    }
    // The same fact decided at any instant, early or decades later, gets the same decision.
    const at = [0, 1, 59_999, 60_000, 1_790_000_000_000, Number.MAX_SAFE_INTEGER]
    for (const kind of KINDS) {
      const decisions = at.map((instant) =>
        decideLevel3(fact(kind, { at: instant }), ON, presence(), NONE, NAMES, TITLE)
      )
      for (const decision of decisions) expect(decision).toStrictEqual(decisions[0])
      expect(decisions[0]?.show).toBeDefined()
    }
  })

  it('[INV-103] an ask with reannounce false is treated as already emitted', () => {
    for (const kind of ['question', 'permission'] as const) {
      const reraised = fact(kind, { reannounce: false, replacesKey: `${DWARF}:${kind}:ask-0` })
      for (const where of [
        presence(),
        presence({ anyUiAttached: false, anyWindowVisible: false })
      ]) {
        expect(decideLevel3(reraised, ON, where, NONE, NAMES, TITLE)).toStrictEqual({})
        expect(
          nextAttentionKey(undefined, {
            type: 'fact',
            fact: reraised,
            gate: { prefs: ON, presence: where },
            emitted: NONE
          })
        ).toStrictEqual({ ok: true, value: 'suppressed' })
      }
    }
  })

  it('[US-SHELL-010.AC09, INV-104] the title uses the custom name when there is one, else the base name', () => {
    // The wiring route resolves crew's `customName ?? baseName` at emit time (lead decision
    // 2026-09-30); the title carries exactly that name, the same one the app shows everywhere.
    const custom = { displayName: 'Durin the Deathless', mineName: 'Erebor' }
    const base = { displayName: 'Claude 2', mineName: 'Erebor' }

    expect(decideLevel3(fact('question'), ON, presence(), NONE, custom, TITLE).show).toMatchObject({
      title: 'title(question, Durin the Deathless)',
      body: 'Erebor'
    })
    expect(decideLevel3(fact('question'), ON, presence(), NONE, base, TITLE).show?.title).toBe(
      'title(question, Claude 2)'
    )
    expect(
      KINDS.map((kind) => decideLevel3(fact(kind), ON, presence(), NONE, custom, TITLE).show?.title)
    ).toStrictEqual([
      'title(permission, Durin the Deathless)',
      'title(question, Durin the Deathless)',
      'title(turn-finished, Durin the Deathless)'
    ])
  })

  it('[INV-100, INV-101, INV-102, INV-103] every combination of kind, setting, presence, reliability, cancelledFromApp, emitted key and reannounce shows exactly when all ADR-018 item 2 conditions hold', () => {
    let shown = 0
    let cases = 0
    for (const kind of KINDS) {
      for (const systemNotificationsOn of [true, false]) {
        for (const anyUiAttached of [true, false]) {
          for (const anyWindowVisible of [true, false]) {
            for (const mineOnScreen of [true, false]) {
              for (const reliability of ['reliable', 'inferred'] as const) {
                for (const cancelledFromApp of [true, false]) {
                  for (const alreadyEmitted of [true, false]) {
                    for (const reannounce of [true, false]) {
                      // A turn-finished fact exists only for a turn end (always reannounce: true).
                      const turnFact =
                        kind === 'turn-finished'
                          ? turnFinishedFact(turnEnd({ reliability, cancelledFromApp }), MINE)
                          : undefined
                      if (kind === 'turn-finished' && !reannounce) continue
                      if (
                        kind !== 'turn-finished' &&
                        (reliability !== 'reliable' || cancelledFromApp)
                      )
                        continue
                      cases += 1
                      const f = kind === 'turn-finished' ? turnFact : fact(kind, { reannounce })
                      const where = presence({
                        anyUiAttached,
                        anyWindowVisible,
                        onScreenMineIds: new Set(mineOnScreen ? [MINE] : [OTHER_MINE])
                      })
                      const decision =
                        f === undefined
                          ? {}
                          : decideLevel3(
                              f,
                              { systemNotificationsOn },
                              where,
                              alreadyEmitted ? new Set([f.key]) : NONE,
                              NAMES,
                              TITLE
                            )

                      const expected =
                        systemNotificationsOn &&
                        !mineOnScreen &&
                        !alreadyEmitted &&
                        reannounce &&
                        (kind !== 'turn-finished' ||
                          (reliability === 'reliable' && !cancelledFromApp && anyUiAttached))
                      if (expected) shown += 1
                      expect(
                        decision.show !== undefined,
                        JSON.stringify({
                          kind,
                          systemNotificationsOn,
                          anyUiAttached,
                          anyWindowVisible,
                          mineOnScreen,
                          reliability,
                          cancelledFromApp,
                          alreadyEmitted,
                          reannounce
                        })
                      ).toBe(expected)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(cases).toBe(256)
    expect(shown).toBe(10)
  })

  it('[S17.02] an inferred or app-cancelled turn end gets no key and an ask with reannounce false is suppressed, and every other machine 17 transition reaches its target; a transition 07 does not list is rejected', () => {
    // S17.02: no key at all for an inferred or app-cancelled turn end.
    expect(turnFinishedFact(turnEnd({ reliability: 'inferred' }), MINE)).toBeUndefined()
    expect(turnFinishedFact(turnEnd({ cancelledFromApp: true }), MINE)).toBeUndefined()

    const ask = fact('question')
    const finished = turnFinishedFact(turnEnd(), MINE) as AttentionFact
    const open = { prefs: ON, presence: presence() }
    const offGate = { prefs: OFF, presence: presence() }
    const onScreen = { prefs: ON, presence: presence({ onScreenMineIds: new Set([MINE]) }) }
    const closedApp = {
      prefs: ON,
      presence: presence({ anyUiAttached: false, anyWindowVisible: false })
    }
    const newFact = (f: AttentionFact, gate: typeof open, emitted = NONE): AttentionKeyEvent => ({
      type: 'fact',
      fact: f,
      gate,
      emitted
    })
    const gateChanged = (f: AttentionFact, gate: typeof open): AttentionKeyEvent => ({
      type: 'gate-changed',
      fact: f,
      gate
    })
    const ended: AttentionKeyEvent = { type: 'fact-ended' }
    const clicked: AttentionKeyEvent = { type: 'clicked' }
    const restarted: AttentionKeyEvent = { type: 'host-restarted' }

    const listed: [string, AttentionKeyState | undefined, AttentionKeyEvent, AttentionKeyState][] =
      [
        ['S17.01', undefined, newFact(ask, open), 'emitted'],
        ['S17.01', undefined, newFact(ask, closedApp), 'emitted'],
        ['S17.01', undefined, newFact(finished, open), 'emitted'],
        ['S17.01', undefined, newFact(ask, offGate), 'gated'],
        ['S17.01', undefined, newFact(finished, onScreen), 'gated'],
        [
          'S17.02',
          undefined,
          newFact(fact('permission', { reannounce: false }), open),
          'suppressed'
        ],
        ['S17.03', 'gated', gateChanged(ask, open), 'emitted'],
        ['S17.03', 'gated', gateChanged(finished, open), 'emitted'],
        ['S17.03', 'gated', gateChanged(ask, onScreen), 'gated'],
        ['S17.04', 'gated', ended, 'withdrawn'],
        ['S17.05', 'emitted', ended, 'withdrawn'],
        ['S17.06', 'emitted', clicked, 'emitted'],
        ['S17.07', 'emitted', restarted, 'emitted'],
        ['S17.08', undefined, newFact(finished, closedApp), 'suppressed'],
        ['S17.08', 'gated', gateChanged(finished, closedApp), 'suppressed'],
        ['S17.09', 'suppressed', ended, 'withdrawn']
      ]
    for (const [id, from, event, to] of listed) {
      expect(
        nextAttentionKey(from, event),
        `${id} from ${from ?? '[*]'} on ${event.type}`
      ).toStrictEqual({
        ok: true,
        value: to
      })
    }

    // INV-100, S17.07: a key already decided is never decided again.
    expect(nextAttentionKey(undefined, newFact(ask, open, new Set([ask.key])))).toStrictEqual({
      ok: false,
      error: 'already-decided'
    })

    const unlisted: [AttentionKeyState | undefined, AttentionKeyEvent][] = [
      [undefined, gateChanged(ask, open)],
      [undefined, ended],
      [undefined, clicked],
      [undefined, restarted],
      ['gated', newFact(ask, open)],
      ['gated', clicked],
      ['gated', restarted],
      ['emitted', newFact(ask, open)],
      ['emitted', gateChanged(ask, open)],
      ['suppressed', newFact(ask, open)],
      ['suppressed', gateChanged(ask, open)],
      ['suppressed', clicked],
      ['suppressed', restarted],
      ['withdrawn', newFact(ask, open)],
      ['withdrawn', gateChanged(ask, open)],
      ['withdrawn', ended],
      ['withdrawn', clicked],
      ['withdrawn', restarted]
    ]
    for (const [from, event] of unlisted) {
      expect(nextAttentionKey(from, event), `${from ?? '[*]'} on ${event.type}`).toStrictEqual({
        ok: false,
        error: 'not-listed'
      })
    }
  })
})

/** A preferences object that records every property read and write made on it. */
function watched<T extends object>(target: T): { prefs: T; reads: string[]; writes: string[] } {
  const reads: string[] = []
  const writes: string[] = []
  const prefs = new Proxy(target, {
    get(t, property, receiver) {
      if (typeof property === 'string') reads.push(property)
      return Reflect.get(t, property, receiver) as unknown
    },
    set(t, property, value, receiver) {
      writes.push(String(property))
      return Reflect.set(t, property, value, receiver)
    }
  })
  return { prefs, reads, writes }
}
