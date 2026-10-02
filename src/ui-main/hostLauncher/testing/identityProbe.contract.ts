// The ProcessIdentityProbe contract (17 §1.3, 16 §2.8; ports.ts `ProcessIdentityProbe`; ADR-002 D3, ADR-014 items
// 1–2): one suite run by the double, by the real probe over a scripted start-time reader (L3) and by the real probe
// over this OS's reader (L8, processStart.os.test.ts). A gate owner is alive while its pid runs with a start time
// within the one 2 000 ms tolerance of the recorded one; a pid with no live process is not alive.
import { describe, expect, it } from 'vitest'
import type { ProcessIdentityProbe, ProcessStart } from '../ports'

export interface IdentityProbeSubject {
  probe: ProcessIdentityProbe
  /** A process that runs, with the start time this OS reports for it. */
  live: ProcessStart
  /** A pid no live process has. */
  gonePid: number
}

/** ADR-014 item 2: the one tolerance on a start-time comparison. */
const TOLERANCE_MS = 2_000

export function runIdentityProbeContract(
  name: string,
  make: () => Promise<IdentityProbeSubject>
): void {
  describe(`${name} meets the ProcessIdentityProbe contract (ADR-002 D3)`, () => {
    it('[ADR-002, ADR-014] the identity of a live process is alive', async () => {
      const { probe, live } = await make()

      expect(await probe(live)).toBe(true)
    })

    it('[ADR-014] a start time within 2 000 ms of the live one is the same process, and 2 001 ms off is another', async () => {
      const { probe, live } = await make()
      const at = (offset: number): ProcessStart => ({
        pid: live.pid,
        processStartTimeMs: live.processStartTimeMs + offset
      })

      expect(await probe(at(TOLERANCE_MS))).toBe(true)
      expect(await probe(at(-TOLERANCE_MS))).toBe(true)
      expect(await probe(at(TOLERANCE_MS + 1))).toBe(false)
      expect(await probe(at(-TOLERANCE_MS - 1))).toBe(false)
    })

    it('[ADR-002, FM-010] a pid with no live process is not alive', async () => {
      const { probe, live, gonePid } = await make()

      expect(await probe({ pid: gonePid, processStartTimeMs: live.processStartTimeMs })).toBe(false)
    })
  })
}
