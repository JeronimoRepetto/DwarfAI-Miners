import { describe, expect, it } from 'vitest'
import type { DwarfAttendance, DwarfProvider, DwarfRole } from './contracts'
import {
  DWARF_PROVIDERS,
  DWARF_SILENCE_WINDOW_MS,
  MCP_CONNECTION_STATUSES,
  TIER_WEIGHT_THRESHOLDS_KB,
  dwarfSilenceWindowKey,
  dwarfSilenceWindowMs,
  isDwarfProvider,
  isMcpConnectionStatus
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
 * Issue #96. The held-session loop reads `mcp_servers[].status` straight off
 * the CLI's own `init` message, which types it as a plain `string` — but the
 * live-fire spike (issue #96's comments) observed only the five values the
 * SDK's control-request surface (`mcpServerStatus()`) types as a closed enum,
 * across seven real entries including three flavours of `needs-auth`. Same
 * boundary-validation discipline `isDwarfProvider`/`isMineTier` already hold:
 * a status this build does not recognise reads as "not this enum" rather than
 * being passed on as a guess.
 */
describe('MCP_CONNECTION_STATUSES', () => {
  it('names the SDK-typed closed enum, and nothing else', () => {
    expect(MCP_CONNECTION_STATUSES).toEqual([
      'connected',
      'failed',
      'needs-auth',
      'pending',
      'disabled'
    ])
  })
})

describe('isMcpConnectionStatus', () => {
  it('recognises every status in the table', () => {
    for (const status of MCP_CONNECTION_STATUSES) {
      expect(isMcpConnectionStatus(status)).toBe(true)
    }
  })

  it.each(['Connected', 'CONNECTED', 'unknown', '', ' connected', 42, null, undefined, {}])(
    'refuses %j, which this build has no MCP status enum member for',
    (value) => {
      expect(isMcpConnectionStatus(value)).toBe(false)
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

/*
 * Issue #140. The renderer has no import path onto main/config/config.ts —
 * main and renderer are separate JS realms, and only this shared module and
 * the IPC wire cross between them — so the canonical KB boundaries the design
 * source fixes (foundations.md) have to live somewhere both sides can read
 * them without the renderer hand-typing four numbers that could drift from
 * main's. This pins the one copy both processes are meant to share.
 */
describe('TIER_WEIGHT_THRESHOLDS_KB', () => {
  it('names the documented KB boundaries, in ascending order', () => {
    expect(TIER_WEIGHT_THRESHOLDS_KB).toEqual({
      copperKb: 100,
      silverKb: 500,
      goldKb: 2048,
      uraniumKb: 8192
    })
    expect(TIER_WEIGHT_THRESHOLDS_KB.copperKb).toBeLessThan(TIER_WEIGHT_THRESHOLDS_KB.silverKb)
    expect(TIER_WEIGHT_THRESHOLDS_KB.silverKb).toBeLessThan(TIER_WEIGHT_THRESHOLDS_KB.goldKb)
    expect(TIER_WEIGHT_THRESHOLDS_KB.goldKb).toBeLessThan(TIER_WEIGHT_THRESHOLDS_KB.uraniumKb)
  })
})
