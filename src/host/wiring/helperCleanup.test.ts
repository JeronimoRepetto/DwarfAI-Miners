// layer: L3
// The helper half of the ADR-015 item 6 cleanup pass (FM-025, INV-57; HO-26; ISSUE-209): a
// leftover DwarfAI helper (`mcp-relay`, `hook-shim`, `launcher`) recorded by a dead Host epoch is
// ended through the kernel's identity-checked tree kill (ADR-014), and its record dropped once it
// is gone. A provider session is never touched; a helper whose identity cannot be read is kept for
// the next boot; a pid that now names another process is never signalled. Over launching's
// in-memory process records and the ProcessControl double.
import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../kernel/domain/processIdentity'
import type { HostEpoch } from '../kernel/domain/values'
import { FakeProcessControl } from '../kernel/fakes/FakeProcessControl'
import { RecordingDiagnosticsLog } from '../kernel/fakes/RecordingDiagnosticsLog'
import type { ProcessPurpose } from '../modules/launching'
import { inMemoryLaunching } from '../modules/launching/testing/inMemoryLaunching'
import { cleanUpHelpers } from './helperCleanup'

const DEAD = 'epoch-dead' as HostEpoch
const NOW = 'epoch-now' as HostEpoch

function identity(pid: number): ProcessIdentity {
  return { pid, processStartTimeMs: 1_700_000_000_000 + pid, bootId: 'boot-a' }
}

function arrange() {
  const db = inMemoryLaunching()
  const processes = new FakeProcessControl({ bootId: 'boot-a' })
  const record = (pid: number, purpose: ProcessPurpose, hostEpoch: HostEpoch): ProcessIdentity => {
    const id = identity(pid)
    db.inTransaction(() => db.processes.put({ identity: id, purpose, hostEpoch }))
    return id
  }
  const log = new RecordingDiagnosticsLog()
  const run = () =>
    cleanUpHelpers({
      processes: db.processes,
      transactions: { inTransaction: (work) => db.inTransaction(work) },
      processControl: processes,
      clock: db.clock,
      hostEpoch: NOW,
      log
    })
  return { db, processes, record, run, log }
}

describe('the helper cleanup pass (ADR-015 item 6; ISSUE-209)', () => {
  it('[FM-025, INV-57] a leftover mcp-relay of a dead epoch is ended on a positive identity match and its record dropped', async () => {
    const s = arrange()
    const relay = s.record(7_001, 'mcp-relay', DEAD)
    s.processes.scriptTree(relay)

    await s.run()

    expect(s.processes.signals.map((signal) => signal.pid)).toEqual([7_001])
    expect(s.db.processes.live()).toEqual([])
  })

  it('[FM-025, INV-57] the pass never signals a provider session process, nor a helper of the running epoch', async () => {
    const s = arrange()
    const session = s.record(7_002, 'session', DEAD)
    const server = s.record(7_003, 'session-server', DEAD)
    const ownRelay = s.record(7_004, 'mcp-relay', NOW)
    for (const live of [session, server, ownRelay]) s.processes.scriptTree(live)

    await s.run()

    expect(s.processes.signals).toEqual([])
    expect(s.db.processes.live().map((p) => p.identity.pid)).toEqual([7_002, 7_003, 7_004])
  })

  it('[INV-57, ADR-014] a helper pid that now names another process is never signalled; an unreadable one is kept for the next boot', async () => {
    const s = arrange()
    s.record(7_005, 'hook-shim', DEAD)
    s.processes.script(7_005, { ...identity(7_005), processStartTimeMs: 1 })
    s.record(7_006, 'launcher', DEAD)
    s.processes.script(7_006, 'unknown')

    await s.run()

    expect(s.processes.signals).toEqual([])
    expect(s.db.processes.live().map((p) => p.identity.pid)).toEqual([7_006])
  })
})
