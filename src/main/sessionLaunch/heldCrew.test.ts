import { describe, expect, it } from 'vitest'
import { MAX_DWARF_TEXT_CHARS, type Dwarf } from '../domain/types'
import {
  HeldCrew,
  heldCrewDwarfs,
  heldCrewTargets,
  heldRootRole,
  MAX_ENDED_CONCLUSIONS,
  rankForSpawnDepth,
  type HeldSessionSubagentSignal,
  type HeldTaskEndStatus
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
  // AMENDED for #510: `task-ended` now carries the ending's own terminal
  // `status` (see HeldTaskEndStatus) — required on the signal's type, so
  // every fixture below that builds one now names it. None of these tests is
  // about the status itself; `'completed'` is the ordinary case and changes
  // nothing about what any of them already proved.
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
    const crew = crewOf(started('a1'), started('a2'), {
      kind: 'task-ended',
      taskId: 'a1',
      status: 'completed'
    })
    expect(crew.members().map((member) => member.taskId)).toEqual(['a2'])
  })

  it('takes the second report of the same ending without complaint', () => {
    // The stream says it twice — `task_updated` with a terminal patch, then
    // `task_notification` — and both are the same fact.
    const crew = crewOf(started('a1'), { kind: 'task-ended', taskId: 'a1', status: 'completed' })
    crew.apply({ kind: 'task-ended', taskId: 'a1', status: 'completed' })
    expect(crew.members()).toEqual([])
  })

  it('never lets an ended subagent come back, whatever a later signal says', () => {
    // The ghost dwarf, in this stream's own currency: ended memory outranks
    // launch memory everywhere, exactly as terminalAgents does for a transcript
    // (#28). A resumed task announcing itself again would otherwise mine
    // forever beside the crew that replaced it.
    const crew = crewOf(started('a1'), { kind: 'task-ended', taskId: 'a1', status: 'completed' })
    crew.apply(started('a1'))
    expect(crew.members()).toEqual([])
  })

  it('ends a task that ended before this panel ever heard it start', () => {
    const crew = crewOf({ kind: 'task-ended', taskId: 'a1', status: 'completed' }, started('a1'))
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

  it('gives a subagent the model its own turns ran on', () => {
    // `task_started` never names a model — id, description, depth, task type
    // and the call it came from are the whole message. The model arrives after
    // it, on the assistant turns the agent itself writes, and those carry the
    // tool-use id of the task they belong to. So the model joins through the
    // SAME identity the parent join already turns on (#447).
    const crew = crewOf(started('a1', { toolUseId: 'toolu-1' }), {
      kind: 'agent-model',
      insideToolUseId: 'toolu-1',
      model: 'claude-sonnet-4-5-20250929'
    })
    expect(crew.members()[0]?.model).toBe('claude-sonnet-4-5-20250929')
  })

  it('attributes each agent in a chain its own model, never the one above it', () => {
    const crew = crewOf(
      started('a1', { toolUseId: 'toolu-1' }),
      { kind: 'agent-model', insideToolUseId: 'toolu-1', model: 'claude-opus-4-1-20250805' },
      { kind: 'tool-call', toolUseId: 'toolu-2', insideToolUseId: 'toolu-1' },
      started('a2', { toolUseId: 'toolu-2', spawnDepth: 2 }),
      { kind: 'agent-model', insideToolUseId: 'toolu-2', model: 'claude-haiku-4-5-20251001' }
    )
    expect(crew.members().map((member) => [member.taskId, member.model])).toEqual([
      ['a1', 'claude-opus-4-1-20250805'],
      ['a2', 'claude-haiku-4-5-20251001']
    ])
  })

  it('leaves the model unknown rather than inheriting it from the agent above', () => {
    // The direction every unproven reading falls in here. A nested agent whose
    // own turns this panel has not seen yet has said nothing about its model,
    // and the agent that launched it cannot say it on its behalf: a subagent is
    // routinely started on a different model from the one that spawned it.
    const crew = crewOf(
      started('a1', { toolUseId: 'toolu-1' }),
      { kind: 'agent-model', insideToolUseId: 'toolu-1', model: 'claude-opus-4-1-20250805' },
      { kind: 'tool-call', toolUseId: 'toolu-2', insideToolUseId: 'toolu-1' },
      started('a2', { toolUseId: 'toolu-2', spawnDepth: 2 })
    )
    expect(crew.members()[1]?.model).toBeUndefined()
  })

  it('attaches a model to nobody when no task was ever started from that call', () => {
    // The root session's own turns carry no parent tool-use id at all and never
    // reach here; a call this crew cannot resolve to a task is the same kind of
    // absence, and stamping the nearest member with it would be the inheritance
    // the test above refuses, arrived at sideways.
    const crew = crewOf(started('a1', { toolUseId: 'toolu-1' }), {
      kind: 'agent-model',
      insideToolUseId: 'toolu-9',
      model: 'claude-opus-4-1-20250805'
    })
    expect(crew.members()[0]?.model).toBeUndefined()
  })

  it('keeps a model reported before the task it belongs to was announced', () => {
    // The same ordering hazard the parent join carries: the stream is watched
    // live and nothing promises the announcement reaches this panel before the
    // turn that proves the model. What is known is retained until the task it
    // names exists, rather than being dropped for arriving early.
    const crew = crewOf(
      { kind: 'agent-model', insideToolUseId: 'toolu-1', model: 'claude-sonnet-4-5-20250929' },
      started('a1', { toolUseId: 'toolu-1' })
    )
    expect(crew.members()[0]?.model).toBe('claude-sonnet-4-5-20250929')
  })

  it('lets a later turn supersede the model an earlier one reported', () => {
    // An agent that fell back to another model mid-run is still that agent, and
    // the newest turn is the one that speaks for what it is running on now —
    // the same rule a held session's `init` follows for the root dwarf (#96).
    const crew = crewOf(
      started('a1', { toolUseId: 'toolu-1' }),
      { kind: 'agent-model', insideToolUseId: 'toolu-1', model: 'claude-opus-4-1-20250805' },
      { kind: 'agent-model', insideToolUseId: 'toolu-1', model: 'claude-sonnet-4-5-20250929' }
    )
    expect(crew.members()[0]?.model).toBe('claude-sonnet-4-5-20250929')
  })
})

describe('HeldCrew — subagent conclusion (#510)', () => {
  // AMENDED for #510, then CORRECTED: a task's own last text, and the status
  // its ending reported, are sealed as a TurnOutcome the crew keeps BY
  // TASK ID — never on the member itself. A subagent still leaves
  // `live`/`members()` the instant its task ends, exactly as the
  // pre-existing tests above already prove — a concluded dwarf that lingered
  // there, still reading `status: 'working'` forever, is the false presence
  // AGENTS.md's crew invariants exist to prevent, and it would have changed
  // `heldCrewDwarfs()`'s own output, which is out of this issue's scope
  // (#511 reads conclusions off the crew directly; see conclusionOf below).
  //
  // A clock is injected here, the same "pass a mutable object, advance it by
  // hand" idiom the rest of this codebase holds, rather than the ambient
  // `Date.now()` `crewOf` above still uses for every test with nothing to
  // time-stamp.
  const NOW = 1_700_000_000_000

  function crewWithClock(now: () => number, ...signals: HeldSessionSubagentSignal[]): HeldCrew {
    const crew = new HeldCrew(now)
    for (const signal of signals) crew.apply(signal)
    return crew
  }

  function textSignal(insideToolUseId: string, text: string): HeldSessionSubagentSignal {
    return { kind: 'task-text', insideToolUseId, text }
  }

  function ended(taskId: string, status: HeldTaskEndStatus): HeldSessionSubagentSignal {
    return { kind: 'task-ended', taskId, status }
  }

  it('still drops the member from members() the instant its task ends, even when text was retained', () => {
    const crew = crewWithClock(
      () => NOW,
      started('a1', { toolUseId: 'toolu-1' }),
      textSignal('toolu-1', 'Found three call sites.'),
      ended('a1', 'completed')
    )
    expect(crew.members()).toEqual([])
  })

  it("keeps a task's own conclusion readable by taskId after it has left the crew", () => {
    const crew = crewWithClock(
      () => NOW,
      started('a1', { toolUseId: 'toolu-1' }),
      textSignal('toolu-1', 'Found three call sites.'),
      ended('a1', 'completed')
    )
    expect(crew.conclusionOf('a1')).toEqual({
      kind: 'concluded',
      text: 'Found three call sites.',
      detail: 'completed',
      endedAt: NOW
    })
  })

  it('lets the last text a task wrote win over an earlier one', () => {
    const crew = crewWithClock(
      () => NOW,
      started('a1', { toolUseId: 'toolu-1' }),
      textSignal('toolu-1', 'Still looking.'),
      textSignal('toolu-1', 'Found three call sites.'),
      ended('a1', 'completed')
    )
    expect(crew.conclusionOf('a1')?.text).toBe('Found three call sites.')
  })

  it('records a conclusion even when a task ends with no text ever attributed to it', () => {
    // Absence of a captured text is not itself a fact, so nothing here
    // invents one — but the ENDING is a fact regardless of whether the task
    // ever wrote anything of its own, so a completed task still seals a
    // conclusion, simply with no text field on it.
    const crew = crewWithClock(() => NOW, started('a1'), ended('a1', 'completed'))
    expect(crew.conclusionOf('a1')).toEqual({
      kind: 'concluded',
      detail: 'completed',
      endedAt: NOW
    })
  })

  it('maps a failed task to errored', () => {
    const crew = crewWithClock(() => NOW, started('a1'), ended('a1', 'failed'))
    expect(crew.conclusionOf('a1')).toEqual({ kind: 'errored', detail: 'failed', endedAt: NOW })
  })

  it('maps a killed or a stopped task to interrupted', () => {
    const killed = crewWithClock(() => NOW, started('a1'), ended('a1', 'killed'))
    const stopped = crewWithClock(() => NOW, started('a2'), ended('a2', 'stopped'))
    expect(killed.conclusionOf('a1')).toEqual({
      kind: 'interrupted',
      detail: 'killed',
      endedAt: NOW
    })
    expect(stopped.conclusionOf('a2')).toEqual({
      kind: 'interrupted',
      detail: 'stopped',
      endedAt: NOW
    })
  })

  it('still carries whatever text was retained even on a non-completed ending', () => {
    // A subagent that wrote something before being killed said something
    // real. TurnOutcome's own rule is "text only when the provider actually
    // handed one over", never "only on a success" — see its module comment.
    const crew = crewWithClock(
      () => NOW,
      started('a1', { toolUseId: 'toolu-1' }),
      textSignal('toolu-1', 'Partial output before it was killed.'),
      ended('a1', 'killed')
    )
    expect(crew.conclusionOf('a1')).toEqual({
      kind: 'interrupted',
      text: 'Partial output before it was killed.',
      detail: 'killed',
      endedAt: NOW
    })
  })

  it("never leaks one task's text onto another", () => {
    const crew = crewWithClock(
      () => NOW,
      started('a1', { toolUseId: 'toolu-1' }),
      started('a2', { toolUseId: 'toolu-2' }),
      textSignal('toolu-1', 'a1 says this.'),
      textSignal('toolu-2', 'a2 says that.'),
      ended('a1', 'completed')
    )
    expect(crew.conclusionOf('a1')?.text).toBe('a1 says this.')
    // a2 has not ended yet, so it has sealed nothing at all — not even a
    // conclusion with the wrong text.
    expect(crew.conclusionOf('a2')).toBeUndefined()
  })

  it('takes the second report of the same ending without disturbing the conclusion the first one already sealed', () => {
    // task_updated and task_notification both report one ending — the same
    // hazard the pre-existing "second report" test above already covers for
    // membership. Re-sealing on the second would re-run the text lookup
    // below and find nothing left (textByCall was already drained by the
    // first), silently overwriting a real conclusion with a textless one.
    const crew = crewWithClock(
      () => NOW,
      started('a1', { toolUseId: 'toolu-1' }),
      textSignal('toolu-1', 'Done.'),
      ended('a1', 'completed')
    )
    crew.apply(ended('a1', 'completed'))
    expect(crew.conclusionOf('a1')).toEqual({
      kind: 'concluded',
      text: 'Done.',
      detail: 'completed',
      endedAt: NOW
    })
  })

  it('bounds a long conclusion to the wire’s ordinary ceiling, and marks it truncated', () => {
    const long = 'x'.repeat(MAX_DWARF_TEXT_CHARS + 10)
    const crew = crewWithClock(
      () => NOW,
      started('a1', { toolUseId: 'toolu-1' }),
      textSignal('toolu-1', long),
      ended('a1', 'completed')
    )
    const conclusion = crew.conclusionOf('a1')
    expect(conclusion?.text).toHaveLength(MAX_DWARF_TEXT_CHARS)
    expect(conclusion?.truncated).toBe(true)
  })

  it('evicts the oldest sealed conclusion once the crew has ended more tasks than it keeps', () => {
    const crew = new HeldCrew(() => NOW)
    for (let i = 0; i <= MAX_ENDED_CONCLUSIONS; i++) {
      const taskId = `a${i}`
      crew.apply({ kind: 'task-started', taskId, taskType: 'local_agent', spawnDepth: 1 })
      crew.apply({ kind: 'task-ended', taskId, status: 'completed' })
    }
    expect(crew.conclusionOf('a0')).toBeUndefined()
    expect(crew.conclusionOf(`a${MAX_ENDED_CONCLUSIONS}`)).toBeDefined()
    expect(crew.conclusions().size).toBe(MAX_ENDED_CONCLUSIONS)
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
    const crew = crewOf(started('a1'), { kind: 'task-ended', taskId: 'a1', status: 'completed' })
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

  it('draws each worker with its own model, and an unreported one with none', () => {
    // What the tooltip actually reads (#447). The root's model is deliberately
    // set to something else here: a crew dwarf takes its model from its own
    // turns or carries none, and `Model unknown` is the honest answer for a
    // worker this stream has not heard speak yet.
    const crew = crewOf(
      started('a1', { toolUseId: 'toolu-1' }),
      { kind: 'agent-model', insideToolUseId: 'toolu-1', model: 'claude-sonnet-4-5-20250929' },
      started('a2', { toolUseId: 'toolu-2' })
    )
    const dwarfs = heldCrewDwarfs(root({ model: 'claude-opus-4-1-20250805' }), crew)
    expect(dwarfs[0]?.model).toBe('claude-sonnet-4-5-20250929')
    expect(dwarfs[1] === undefined || 'model' in dwarfs[1]).toBe(false)
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
      { kind: 'task-ended', taskId: 'a1', status: 'completed' }
    )
    expect(crew.members().map((member) => member.taskId)).toEqual(['a2'])
    expect(heldCrewTargets(root(), crew).get('claude:session-1:a2')).toEqual({
      kind: 'foreman-relay',
      foremanDwarfId: 'claude:session-1',
      workerName: 'Scout'
    })
  })
})
