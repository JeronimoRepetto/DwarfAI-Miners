import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { endpointFor, PROTOCOL_VERSION, type EndpointInput } from '@dwarfai/contracts'
import { FakeClock } from '../kernel/fakes/FakeClock'
import { FakeScheduler } from '../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import { SequenceIdGenerator } from '../kernel/fakes/SequenceIdGenerator'
import { NodeScheduler } from '../platform/clock/NodeScheduler'
import { ConnectionRegistry } from '../transport/connectionRegistry'
import { Dispatcher } from '../transport/dispatcher'
import type { ListenOwnerOnlyPipe } from '../transport/endpoint/windowsPipeSecurity'
import { HostStateHolder, LIFECYCLE_FRAMES } from '../transport/lifecycle/hostState'
import { createUiEndpoint } from './bootSteps'

// L8 OS lane (17 §1.8): the bind step's composition on Windows, where the UI endpoint is a named pipe. MOVED for the
// cut-0 conformance audit from bootSteps.test.ts, where it ran under `it.runIf(win32)` in `pnpm test`; its assertions
// are unchanged. Synthetic SID only (privacy-guard).

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A fresh folder for one case. */
function caseRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dwarfai-022-wiring-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** Windows facts under `root`, as the platform adapter reads them. */
function windowsFacts(root: string): EndpointInput {
  return { platform: 'win32', hostDataDir: join(root, 'host'), userSid: 'S-1-5-5-0-4242', sha256 }
}

/** The auth layer's inputs for one Host boot (ISSUE-023), as bootSteps.test.ts composes them. */
function channelDeps() {
  const log = new RecordingDiagnosticsLog()
  const clock = new FakeClock(1_000)
  const connections = new ConnectionRegistry()
  const state = new HostStateHolder(connections)
  return {
    clock,
    ids: new SequenceIdGenerator(),
    identity: { hostVersion: '0.20.0', buildId: 'abc1234', protocolVersion: PROTOCOL_VERSION },
    pid: 4242,
    epoch: 'epoch-0001',
    state: () => state.current(),
    dispatcher: new Dispatcher({
      log,
      clock,
      scheduler: new FakeScheduler(clock),
      state: () => state.current().state
    }),
    connections,
    frames: LIFECYCLE_FRAMES,
    identityFile: {
      publish: () => Promise.resolve('written' as const),
      remove: () => Promise.resolve()
    }
  }
}

describe.runIf(process.platform === 'win32')(
  'the bind step composition on Windows (ADR-003 item 2)',
  () => {
    it('[ADR-003, FM-036] the bind step creates a Windows pipe only through the owner-only pipe helper it is given', async () => {
      const input = windowsFacts(caseRoot())
      const asked: string[] = []
      const helper: ListenOwnerOnlyPipe = (name) => {
        asked.push(name)
        return Promise.resolve({ ok: true, server: { close: () => Promise.resolve() } })
      }
      const endpoint = createUiEndpoint({
        facts: () => Promise.resolve({ ok: true, value: input }),
        log: new RecordingDiagnosticsLog(),
        scheduler: new NodeScheduler({ onTaskError: () => {} }),
        ...channelDeps(),
        ownerOnlyPipe: helper
      })
      cleanups.push(() => endpoint.close())

      expect(await endpoint.bind()).toBe('bound')

      const named = endpointFor(input)
      if (!named.ok) throw new Error(named.error.kind)
      expect(asked).toEqual([named.value.path])
    })
  }
)
