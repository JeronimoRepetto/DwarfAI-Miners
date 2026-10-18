// layer: L2
// L2 flow of step 3d (17 §1.2; 21 §2 cut 3d "Parity / exit": the "Other…" session no longer dies with the window;
// ISSUE-186): an "Other…" launch through the wired Host, composed as host/main.ts composes it (flows/testing/cut3aHost.ts,
// the Host the 3a and 3b flows boot, with `HostedCommandDriver` attached as main.ts attaches it). The person's program
// is a recording spawn that keeps running (no real process). The `ui` client is a FrameClient behind an in-process
// duplex, every frame checked against its 14 §3.5 schema; closing the window is that client's stream ending.
//
// launchOther.test.ts (ISSUE-165) already proves an "Other…" launch produces a dwarf, its refusals and its sameness with a
// supplier dwarf; the case it lacks for row 3d is the window closed during the session, added here.
import { afterEach, describe, expect, it } from 'vitest'
import { HOST_METHOD_SCHEMAS } from '@dwarfai/contracts'
import type { DwarfId, LaunchId } from '../../kernel/domain/values'
import { RecordingSpawn } from '../../modules/suppliers/testing/recordingSpawn'
import type { FrameClient } from '../../transport/testing/frameClient'
import { bootHost, cleanUp, evts, world, type Host } from './testing/cut3aHost'

afterEach(cleanUp)

const PROGRAM = '/opt/agents/my-agent'
const COMMAND = `${PROGRAM} --non-interactive`
/** Longer than the whole case: the person's program never ends on its own here. */
const RUNS_FOR_MS = 10 * 60_000

interface LaunchChanged {
  launch: { launchId: LaunchId; state: string; dwarfId?: DwarfId }
}

/** The dwarfs of a fresh `session.snapshot` (14 §4), as a reopened window reads them. */
async function snapshotDwarfs(h: Host, ui: FrameClient) {
  const res = await h.call(ui, 'session.snapshot', { sections: ['dwarfs'] })
  if (!res.ok) throw new Error(`session.snapshot refused: ${res.error.code}`)
  const page = HOST_METHOD_SCHEMAS['session.snapshot'].result.parse(res.result)
  return page.chunks.flatMap((chunk) => (chunk.section === 'dwarfs' ? chunk.data : []))
}

describe('step 3d Other… flow (21 §2 cut 3d)', () => {
  it('[ADR-001, US-OBS-007.AC05] an Other session launched through the Host survives closing the window and is there when it reopens', async () => {
    const w = world()
    let spawn: RecordingSpawn | undefined
    const h = await bootHost(w, {
      epoch: 'epoch-186-a',
      processes: ({ clock, scheduler }) => {
        spawn = new RecordingSpawn({
          clock,
          scheduler,
          decide: (spec) =>
            spec.executable === PROGRAM
              ? { kind: 'exit', afterMs: RUNS_FOR_MS, code: 0 }
              : { kind: 'exit', afterMs: 0, code: 1, stdout: '' }
        })
        return spawn
      }
    })
    const mineId = await h.mine()
    const window = await h.attach()

    const answered = await h.call(window, 'launching.launchCustom', {
      mineId,
      command: COMMAND,
      prompt: 'Survey the north seam',
      requestId: h.rid()
    })
    expect(answered).toMatchObject({ ok: true })
    await h.run(4_000, window)
    const dwarfId = evts<LaunchChanged>(window, 'launch.changed').find(
      (frame) => frame.launch.state === 'succeeded'
    )?.launch.dwarfId
    if (dwarfId === undefined) throw new Error('the Other… command did not launch')
    expect(spawn?.spawns.filter((s) => s.executable === PROGRAM)).toHaveLength(1)

    // The window closes (its connection ends) and stays closed for a minute: the Host owns the session, so nothing ends
    // it and its dwarf never departs (21 §2 row 3d; ADR-002 D1).
    window.stream.destroy()
    await h.settle()
    await h.run(60_000)
    expect(h.events<{ dwarfId: DwarfId }>('DwarfDeparted').map((e) => e.dwarfId)).not.toContain(
      dwarfId
    )

    // The window reopens: its snapshot holds the same dwarf, present and owned, and no second process was spawned.
    const reopened = await h.attach()
    const dwarf = (await snapshotDwarfs(h, reopened)).find((d) => d.id === dwarfId)
    expect(dwarf).toMatchObject({ id: dwarfId, mineId, presence: 'present', owned: true })
    expect(spawn?.spawns.filter((s) => s.executable === PROGRAM)).toHaveLength(1)
  })
})
