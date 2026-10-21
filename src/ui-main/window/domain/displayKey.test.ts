// layer: L1
import { describe, expect, it } from 'vitest'
import { displayKeyOf, matchDisplayKey, type DisplayFacts } from './displayKey'

/**
 * The `displayKey` of ADR-024 item 5 (INV-118), over the facts the S-024-1 record holds
 * (`spike-results/S-024-1/windows-same-boot-{1,2}.json`, Windows 11, Electron 44): two external displays, read twice in
 * one boot, each matched by `id` with no fact changed. The record's verdict is `partial`: the reboot, driver-update and
 * dock/undock events are still pending per OS, so this table holds the recorded facts and the transformations ADR-024
 * item 5 names (another `id` for the same display, a scale or primary change), never facts nobody observed.
 */
const SAME_BOOT_1: readonly DisplayFacts[] = [
  {
    id: 405_689_602,
    label: 'Q27G2WG4',
    bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    size: { width: 2560, height: 1440 },
    scaleFactor: 1
  },
  {
    id: 3_709_332_974,
    label: 'PHL 243V7',
    bounds: { x: 2560, y: 357, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1
  }
]
/** The second snapshot of the same boot: the record compared it with the first and found no changed fact. */
const SAME_BOOT_2: readonly DisplayFacts[] = SAME_BOOT_1.map((display) => ({ ...display }))

const keysOf = (displays: readonly DisplayFacts[]): string[] =>
  displays.map((display) => displayKeyOf(display, displays[0]!))

describe('displayKey (ADR-024 item 5; INV-118; S-024-1)', () => {
  it('[INV-118, S-024-1] a display keeps its displayKey across the recorded reboot and driver facts and never keys on display.id alone', () => {
    // The recorded snapshots of one boot: the same keys, one per display.
    expect(keysOf(SAME_BOOT_2)).toEqual(keysOf(SAME_BOOT_1))
    expect(new Set(keysOf(SAME_BOOT_1)).size).toBe(2)
    // After a reboot or a driver update Electron may hand the same display another id: the key does not change.
    const renumbered = SAME_BOOT_1.map((display, i) => ({ ...display, id: 7 + i }))
    expect(keysOf(renumbered)).toEqual(keysOf(SAME_BOOT_1))
    // Two displays that share an id are still two displays: the id is never the key, nor part of it.
    const sharedId = SAME_BOOT_1.map((display) => ({ ...display, id: 1 }))
    expect(new Set(keysOf(sharedId)).size).toBe(2)
    for (const display of SAME_BOOT_1) {
      expect(displayKeyOf(display, SAME_BOOT_1[0]!)).not.toContain(String(display.id))
    }
  })

  it('[INV-118, ADR-024] a stored key finds its display after a scale or primary change, fuzzily, and never another display', () => {
    const [left, right] = SAME_BOOT_1 as [DisplayFacts, DisplayFacts]
    const stored = displayKeyOf(right, left)
    const now = (displays: readonly DisplayFacts[], primary: DisplayFacts) =>
      displays.map((display) => ({ displayKey: displayKeyOf(display, primary) }))
    // Exactly the same display: the same key.
    expect(matchDisplayKey(stored, now(SAME_BOOT_1, left))).toBe(stored)
    // The right display became the primary one: every position moved, its label and resolution did not.
    const swapped = now(SAME_BOOT_1, right)
    expect(matchDisplayKey(stored, swapped)).toBe(displayKeyOf(right, right))
    // Its scale changed: the key changed, the display is the same.
    const scaled = [left, { ...right, scaleFactor: 1.25, size: { width: 1536, height: 864 } }]
    expect(matchDisplayKey(stored, now(scaled, left))).toBe(displayKeyOf(scaled[1]!, left))
    // Unplugged: nothing matches, and the other display is never taken for it.
    expect(matchDisplayKey(stored, now([left], left))).toBeNull()
    // Two unlabelled identical monitors are told apart by where they stand, and only an exact key matches them.
    const twin = { ...right, label: '', bounds: { ...right.bounds, x: -1920 } }
    const unlabelled = { ...right, label: '' }
    const twins = now([left, unlabelled, twin], left)
    expect(matchDisplayKey(displayKeyOf(unlabelled, left), twins)).toBe(
      displayKeyOf(unlabelled, left)
    )
    expect(matchDisplayKey(displayKeyOf(unlabelled, left), now([left, twin], left))).toBeNull()
  })
})
