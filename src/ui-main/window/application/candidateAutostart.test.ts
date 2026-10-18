// layer: L2
import { describe, expect, it } from 'vitest'
import {
  FakeCandidateDefaultMarker,
  FakeCandidateLoginEntry
} from '../ports/fakes/FakeCandidateLoginEntry'
import { createCandidateAutostart } from './candidateAutostart'
import type { AutostartRegisterRecord } from './startWithSystem'

/**
 * The candidate login autostart (21 §2 cut 1), transplanted from `src/main/shell/autostart.test.ts` (17 §2.5): on an OS
 * where S-027-4 has not passed, a packaged build turns the login entry on once, at its first start, and migrates a
 * pre-rename entry, exactly as today's runtime did. A packaged build is the root's condition (index.ts), so it is not
 * repeated here.
 */
function world(entry = new FakeCandidateLoginEntry(), marker = new FakeCandidateDefaultMarker()) {
  const logged: AutostartRegisterRecord[] = []
  const start = createCandidateAutostart({ entry, marker, log: (record) => logged.push(record) })
  return { entry, marker, logged, start }
}

describe('the candidate login autostart (21 §2 cut 1)', () => {
  it('[ADR-027] the first start turns the login entry on, then writes the default marker', async () => {
    const { entry, marker, logged, start } = world()

    await start()

    expect(entry.entry).toBe(true)
    expect(marker.present).toBe(true)
    expect(logged).toEqual([])
  })

  it('[ADR-027] a later start, the marker written, never turns the entry on again', async () => {
    const { entry, marker, start } = world()
    marker.present = true

    await start()

    expect(entry.calls).toEqual(['migrateLegacy'])
    expect(entry.entry).toBe(false)
  })

  it('[ADR-027] a write the OS refuses leaves no marker, is logged by its code, and the next start retries', async () => {
    const { entry, marker, logged, start } = world()
    entry.refuse = true

    await start()

    expect(marker.present).toBe(false)
    expect(logged).toEqual([
      {
        level: 'warn',
        event: 'autostart.register',
        subsystem: 'window',
        outcome: 'failed',
        causeClass: 'failed',
        errCode: 'EACCES',
        msg: 'start on'
      }
    ])

    entry.refuse = false
    await start()
    expect(entry.entry).toBe(true)
    expect(marker.present).toBe(true)
  })

  it('[ADR-027] the pre-rename entry is migrated before the default is applied, at every start', async () => {
    const { entry, marker, start } = world()
    entry.legacyEntry = true
    marker.present = true

    await start()

    expect(entry.calls).toEqual(['migrateLegacy'])
    expect(entry.legacyEntry).toBe(false)
    expect(entry.entry).toBe(true)
  })

  it('[ADR-027] a migration the OS refuses is logged and the default is still applied', async () => {
    const { entry, marker, logged, start } = world()
    entry.legacyEntry = true
    entry.refuse = true

    await start()

    expect(entry.calls).toEqual(['migrateLegacy', 'enable'])
    expect(marker.present).toBe(false)
    expect(logged.map((record) => record.msg)).toEqual(['migrate on', 'start on'])
  })
})
