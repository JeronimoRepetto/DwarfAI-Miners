import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { endedAgentsIn } from '../../../src/host/modules/observation/adapters/claude/reconcile.ts'
import {
  parentAgentIdOf,
  transcriptFileOf
} from '../../../src/host/modules/observation/adapters/claude/subagents.ts'
import {
  parseRolloutLine,
  rolloutHeadOf,
  threadIdOfRolloutName
} from '../../../src/host/modules/observation/adapters/codex/parse.ts'
import {
  agentIdOf,
  claudeSidecar,
  claudeSubagentFiles,
  codexRolloutFile,
  codexSubthreadMeta,
  taskNotification,
  threadIdOf
} from './subagents.mjs'

const SESSION = '01a0b000-0000-7000-8000-000000000716'
const CWD = path.join('demo', 'mines', 'Moria')

describe('the subagents a demo foreman’s CLI writes, read back by the Host’s own readers', () => {
  it('names each Claude subagent with a stable agent id of the kind Claude Code writes, distinct per worker', () => {
    expect(agentIdOf(`${SESSION}:oin`)).toBe(agentIdOf(`${SESSION}:oin`))
    expect(agentIdOf(`${SESSION}:oin`)).not.toBe(agentIdOf(`${SESSION}:ori`))
    expect(agentIdOf(`${SESSION}:oin`)).toMatch(/^a[0-9a-f]{16}$/)
  })

  it('puts a Claude subagent’s transcript and sidecar where the observer finds a subagent of the session', () => {
    const home = path.join('demo', 'claude')
    const agentId = agentIdOf(`${SESSION}:oin`)
    const files = claudeSubagentFiles(home, CWD, SESSION, agentId)
    expect(transcriptFileOf(files.transcript)).toEqual({
      kind: 'subagent',
      sessionId: SESSION,
      agentId,
      sidecarPath: files.sidecar
    })
    expect(path.dirname(path.dirname(path.dirname(files.transcript)))).toBe(
      path.join(home, 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'))
    )
  })

  it('names a worker²’s parent agent in its sidecar, and no parent for a worker, which the session parents', () => {
    const parent = agentIdOf(`${SESSION}:gloin`)
    expect(parentAgentIdOf(JSON.stringify(claudeSidecar('Help Glóin', 'toolu_x', parent)))).toBe(
      parent
    )
    expect(parentAgentIdOf(JSON.stringify(claudeSidecar('Help Balin', 'toolu_y', null)))).toBeNull()
    expect(claudeSidecar('Help Glóin', 'toolu_x', parent).spawnDepth).toBe(2)
  })

  it('ends a Claude subagent with the task notification the observer reads as its ending', () => {
    const agentId = agentIdOf(`${SESSION}:ori`)
    const record = taskNotification(SESSION, CWD, agentId, 'Indexed the chronicle.', 1_000)
    expect(endedAgentsIn(record)).toEqual([agentId])
  })

  it('heads a Codex sub-thread’s rollout with its parent thread, in a file the observer names by thread id', () => {
    const parent = threadIdOf(`${SESSION}:doc`)
    const thread = threadIdOf(`${SESSION}:grumpy`)
    expect(thread).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(thread).not.toBe(parent)
    const line = JSON.stringify(codexSubthreadMeta(thread, parent, CWD, 1_000))
    expect(rolloutHeadOf(parseRolloutLine(line))).toMatchObject({
      threadId: thread,
      parentThreadId: parent
    })
    const file = codexRolloutFile(path.join('demo', 'codex'), thread, 1_000)
    expect(threadIdOfRolloutName(path.basename(file))).toBe(thread)
    expect(file.startsWith(path.join('demo', 'codex', 'sessions'))).toBe(true)
  })
})
