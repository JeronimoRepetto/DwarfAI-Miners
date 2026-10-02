// The HostSpawner contract (17 §1.3, 16 §2.8; ports.ts `HostSpawner`, `LaunchedHost`; ADR-002 D6): one suite run by
// the double, by each OS's spawner over its injectable seam (L3) and by this OS's spawner for real (L8,
// spawner.os.test.ts). A launch answers `launched` with how the process was started; its `exited` reports the exit
// code of a process that exits while watched and `null` once `release()` stopped the watch, which leaves the process
// running; a file that cannot be started answers `failed` with an error code.
import { describe, expect, it } from 'vitest'
import type { HostSpawnRequest, HostSpawner, LaunchedHost } from '../ports'

/** What the process of a request does. */
export type SpawnScript = 'exits-with-3' | 'keeps-running' | 'cannot-start'

export interface HostSpawnerSubject {
  spawner: HostSpawner
  /** A request whose process does what `script` says. */
  request(script: SpawnScript): HostSpawnRequest
  /** Plays a double's side after a launch of `script` (its process exits as scripted); a real process needs nothing. */
  afterLaunch(script: SpawnScript): void
  /** Whether the process of the last `keeps-running` launch still runs. */
  stillRunning(): Promise<boolean>
}

/** The ways ADR-002 D6 starts a Host. */
const HOW: ReadonlyArray<LaunchedHost['how']> = ['breakaway', 'wmi', 'detached']

export function runHostSpawnerContract(
  name: string,
  make: () => Promise<HostSpawnerSubject>
): void {
  describe(`${name} meets the HostSpawner contract (ADR-002 D6)`, () => {
    it('[ADR-002] a launch answers launched with how it was started, then the exit code of a process that exits while watched', async () => {
      const subject = await make()

      const outcome = await subject.spawner(subject.request('exits-with-3'))
      subject.afterLaunch('exits-with-3')

      if (outcome.kind !== 'launched') throw new Error(`not launched: ${JSON.stringify(outcome)}`)
      expect(HOW).toContain(outcome.host.how)
      expect(await outcome.host.exited).toBe(3)
    })

    it('[ADR-002] release stops the watch: exited answers null and the process keeps running', async () => {
      const subject = await make()

      const outcome = await subject.spawner(subject.request('keeps-running'))
      subject.afterLaunch('keeps-running')
      if (outcome.kind !== 'launched') throw new Error(`not launched: ${JSON.stringify(outcome)}`)
      outcome.host.release()

      // release() ends the watch at once: `exited` has settled by the next turn of the event loop.
      const pending = new Promise<'still pending'>((resolve) =>
        setImmediate(() => resolve('still pending'))
      )
      expect(await Promise.race([outcome.host.exited, pending])).toBeNull()
      expect(await subject.stillRunning()).toBe(true)
    })

    it('[ADR-002, FM-008] a file that cannot be started answers failed with an error code', async () => {
      const subject = await make()

      const outcome = await subject.spawner(subject.request('cannot-start'))
      subject.afterLaunch('cannot-start')

      expect(outcome).toEqual({ kind: 'failed', errCode: expect.stringMatching(/^\S+$/) })
    })
  })
}
