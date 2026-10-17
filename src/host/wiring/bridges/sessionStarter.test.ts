// layer: L3
// The SessionStarter bridge over the suppliers module's own session tracking (`stagedSessions`):
// a launch that fails after its session was handed out never binds it, so the bridge releases the
// unbound entry and its held events (GitHub #1316). "Gone" is read through the suppliers surface: a
// released session can no longer be bound, and none of its events reach the sink.
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../kernel/domain/errors'
import type { DwarfId, FolderPath, LaunchId } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import {
  EARLY_FAILURE_WINDOW_MS,
  HANDSHAKE_TIMEOUT_MS,
  type StartResult
} from '../../modules/launching'
import type { DriverLaunchRequest } from '../../modules/suppliers'
import {
  STAGED_PROVIDER_ID as PROVIDER,
  stagedSessions
} from '../../modules/suppliers/testing/stagedSessions'
import { createSessionStarter } from './sessionStarter'

const DWARF = '00000000-0000-7000-8000-0000000013a1' as DwarfId
const QUICK_HANDSHAKE_MS = 20

function request(): DriverLaunchRequest {
  return {
    launchId: 'launch-1316' as LaunchId,
    install: {
      providerId: PROVIDER,
      binaryPath: '/opt/staged/bin/tool',
      version: '1.0.0',
      resolvedVia: 'path',
      statMtimeMs: 0
    },
    cwd: '/work/mine-one' as FolderPath,
    prompt: 'Survey the north seam',
    permissionMode: null,
    delegation: null,
    spawnTag: 'v1:install-1316:launch-1316:epoch-1316',
    onSpawned: async () => undefined
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

async function advance(clock: FakeClock, ms: number): Promise<void> {
  let left = ms
  while (left > 0) {
    const step = Math.min(10, left)
    clock.advance(step)
    left -= step
    await flush()
  }
}

async function arrange(handshakeMs: number) {
  const clock = new FakeClock(1_790_000_000_000)
  const scheduler = new FakeScheduler(clock)
  const tracked = stagedSessions({ clock, scheduler, handshakeMs })
  const starter = createSessionStarter({
    registry: tracked.registry,
    sessions: tracked.channels,
    releases: tracked.releases,
    clock,
    scheduler
  })
  let result: StartResult | undefined
  void starter.start(PROVIDER, request(), { launchedWithLetJevChoose: false }).then((value) => {
    result = value
  })
  await flush() // the spawn is reported and the handshake timer armed at the start instant
  return { clock, sink: tracked.sink, tracked, result: () => result }
}

describe('the SessionStarter bridge releases the session of a failed launch (GitHub #1316)', () => {
  it('[S5.20, S5.21, ADR-015] a session that exited inside the early window settles exited-at-once and leaves no unbound entry', async () => {
    const { clock, sink, tracked, result } = await arrange(QUICK_HANDSHAKE_MS)
    await advance(clock, QUICK_HANDSHAKE_MS)
    const { ref } = tracked.handedOut()
    tracked.handedOut().emit({ t: 'status', value: 'working' })
    tracked.handedOut().emit({ t: 'exited', code: 1 })
    await advance(clock, EARLY_FAILURE_WINDOW_MS)

    expect(result()).toMatchObject({ ok: false, error: { cause: 'exited-at-once' } })
    expect(() => tracked.bindings.bind(ref, DWARF)).toThrow(HostInvariantError)
    expect(sink.deliveries).toEqual([])
  })

  it('[S5.19, ADR-015] a session handed out after the handshake budget is closed and leaves no unbound entry once it exited', async () => {
    const { clock, sink, tracked, result } = await arrange(HANDSHAKE_TIMEOUT_MS + 100)
    await advance(clock, HANDSHAKE_TIMEOUT_MS)
    expect(result()).toMatchObject({ ok: false, error: { cause: 'could-not-start' } })

    await advance(clock, 100)
    const { ref } = tracked.handedOut()
    tracked.handedOut().emit({ t: 'exited', code: null })
    await flush()

    expect(tracked.channels.sessionFor(ref)).toBeNull()
    expect(() => tracked.bindings.bind(ref, DWARF)).toThrow(HostInvariantError)
    expect(sink.deliveries).toEqual([])
  })

  it('[S5.18, ADR-015] a session still live at the end of the early window starts and stays bindable', async () => {
    const { clock, sink, tracked, result } = await arrange(QUICK_HANDSHAKE_MS)
    await advance(clock, EARLY_FAILURE_WINDOW_MS)
    expect(result()?.ok).toBe(true)

    tracked.bindings.bind(tracked.handedOut().ref, DWARF)
    tracked.handedOut().emit({ t: 'exited', code: 0 })
    await flush()

    expect(sink.deliveries.map((d) => [d.dwarfId, d.event.t])).toEqual([[DWARF, 'exited']])
  })
})
