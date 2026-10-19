import { describe, expect, it } from 'vitest'
import {
  cueKey,
  isAnnounceableEnd,
  shouldPlayCue,
  type AttentionCueEvent,
  type CueGates
} from './attentionCueRules'

/*
 * THE LEVEL-2 RULE (ISSUE-117; ADR-018 item 8, ADR-021 item 3).
 *
 * Pure: whether one need's attention cue plays, given the three facts the renderer of a mode window holds — the
 * Notification sounds switch, whether this window is the shown one, and whether the need's key was already seen.
 * The rule takes no mode and no mine: which mode window is shown (Panel, Veta, Valle) and which mine has focus are
 * not inputs, which is how "Veta included" and "a muted mine never silences it" hold by construction.
 */

const question: AttentionCueEvent = {
  kind: 'question',
  dwarfId: 'dwarf-1',
  askId: 'ask-1',
  reannounce: true
}
const permission: AttentionCueEvent = {
  kind: 'permission',
  dwarfId: 'dwarf-1',
  askId: 'ask-2',
  reannounce: true
}
const finished: AttentionCueEvent = {
  kind: 'finished',
  dwarfId: 'dwarf-1',
  turnKey: 'turn-1',
  end: { reliability: 'reliable', cancelledFromApp: false }
}
const THREE_EVENTS = [question, permission, finished] as const

const SHOWN: CueGates = { soundsOn: true, windowShown: true, alreadyPlayed: false }

describe('attentionCueRules', () => {
  it('[US-SHELL-010.AC02, US-SET-005.AC01, BR-01] with notification sounds on, a new question, permission or reliable finished turn plays its own cue in the shown window, Veta included', () => {
    for (const event of THREE_EVENTS) expect(shouldPlayCue(event, SHOWN)).toBe(true)
    // Its OWN cue: the key names the event's kind, so a question and a permission of one dwarf are two needs.
    expect(THREE_EVENTS.map(cueKey)).toEqual([
      'dwarf-1:question:ask-1',
      'dwarf-1:permission:ask-2',
      'dwarf-1:finished:turn-1'
    ])
    // Once per key: the same need already seen plays nothing, whatever window or mode is shown now.
    for (const event of THREE_EVENTS) {
      expect(shouldPlayCue(event, { ...SHOWN, alreadyPlayed: true })).toBe(false)
    }
  })

  it('[US-SET-005.AC02, NFR-SND-04] with notification sounds off no cue plays for any of the three events', () => {
    for (const event of THREE_EVENTS) {
      expect(shouldPlayCue(event, { ...SHOWN, soundsOn: false })).toBe(false)
    }
  })

  it('[US-SHELL-010.AC07, NFR-SND-08] an inferred end or a turn cancelled from the app never plays the finished cue', () => {
    const inferred = { reliability: 'inferred', cancelledFromApp: false } as const
    const cancelled = { reliability: 'reliable', cancelledFromApp: true } as const
    const both = { reliability: 'inferred', cancelledFromApp: true } as const
    expect(isAnnounceableEnd({ reliability: 'reliable', cancelledFromApp: false })).toBe(true)
    for (const end of [inferred, cancelled, both]) {
      expect(isAnnounceableEnd(end)).toBe(false)
      expect(shouldPlayCue({ ...finished, end }, SHOWN)).toBe(false)
    }
  })

  it('[NFR-SND-07] a hidden window plays no cue', () => {
    for (const event of THREE_EVENTS) {
      expect(shouldPlayCue(event, { ...SHOWN, windowShown: false })).toBe(false)
    }
  })
})
