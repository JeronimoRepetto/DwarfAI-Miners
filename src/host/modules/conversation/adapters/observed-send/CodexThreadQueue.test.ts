// layer: L2
// L2 (17 §1.2): the observed-Codex queue (15 §3.1 X3 `sendTurn` = `codex queue --thread`, §3.3 "queues
// the text for the thread's next turn, never mid-turn") over the kernel `ProcessControl` double (R17):
// one run of the person's own codex with an argv array, its exit read as the queue's answer, bounded,
// and nothing run for a thread id or a text it cannot honestly carry.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import type { SpawnSpec } from '../../../../kernel/ports/processControl'
import {
  CODEX_QUEUE_TIMEOUT_MS,
  CodexThreadQueue,
  MAX_CODEX_QUEUE_TEXT_CHARS
} from './CodexThreadQueue'
import { ScriptedConsoleTools, type ToolAnswer } from './testing/ScriptedConsoleTools'

const THREAD = '019a2c3e-5b7d-7f01-8a2b-3c4d5e6f7a8b'
const CODEX = '/home/j/.local/bin/codex'
const ENV = {
  PATH: '/usr/bin',
  HOME: '/home/j',
  CODEX_HOME: '/home/j/.codex',
  DWARFAI_CHANNEL_TOKEN: 'secret',
  OPENAI_API_KEY: 'sk-secret'
}

function world(
  answer: (spec: SpawnSpec) => ToolAnswer = () => ({ code: 0 }),
  executable: string | null = CODEX
) {
  const tools = new ScriptedConsoleTools(answer)
  const clock = new FakeClock(0)
  const queue = new CodexThreadQueue({
    processes: tools,
    executable: async () => executable,
    env: ENV,
    cwd: '/home/j',
    scheduler: new FakeScheduler(clock)
  })
  return { tools, clock, queue }
}

describe('CodexThreadQueue: a message on an observed Codex thread’s own queue', () => {
  it('[ADR-022] queues the text verbatim for the thread’s next turn: one run of the user’s codex, an argv array, an allowlisted environment', async () => {
    const text = 'dig  the\nnorth tunnel'
    const { tools, queue } = world()
    expect(await queue.queue(THREAD, text)).toBe('queued')
    expect(tools.spawns).toEqual([
      {
        executable: CODEX,
        args: ['queue', '--thread', THREAD, '--message', text],
        env: { PATH: '/usr/bin', HOME: '/home/j', CODEX_HOME: '/home/j/.codex' },
        cwd: '/home/j',
        processGroup: 'inherit',
        stdio: 'pipe'
      }
    ])
  })

  it('[ADR-022, S7.07] exit 1 is a thread Codex no longer knows; any other failure, a tool that will not start or an overrun is a failed queue', async () => {
    expect(await world(() => ({ code: 1 })).queue.queue(THREAD, 'dig')).toBe('unknown-thread')
    expect(await world(() => ({ code: 2 })).queue.queue(THREAD, 'dig')).toBe('failed')
    const broken = world()
    broken.tools.spawn = () => {
      throw new Error('spawn ENOENT')
    }
    expect(await broken.queue.queue(THREAD, 'dig')).toBe('failed')
    const { tools, clock, queue } = world(() => 'hang')
    const queuing = queue.queue(THREAD, 'dig')
    await new Promise((resolve) => setImmediate(resolve))
    clock.advance(CODEX_QUEUE_TIMEOUT_MS)
    expect(await queuing).toBe('failed')
    expect(tools.events).toContain('killTree 9000 foreign')
  })

  it('[INV-33] no installed codex, a thread id that is not one, or a text it cannot carry runs nothing', async () => {
    const missing = world(undefined, null)
    expect(await missing.queue.queue(THREAD, 'dig')).toBe('not-installed')
    expect(missing.tools.spawns).toEqual([])
    for (const [thread, text] of [
      ['--remote', 'dig'],
      ['not-a-uuid', 'dig'],
      [THREAD, ''],
      [THREAD, ' \n '],
      [THREAD, 'x'.repeat(MAX_CODEX_QUEUE_TEXT_CHARS + 1)]
    ] as const) {
      const { tools, queue } = world()
      expect({ thread, outcome: await queue.queue(thread, text) }).toEqual({
        thread,
        outcome: 'refused'
      })
      expect(tools.spawns).toEqual([])
    }
    expect(await world().queue.queue(THREAD, 'x'.repeat(MAX_CODEX_QUEUE_TEXT_CHARS))).toBe('queued')
  })
})
