// The LaunchStore conformance suite (16 §4.5; 17 §1.3): run on the in-memory double and on the
// SQLite adapter. A failed launch keeps exactly one of the five causes and a settled time (INV-52);
// `inFlight` lists the routing, resolving and spawned launches only (INV-53); `markSeen` is for a
// failed launch only and keeps its first instant (14 §8 I-03); a launch only moves forward
// (07 machine 5B); every write runs inside the caller's transaction (16 §2.2). What a launch reads
// back is the port's stored projection (`ports/launchStore.ts`).
import { afterEach, describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { LaunchFailureCause } from '../../../kernel/domain/sharedContracts'
import type { DwarfId, HostEpoch, Instant, LaunchId, MineId } from '../../../kernel/domain/values'
import type { FakeClock } from '../../../kernel/fakes/FakeClock'
import {
  applyLaunchEvent,
  requestLaunch,
  type Launch,
  type LaunchEvent,
  type LaunchRequest
} from '../domain/launch'
import { buildLaunchFailure } from '../domain/launchFailure'
import type { LaunchStore } from '../ports/launchStore'

/** 09 D-17: what a delegated worker's launch request carries. */
export interface StoredDelegation {
  delegationId: string
  parentDwarfId: DwarfId
}

export interface LaunchStoreSubject {
  store: LaunchStore
  /** Stamps `requested_at` and `settled_at`. */
  clock: FakeClock
  /** A mine that exists in the subject's store (the SQLite half seeds its row). */
  mineId: MineId
  /** A delegation that exists in the subject's store, for a delegated worker's launch. */
  delegation: StoredDelegation
  /** A dwarf that exists in the subject's store, for a succeeded launch. */
  dwarfId: DwarfId
  /** The stored settlement instant (`launches.settled_at`), null while in flight or unknown. */
  settledAt(id: LaunchId): Instant | null
  /** The stored first instant a ui connection saw the failure (`launches.seen_at`). */
  seenAt(id: LaunchId): Instant | null
  /** The caller's transaction: commits when `work` returns, rolls back when it throws. */
  inTransaction<T>(work: () => T): T
  dispose(): void | Promise<void>
}

class CallerFailure extends Error {}

const EPOCH: HostEpoch = 'epoch-0161'

let sequence = 0
const nextLaunchId = (): LaunchId =>
  `00000000-0000-7000-8161-${(++sequence).toString(16).padStart(12, '0')}` as LaunchId

type StoredRequest = LaunchRequest<string, StoredDelegation>
type StoredLaunch = Launch<string, StoredDelegation>

function request(mineId: MineId, extra: Partial<StoredRequest> = {}): StoredRequest {
  return {
    mineId,
    way: { kind: 'supplier', providerId: 'claude' },
    model: 'model-x',
    effort: 'high',
    permissionMode: 'ask-first',
    prompt: 'Tidy the tunnels',
    jevOn: false,
    jevAutoAccept: false,
    ...extra
  }
}

function withoutPermissionMode(req: StoredRequest): StoredRequest {
  const { permissionMode, ...rest } = req
  void permissionMode
  return rest
}

function sent(req: StoredRequest, retryOf?: LaunchId): StoredLaunch {
  const result = requestLaunch({
    id: nextLaunchId(),
    request: req,
    hostEpoch: EPOCH,
    ...(retryOf !== undefined ? { retryOf } : {})
  })
  if (!result.ok) throw new Error('fixture request refused')
  return result.value.launch
}

function step(launch: StoredLaunch, event: LaunchEvent): StoredLaunch {
  const result = applyLaunchEvent(launch, event)
  if (!result.ok) throw new Error(`fixture transition refused: ${event.t}`)
  return result.value.launch
}

function failedWith(
  launch: StoredLaunch,
  cause: LaunchFailureCause,
  extra: { toolOutputTail?: string } = {}
) {
  const jev = cause === 'jev-unreachable' || cause === 'jev-could-not-choose'
  return step(launch, {
    t: 'failed',
    failure: buildLaunchFailure({
      cause,
      supplierLabel: 'Claude Code',
      ...(jev ? { jevReason: 'timeout' as const } : {}),
      ...extra
    })
  })
}

/** The facts `launches` keeps of a launch (`ports/launchStore.ts` read-back projection). */
function storedFacts(launch: StoredLaunch) {
  const { failure, request: req, ...rest } = launch
  return {
    ...rest,
    request: {
      ...req,
      prompt: '',
      jevOn: launch.launchedWithLetJevChoose
    },
    ...(failure !== undefined
      ? {
          failure: {
            cause: failure.cause,
            ...(failure.jevReason !== undefined ? { jevReason: failure.jevReason } : {})
          }
        }
      : {})
  }
}

export function runLaunchStoreContract(
  makeSubject: () => LaunchStoreSubject | Promise<LaunchStoreSubject>
): void {
  describe('LaunchStore', () => {
    let subject: LaunchStoreSubject | null = null

    afterEach(async () => {
      await subject?.dispose()
      subject = null
    })

    const setUp = async () => {
      subject = await makeSubject()
      return subject
    }

    const putIn = (s: LaunchStoreSubject, l: StoredLaunch) => s.inTransaction(() => s.store.put(l))

    it('[INV-52] a failed launch is stored with exactly one failure cause and a settled time', async () => {
      const s = await setUp()
      const launch = step(sent(request(s.mineId)), { t: 'spawned', at: s.clock.now() })
      putIn(s, launch)
      expect(s.settledAt(launch.id)).toBeNull()
      s.clock.advance(1_500)
      const settledAt = s.clock.now()

      const failed = failedWith(launch, 'exited-at-once', { toolOutputTail: 'Error: no such flag' })
      putIn(s, failed)
      s.clock.advance(1_000)
      putIn(s, failed)

      const stored = s.store.byId(launch.id)
      expect(stored).toMatchObject(storedFacts(failed))
      expect(stored?.state).toBe('failed')
      expect(stored?.failure?.cause).toBe('exited-at-once')
      expect(stored?.failure).not.toHaveProperty('toolOutputTail')
      expect(s.settledAt(launch.id)).toBe(settledAt)
    })

    it('[INV-53] inFlight returns launches in routing, resolving or spawned only', async () => {
      const s = await setUp()
      const routing = sent(request(s.mineId, { jevOn: true }))
      const resolving = sent(request(s.mineId))
      const spawned = step(sent(request(s.mineId)), { t: 'spawned', at: s.clock.now() })
      const succeeded = step(step(sent(request(s.mineId)), { t: 'spawned', at: s.clock.now() }), {
        t: 'succeeded',
        dwarfId: s.dwarfId
      })
      const failed = failedWith(sent(request(s.mineId)), 'not-installed')
      const handedBack = step(sent(request(s.mineId, { jevOn: true })), { t: 'handed-back' })
      const lost = step(sent(request(s.mineId)), { t: 'boot-reconciled', evidence: null })
      for (const launch of [routing, resolving, spawned, succeeded, failed, handedBack, lost]) {
        putIn(s, launch)
      }

      expect(s.store.inFlight().map((l) => [l.id, l.state])).toEqual([
        [routing.id, 'routing'],
        [resolving.id, 'resolving'],
        [spawned.id, 'spawned']
      ])
      expect(s.store.inFlight()[2]).toMatchObject(storedFacts(spawned))
    })

    it('[ADR-020] markSeen is accepted only for a failed launch', async () => {
      const s = await setUp()
      const live = sent(request(s.mineId))
      const succeeded = step(step(sent(request(s.mineId)), { t: 'spawned', at: s.clock.now() }), {
        t: 'succeeded',
        dwarfId: s.dwarfId
      })
      const failed = failedWith(sent(request(s.mineId)), 'could-not-start')
      for (const launch of [live, succeeded, failed]) putIn(s, launch)
      const firstSeen = s.clock.now() + 10

      expect(() => s.inTransaction(() => s.store.markSeen(live.id, firstSeen))).toThrow(
        HostInvariantError
      )
      expect(() => s.inTransaction(() => s.store.markSeen(succeeded.id, firstSeen))).toThrow(
        HostInvariantError
      )
      s.inTransaction(() => s.store.markSeen(failed.id, firstSeen))
      s.inTransaction(() => s.store.markSeen(failed.id, firstSeen + 50))

      expect(s.seenAt(live.id)).toBeNull()
      expect(s.seenAt(succeeded.id)).toBeNull()
      expect(s.seenAt(failed.id)).toBe(firstSeen)
    })

    it('[ADR-020] a launch reads back with its stored facts for each way, a retry and a delegated worker included', async () => {
      const s = await setUp()
      const supplier = sent(request(s.mineId))
      const custom = sent(
        withoutPermissionMode(
          request(s.mineId, {
            way: {
              kind: 'custom',
              command: { raw: 'my-agent --fast', argv: ['my-agent', '--fast'] }
            }
          })
        ),
        supplier.id
      )
      const jev = failedWith(
        sent(request(s.mineId, { way: { kind: 'jev' }, jevOn: true, jevAutoAccept: true })),
        'jev-unreachable'
      )
      const delegated = sent(
        request(s.mineId, { way: { kind: 'jev' }, jevOn: true, delegation: s.delegation })
      )
      for (const launch of [supplier, custom, jev, delegated]) putIn(s, launch)

      expect(s.store.byId(supplier.id)).toMatchObject(storedFacts(supplier))
      expect(s.store.byId(custom.id)).toMatchObject(storedFacts(custom))
      expect(s.store.byId(custom.id)?.request.permissionMode).toBeUndefined()
      expect(s.store.byId(jev.id)).toMatchObject(storedFacts(jev))
      expect(s.store.byId(delegated.id)).toMatchObject(storedFacts(delegated))
      expect(s.store.byId(delegated.id)?.launchedWithLetJevChoose).toBe(false)
      expect(s.store.byId(supplier.id)?.request.prompt).toBe('')
      expect(s.store.byId(nextLaunchId())).toBeNull()
    })

    it('[ADR-020] a launch only moves forward: a settled launch is never rewritten and an in-flight one never goes back', async () => {
      const s = await setUp()
      const resolving = sent(request(s.mineId))
      const spawned = step(resolving, { t: 'spawned', at: s.clock.now() })
      const failed = failedWith(spawned, 'exited-at-once')
      putIn(s, spawned)

      expect(() => putIn(s, resolving)).toThrow(HostInvariantError)
      putIn(s, failed)
      expect(() => putIn(s, spawned)).toThrow(HostInvariantError)
      expect(() => putIn(s, { ...spawned, state: 'succeeded', dwarfId: s.dwarfId })).toThrow(
        HostInvariantError
      )

      expect(s.store.byId(failed.id)).toMatchObject(storedFacts(failed))
    })

    it('[ADR-020] a write outside a transaction is refused and a rolled-back put leaves nothing', async () => {
      const s = await setUp()
      const launch = sent(request(s.mineId))

      expect(() => s.store.put(launch)).toThrow(HostInvariantError)
      expect(() =>
        s.inTransaction(() => {
          s.store.put(launch)
          throw new CallerFailure('the caller failed after storing')
        })
      ).toThrow(CallerFailure)
      expect(s.store.byId(launch.id)).toBeNull()

      const failed = failedWith(launch, 'not-installed')
      putIn(s, failed)
      expect(() => s.store.markSeen(failed.id, s.clock.now())).toThrow(HostInvariantError)
      expect(s.seenAt(failed.id)).toBeNull()
      expect(s.store.inFlight()).toEqual([])
    })
  })
}
