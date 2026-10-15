import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId, Instant, LaunchId } from '../../../kernel/domain/values'
import type { Delegation, DelegationId } from '../domain/delegation'
import type { DelegationLifecycleEvent } from '../domain/events'
import type { SubtaskText } from '../domain/subtaskText'
import type { DelegationToken } from '../ports/delegationStores'
import { InMemoryCredentialFileStore } from '../ports/fakes/InMemoryCredentialFileStore'
import { InMemoryDelegationTicketStore } from '../ports/fakes/InMemoryDelegationTicketStore'
import { InMemoryDelegationTokenStore } from '../ports/fakes/InMemoryDelegationTokenStore'
import { drawCredential, hashOf } from '../testing/drawCredential'
import { DelegationLifecycleService } from './delegationLifecycle'

// L2 (17 §1.2): the revocation half of `DelegationLifecycle` (owner amendment N (AMENDMENT-14,
// OQ-85), 2026-10-15; 16 §4.8, §5.3; ADR-013 item 3) over the in-memory stores, a fake clock and
// a recording bus. `issueFor` is not here: see the hand-off of ISSUE-198.

const T0: Instant = 1_750_000_000_000
const PARENT = '00000000-0000-7000-8000-0000000d6d01' as DwarfId
const OTHER_PARENT = '00000000-0000-7000-8000-0000000d6d02' as DwarfId
const WORKER = '00000000-0000-7000-8000-0000000d6d03' as DwarfId
const LAUNCH = '00000000-0000-7000-8000-0000000d6a01' as LaunchId
const OTHER_LAUNCH = '00000000-0000-7000-8000-0000000d6a02' as LaunchId
const UNBOUND_LAUNCH = '00000000-0000-7000-8000-0000000d6a03' as LaunchId
const ORPHAN_FILE = '00000000-0000-7000-8000-0000000d6a04' as LaunchId
const TASK = 'Summarise the failing test' as SubtaskText

function setUp() {
  const tokens = new InMemoryDelegationTokenStore()
  const tickets = new InMemoryDelegationTicketStore()
  const files = new InMemoryCredentialFileStore()
  const clock = new FakeClock(T0)
  const bus = new RecordingEventBus<DelegationLifecycleEvent>()
  const log = new RecordingDiagnosticsLog()
  const lifecycle = new DelegationLifecycleService({
    tokens,
    tickets,
    files,
    transactions: { inTransaction: (work) => work() },
    bus,
    clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-1',
    log
  })
  return { tokens, tickets, files, clock, bus, log, lifecycle }
}

/** A gated launch as `issueFor` leaves it: the row (hash only), then the file. */
async function issued(
  s: ReturnType<typeof setUp>,
  launchId: LaunchId,
  parent: DwarfId | null
): Promise<{ credential: string; token: DelegationToken }> {
  const credential = drawCredential()
  const token: DelegationToken = {
    launchId,
    parentDwarfId: parent,
    mechanism: 'ticket-file',
    credentialHash: hashOf(credential),
    issuedAt: T0
  }
  s.tokens.issue(token)
  await s.files.write(launchId, credential)
  return { credential, token }
}

function delegation(n: number, parent: DwarfId, change: Partial<Delegation> = {}): Delegation {
  return {
    id: `00000000-0000-7000-8000-0000000d6e0${n}` as DelegationId,
    parentDwarfId: parent,
    ticket: `ticket-${n}`,
    task: TASK,
    state: 'attempted',
    createdAt: T0,
    ...change
  }
}

describe('DelegationLifecycle revocation (16 §4.8, §5.3)', () => {
  it("[S8.11, INV-83] revokeFor sets revoked_at, deletes the file and fails the dwarf's running delegations as parent-gone", async () => {
    const s = setUp()
    const { token } = await issued(s, LAUNCH, PARENT)
    await issued(s, OTHER_LAUNCH, OTHER_PARENT)
    s.tickets.put(delegation(1, PARENT))
    s.tickets.put(delegation(2, PARENT, { state: 'running', workerDwarfId: WORKER }))
    s.tickets.put(delegation(3, OTHER_PARENT))
    s.clock.advance(5_000)

    await s.lifecycle.revokeFor(PARENT)

    const at = T0 + 5_000
    expect(s.tokens.snapshot()).toStrictEqual([
      { ...token, revokedAt: at },
      expect.objectContaining({ launchId: OTHER_LAUNCH, parentDwarfId: OTHER_PARENT })
    ])
    expect(s.tokens.byLaunch(LAUNCH)).toBeNull()
    expect(await s.files.list()).toStrictEqual([OTHER_LAUNCH])
    expect(s.tickets.inFlight().map((d) => d.ticket)).toStrictEqual(['ticket-3'])
    expect(s.tickets.byTicket('ticket-1')).toStrictEqual({
      id: delegation(1, PARENT).id,
      parentDwarfId: PARENT,
      ticket: 'ticket-1',
      state: 'failed',
      failure: 'parent-gone',
      createdAt: T0,
      settledAt: at
    })
    expect(s.tickets.byTicket('ticket-2')).toMatchObject({
      state: 'failed',
      failure: 'parent-gone',
      workerDwarfId: WORKER
    })
    expect(s.bus.published.map((e) => [e.type, e.payload])).toStrictEqual([
      [
        'DelegationFailed',
        { delegationId: delegation(1, PARENT).id, parentDwarfId: PARENT, failure: 'parent-gone' }
      ],
      [
        'DelegationFailed',
        { delegationId: delegation(2, PARENT).id, parentDwarfId: PARENT, failure: 'parent-gone' }
      ]
    ])
  })

  it('[ADR-013] revokeFor of a dwarf with no token and no delegation changes nothing, and twice revokes once', async () => {
    const s = setUp()
    const { token } = await issued(s, LAUNCH, PARENT)

    await s.lifecycle.revokeFor(OTHER_PARENT)
    expect(s.tokens.byLaunch(LAUNCH)).toStrictEqual(token)
    expect(await s.files.list()).toStrictEqual([LAUNCH])

    await s.lifecycle.revokeFor(PARENT)
    s.clock.advance(1_000)
    await s.lifecycle.revokeFor(PARENT)

    expect(s.tokens.snapshot()).toStrictEqual([{ ...token, revokedAt: T0 }])
    expect(s.bus.published).toStrictEqual([])
  })

  it('[ADR-013] revokeLaunch revokes the token of a launch whose start failed and deletes its file', async () => {
    const s = setUp()
    const { token } = await issued(s, UNBOUND_LAUNCH, null)
    await issued(s, LAUNCH, PARENT)

    await s.lifecycle.revokeLaunch(UNBOUND_LAUNCH)

    expect(s.tokens.snapshot()).toStrictEqual([
      expect.objectContaining({ launchId: LAUNCH, parentDwarfId: PARENT }),
      { ...token, revokedAt: T0 }
    ])
    expect(await s.files.list()).toStrictEqual([LAUNCH])
  })

  it("[ADR-013] bindParent makes the launch's dwarf the token's parent once, so revokeFor finds it", async () => {
    const s = setUp()
    await issued(s, UNBOUND_LAUNCH, null)

    s.lifecycle.bindParent(UNBOUND_LAUNCH, PARENT)
    s.lifecycle.bindParent(UNBOUND_LAUNCH, PARENT)
    s.lifecycle.bindParent(LAUNCH, PARENT)

    expect(s.tokens.byLaunch(UNBOUND_LAUNCH)?.parentDwarfId).toBe(PARENT)
    await s.lifecycle.revokeFor(PARENT)
    expect(s.tokens.live()).toStrictEqual([])
    expect(await s.files.list()).toStrictEqual([])
  })

  it('[ADR-013] the boot sweep deletes credential files with no live, unrevoked token', async () => {
    const s = setUp()
    await issued(s, LAUNCH, PARENT)
    await issued(s, OTHER_LAUNCH, OTHER_PARENT)
    await issued(s, UNBOUND_LAUNCH, null)
    await s.files.write(ORPHAN_FILE, drawCredential())
    s.tokens.revoke(OTHER_LAUNCH, T0)

    const swept = await s.lifecycle.sweepOrphans()

    // The unbound launch did not survive the restart: its token is revoked, then its file goes.
    expect(swept).toStrictEqual({ revoked: 1, deleted: 3 })
    expect(s.tokens.live().map((t) => t.launchId)).toStrictEqual([LAUNCH])
    expect(await s.files.list()).toStrictEqual([LAUNCH])
    expect(await s.lifecycle.sweepOrphans()).toStrictEqual({ revoked: 0, deleted: 0 })
  })

  it('[ADR-013] a file the sweep cannot list is logged and never fatal, and no credential reaches the log', async () => {
    const s = setUp()
    const { credential } = await issued(s, UNBOUND_LAUNCH, null)
    s.files.list = () => Promise.reject(Object.assign(new Error(credential), { code: 'EACCES' }))

    expect(await s.lifecycle.sweepOrphans()).toStrictEqual({ revoked: 1, deleted: 0 })

    expect(s.log.entries).toStrictEqual([
      expect.objectContaining({
        level: 'warn',
        event: 'delegation.credential.sweep',
        subsystem: 'delegation',
        outcome: 'failed'
      })
    ])
    expect(JSON.stringify([s.log.entries, s.log.refused])).not.toContain(credential)
  })
})
