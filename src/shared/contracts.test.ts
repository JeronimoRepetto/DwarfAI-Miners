import { describe, expect, it } from 'vitest'
import type { DwarfAttendance, DwarfProvider, DwarfRole } from './contracts'
import {
  DWARF_PROVIDERS,
  DWARF_SILENCE_WINDOW_MS,
  dwarfSilenceWindowKey,
  dwarfSilenceWindowMs,
  isDwarfProvider
} from './contracts'

/*
 * Issue #78. Adding a provider used to mean editing the union here and then
 * finding every hand-written copy of it elsewhere. These pin the table as the
 * one declaration point: the union is derived from it, and the two mirrors
 * that used to exist (the projects store's read-back list, the CLI detector's
 * own type) now read this instead of restating it.
 */
describe('DWARF_PROVIDERS', () => {
  it('names every provider identity the wire admits, and nothing else', () => {
    expect(DWARF_PROVIDERS).toEqual(['claude', 'codex'])
  })

  it('is the type the union is derived from, so the two cannot drift apart', () => {
    // Assignable in both directions: a member added to the table becomes a
    // member of the union with no second edit, and a union member missing from
    // the table would fail to compile here rather than at a call site.
    const fromTable: DwarfProvider[] = [...DWARF_PROVIDERS]
    const fromUnion: readonly DwarfProvider[] = DWARF_PROVIDERS
    expect(fromTable).toEqual([...fromUnion])
  })
})

describe('isDwarfProvider', () => {
  it('recognises every identity in the table', () => {
    for (const provider of DWARF_PROVIDERS) {
      expect(isDwarfProvider(provider)).toBe(true)
    }
  })

  it.each(['gemini', 'Claude', 'CODEX', '', ' claude ', 42, null, undefined, {}])(
    'refuses %j, which this build has no provider for',
    (value) => {
      // Every caller is reading something it did not produce — a row off the
      // user's disk, a value off the IPC boundary — so an unrecognised one has
      // to read as "no provider" rather than being passed on as a guess.
      expect(isDwarfProvider(value)).toBe(false)
    }
  )
})

/*
 * Issue #68. The long window exists because a human may be typing the next
 * prompt, and until now it was handed out on RANK — so a headless `claude -p`
 * run, which is a root and therefore a foreman, was granted the hour with
 * nobody at the keyboard. These tests pin the predicate the window actually
 * means, and the direction the unproven case falls in.
 */
describe('dwarfSilenceWindowMs', () => {
  it('keeps the two measured windows, an hour against half of one', () => {
    // Unchanged by #68: the numbers were never the defect, only what picked
    // between them. The provider's staleness rule reads the same two.
    expect(DWARF_SILENCE_WINDOW_MS.attended).toBe(60 * 60_000)
    expect(DWARF_SILENCE_WINDOW_MS.unattended).toBe(30 * 60_000)
  })

  it('gives the hour to a session a human is sitting at', () => {
    expect(dwarfSilenceWindowMs('foreman', 'attended')).toBe(DWARF_SILENCE_WINDOW_MS.attended)
  })

  it('takes the hour back from a root session nobody can type into', () => {
    // The whole of #68: `claude -p` and a Codex automation thread are roots,
    // so they were foremen, so they got an hour of patience for a keyboard
    // that does not exist.
    expect(dwarfSilenceWindowMs('foreman', 'unattended')).toBe(DWARF_SILENCE_WINDOW_MS.unattended)
  })

  it('leaves the hour standing when the provider proved nothing either way', () => {
    // The conservative direction, and the same one this codebase has taken
    // twice: absence of a pendingBackgroundAgentCount is not a count of zero,
    // and tierOf's placeholder may not seal a ledger delta. The two errors are
    // not symmetric — shortening the window on a session a human IS typing
    // into makes the panel call a live session silent, which is the false
    // departure #28 and #40 exist to prevent.
    expect(dwarfSilenceWindowMs('foreman', 'unknown')).toBe(DWARF_SILENCE_WINDOW_MS.attended)
  })

  it('treats a provider that reports no attendance at all as unproven, not as headless', () => {
    // Absent is the same reading as 'unknown' and deliberately not a third
    // one: a provider that was never taught to answer has not answered.
    expect(dwarfSilenceWindowMs('foreman')).toBe(DWARF_SILENCE_WINDOW_MS.attended)
    expect(dwarfSilenceWindowMs('foreman', undefined)).toBe(DWARF_SILENCE_WINDOW_MS.attended)
  })

  it('judges every worker on the half hour, whatever a provider claims about it', () => {
    // The one place topology still decides, because there it PROVES the thing:
    // a spawned subagent has no channel of its own, so no human can be typing
    // into it whatever the field says. Rank may shorten the window, never
    // lengthen it.
    expect(dwarfSilenceWindowMs('worker')).toBe(DWARF_SILENCE_WINDOW_MS.unattended)
    expect(dwarfSilenceWindowMs('worker', 'unknown')).toBe(DWARF_SILENCE_WINDOW_MS.unattended)
    expect(dwarfSilenceWindowMs('worker', 'attended')).toBe(DWARF_SILENCE_WINDOW_MS.unattended)
  })
})

describe('dwarfSilenceWindowKey', () => {
  const ROLES: DwarfRole[] = ['foreman', 'worker']
  const ATTENDANCE: (DwarfAttendance | undefined)[] = [
    'attended',
    'unattended',
    'unknown',
    undefined
  ]

  it('names the window dwarfSilenceWindowMs would hand back, for every input', () => {
    // The two must never part company: the key exists only so a caller with
    // its OWN pair of numbers — the Claude provider's staleness rule, whose
    // windows tests shrink to something crossable — can make the same choice
    // without restating the rule and drifting from it.
    for (const role of ROLES) {
      for (const attendance of ATTENDANCE) {
        expect(DWARF_SILENCE_WINDOW_MS[dwarfSilenceWindowKey(role, attendance)]).toBe(
          dwarfSilenceWindowMs(role, attendance)
        )
      }
    }
  })

  it('answers with one of the two window names and nothing else', () => {
    expect(dwarfSilenceWindowKey('foreman', 'unattended')).toBe('unattended')
    expect(dwarfSilenceWindowKey('foreman', 'unknown')).toBe('attended')
    expect(dwarfSilenceWindowKey('worker', 'attended')).toBe('unattended')
  })
})
