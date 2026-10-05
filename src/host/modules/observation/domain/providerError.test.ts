// layer: L1
// L1 (17 §1.1): the provider-error fold of observation (ISSUE-084; 08 §2.3 `ProviderErrorObserved`
// idempotency `(providerId, cause, dwarfId?)` per poll cycle; ADR-026 item 6 "drift events are
// counted before they are surfaced"; 13 FM-067, FM-068). Pure: no clock, no I/O.
//
// TC-084-01, TC-084-02 (the fold half; the loop and frame halves are in the application and
// transport tests).
import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import {
  DRIFT_SURFACE_THRESHOLD,
  PROVIDER_ERROR_CAUSES,
  ProviderErrorFold,
  type ProviderErrorReport
} from './providerError'

const D1 = 'dwarf-1' as DwarfId
const D2 = 'dwarf-2' as DwarfId

describe('ProviderErrorFold', () => {
  it('[US-RES-004.AC01, FM-067] a provider error of a dwarf yields one ProviderErrorObserved per cause and poll cycle', () => {
    const fold = new ProviderErrorFold()
    const reported: ProviderErrorReport[] = []
    const report = (r: ProviderErrorReport): void => {
      const out = fold.error(r)
      if (out !== null) reported.push(out)
    }

    fold.beginCycle()
    report({ providerId: 'claude', cause: 'provider-error', dwarfId: D1 })
    report({ providerId: 'claude', cause: 'provider-error', dwarfId: D1 })
    report({ providerId: 'claude', cause: 'provider-error', dwarfId: D1 })
    report({ providerId: 'claude', cause: 'rate-limited', dwarfId: D1 })
    // Another dwarf, another key.
    report({ providerId: 'claude', cause: 'provider-error', dwarfId: D2 })

    expect(reported).toEqual([
      { providerId: 'claude', cause: 'provider-error', dwarfId: D1 },
      { providerId: 'claude', cause: 'rate-limited', dwarfId: D1 },
      { providerId: 'claude', cause: 'provider-error', dwarfId: D2 }
    ])

    // The next poll cycle reports the same cause again, once.
    fold.beginCycle()
    report({ providerId: 'claude', cause: 'provider-error', dwarfId: D1 })
    report({ providerId: 'claude', cause: 'provider-error', dwarfId: D1 })
    expect(reported).toHaveLength(4)
    expect(reported[3]).toEqual({ providerId: 'claude', cause: 'provider-error', dwarfId: D1 })
  })

  it('[US-RES-004.AC01, 16 §2.1] a report without a dwarf carries no dwarfId and the causes are the typed four', () => {
    const fold = new ProviderErrorFold()
    fold.beginCycle()
    expect(fold.error({ providerId: 'codex', cause: 'auth-required' })).toEqual({
      providerId: 'codex',
      cause: 'auth-required'
    })
    expect(fold.error({ providerId: 'codex', cause: 'auth-required' })).toBeNull()
    expect([...PROVIDER_ERROR_CAUSES]).toEqual([
      'provider-error',
      'rate-limited',
      'auth-required',
      'unreadable'
    ])
  })

  it('[US-RES-004.AC04, FM-068] drift below the threshold stays a log record and above it surfaces as the same provider-error cause', () => {
    const fold = new ProviderErrorFold()
    const unreadable = { readable: false, drifted: true }
    const key = { providerId: 'antigravity', dwarfId: D1 }

    // Below the threshold: counted, nothing surfaces.
    for (let n = 1; n < DRIFT_SURFACE_THRESHOLD; n++) {
      fold.beginCycle()
      expect(fold.read(key, unreadable)).toBeNull()
    }
    // The read that reaches it surfaces once, as the typed `unreadable` cause.
    fold.beginCycle()
    expect(fold.read(key, unreadable)).toEqual({
      providerId: 'antigravity',
      cause: 'unreadable',
      dwarfId: D1
    })
    // Still unreadable: told once per streak, not once per cycle.
    fold.beginCycle()
    expect(fold.read(key, unreadable)).toBeNull()
  })

  it('[US-RES-004.AC04, FM-068] each stream keeps its own streak and two streams of one dwarf surface as one report per cycle', () => {
    const fold = new ProviderErrorFold()
    const unreadable = { readable: false, drifted: true }
    const a = { providerId: 'claude', dwarfId: D1, streamId: 'a' }
    const b = { providerId: 'claude', dwarfId: D1, streamId: 'b' }
    const surfaced: Array<ProviderErrorReport | null> = []
    for (let n = 0; n < DRIFT_SURFACE_THRESHOLD; n++) {
      fold.beginCycle()
      surfaced.push(fold.read(a, unreadable), fold.read(b, unreadable))
    }
    // Two unreadable reads a cycle are one cycle of drift for each stream, not two.
    expect(surfaced.slice(0, -2).every((r) => r === null)).toBe(true)
    // Both streams cross in the same cycle: one report, without the stream.
    expect(surfaced.slice(-2)).toEqual([
      { providerId: 'claude', cause: 'unreadable', dwarfId: D1 },
      null
    ])
  })

  it('[US-RES-004.AC04, FM-068, INV-38] a readable read ends the streak and a batch with skipped lines but readable records never surfaces', () => {
    const fold = new ProviderErrorFold()
    const key = { providerId: 'claude', dwarfId: D1 }
    const surfaced: Array<ProviderErrorReport | null> = []
    for (let n = 0; n < DRIFT_SURFACE_THRESHOLD * 3; n++) {
      fold.beginCycle()
      // Some lines skipped, the rest read: a log record only (FM-086).
      surfaced.push(fold.read(key, { readable: true, drifted: true }))
    }
    expect(surfaced.every((r) => r === null)).toBe(true)

    // A streak broken by a readable read starts again from zero.
    for (let n = 1; n < DRIFT_SURFACE_THRESHOLD; n++) {
      fold.beginCycle()
      expect(fold.read(key, { readable: false, drifted: true })).toBeNull()
    }
    fold.beginCycle()
    expect(fold.read(key, { readable: true, drifted: false })).toBeNull()
    fold.beginCycle()
    expect(fold.read(key, { readable: false, drifted: true })).toBeNull()

    // A read with nothing new and nothing skipped neither counts nor resets.
    for (let n = 2; n < DRIFT_SURFACE_THRESHOLD; n++) {
      fold.beginCycle()
      expect(fold.read(key, { readable: false, drifted: true })).toBeNull()
    }
    fold.beginCycle()
    expect(fold.read(key, { readable: false, drifted: false })).toBeNull()
    fold.beginCycle()
    expect(fold.read(key, { readable: false, drifted: true })).toEqual({
      providerId: 'claude',
      cause: 'unreadable',
      dwarfId: D1
    })

    // After a readable read the next streak surfaces again.
    fold.beginCycle()
    fold.read(key, { readable: true, drifted: false })
    let again: ProviderErrorReport | null = null
    for (let n = 0; n < DRIFT_SURFACE_THRESHOLD; n++) {
      fold.beginCycle()
      again = fold.read(key, { readable: false, drifted: true })
    }
    expect(again).toEqual({ providerId: 'claude', cause: 'unreadable', dwarfId: D1 })
  })
})
