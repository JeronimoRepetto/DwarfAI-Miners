import { describe, expect, it } from 'vitest'
import { DWARF_SILENCE_WINDOW_MS } from '../../../shared/contracts'
import type { DwarfRole, DwarfStatus, MineTier } from '../types'
import { MATERIALS } from '../types'
import { emptyMaterialTotals } from './vault/vault'
import {
  AWAITING_ANSWER_ANIMATION,
  BUBBLE_MAX_CHARS,
  LEAVING_EXIT_MS,
  NEUTRAL_DWARF_FRAME,
  WALK_ANIMATION,
  describeSilence,
  dwarfAnimation,
  isDwarfSilent,
  isPickImpact,
  isSpriteFlipped,
  materialLabel,
  orePileLabel,
  sceneDwarfAnimation,
  statusAnimationClass,
  tierLabel,
  vaultLabel
} from './presentation'

describe('statusAnimationClass', () => {
  it('maps every dwarf status to its animation class', () => {
    const expected: Record<DwarfStatus, string> = {
      working: 'is-working',
      waiting: 'is-waiting',
      leaving: 'is-leaving'
    }
    for (const status of Object.keys(expected) as DwarfStatus[]) {
      expect(statusAnimationClass(status)).toBe(expected[status])
    }
  })
})

describe('tierLabel', () => {
  it('capitalizes each tier for display', () => {
    const cases: Record<MineTier, string> = {
      bronze: 'Bronze',
      copper: 'Copper',
      silver: 'Silver',
      gold: 'Gold',
      uranium: 'Uranium'
    }
    for (const tier of Object.keys(cases) as MineTier[]) {
      expect(tierLabel(tier)).toBe(cases[tier])
    }
  })
})

describe('BUBBLE_MAX_CHARS', () => {
  it('keeps speech bubbles around seventy characters', () => {
    expect(BUBBLE_MAX_CHARS).toBe(70)
  })
})

describe('dwarfAnimation', () => {
  it('swings the pickaxe while a worker is working', () => {
    expect(dwarfAnimation('working', 'worker')).toEqual({
      frames: ['pick-1', 'pick-2'],
      frameMs: 550
    })
  })

  it('sits a waiting worker down on one resting pose and leaves it there', () => {
    // Was the two-frame ['rest-1', 'rest-2'] pair until issue #72 retired the
    // painted z: the second frame differed from the first by that glyph alone,
    // and the CSS z z z was already saying the same thing over the top of it.
    expect(dwarfAnimation('waiting', 'worker')).toEqual({
      frames: ['rest-1'],
      frameMs: 1400
    })
  })

  it('has the foreman check the log book while working', () => {
    expect(dwarfAnimation('working', 'foreman')).toEqual({
      frames: ['foreman-idle', 'foreman-check'],
      frameMs: 1000
    })
  })

  it('rests a waiting foreman on the worker rest frames until foreman art exists', () => {
    // Issue #34: dedicated foreman-waiting artwork is explicitly deferred, so a
    // blocked foreman temporarily reuses the worker sleeping/rest animation —
    // it must read as paused, not as a foreman still checking the log book.
    expect(dwarfAnimation('waiting', 'foreman')).toEqual({
      frames: ['rest-1'],
      frameMs: 1400
    })
    expect(dwarfAnimation('waiting', 'foreman')).toEqual(dwarfAnimation('waiting', 'worker'))
  })

  it('walks anyone who is leaving, foreman included', () => {
    const walking = { frames: ['walk-1', 'walk-2'], frameMs: 350 }
    expect(dwarfAnimation('leaving', 'worker')).toEqual(walking)
    expect(dwarfAnimation('leaving', 'foreman')).toEqual(walking)
  })

  it('covers every status and role combination with at least one frame', () => {
    const statuses: DwarfStatus[] = ['working', 'waiting', 'leaving']
    const roles: DwarfRole[] = ['worker', 'foreman']
    for (const status of statuses) {
      for (const role of roles) {
        const animation = dwarfAnimation(status, role)
        expect(animation.frames.length).toBeGreaterThan(0)
        expect(animation.frameMs).toBeGreaterThan(0)
      }
    }
  })
})

describe('NEUTRAL_DWARF_FRAME', () => {
  it('is the plain standing pose used for brief transitions', () => {
    expect(NEUTRAL_DWARF_FRAME).toBe('idle')
  })

  it('is never part of a running animation, so it reads as a pause', () => {
    const statuses: DwarfStatus[] = ['working', 'waiting', 'leaving']
    const roles: DwarfRole[] = ['worker', 'foreman']
    for (const status of statuses) {
      for (const role of roles) {
        expect(dwarfAnimation(status, role).frames).not.toContain(NEUTRAL_DWARF_FRAME)
      }
    }
  })

  it('is exactly what a silent worker stands on, because that is the pause (issue #47)', () => {
    // The pose was held back from every running loop above so that showing it
    // would read as "supposed to be working, and nothing is happening". That
    // is the sentence #47 needed a picture for, so it spends the reserve
    // rather than adding art — and it stays out of the running loops.
    expect(dwarfAnimation('working', 'worker', true).frames).toEqual([NEUTRAL_DWARF_FRAME])
  })
})

describe('isSpriteFlipped', () => {
  it('mirrors only a leaving dwarf, because the art faces right and the exit is left', () => {
    expect(isSpriteFlipped('leaving')).toBe(true)
    expect(isSpriteFlipped('working')).toBe(false)
    expect(isSpriteFlipped('waiting')).toBe(false)
  })
})

describe('LEAVING_EXIT_MS', () => {
  it('matches the runtime grace window a leaving dwarf has to walk out', () => {
    expect(LEAVING_EXIT_MS).toBe(16_000)
  })
})

/*
 * Issue #19 — the cave stopped being a backdrop. A dwarf now walks to the
 * painted feature its status calls for, so the frame loops have to cover the
 * journey as well as the destination.
 */
describe('WALK_ANIMATION', () => {
  it('reuses the painted walk cycle, so crossing the floor needs no new art', () => {
    expect(WALK_ANIMATION).toEqual({ frames: ['walk-1', 'walk-2'], frameMs: 350 })
    expect(WALK_ANIMATION).toEqual(dwarfAnimation('leaving', 'worker'))
  })
})

describe('sceneDwarfAnimation', () => {
  it('walks any dwarf that is mid-crossing, whatever it is on its way to do', () => {
    const statuses: DwarfStatus[] = ['working', 'waiting', 'leaving']
    const roles: DwarfRole[] = ['worker', 'foreman']
    for (const status of statuses) {
      for (const role of roles) {
        expect(sceneDwarfAnimation(status, role, true), `${status}/${role}`).toEqual(WALK_ANIMATION)
      }
    }
  })

  it('hands back to the status loop the moment the dwarf arrives', () => {
    expect(sceneDwarfAnimation('working', 'worker', false)).toEqual(
      dwarfAnimation('working', 'worker')
    )
    expect(sceneDwarfAnimation('waiting', 'foreman', false)).toEqual(
      dwarfAnimation('waiting', 'foreman')
    )
  })
})

describe('isPickImpact', () => {
  it('marks the down-stroke of the swing — the frame whose hit throws sparks', () => {
    expect(isPickImpact('pick-2')).toBe(true)
  })

  it('marks no other pose, so nothing sparks while resting or walking past', () => {
    for (const frame of ['idle', 'pick-1', 'walk-1', 'walk-2', 'rest-1', 'rest-2'] as const) {
      expect(isPickImpact(frame), frame).toBe(false)
    }
  })
})

/*
 * The CSS nuggets read as anonymous grey balls, so the pile has to say what it
 * is. The painted art has since landed and the wording survived the swap
 * unchanged, which is exactly why it lives here and not in the template.
 *
 * What DID change is the arithmetic behind the count: the pile is now a pile of
 * ONE material, so the amount is that material's own tokens divided by its own
 * grain size (MATERIAL_TOKENS_PER_UNIT) instead of everything divided by the
 * single flat TOKENS_PER_ORE the app shipped with. Coarse ore therefore reads
 * as fewer, bigger nuggets for the same tokens — see the gold/uranium cases.
 */
describe('orePileLabel', () => {
  it('names the material and the amount rather than leaving a nameless heap', () => {
    expect(orePileLabel('gold', 1_200_000)).toBe('Gold ore — 12 mined (1.2M tokens)')
    expect(orePileLabel('uranium', 250_000)).toBe('Uranium ore — 1 mined (250K tokens)')
  })

  it('says plainly that nothing has been mined instead of implying a pile', () => {
    expect(orePileLabel('bronze', 0)).toBe('Bronze ore — none mined yet')
    expect(orePileLabel('bronze', 9_999)).toBe('Bronze ore — none mined yet')
  })

  /*
   * Coal belongs to no tier at all — it is the material of every token burned
   * before the app existed — so the label has to work for a material that no
   * mine will ever be "on".
   */
  it('labels coal, which no tier produces, exactly like any other ore', () => {
    expect(orePileLabel('coal', 25_000)).toBe('Coal ore — 10 mined (25K tokens)')
  })
})

describe('materialLabel', () => {
  it('names every material the vault can hold', () => {
    expect(MATERIALS.map((material) => materialLabel(material))).toEqual([
      'Coal',
      'Bronze',
      'Copper',
      'Silver',
      'Gold',
      'Uranium'
    ])
  })
})

/*
 * The vault chip's accessible name. Materials never convert into one another,
 * so this lists them one by one and deliberately never adds their units up: a
 * single combined figure would imply exactly the exchange rate #22 refuses.
 */
describe('vaultLabel', () => {
  it('names each material separately, poorest first, and never sums them', () => {
    const totals = { ...emptyMaterialTotals(), coal: 25_000, gold: 300_000 }
    expect(vaultLabel(totals, 125_000)).toBe('Vault: 10 coal, 3 gold. 125K tokens observed.')
  })

  it('says the vault is empty rather than showing a bare zero', () => {
    expect(vaultLabel(emptyMaterialTotals(), 0)).toBe(
      'Vault: nothing mined yet. 0 tokens observed.'
    )
  })

  it('treats a snapshot that carries no breakdown as an empty vault', () => {
    expect(vaultLabel(undefined, 500)).toBe('Vault: nothing mined yet. 500 tokens observed.')
  })
})

/*
 * Issue #47 — a dwarf that had produced nothing for twenty-nine minutes looked
 * exactly like one that finished a tool call a second ago, right up until it
 * vanished at thirty. The provider now puts the figure on the wire; these pin
 * what the panel is allowed to do with it.
 *
 * Two properties are load-bearing throughout. The windows are the PROVIDER's
 * own staleness windows (#40), read rather than re-invented, so the panel can
 * never say "still working" about a dwarf the provider is already judging. And
 * silence is a presentation layer over `working` — never a fourth DwarfStatus,
 * which the ledger, the delivery channels and the capability matrix all key
 * off.
 */
describe('isDwarfSilent', () => {
  const { foreman, worker } = DWARF_SILENCE_WINDOW_MS

  it('scales the window to the role, matching the provider staleness rule', () => {
    // A foreman legitimately idles for as long as a human takes to type; a
    // worker cannot wait on anyone, so its silence is judged twice as soon.
    expect(foreman).toBe(60 * 60_000)
    expect(worker).toBe(30 * 60_000)
  })

  it('calls a dwarf silent the moment its own window has exactly elapsed', () => {
    // Same side of the boundary the provider picks for the same numbers.
    expect(isDwarfSilent('worker', worker)).toBe(true)
    expect(isDwarfSilent('worker', worker - 1)).toBe(false)
    expect(isDwarfSilent('foreman', foreman)).toBe(true)
    expect(isDwarfSilent('foreman', foreman - 1)).toBe(false)
  })

  it('judges each role against its own window rather than one shared number', () => {
    const betweenTheTwo = 45 * 60_000
    expect(isDwarfSilent('worker', betweenTheTwo)).toBe(true)
    expect(isDwarfSilent('foreman', betweenTheTwo)).toBe(false)
  })

  it('stays quiet about a provider that has no per-agent evidence at all', () => {
    // Codex writes no per-subagent transcript, so there is no mtime to read
    // and the field is absent. Absence of evidence is not evidence of silence.
    expect(isDwarfSilent('worker', undefined)).toBe(false)
    expect(isDwarfSilent('foreman', undefined)).toBe(false)
  })
})

describe('dwarfAnimation while silent', () => {
  it('stands a silent worker still, pick on the shoulder, instead of swinging', () => {
    expect(dwarfAnimation('working', 'worker', true)).toEqual({ frames: ['idle'], frameMs: 550 })
  })

  it('leaves a silent foreman on his own idle pose rather than the worker one', () => {
    // He already has a pose that carries this meaning for his rank, so the
    // change costs no art here either — it only stops him checking the book.
    expect(dwarfAnimation('working', 'foreman', true)).toEqual({
      frames: ['foreman-idle'],
      frameMs: 1000
    })
  })

  it('draws the silence pose in a single frame, which starts no timer at all', () => {
    // Quietly correct: a dwarf we suspect is dead should not cost more to draw
    // than a live one. The sprite starts no interval for a one-frame loop.
    for (const role of ['worker', 'foreman'] as const) {
      expect(dwarfAnimation('working', role, true).frames, role).toHaveLength(1)
    }
  })

  it('changes nothing for a dwarf that is not working', () => {
    // Silence layers over `working` alone. A waiting dwarf is provably blocked
    // and a leaving one is already on its way out — neither needs a second
    // rendering of the same fact.
    for (const status of ['waiting', 'leaving'] as const) {
      for (const role of ['worker', 'foreman'] as const) {
        expect(dwarfAnimation(status, role, true), `${status}/${role}`).toEqual(
          dwarfAnimation(status, role)
        )
      }
    }
  })

  it('swings as it always did when nothing says the dwarf is silent', () => {
    expect(dwarfAnimation('working', 'worker', false)).toEqual({
      frames: ['pick-1', 'pick-2'],
      frameMs: 550
    })
    expect(dwarfAnimation('working', 'worker')).toEqual(dwarfAnimation('working', 'worker', false))
  })

  it('never borrows another status pose, so silence cannot be misread as one', () => {
    // The constraint the whole change hangs on: this is a fourth *picture*,
    // not a fourth state. Reusing the resting or walking loop would make a
    // suspected ghost indistinguishable from a dwarf that really is waiting.
    const silentWorker = dwarfAnimation('working', 'worker', true)
    expect(silentWorker).not.toEqual(dwarfAnimation('waiting', 'worker'))
    expect(silentWorker).not.toEqual(dwarfAnimation('leaving', 'worker'))
    expect(statusAnimationClass('working')).toBe('is-working')
  })
})

describe('sceneDwarfAnimation while silent', () => {
  it('keeps a silent dwarf walking while it is still crossing the floor', () => {
    // Travel outranks everything, exactly as it does for the other loops: a
    // dwarf mid-stride must not be standing still with its pick shouldered.
    expect(sceneDwarfAnimation('working', 'worker', true, true)).toEqual(WALK_ANIMATION)
  })

  it('drops it onto the silence pose the moment it arrives', () => {
    expect(sceneDwarfAnimation('working', 'worker', false, true)).toEqual(
      dwarfAnimation('working', 'worker', true)
    )
  })

  it('animates a dwarf with no silence figure exactly as it did before', () => {
    for (const walking of [true, false]) {
      expect(sceneDwarfAnimation('working', 'worker', walking), String(walking)).toEqual(
        sceneDwarfAnimation('working', 'worker', walking, false)
      )
    }
  })
})

/*
 * The tooltip's sentence. It lives here rather than in the template for the
 * same reason orePileLabel does: the wording is the affordance — "no output
 * for 25 minutes" is what makes a dwarf leaving at thirty need no explanation.
 */
describe('describeSilence', () => {
  it('says how long the dwarf has produced nothing, in plain words', () => {
    expect(describeSilence(25 * 60_000)).toBe('no output for 25 minutes')
    expect(describeSilence(90 * 60_000)).toBe('no output for 1 hour 30 minutes')
  })

  it('keeps the singular singular', () => {
    expect(describeSilence(60_000)).toBe('no output for 1 minute')
    expect(describeSilence(60 * 60_000)).toBe('no output for 1 hour')
  })

  it('drops an empty minutes tail from a whole number of hours', () => {
    expect(describeSilence(2 * 60 * 60_000)).toBe('no output for 2 hours')
  })

  it('rounds down, so it never claims more silence than was observed', () => {
    expect(describeSilence(25 * 60_000 + 59_999)).toBe('no output for 25 minutes')
    expect(describeSilence(60 * 60_000 + 59_999)).toBe('no output for 1 hour')
  })

  it('says less than a minute rather than counting seconds nobody reads', () => {
    expect(describeSilence(0)).toBe('no output for less than a minute')
    expect(describeSilence(59_999)).toBe('no output for less than a minute')
  })
})

/**
 * Issue #60. A dwarf whose provider proved a human has been asked a question
 * gets its own loop, so "I need you" is distinguishable from generic rest.
 *
 * The paintings for it do not exist yet, and the issue is explicit that they
 * must not be faked: the loop is wired now and points at the rest frames until
 * the two "awaiting answer" foreman poses are commissioned. These tests pin the
 * WIRING, not the frames, so the art can drop in without a second refactor.
 */
describe('dwarfAnimation while awaiting an answer', () => {
  it('selects the awaiting-answer loop only on proof a human was asked', () => {
    // Reference identity, not frame equality: the loop currently HOLDS the rest
    // frames, so an equality check here would pass even with the branch gone.
    expect(dwarfAnimation('waiting', 'foreman', false, 'user-input')).toBe(
      AWAITING_ANSWER_ANIMATION.foreman
    )
    expect(dwarfAnimation('waiting', 'worker', false, 'user-input')).toBe(
      AWAITING_ANSWER_ANIMATION.worker
    )
    expect(dwarfAnimation('waiting', 'foreman')).not.toBe(AWAITING_ANSWER_ANIMATION.foreman)
  })

  it('leaves every unproven reason on the ordinary rest loop', () => {
    // 'unknown' is the reason that must never behave like 'user-input', here as
    // much as in the eviction rule: an open dialog is not a question.
    for (const reason of ['approval', 'unknown', undefined] as const) {
      expect(dwarfAnimation('waiting', 'foreman', false, reason), String(reason)).toEqual(
        dwarfAnimation('waiting', 'foreman')
      )
    }
  })

  it('holds the rest frames until the awaiting-answer poses are painted', () => {
    // Deliberate and temporary. The moment two foreman poses exist this
    // expectation is the one that changes, and nothing else has to.
    expect(AWAITING_ANSWER_ANIMATION.foreman).toEqual(dwarfAnimation('waiting', 'foreman'))
    expect(AWAITING_ANSWER_ANIMATION.worker).toEqual(dwarfAnimation('waiting', 'worker'))
  })

  it('never shows an awaiting-answer pose to a dwarf that is working or leaving', () => {
    // The reason rides on a blocked dwarf. A working one is producing and a
    // leaving one is already on its way out; neither is waiting on anybody.
    for (const status of ['working', 'leaving'] as const) {
      expect(dwarfAnimation(status, 'foreman', false, 'user-input'), status).toEqual(
        dwarfAnimation(status, 'foreman')
      )
    }
  })

  it('is never the silence pose, whatever the loop it borrows is made of', () => {
    // #60 asks for attentive, not asleep, and pinned that as "keeps two
    // frames" back when every active loop was a pair — a single frame would
    // then have read as the silence pose (#47), which says the opposite thing
    // about the dwarf. Issue #72 retired the painted z, so the rest loop this
    // placeholder borrows is a single pose now and a frame count stands in for
    // nothing. What it was standing in for is pinned directly instead.
    for (const role of ['worker', 'foreman'] as const) {
      expect(AWAITING_ANSWER_ANIMATION[role], role).not.toEqual(
        dwarfAnimation('working', role, true)
      )
      expect(AWAITING_ANSWER_ANIMATION[role].frames, role).not.toContain(NEUTRAL_DWARF_FRAME)
    }
  })
})

describe('sceneDwarfAnimation while awaiting an answer', () => {
  it('keeps a dwarf walking until it reaches its spot, as every other loop does', () => {
    expect(sceneDwarfAnimation('waiting', 'foreman', true, false, 'user-input')).toEqual(
      WALK_ANIMATION
    )
  })

  it('drops onto the awaiting-answer loop once it has arrived', () => {
    expect(sceneDwarfAnimation('waiting', 'foreman', false, false, 'user-input')).toEqual(
      dwarfAnimation('waiting', 'foreman', false, 'user-input')
    )
  })

  it('animates a dwarf with no reason exactly as it did before', () => {
    for (const walking of [true, false]) {
      expect(sceneDwarfAnimation('waiting', 'foreman', walking), String(walking)).toEqual(
        sceneDwarfAnimation('waiting', 'foreman', walking, false, undefined)
      )
    }
  })
})

/*
 * Issue #72 — a resting dwarf carried two sleep indicators at once: the `z`
 * painted into `rest-2`, and the CSS `z z z` DwarfSprite floats over the same
 * image. The CSS one is the one that stays, so no loop plays the painted frame
 * any more and rest is a single pose rather than a two-frame cycle whose whole
 * content was one glyph (silhouette IoU 0.994 — see docs/animation-loops.md).
 */
describe('the rest loop, with the painted z retired', () => {
  /** Every loop the panel can actually select, whatever the dwarf is doing. */
  function everyLoop(): { where: string; animation: ReturnType<typeof dwarfAnimation> }[] {
    const found: { where: string; animation: ReturnType<typeof dwarfAnimation> }[] = []
    for (const status of ['working', 'waiting', 'leaving'] as const) {
      for (const role of ['worker', 'foreman'] as const) {
        for (const silent of [false, true]) {
          for (const reason of [undefined, 'approval', 'unknown', 'user-input'] as const) {
            found.push({
              where: `${status}/${role}/silent=${silent}/${reason}`,
              animation: dwarfAnimation(status, role, silent, reason)
            })
          }
        }
      }
    }
    found.push({ where: 'walking', animation: WALK_ANIMATION })
    return found
  }

  it('rests on one pose, because the painted z was the whole of the animation', () => {
    for (const role of ['worker', 'foreman'] as const) {
      expect(dwarfAnimation('waiting', role).frames, role).toEqual(['rest-1'])
    }
  })

  it('plays the painted-z frame in no loop at all, so one indicator is left', () => {
    for (const { where, animation } of everyLoop()) {
      expect(animation.frames, where).not.toContain('rest-2')
    }
  })

  it('keeps the tempo it always rested at, so nothing else has to move', () => {
    expect(dwarfAnimation('waiting', 'worker').frameMs).toBe(1400)
  })
})
