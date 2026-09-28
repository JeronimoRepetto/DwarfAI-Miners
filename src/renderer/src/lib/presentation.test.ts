import { describe, expect, it } from 'vitest'
import type { MineTier } from '../types'
import { DWARF_SILENCE_WINDOW_MS, MATERIALS } from '../types'
import {
  LEAVING_EXIT_MS,
  groupDigits,
  isDwarfSilent,
  materialLabel,
  orePileLabel,
  tierLabel
} from './presentation'

/*
 * REMOVED for #635, stated rather than passing unseen, with the scene they served (the mine
 * column replaced MineScene, DwarfSprite, DwarfTooltip and VaultChip):
 * - statusAnimationClass, "maps every dwarf status to its animation class": the redesigned dwarf
 *   says its state on `data-status` (SceneDwarf.test.ts, "says which state it is in").
 * - BUBBLE_MAX_CHARS, "keeps speech bubbles around seventy characters": the talk bubble is retired
 *   by the design (MineColumn.test.ts's note).
 * - LEAVING_EXIT_MS and its two tests went too, and came back with today's walk (PANEL-QUESTIONS
 *   14): RESTORED below under their old names.
 * - vaultLabel, its three cases: the vault chip went; each capsule names its own material and
 *   count (VaultStrip.test.ts, OreCapsule.test.ts).
 * - describeSilence, its five cases: the redesigned tooltip writes "silent 25m"
 *   (lib/dwarf/dwarfTip.test.ts, compactSilence), rounding down as this did.
 */

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

/*
 * REMOVED HERE: the frame-loop suites (issues #74, #87).
 *
 * Forty-one cases stood between this note and `isSpriteFlipped` below, and in
 * three further blocks lower down. They pinned `dwarfAnimation`,
 * `sceneDwarfAnimation`, `stillDwarfAnimation`, `WALK_ANIMATION`,
 * `AWAITING_ANSWER_ANIMATION`, `NEUTRAL_DWARF_FRAME` and `isPickImpact` — the
 * machinery that named nine painted poses and cycled them by name.
 *
 * They went because their subject went. The hand-drawn dwarfs arrive as packed
 * sprite sheets, so an animation is a FILE and not a list of pose names, and
 * there is nothing left for a pose union to name. The suites that replace them
 * live beside the code that replaced it:
 *
 *   lib/sprite/spriteSheet.test.ts    which frame is showing, and when
 *   lib/sprite/dwarfSheets.test.ts    the strips, checked against the PNGs
 *   lib/sprite/dwarfSequence.test.ts  which strips a dwarf plays, and in what
 *                                     order — including #60's awaiting-answer
 *                                     signal, #71's held frame, and the states
 *                                     the new art cannot yet tell apart
 *
 * Named individually so a search for any of them lands somewhere: the loop
 * tables ("swings the pickaxe while a worker is working" and the five beside
 * it), the NEUTRAL_DWARF_FRAME trio, WALK_ANIMATION, sceneDwarfAnimation, the
 * isPickImpact pair, the six silent-loop cases and the three scene ones, the
 * five awaiting-answer cases and their three scene twins, the three that held
 * the painted `z` retired (#72), and the seven behind stillDwarfAnimation.
 *
 * What did NOT go: `isDwarfSilent` below is untouched (and `describeSilence` was, until #635),
 * because #47's windows and #68's attendance rule are about the provider and
 * not about drawing. What changed for them is only that no sheet has been
 * drawn for a silent dwarf yet, so nothing currently selects a picture.
 */

/*
 * REMOVED HERE: the one `isSpriteFlipped` case (#156).
 *
 * It asserted that a leaving dwarf is mirrored "because the art faces right and
 * the exit is left". The art faces LEFT — measured off the committed sheets,
 * which is the coverage that replaces this one, in
 * lib/sprite/sheetFacing.test.ts — so a leaver reaches the exit drawn exactly as
 * painted and the function had no case left to decide. The mirror is now the
 * scene's own facing, pinned in SceneDwarf.test.ts ("mirrors a dwarf facing right and draws
 * one facing left as painted") since #635 replaced DwarfSprite.
 */

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
describe('isDwarfSilent', () => {
  const { attended, unattended } = DWARF_SILENCE_WINDOW_MS

  it('scales the window to whether anyone can answer, matching the provider staleness rule', () => {
    // A session a human sits at legitimately idles for as long as they take to
    // type; one nobody can type into cannot wait on anyone, so its silence is
    // judged twice as soon. Named for the keyboard rather than the rank since
    // issue #68 — the numbers are the same two.
    expect(attended).toBe(60 * 60_000)
    expect(unattended).toBe(30 * 60_000)
  })

  it('calls a dwarf silent the moment its own window has exactly elapsed', () => {
    // Same side of the boundary the provider picks for the same numbers.
    expect(isDwarfSilent('worker', unattended)).toBe(true)
    expect(isDwarfSilent('worker', unattended - 1)).toBe(false)
    expect(isDwarfSilent('foreman', attended)).toBe(true)
    expect(isDwarfSilent('foreman', attended - 1)).toBe(false)
  })

  it('judges each role against its own window rather than one shared number', () => {
    const betweenTheTwo = 45 * 60_000
    expect(isDwarfSilent('worker', betweenTheTwo)).toBe(true)
    expect(isDwarfSilent('foreman', betweenTheTwo)).toBe(false)
    // #157: the panel judges a worker2 on the worker's half hour, because the
    // provider's staleness rule does. The two reading the same silence through
    // different windows is the disagreement these windows live on the wire to
    // prevent, and a new rank is exactly where that drift would start.
    expect(isDwarfSilent('worker2', betweenTheTwo)).toBe(true)
  })

  it('stays quiet about a provider that has no per-agent evidence at all', () => {
    // Codex writes no per-subagent transcript, so there is no mtime to read
    // and the field is absent. Absence of evidence is not evidence of silence.
    expect(isDwarfSilent('worker', undefined)).toBe(false)
    expect(isDwarfSilent('foreman', undefined)).toBe(false)
  })

  /*
   * Issue #68. Rank is topology: every root session is a foreman, and a
   * headless `claude -p` run is a root. So the hour that exists because a
   * human might be typing was being spent on sessions with nobody there.
   */
  it('judges a headless foreman on the half hour, since nobody can be typing into it', () => {
    const betweenTheTwo = 45 * 60_000
    expect(isDwarfSilent('foreman', betweenTheTwo, 'unattended')).toBe(true)
    expect(isDwarfSilent('foreman', unattended, 'unattended')).toBe(true)
    expect(isDwarfSilent('foreman', unattended - 1, 'unattended')).toBe(false)
  })

  it('keeps the hour for a foreman a human is proven to be sitting at', () => {
    const betweenTheTwo = 45 * 60_000
    expect(isDwarfSilent('foreman', betweenTheTwo, 'attended')).toBe(false)
  })

  it('keeps the hour for a foreman whose provider proved nothing about attendance', () => {
    // Unproven must behave like neither of the other two by accident: it may
    // not shorten the window (that would call a live session silent), and the
    // value itself stays distinguishable so nothing can seal a decision on it.
    const betweenTheTwo = 45 * 60_000
    expect(isDwarfSilent('foreman', betweenTheTwo, 'unknown')).toBe(false)
    expect(isDwarfSilent('foreman', betweenTheTwo, undefined)).toBe(false)
    expect(isDwarfSilent('foreman', betweenTheTwo)).toBe(false)
  })

  it('never lengthens a worker window on a provider claim about attendance', () => {
    // A spawned subagent has no channel of its own, so no human can be typing
    // into it whatever a provider stamps.
    const betweenTheTwo = 45 * 60_000
    expect(isDwarfSilent('worker', betweenTheTwo, 'attended')).toBe(true)
    expect(isDwarfSilent('worker', betweenTheTwo, 'unknown')).toBe(true)
  })
})

/*
 * The tooltip's sentence. It lives here rather than in the template for the
 * same reason orePileLabel does: the wording is the affordance — "no output
 * for 25 minutes" is what makes a dwarf leaving at thirty need no explanation.
 */
describe('groupDigits', () => {
  it('writes a whole number with comma thousands', () => {
    expect(groupDigits(0)).toBe('0')
    expect(groupDigits(12)).toBe('12')
    expect(groupDigits(9999)).toBe('9,999')
    expect(groupDigits(1630)).toBe('1,630')
    expect(groupDigits(1234567)).toBe('1,234,567')
  })

  it('never writes a fraction', () => {
    expect(groupDigits(1630.7)).toBe('1,630')
  })
})

/*
 * RESTORED for #635 (PANEL-QUESTIONS 14: today's walk stays), as they stood at 88ee3fc. How long a
 * departed session stays in the board is main's (`dwarfLeaveGraceS`, 20s); how long its dwarf
 * takes to fade once it has walked out is the panel's, and it is prompt (#153).
 */
describe('LEAVING_EXIT_MS', () => {
  it('takes a leaving dwarf off the screen promptly', () => {
    expect(LEAVING_EXIT_MS).toBe(1_200)
  })

  it('is far shorter than the grace window it used to fill', () => {
    expect(LEAVING_EXIT_MS).toBeLessThan(20_000 / 4)
  })
})
