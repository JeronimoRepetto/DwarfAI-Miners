// layer: L7
import { describe, expect, it } from 'vitest'
import { ELEVATED_REFUSED_EXIT_CODE, parseArgs, verdict } from './elevatedRefusal.mjs'

// The pure half of scripts/ci/check-elevated-refusal.mjs: the Windows checks job, which runs elevated, starts the
// built Host once and expects it to refuse (ADR-002 D6; 07 S12.03; 13 FM-011). This is the high-integrity branch the
// non-elevated OS lane cannot reach (src/ui-main/hostLauncher/elevatedRefused.os.test.ts).

const HIGH = 0x3000
const MEDIUM = 0x2000
const NOTHING_BOUND = { identityFile: false, uiToken: false }

describe('the elevated-start refusal check (Windows CI)', () => {
  it('[ADR-002, S12.03] an elevated job whose Host exited with ELEVATED_REFUSED and bound nothing passes', () => {
    expect(ELEVATED_REFUSED_EXIT_CODE).toBe(65)
    for (const rid of [HIGH, 0x4000]) {
      expect(verdict({ rid, exit: { code: 65 }, bound: NOTHING_BOUND })).toEqual({
        ok: true,
        message: expect.stringContaining('refused')
      })
    }
  })

  it('[ADR-002, FM-011] any other exit, a Host still running, or anything bound fails', () => {
    for (const [why, run] of [
      ['started normally', { exit: { code: null }, bound: NOTHING_BOUND }],
      ['failed its boot', { exit: { code: 1 }, bound: NOTHING_BOUND }],
      ['already running', { exit: { code: 64 }, bound: NOTHING_BOUND }],
      ['never exited', { exit: 'timed-out', bound: NOTHING_BOUND }],
      ['bound its endpoint', { exit: { code: 65 }, bound: { identityFile: true, uiToken: false } }],
      ['wrote its uiToken', { exit: { code: 65 }, bound: { identityFile: false, uiToken: true } }]
    ]) {
      expect(verdict({ rid: HIGH, ...run }), why).toEqual({
        ok: false,
        message: expect.any(String)
      })
    }
  })

  it('[ADR-002] a job that is not elevated, or whose level cannot be read, fails: the check would prove nothing', () => {
    for (const rid of [MEDIUM, 0x1000, null]) {
      expect(verdict({ rid, exit: { code: 65 }, bound: NOTHING_BOUND }), String(rid)).toEqual({
        ok: false,
        message: expect.stringContaining('elevated')
      })
    }
  })

  it('[ADR-002] the arguments name the built Host entry, and nothing else is accepted', () => {
    expect(parseArgs(['--entry', 'out/host/main.js'])).toEqual({
      kind: 'run',
      entry: 'out/host/main.js'
    })
    expect(parseArgs([])).toEqual({ kind: 'usage' })
    expect(parseArgs(['--entry'])).toEqual({ kind: 'usage' })
    expect(parseArgs(['--entry', 'a', 'extra'])).toEqual({ kind: 'usage' })
  })
})
