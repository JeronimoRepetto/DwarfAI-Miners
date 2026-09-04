import { describe, expect, it } from 'vitest'
import type { Dwarf } from '../domain/types'
import {
  HeldCrew,
  heldCrewDwarfs,
  heldCrewTargets,
  heldRootRole,
  rankForSpawnDepth,
  type HeldSessionSubagentSignal
} from './heldCrew'

/*
 * The taxonomy of #157, pinned against the shapes the Agent SDK actually
 * emits. Every signal below is the shape measured off a real held session on
 * 2026-09-03 (two subagents launched in parallel, the first of which launched
 * one of its own): `task_started` carries `spawn_depth` — 1 for a top-level
 * spawn, N+1 from inside a depth-N agent — and endings arrive twice, once as
 * `task_updated` with a terminal patch and once as `task_notification`.
 */

function root(overrides: Partial<Dwarf> = {}): Dwarf {
  return {
    id: 'claude:session-1',
    provider: 'claude',
    role: 'foreman',
    name: 'session-1',
    status: 'working',
    sessionId: 'session-1',
    pid: 4242,
    ...overrides
  }
}

function started(
  taskId: string,
  extra: Partial<Extract<HeldSessionSubagentSignal, { kind: 'task-started' }>> = {}
): HeldSessionSubagentSignal {
  return { kind: 'task-started', taskId, taskType: 'local_agent', spawnDepth: 1, ...extra }
}

function crewOf(...signals: HeldSessionSubagentSignal[]): HeldCrew {
  const crew = new HeldCrew()
  for (const signal of signals) crew.apply(signal)
  return crew
}

describe('rankForSpawnDepth', () => {
  it('makes a top-level spawn a worker and everything below it a worker2', () => {
    expect(rankForSpawnDepth(1)).toBe('worker')
    expect(rankForSpawnDepth(2)).toBe('worker2')
    expect(rankForSpawnDepth(3)).toBe('worker2')
    expect(rankForSpawnDepth(9)).toBe('worker2')
  })

  it('reads a depth it was never told as a worker, never as a worker2', () => {
    // Being deeper is the stronger claim, so it needs the proof. The same
    // direction the rest of this codebase reads an absence in: an absent
    // pendingBackgroundAgentCount is not a count of zero, and a provisional
    // tier may not seal a ledger delta.
    expect(rankForSpawnDepth(undefined)).toBe('worker')
    expect(rankForSpawnDepth(0)).toBe('worker')
    expect(rankForSpawnDepth(-1)).toBe('worker')
    expect(rankForSpawnDepth(Number.NaN)).toBe('worker')
  })
})

describe('HeldCrew', () => {
  it('has nobody until the session actually launches something', () => {
    expect(crewOf().members()).toEqual([])
    expect(crewOf().hasCoordinated()).toBe(false)
  })

  it('takes a launched subagent on, in the order it was launched', () => {
    const crew = crewOf(started('a1', { description: 'Map the formats' }), started('a2'))
    expect(crew.members().map((member) => member.taskId)).toEqual(['a1', 'a2'])
  })

  it('names a subagent after its own task description', () => {
    const crew = crewOf(started('a1', { description: 'Map the formats' }))
    expect(crew.members()[0]?.name).toBe('Map the formats')
  })

  it('falls back to a name built from the task id, never to an empty one', () => {
    // Built from the id rather than from model text, so nothing a description
    // could carry can reach it — and an absent description stays absent on the
    // dwarf rather than inheriting this.
    const crew = crewOf(started('a1234567890'))
    expect(crew.members()[0]?.name).toBe('agent-a123456')
    expect(crew.members()[0]?.description).toBeUndefined()
  })

  it('drops a subagent the moment its task reaches a terminal status', () => {
    const crew = crewOf(started('a1'), started('a2'), { kind: 'task-ended', taskId: 'a1' })
    expect(crew.members().map((member) => member.taskId)).toEqual(['a2'])
  })

  it('takes the second report of the same ending without complaint', () => {
    // The stream says it twice — `task_updated` with a terminal patch, then
    // `task_notification` — and both are the same fact.
    const crew = crewOf(started('a1'), { kind: 'task-ended', taskId: 'a1' })
    crew.apply({ kind: 'task-ended', taskId: 'a1' })
    expect(crew.members()).toEqual([])
  })

  it('never lets an ended subagent come back, whatever a later signal says', () => {
    // The ghost dwarf, in this stream's own currency: ended memory outranks
    // launch memory everywhere, exactly as terminalAgents does for a transcript
    // (#28). A resumed task announcing itself again would otherwise mine
    // forever beside the crew that replaced it.
    const crew = crewOf(started('a1'), { kind: 'task-ended', taskId: 'a1' })
    crew.apply(started('a1'))
    expect(crew.members()).toEqual([])
  })

  it('ends a task that ended before this panel ever heard it start', () => {
    const crew = crewOf({ kind: 'task-ended', taskId: 'a1' }, started('a1'))
    expect(crew.members()).toEqual([])
  })

  it('leaves alone every task that is not a spawned agent', () => {
    // A backgrounded bash job, an MCP call and a workflow all arrive on the
    // same `task_started` channel. Only a local_agent is a dwarf; the rest are
    // tools, and drawing one would put a miner in the gallery for a shell.
    const crew = crewOf(
      { kind: 'task-started', taskId: 'b1', taskType: 'local_bash' },
      { kind: 'task-started', taskId: 'm1', taskType: 'mcp_task' },
      { kind: 'task-started', taskId: 'w1', taskType: 'local_workflow' }
    )
    expect(crew.members()).toEqual([])
  })

  it('takes a task on when its own depth proves it is a spawned agent', () => {
    // `spawn_depth` is documented as set on a spawned agent and on nothing
    // else, so it is proof in its own right when task_type is absent — an
    // older CLI that names no type has still said what this is.
    const crew = crewOf({ kind: 'task-started', taskId: 'a1', spawnDepth: 1 })
    expect(crew.members().map((member) => member.taskId)).toEqual(['a1'])
  })

  it('refuses a task that proves neither, rather than guessing it is an agent', () => {
    const crew = crewOf({ kind: 'task-started', taskId: 'x1' })
    expect(crew.members()).toEqual([])
  })

  it('leaves the housekeeping tasks the CLI itself says to hide out of the crew', () => {
    // `ambient` is the CLI's own word for a task it does not surface as user
    // work — a live-update watcher and its kin. A dwarf for one would be the
    // panel inventing labour nobody asked for.
    const crew = crewOf(started('a1', { ambient: true }))
    expect(crew.members()).toEqual([])
  })

  it('remembers the tool call a nested agent was launched from', () => {
    // The join that makes a chain addressable: the assistant turn INSIDE a
    // worker carries that worker's own tool-use id, and the task_started that
    // follows names the call it came from. Neither half says who the parent is
    // on its own.
    const crew = crewOf(
      started('a1', { toolUseId: 'toolu-1' }),
      { kind: 'tool-call', toolUseId: 'toolu-2', insideToolUseId: 'toolu-1' },
      started('a2', { toolUseId: 'toolu-2', spawnDepth: 2 })
    )
    expect(crew.members().map((member) => [member.taskId, member.parentTaskId])).toEqual([
      ['a1', undefined],
      ['a2', 'a1']
    ])
  })

  it('leaves the parent unnamed when nothing in the stream established one', () => {
    const crew = crewOf(started('a2', { spawnDepth: 2 }))
    expect(crew.members()[0]?.parentTaskId).toBeUndefined()
  })
})

describe('heldRootRole', () => {
  /*
   * The promotion rule, and the one decision this issue left open.
   *
   * A launched session digs alone until it actually coordinates, and the moment
   * it has a live subagent it is the foreman. What happens when the last one
   * finishes is answered by the OBSERVED sessions' own rule, so that both paths
   * say the same thing about the same session: claudeProvider makes a session
   * "the foreman whether or not it currently has agents out", because deriving
   * the rank from the headcount made the same dwarf swap identity mid-session.
   * So promotion LATCHES: it is derived from reality, and having coordinated is
   * a fact about this session that finishing does not undo.
   */
  it('digs alone as a worker until the session has coordinated anything', () => {
    expect(heldRootRole(crewOf())).toBe('worker')
  })

  it('promotes the moment a subagent is live', () => {
    expect(heldRootRole(crewOf(started('a1')))).toBe('foreman')
  })

  it('keeps the rank after the last subagent has gone', () => {
    const crew = crewOf(started('a1'), { kind: 'task-ended', taskId: 'a1' })
    expect(crew.members()).toEqual([])
    expect(heldRootRole(crew)).toBe('foreman')
  })

  it('is not promoted by a task that was never a dwarf', () => {
    // Coordinating a bash job is not coordinating a crew.
    expect(
      heldRootRole(crewOf({ kind: 'task-started', taskId: 'b1', taskType: 'local_bash' }))
    ).toBe('worker')
  })
})

describe('heldCrewDwarfs', () => {
  it('names each dwarf after its parent, so a subagent is never mistaken for a root', () => {
    const crew = crewOf(started('a1'))
    expect(heldCrewDwarfs(root(), crew)[0]?.id).toBe('claude:session-1:a1')
  })

  it('gives the depth-1 crew the worker rank and everything deeper worker2', () => {
    const crew = crewOf(
      started('a1', { toolUseId: 'toolu-1' }),
      { kind: 'tool-call', toolUseId: 'toolu-2', insideToolUseId: 'toolu-1' },
      started('a2', { toolUseId: 'toolu-2', spawnDepth: 2 }),
      { kind: 'tool-call', toolUseId: 'toolu-3', insideToolUseId: 'toolu-2' },
      started('a3', { toolUseId: 'toolu-3', spawnDepth: 3 })
    )
    expect(heldCrewDwarfs(root(), crew).map((dwarf) => dwarf.role)).toEqual([
      'worker',
      'worker2',
      'worker2'
    ])
  })

  it('says no human can be typing into any of them, whatever the root is', () => {
    // Its own fact, never inherited from the session above: nothing outside the
    // parent session can address a running subagent at all (#68).
    const crew = crewOf(started('a1'), started('a2', { spawnDepth: 2 }))
    for (const dwarf of heldCrewDwarfs(root({ attendance: 'attended' }), crew)) {
      expect(dwarf.attendance, dwarf.id).toBe('unattended')
    }
  })

  it('carries the session and pid of the session that owns them', () => {
    const dwarfs = heldCrewDwarfs(root(), crewOf(started('a1')))
    expect(dwarfs[0]?.sessionId).toBe('session-1')
    expect(dwarfs[0]?.pid).toBe(4242)
  })

  it('works until it is told otherwise, rather than being guessed into waiting', () => {
    // The same conservative reading claudeProvider takes for a transcript-
    // derived worker: nothing in this stream is a per-subagent blocked signal,
    // so an in-flight agent is never inferred to be waiting on anything.
    expect(heldCrewDwarfs(root(), crewOf(started('a1')))[0]?.status).toBe('working')
  })

  it('redacts a description before it can reach the panel', () => {
    // Free text the orchestrating model wrote, on its way into an always-on-top
    // window as both a name and a tooltip — the same gate lastMessage passes,
    // and passed HERE rather than after a renderer has truncated it, because a
    // truncated prefix can still contain a whole key (#59).
    const crew = crewOf(started('a1', { description: 'use sk-ant-api03-SECRETSECRETSECRET now' }))
    const dwarf = heldCrewDwarfs(root(), crew)[0]
    expect(dwarf?.name).not.toContain('SECRETSECRETSECRET')
    expect(dwarf?.description).not.toContain('SECRETSECRETSECRET')
  })

  it('carries the parent edge of a nested crew member, so its launcher can be named', () => {
    // #189. The rank cannot say who spawned a worker2 (rankForSpawnDepth gives
    // it to depth 2 AND DEEPER) and the id names the SESSION, so the fact that
    // settles it is the crew's own parent join — carried onto the wire here,
    // where messageIssuer can read it off the board.
    const crew = crewOf(
      started('a1', { toolUseId: 'toolu-1' }),
      { kind: 'tool-call', toolUseId: 'toolu-2', insideToolUseId: 'toolu-1' },
      started('a2', { toolUseId: 'toolu-2', spawnDepth: 2 })
    )
    expect(heldCrewDwarfs(root(), crew).map((dwarf) => [dwarf.id, dwarf.parentId])).toEqual([
      ['claude:session-1:a1', undefined],
      ['claude:session-1:a2', 'claude:session-1:a1']
    ])
  })

  it('leaves the edge absent when the stream established no parent, never guessing the root', () => {
    // The same refusal parentTaskId already holds one layer down: "I was
    // spawned" and "here is who by" are different facts, and an absent edge
    // keeps a worker2's prompt unattributed rather than naming the session.
    const crew = crewOf(started('a2', { spawnDepth: 2 }))
    expect(heldCrewDwarfs(root(), crew)[0]?.parentId).toBeUndefined()
  })

  it('claims nothing about how long any of them has been silent', () => {
    // No per-agent transcript is read here, so there is no mtime to publish.
    // The absent field means "nothing is known", where a 0 would claim the
    // dwarf had just spoken.
    expect(heldCrewDwarfs(root(), crewOf(started('a1')))[0]?.silentForMs).toBeUndefined()
  })
})

describe('heldCrewTargets', () => {
  it('routes a worker through the session that launched it', () => {
    const crew = crewOf(started('a1', { description: 'Explorer' }))
    expect(heldCrewTargets(root(), crew)).toEqual(
      new Map([
        [
          'claude:session-1:a1',
          { kind: 'foreman-relay', foremanDwarfId: 'claude:session-1', workerName: 'Explorer' }
        ]
      ])
    )
  })

  it('routes a worker2 through the worker that launched it, one hop further up', () => {
    // The whole chain, named. A running subagent has no channel of its own, so
    // the message lands in the session's queue either way — but a session that
    // never launched the worker2 has no idea who it is, and "[for agent A] [for
    // agent B]" is the only phrasing that tells it.
    const crew = crewOf(
      started('a1', { toolUseId: 'toolu-1', description: 'Explorer' }),
      { kind: 'tool-call', toolUseId: 'toolu-2', insideToolUseId: 'toolu-1' },
      started('a2', { toolUseId: 'toolu-2', spawnDepth: 2, description: 'Scout' })
    )
    expect(heldCrewTargets(root(), crew).get('claude:session-1:a2')).toEqual({
      kind: 'foreman-relay',
      foremanDwarfId: 'claude:session-1:a1',
      workerName: 'Scout'
    })
  })

  it('falls back to the session when the parent is not on the board', () => {
    // A parent that finished first, or one no signal ever named. The session is
    // the only addressable node in the whole tree, so relaying to it is the
    // honest degradation — a hop to a dwarf that is not there would resolve to
    // no channel at all and lose the send entirely.
    const crew = crewOf(
      started('a1', { toolUseId: 'toolu-1' }),
      { kind: 'tool-call', toolUseId: 'toolu-2', insideToolUseId: 'toolu-1' },
      started('a2', { toolUseId: 'toolu-2', spawnDepth: 2, description: 'Scout' }),
      { kind: 'task-ended', taskId: 'a1' }
    )
    expect(crew.members().map((member) => member.taskId)).toEqual(['a2'])
    expect(heldCrewTargets(root(), crew).get('claude:session-1:a2')).toEqual({
      kind: 'foreman-relay',
      foremanDwarfId: 'claude:session-1',
      workerName: 'Scout'
    })
  })
})
