// layer: L4
// L4 (17 §1.4): what the Claude observation adapter tells the observed-subagent route (AMENDMENT-29,
// owner 2026-10-24) of a subagent dwarf, read from a per-test temp Claude configuration folder
// (17 §5.3) laid out as Claude Code lays it out: the lead session's recorded process identity (its
// registry entry through the #45 guard), the subagent's `description` (its `agent-<id>.meta.json`),
// how many other subagents of the session not seen to end share it, and the Claude Code version the
// session's transcripts last named. The records are synthetic, shaped like the spike's (2.1.310).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../../../kernel/domain/processIdentity'
import type { ProviderIdentity } from '../../../../kernel/domain/values'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeProcessControl } from '../../../../kernel/fakes/FakeProcessControl'
import { NodeFs } from '../../../../platform/fs/NodeFs'
import { ClaudeObservationAdapter } from './ClaudeObservationAdapter'

const SESSION = '01a0b000-0000-7000-8000-000000000729'
const ECHO_AGENT = 'a7725068ba6a77d24'
const DELTA_AGENT = 'a1111111111111111'
const ECHO = 'Run ping five times (echo)'
const DELTA = 'Run ping five times (delta)'
const CWD = 'C:\\work\\sample-project'
// The registry's procStart (a Windows FILETIME) and the same instant in epoch ms.
const PROC_START = '134324755721362761'
const LEAD: ProcessIdentity = { pid: 4242, processStartTimeMs: 1_788_001_972_136, bootId: 'boot-a' }

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const claude = (agent?: string): ProviderIdentity => ({
  providerId: 'claude',
  providerSessionId: SESSION,
  ...(agent === undefined ? {} : { providerAgentId: agent })
})

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`
const userLine = (n: number, version: string, extra: Record<string, unknown> = {}) =>
  line({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: CWD,
    sessionId: SESSION,
    version,
    type: 'user',
    message: { role: 'user', content: `step ${n}` },
    uuid: `00000000-0000-4000-8000-0000000729${String(n).padStart(2, '0')}`,
    timestamp: `2026-10-24T15:0${n}:00.000Z`,
    ...extra
  })

/** A session laid out as Claude Code lays it out, with its registry entry and two subagents. */
async function world(
  opts: { leadVersion?: string; registry?: boolean; sidecars?: Record<string, unknown> } = {}
) {
  const configDir = await mkdtemp(join(tmpdir(), 'dwarfai-claude-sub-'))
  temps.push(configDir)
  const project = join(configDir, 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'))
  const subagents = join(project, SESSION, 'subagents')
  await mkdir(subagents, { recursive: true })
  await writeFile(join(project, `${SESSION}.jsonl`), userLine(1, opts.leadVersion ?? '2.1.310'))
  const sidecars: Record<string, unknown> = opts.sidecars ?? {
    [ECHO_AGENT]: { agentType: 'general-purpose', description: ECHO, spawnDepth: 1 },
    [DELTA_AGENT]: { agentType: 'general-purpose', description: DELTA, spawnDepth: 1 }
  }
  for (const [agent, sidecar] of Object.entries(sidecars)) {
    await writeFile(
      join(subagents, `agent-${agent}.jsonl`),
      userLine(2, '2.1.310', { isSidechain: true, agentId: agent })
    )
    await writeFile(join(subagents, `agent-${agent}.meta.json`), JSON.stringify(sidecar))
  }
  if (opts.registry !== false) {
    await mkdir(join(configDir, 'sessions'), { recursive: true })
    await writeFile(
      join(configDir, 'sessions', `${LEAD.pid}.json`),
      JSON.stringify({
        pid: LEAD.pid,
        sessionId: SESSION,
        procStart: PROC_START,
        kind: 'interactive'
      })
    )
  }
  const processes = new FakeProcessControl({ bootId: 'boot-a' })
  processes.script(LEAD.pid, { ...LEAD })
  const fs = new NodeFs()
  const adapter = new ClaudeObservationAdapter({
    providerId: 'claude',
    configDir,
    claimedRoots: [],
    fs,
    clock: new FakeClock(1_790_800_000_000),
    processes
  })
  const observe = async () => {
    for (const source of await adapter.discover(fs)) await adapter.read(source, null)
  }
  await observe()
  return { adapter, project, subagents, observe }
}

describe('ClaudeObservationAdapter: what the subagent route reads (AMENDMENT-29)', () => {
  it("[ADR-014] a subagent's lead process is its session's recorded identity; the session itself and a subagent keep no process of their own", async () => {
    const { adapter } = await world()
    expect(adapter.leadProcessOf(claude(ECHO_AGENT))).toEqual(LEAD)
    expect(adapter.leadProcessOf(claude())).toBeNull()
    expect(adapter.processIdentityOf(claude(ECHO_AGENT))).toBeNull()
    expect(adapter.processIdentityOf(claude())).toEqual(LEAD)
  })

  it("[ADR-012, ADR-014] the facts: the lead, the subagent's description, no twin, the transcripts' version", async () => {
    const { adapter } = await world()
    expect(await adapter.subagentSendFactsOf(claude(ECHO_AGENT))).toEqual({
      lead: LEAD,
      description: ECHO,
      twins: 0,
      version: '2.1.310'
    })
  })

  it('[ADR-012] another subagent of the session with the same description is a twin, until it is seen to end', async () => {
    const { adapter, project, subagents, observe } = await world()
    // A third agent, started with the same description (no transcript read yet).
    await writeFile(
      join(subagents, 'agent-a2222222222222222.meta.json'),
      JSON.stringify({ agentType: 'general-purpose', description: ECHO, spawnDepth: 1 })
    )
    expect((await adapter.subagentSendFactsOf(claude(ECHO_AGENT)))?.twins).toBe(1)
    // Its task notification is delivered in the lead's transcript: it ended.
    await writeFile(
      join(project, `${SESSION}.jsonl`),
      userLine(1, '2.1.310') +
        line({
          type: 'queue-operation',
          operation: 'enqueue',
          sessionId: SESSION,
          timestamp: '2026-10-24T15:09:00.000Z',
          content:
            '<task-notification><task-id>a2222222222222222</task-id><status>completed</status></task-notification>'
        })
    )
    await observe()
    expect((await adapter.subagentSendFactsOf(claude(ECHO_AGENT)))?.twins).toBe(0)
  })

  it('[ADR-012] a sidecar that names no description, or cannot be read, gives none', async () => {
    const { adapter } = await world({
      sidecars: { [ECHO_AGENT]: { agentType: 'general-purpose', spawnDepth: 1 } }
    })
    expect((await adapter.subagentSendFactsOf(claude(ECHO_AGENT)))?.description).toBeNull()
  })

  it('[ADR-012] the version is the one the latest record of the session names', async () => {
    const { adapter } = await world({ leadVersion: '2.1.309' })
    // The subagents' records, read after the lead's, name 2.1.310.
    expect((await adapter.subagentSendFactsOf(claude(ECHO_AGENT)))?.version).toBe('2.1.310')
    const { adapter: other } = await world({ leadVersion: '2.1.311', sidecars: {} })
    const facts = await other.subagentSendFactsOf(claude(ECHO_AGENT))
    expect(facts).toBeNull()
  })

  it('[ADR-014] no registry entry for the lead, the session itself or an unknown agent: no facts', async () => {
    const { adapter } = await world({ registry: false })
    expect(await adapter.subagentSendFactsOf(claude(ECHO_AGENT))).toBeNull()
    const { adapter: known } = await world()
    expect(await known.subagentSendFactsOf(claude())).toBeNull()
    expect(await known.subagentSendFactsOf(claude('a9999999999999999'))).toBeNull()
  })
})
