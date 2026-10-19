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

// L2 (17 §1.2): `DelegationLifecycle` (owner amendment N (AMENDMENT-14, OQ-85), 2026-10-15, and
// its addendum A14-07; 16 §4.8, §5.3; ADR-013 items 3-4) over the in-memory stores, a fake clock,
// a recording bus and a recording minter.

const T0: Instant = 1_750_000_000_000
const PARENT = '00000000-0000-7000-8000-0000000d6d01' as DwarfId
const OTHER_PARENT = '00000000-0000-7000-8000-0000000d6d02' as DwarfId
const WORKER = '00000000-0000-7000-8000-0000000d6d03' as DwarfId
const LAUNCH = '00000000-0000-7000-8000-0000000d6a01' as LaunchId
const OTHER_LAUNCH = '00000000-0000-7000-8000-0000000d6a02' as LaunchId
const UNBOUND_LAUNCH = '00000000-0000-7000-8000-0000000d6a03' as LaunchId
const ORPHAN_FILE = '00000000-0000-7000-8000-0000000d6a04' as LaunchId
const TASK = 'Summarise the failing test' as SubtaskText

const RELAY_ARGS = ['--dwarfai-relay-entry'] as const
const EXEC_PATH = '/opt/dwarfai/versions/1.2.3/DwarfAI-Miners'

function setUp(options: { delegationOn?: boolean } = {}) {
  const minted: string[] = []
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
    log,
    preferences: {
      get: () => ({
        subagentDelegationOn: options.delegationOn ?? true,
        routingProfile: 'balanced',
        systemNotificationsOn: true,
        openCodePermissionsOn: false
      })
    },
    mintCredential: () => {
      const value = drawCredential()
      minted.push(value)
      return { value, sha256: hashOf(value) }
    },
    appPaths: { execPath: EXEC_PATH },
    relayEntryArgs: RELAY_ARGS
  })
  return { tokens, tickets, files, clock, bus, log, lifecycle, minted }
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

describe('DelegationLifecycle.issueFor (16 §5.3; ADR-013 items 3-4)', () => {
  it("[INV-80, INV-81] issueFor returns null unless both gates are open and never for a delegated worker's launch", async () => {
    const off = setUp({ delegationOn: false })
    const on = setUp()

    // The setting off: closed, whatever the launch.
    expect(
      await off.lifecycle.issueFor({
        launchId: LAUNCH,
        mechanism: 'ticket-file',
        launchedWithLetJevChoose: true
      })
    ).toBeNull()
    // The launch did not use "Let Jev choose": closed. A delegated worker's launch always has
    // launchedWithLetJevChoose = false (09 D-17), so a worker gets null: depth one (INV-81).
    expect(
      await on.lifecycle.issueFor({
        launchId: LAUNCH,
        mechanism: 'ticket-file',
        launchedWithLetJevChoose: false
      })
    ).toBeNull()
    // No delegation for this driver.
    expect(
      await on.lifecycle.issueFor({
        launchId: OTHER_LAUNCH,
        mechanism: 'none',
        launchedWithLetJevChoose: true
      })
    ).toBeNull()

    for (const s of [off, on]) {
      expect(s.tokens.snapshot()).toStrictEqual([])
      expect(await s.files.list()).toStrictEqual([])
      expect(s.minted).toStrictEqual([])
    }
  })

  it('[C-13, C-15, INV-83] issueFor commits the hash-only token row, then writes the credential file, and returns a DelegationInjection that carries only the file path', async () => {
    const s = setUp()
    const write = s.files.write.bind(s.files)
    let rowAtWrite: DelegationToken | null = null
    s.files.write = (launchId, credential) => {
      rowAtWrite = s.tokens.byLaunch(launchId)
      return write(launchId, credential)
    }

    const injection = await s.lifecycle.issueFor({
      launchId: LAUNCH,
      mechanism: 'ticket-file',
      launchedWithLetJevChoose: true
    })

    expect(s.minted).toHaveLength(1)
    const credential = s.minted[0] ?? ''
    const path = `/host-data/run/mcp/${LAUNCH}.cred`
    expect(injection).toStrictEqual({
      mechanism: 'ticket-file',
      relay: { program: EXEC_PATH, args: [...RELAY_ARGS] },
      credentialFilePath: path
    })
    const token: DelegationToken = {
      launchId: LAUNCH,
      parentDwarfId: null,
      mechanism: 'ticket-file',
      credentialHash: hashOf(credential),
      issuedAt: T0
    }
    expect(rowAtWrite).toStrictEqual(token)
    expect(s.tokens.snapshot()).toStrictEqual([token])
    expect(s.files.read(path)).toBe(credential)
    // Never in the entry (no argv, no env), the row or the log (ADR-013 item 2, C-16).
    expect(JSON.stringify(injection)).not.toContain(credential)
    expect(JSON.stringify(s.tokens.snapshot())).not.toContain(credential)
    expect(JSON.stringify([s.log.entries, s.log.refused])).not.toContain(credential)
  })

  it('[ADR-013, INV-83] a protocol relay entry is issued like ticket-file, with its hash', async () => {
    const s = setUp()

    const injection = await s.lifecycle.issueFor({
      launchId: LAUNCH,
      mechanism: 'protocol',
      launchedWithLetJevChoose: true
    })

    expect(injection).toMatchObject({
      mechanism: 'protocol',
      credentialFilePath: `/host-data/run/mcp/${LAUNCH}.cred`
    })
    expect(s.tokens.byLaunch(LAUNCH)).toMatchObject({
      mechanism: 'protocol',
      credentialHash: hashOf(s.minted[0] ?? '')
    })
  })

  it('[ADR-013] in-process has no v1 driver: issueFor returns null and writes nothing', async () => {
    const s = setUp()

    expect(
      await s.lifecycle.issueFor({
        launchId: LAUNCH,
        mechanism: 'in-process',
        launchedWithLetJevChoose: true
      })
    ).toBeNull()
    expect(s.tokens.snapshot()).toStrictEqual([])
    expect(s.minted).toStrictEqual([])
  })

  it('[ADR-013, C-16] a credential file that cannot be written revokes the row and returns null, logged without the value', async () => {
    const s = setUp()
    s.files.failNextWrite('no-space')

    const injection = await s.lifecycle.issueFor({
      launchId: LAUNCH,
      mechanism: 'ticket-file',
      launchedWithLetJevChoose: true
    })

    expect(injection).toBeNull()
    expect(s.tokens.byLaunch(LAUNCH)).toBeNull()
    expect(s.tokens.snapshot()).toStrictEqual([
      expect.objectContaining({ launchId: LAUNCH, revokedAt: T0 })
    ])
    expect(s.log.entries).toStrictEqual([
      expect.objectContaining({
        level: 'warn',
        event: 'delegation.credential.write',
        subsystem: 'delegation',
        outcome: 'failed',
        causeClass: 'no-space',
        launchId: LAUNCH
      })
    ])
    expect(JSON.stringify([s.log.entries, s.log.refused])).not.toContain(s.minted[0] ?? '-')
  })

  it('[ADR-013] a credential file already at the path is never overwritten: the row is revoked and issueFor returns null', async () => {
    const s = setUp()
    await s.files.write(LAUNCH, 'planted')

    expect(
      await s.lifecycle.issueFor({
        launchId: LAUNCH,
        mechanism: 'ticket-file',
        launchedWithLetJevChoose: true
      })
    ).toBeNull()
    expect(s.files.read(`/host-data/run/mcp/${LAUNCH}.cred`)).toBe('planted')
    expect(s.tokens.live()).toStrictEqual([])
  })

  it('[ADR-013, INV-83] a credential store that throws after the row was committed fails closed: the row is revoked and issueFor returns null', async () => {
    const s = setUp()
    s.files.write = () => Promise.reject(new Error('a credential file is named by a launch id'))

    const injection = await s.lifecycle.issueFor({
      launchId: LAUNCH,
      mechanism: 'ticket-file',
      launchedWithLetJevChoose: true
    })

    expect(injection).toBeNull()
    expect(s.tokens.live()).toStrictEqual([])
    expect(s.tokens.snapshot()).toStrictEqual([
      expect.objectContaining({ launchId: LAUNCH, revokedAt: T0 })
    ])
    expect(s.log.entries).toStrictEqual([
      expect.objectContaining({
        event: 'delegation.credential.write',
        outcome: 'failed',
        causeClass: 'unknown',
        launchId: LAUNCH
      })
    ])
  })
})

describe('DelegationLifecycle.issuePromptRelay (AMENDMENT-21; ADR-013 item 3)', () => {
  it('[ADR-013, INV-83] a stream-json launch gets its relay credential whatever the delegation gates: hash-only row, then the file, and an injection with the path only', async () => {
    // Both gates closed: the setting off and a launch that did not use "Let Jev choose". The
    // permission tool needs the relay anyway; the delegation tools stay gate-checked per call.
    const s = setUp({ delegationOn: false })

    const injection = await s.lifecycle.issuePromptRelay(LAUNCH)

    expect(s.minted).toHaveLength(1)
    const credential = s.minted[0] ?? ''
    const path = `/host-data/run/mcp/${LAUNCH}.cred`
    expect(injection).toStrictEqual({
      mechanism: 'ticket-file',
      relay: { program: EXEC_PATH, args: [...RELAY_ARGS] },
      credentialFilePath: path
    })
    expect(s.tokens.snapshot()).toStrictEqual([
      {
        launchId: LAUNCH,
        parentDwarfId: null,
        mechanism: 'ticket-file',
        credentialHash: hashOf(credential),
        issuedAt: T0
      }
    ])
    expect(s.files.read(path)).toBe(credential)
    expect(JSON.stringify(injection)).not.toContain(credential)
    expect(JSON.stringify([s.log.entries, s.log.refused])).not.toContain(credential)
  })

  it('[ADR-013, INV-83] a prompt relay whose credential file cannot be written revokes the row and returns null', async () => {
    const s = setUp()
    s.files.failNextWrite('no-space')

    expect(await s.lifecycle.issuePromptRelay(LAUNCH)).toBeNull()
    expect(s.tokens.live()).toStrictEqual([])
    expect(await s.files.list()).toStrictEqual([])
  })
})
