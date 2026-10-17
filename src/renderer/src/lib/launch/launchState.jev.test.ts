import { describe, expect, it } from 'vitest'
import type { JevSuggestionView, MineId } from '@dwarfai/contracts'
import { DEFAULT_JEV_PREFERENCES, type JevSettings } from '../../types'
import {
  chooseEffort,
  chooseModel,
  chooseProvider,
  clearJevDecision,
  jevSuggestAnswered,
  jevSuggestAsked,
  jevSuggestParams,
  openLaunch,
  closedLaunch,
  setJevSettings,
  shouldSuggest,
  toggleJev,
  toggleJevAutoAccept,
  typePrompt,
  type JevSuggestAnswer,
  type LaunchState
} from './launchState'

// ISSUE-195: the renderer half of A-50 in its 14 shape (`routeJevLaunch(JevSuggestParams)` →
// `IpcResult<JevSuggestResult>`). The card is a request result held in the panel's memory, never a frame and never
// persisted (INV-87; 11 §6 O-11-11). The call itself is wired with the step-3a route switch (ISSUE-001).

const READY: JevSettings = { configured: true, preferences: DEFAULT_JEV_PREFERENCES }
const MINE = '01900000-0000-7000-8000-000000000001' as MineId

/** An open panel with Jev ready and on, the person's own pickers set, and a prompt written. */
function writing(prompt: string): LaunchState {
  const opened = toggleJev(setJevSettings(openLaunch(closedLaunch()), READY))
  const picked = chooseEffort(chooseModel(chooseProvider(opened, 'codex'), 'gpt-5'), 'low')
  return typePrompt(picked, prompt)
}

function picked(view: Partial<JevSuggestionView> = {}): JevSuggestAnswer {
  return {
    ok: true,
    value: {
      ok: true,
      value: {
        providerId: 'claude',
        model: 'sonnet',
        effort: 'high',
        tier: 'balanced',
        confidence: { providerId: 0.9, tier: 0.8 },
        truncated: false,
        parts: { providerId: 'answered', model: 'answered', effort: 'answered', tier: 'answered' },
        ...view
      }
    }
  }
}

const UNREACHABLE: JevSuggestAnswer = { ok: true, value: { ok: false, error: 'jev-unreachable' } }

function pickers(state: LaunchState): { choice: unknown; model: unknown; effort: unknown } {
  return { choice: state.choice, model: state.model, effort: state.effort }
}

const BEFORE = { choice: 'codex', model: 'gpt-5', effort: 'low' }
const PICK = { choice: 'claude', model: 'sonnet', effort: 'high' }

describe('the Jev card from A-50 in its 14 shape (ISSUE-195)', () => {
  it('[US-LAUNCH-003.AC02] an answered routeJevLaunch fills the card and the pickers with the pick', () => {
    const state = writing('  refactor the parser  ')
    expect(shouldSuggest(state)).toBe(true)
    expect(jevSuggestParams(state, MINE)).toEqual({ prompt: 'refactor the parser', mineId: MINE })

    const asking = jevSuggestAsked(state, 1)
    expect(asking.jev.routing).toEqual({ phase: 'asking', request: 1 })

    const answer = picked()
    const answered = jevSuggestAnswered(asking, 1, answer)
    expect(answered.jev.routing).toEqual({
      phase: 'suggested',
      suggestion: answer.ok && answer.value.ok ? answer.value.value : null
    })
    expect(pickers(answered)).toEqual(PICK)
  })

  it('[US-LAUNCH-003.AC07, INV-87] a changed prompt hides the card, restores the pickers and asks again with the new prompt; the older result is dropped when it arrives', () => {
    const shown = jevSuggestAnswered(jevSuggestAsked(writing('first prompt'), 1), 1, picked())
    expect(shown.jev.routing.phase).toBe('suggested')

    // The person edits the prompt while the card shows, then again while that ask is in flight.
    const asked2 = jevSuggestAsked(typePrompt(shown, 'second prompt'), 2)
    expect(pickers(asked2)).toEqual(BEFORE)
    expect(asked2.jev.routing).toEqual({ phase: 'asking', request: 2 })
    const asked3 = jevSuggestAsked(typePrompt(asked2, 'third prompt'), 3)
    expect(jevSuggestParams(asked3, MINE)).toEqual({ prompt: 'third prompt', mineId: MINE })

    // Request 2's answer arrives late: dropped, the pickers stay as the person left them.
    const late = jevSuggestAnswered(asked3, 2, picked({ providerId: 'antigravity', model: 'old' }))
    expect(late.jev.routing).toEqual({ phase: 'asking', request: 3 })
    expect(pickers(late)).toEqual(BEFORE)

    // Request 3's own answer applies.
    expect(pickers(jevSuggestAnswered(late, 3, picked()))).toEqual(PICK)
  })

  it('[US-LAUNCH-003.AC07, INV-87] an emptied prompt hides the card, restores the pickers and asks nothing', () => {
    const shown = jevSuggestAnswered(jevSuggestAsked(writing('a prompt'), 1), 1, picked())
    const emptied = jevSuggestAsked(typePrompt(shown, '   '), 2)
    expect(shouldSuggest(emptied)).toBe(false)
    expect(emptied.jev.routing).toEqual({ phase: 'idle' })
    expect(pickers(emptied)).toEqual(BEFORE)
    expect(jevSuggestAnswered(emptied, 2, picked()).jev.routing).toEqual({ phase: 'idle' })
  })

  it('[US-LAUNCH-003.AC08] a jev-unreachable result shows no card and restores the pickers that stood before', () => {
    const asking = jevSuggestAsked(writing('a prompt'), 1)
    const failed = jevSuggestAnswered(asking, 1, UNREACHABLE)
    expect(failed.jev.routing).toEqual({ phase: 'idle' })
    expect(failed.jev.previousChoice).toBeNull()
    expect(pickers(failed)).toEqual(BEFORE)
  })

  it('[US-LAUNCH-003.AC08] a call error, could-not-choose, not-configured or a pick naming no provider shows no card either', () => {
    const answers: JevSuggestAnswer[] = [
      { ok: false, error: { code: 'TIMEOUT', message: 'deadline', retryable: true } },
      { ok: true, value: { ok: false, error: 'jev-could-not-choose' } },
      { ok: true, value: { ok: false, error: 'not-configured' } },
      picked({
        providerId: undefined,
        model: undefined,
        effort: undefined,
        fallback: 'effort-ceiling'
      })
    ]
    for (const answer of answers) {
      const after = jevSuggestAnswered(jevSuggestAsked(writing('a prompt'), 1), 1, answer)
      expect(after.jev.routing).toEqual({ phase: 'idle' })
      expect(pickers(after)).toEqual(BEFORE)
    }
  })

  it('[US-LAUNCH-004.AC01, INV-87] after Dismiss a late result is dropped and no card returns', () => {
    const asking = jevSuggestAsked(writing('a prompt'), 1)
    const dismissed = clearJevDecision(asking)
    const late = jevSuggestAnswered(dismissed, 1, picked())
    expect(late.jev.routing).toEqual({ phase: 'idle' })
    expect(pickers(late)).toEqual(BEFORE)

    // Dismissing a card that shows puts back the pickers that stood before Jev answered.
    const shown = jevSuggestAnswered(jevSuggestAsked(writing('a prompt'), 2), 2, picked())
    const closed = clearJevDecision(shown)
    expect(closed.jev.routing).toEqual({ phase: 'idle' })
    expect(pickers(closed)).toEqual(BEFORE)
  })

  it('[US-LAUNCH-003.AC04] with auto-accept on the same suggestion is applied and the card reads as accepted automatically', () => {
    const manual = jevSuggestAnswered(jevSuggestAsked(writing('a prompt'), 1), 1, picked())
    const auto = jevSuggestAnswered(
      jevSuggestAsked(toggleJevAutoAccept(writing('a prompt')), 1),
      1,
      picked()
    )
    expect(auto.jev.routing).toEqual(manual.jev.routing)
    expect(pickers(auto)).toEqual(pickers(manual))
    // The acceptance mode the card's eyebrow reads (EPIC-16 draws it).
    expect([manual.jev.autoAccept, auto.jev.autoAccept]).toEqual([false, true])
  })

  it('[US-LAUNCH-003.AC02] Jev off or not ready asks nothing', () => {
    const off = toggleJev(writing('a prompt'))
    expect(shouldSuggest(off)).toBe(false)
    expect(jevSuggestAsked(off, 1).jev.routing).toEqual({ phase: 'idle' })
  })
})
