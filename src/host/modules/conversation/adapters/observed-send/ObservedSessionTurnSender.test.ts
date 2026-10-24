// layer: L3
// L3 (17 §1.3): `runTurnSenderContract` on `FakeTurnSender` and on `ObservedSessionTurnSender` over the
// kernel `ProcessControl` double (TC-167-01), plus the adapter's own mapping of each relay and queue
// outcome to an honest `DriverSendError`-shaped failure (TC-167-02; ADR-022 item 1; 16 §4.6 as
// extended by AMENDMENT-16). The real adapter's world is Linux with a tmux pane on the session's tty,
// so every terminal write and every identity probe runs through the same scripted tools.
import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../../../kernel/domain/processIdentity'
import { FakeClock } from '../../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../../kernel/fakes/FakeScheduler'
import type { DwarfId, MessageId } from '../../../../kernel/domain/values'
import type { TurnInput } from '../../../suppliers'
import type { TurnSendFailure } from '../../ports/turnSender'
import { FakeTurnSender } from '../../ports/fakes/FakeTurnSender'
import {
  runTurnSenderContract,
  type TurnSenderContractWorld
} from '../../testing/turnSender.contract'
import { SUBMIT_SPLIT_DELAY_MS } from './consoleText'
import { CodexThreadQueue, type CodexQueueOutcome } from './CodexThreadQueue'
import { ConsoleTextDelivery, type TextWriteOutcome } from './ConsoleTextDelivery'
import type { SubagentSendOutcome } from './ClaudeSubagentConsoleSend'
import {
  ObservedSessionTurnSender,
  SUBAGENT_REFUSAL_COPY,
  type ObservedSendTarget
} from './ObservedSessionTurnSender'
import { ScriptedConsoleTools } from './testing/ScriptedConsoleTools'

const CLAUDE = '00000000-0000-7000-8000-0000000000c1' as DwarfId
const CODEX = '00000000-0000-7000-8000-0000000000c2' as DwarfId
const OPENCODE = '00000000-0000-7000-8000-0000000000c3' as DwarfId
const THREAD = '019a2c3e-5b7d-7f01-8a2b-3c4d5e6f7a8b'
const PROCESS: ProcessIdentity = { pid: 4242, processStartTimeMs: 1_790_000_000_000, bootId: 'b' }

const TARGETS: ReadonlyMap<DwarfId, ObservedSendTarget> = new Map([
  [CLAUDE, { providerId: 'claude', providerSessionId: 'claude-session-1', process: PROCESS }],
  [CODEX, { providerId: 'codex', providerSessionId: THREAD, process: null }],
  [OPENCODE, { providerId: 'opencode', providerSessionId: 'ses_1', process: null }]
])

function turn(text: string, extra: Partial<TurnInput> = {}): TurnInput {
  return {
    messageId: '00000000-0000-7000-8000-0000000000a1' as MessageId,
    kind: 'message',
    text,
    attachments: [],
    ...extra
  }
}

runTurnSenderContract('FakeTurnSender', () => {
  const fake = new FakeTurnSender({ relayed: [CLAUDE], queued: [CODEX] })
  return {
    sender: fake,
    canDeliverTo: (dwarfId) => fake.canDeliverTo(dwarfId),
    relayed: CLAUDE,
    queued: CODEX,
    unrouted: OPENCODE,
    loseTargetBeforeWrite: () => fake.loseTarget(CLAUDE),
    typed: () => fake.typed(CLAUDE),
    queuedTexts: () => fake.queuedFor(CODEX)
  }
})

/** The real adapter over scripted tools: Linux, the session on pts/4, a tmux pane %7 there. */
function realWorld(): TurnSenderContractWorld {
  const tools = new ScriptedConsoleTools((spec) => {
    if (spec.executable === 'ps') return { code: 0, stdout: 'pts/4\n' }
    if (spec.executable === 'tmux' && spec.args[0] === 'list-panes') {
      return { code: 0, stdout: '%7 /dev/pts/4 200\n' }
    }
    return { code: 0 }
  })
  tools.script(PROCESS.pid, { ...PROCESS })
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const terminal = new ConsoleTextDelivery({
    processes: tools,
    platform: 'linux',
    env: {},
    cwd: '/home/j',
    scheduler
  })
  const codex = new CodexThreadQueue({
    processes: tools,
    executable: async () => '/usr/bin/codex',
    env: {},
    cwd: '/home/j',
    scheduler
  })
  const adapter = new ObservedSessionTurnSender({
    targets: { targetOf: (dwarfId) => TARGETS.get(dwarfId) ?? null },
    terminal,
    codex
  })
  // The relay waits out its paste → Enter margin on the scheduler: run the clock while a send is open.
  const sender = {
    send: async (dwarfId: DwarfId, input: TurnInput) => {
      let done = false
      const sending = adapter.send(dwarfId, input).finally(() => (done = true))
      for (let turn = 0; turn < 50 && !done; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve))
        if (!done) clock.advance(SUBMIT_SPLIT_DELAY_MS)
      }
      return sending
    }
  }
  return {
    sender,
    canDeliverTo: (dwarfId) => adapter.canDeliverTo(dwarfId),
    relayed: CLAUDE,
    queued: CODEX,
    unrouted: OPENCODE,
    // The recorded process is gone by the time the write is due (its pid reused by another).
    loseTargetBeforeWrite: () =>
      tools.script(PROCESS.pid, {
        ...PROCESS,
        processStartTimeMs: PROCESS.processStartTimeMs + 60_000
      }),
    typed: () => {
      const typed: string[] = []
      let loaded: string | undefined
      tools.spawns.forEach((spawn, index) => {
        if (spawn.args[0] === 'load-buffer') loaded = tools.stdinOf.get(9_000 + index)
        if (spawn.args[0] === 'paste-buffer' && loaded !== undefined) typed.push(loaded)
      })
      return typed
    },
    queuedTexts: () =>
      tools.spawns.filter((s) => s.args[0] === 'queue').map((s) => s.args[4] as string)
  }
}

runTurnSenderContract('ObservedSessionTurnSender (FakeProcessControl)', realWorld)

/** The adapter over recording doubles of its two paths. */
function mapped(write: TextWriteOutcome = 'written', queued: CodexQueueOutcome = 'queued') {
  const writes: Array<[ProcessIdentity, string]> = []
  const queues: Array<[string, string]> = []
  const pasted: Array<readonly string[]> = []
  const sender = new ObservedSessionTurnSender({
    targets: { targetOf: (dwarfId) => TARGETS.get(dwarfId) ?? null },
    terminal: {
      write: async (target, text, paths = []) => {
        writes.push([target, text])
        pasted.push([...paths])
        return write
      }
    },
    codex: {
      queue: async (thread, text) => {
        queues.push([thread, text])
        return queued
      }
    }
  })
  return { sender, writes, queues, pasted }
}

describe('ObservedSessionTurnSender: each outcome is an honest delivery failure', () => {
  it('[ADR-012, ADR-014] a Claude relay is aimed at the process identity observation recorded, with the message text', async () => {
    const { sender, writes } = mapped()
    const result = await sender.send(CLAUDE, turn('dig'))
    expect(result).toEqual({
      ok: true,
      value: {
        confidence: 'unconfirmed',
        heldUntilTurnEnd: false,
        correlation: '00000000-0000-7000-8000-0000000000a1',
        reactionEvidence: 'transcript-match'
      }
    })
    expect(writes).toEqual([[PROCESS, 'dig']])
  })

  it('[ADR-012, S7.06, S7.07] a gone process is session-closed; an untargetable terminal or an unfinished write is a channel error', async () => {
    expect(await mapped('gone').sender.send(CLAUDE, turn('dig'))).toEqual({
      ok: false,
      error: { kind: 'session-closed' }
    })
    expect(await mapped('not-targeted').sender.send(CLAUDE, turn('dig'))).toEqual({
      ok: false,
      error: { kind: 'channel-error', reason: 'the terminal of that session cannot be targeted' }
    })
    expect(await mapped('incomplete').sender.send(CLAUDE, turn('dig'))).toEqual({
      ok: false,
      error: { kind: 'channel-error', reason: 'the write into the terminal did not complete' }
    })
  })

  it('[INV-33, ADR-014] an observed Claude session with no recorded process identity has no send path', async () => {
    const sender = new ObservedSessionTurnSender({
      targets: {
        targetOf: () => ({ providerId: 'claude', providerSessionId: 'subagent-1', process: null })
      },
      terminal: { write: async () => 'written' },
      codex: { queue: async () => 'queued' }
    })
    expect(sender.canDeliverTo(CLAUDE)).toBe(false)
    expect(await sender.send(CLAUDE, turn('dig'))).toEqual({
      ok: false,
      error: { kind: 'session-closed' }
    })
  })

  it('[ADR-022, S7.06, S7.07] a Codex thread the store no longer holds is session-closed; every other queue failure is a channel error', async () => {
    const { queues } = mapped()
    expect(await mapped('written', 'unknown-thread').sender.send(CODEX, turn('dig'))).toEqual({
      ok: false,
      error: { kind: 'session-closed' }
    })
    for (const [outcome, reason] of [
      ['not-installed', 'codex is not installed'],
      ['refused', 'the message cannot be queued on that thread'],
      ['failed', 'the message could not be queued']
    ] as const) {
      expect(await mapped('written', outcome).sender.send(CODEX, turn('dig'))).toEqual({
        ok: false,
        error: { kind: 'channel-error', reason }
      })
    }
    const codex = mapped()
    await codex.sender.send(CODEX, turn('dig'))
    expect(codex.queues).toEqual([[THREAD, 'dig']])
    expect(queues).toEqual([])
  })

  /*
   * AMENDED for #1463 (was: an attachment refused on both paths, with 'an observed session takes no
   * attachment'): an observed Claude session takes its files as bracketed pastes, as legacy
   * measured (#408); a Codex thread's queue carries text only, as it did in legacy, and says so.
   */
  it('[ADR-012, ADR-013] a delegation hand-off is not relayed into an observed session', async () => {
    const { sender, writes, queues } = mapped()
    for (const dwarfId of [CLAUDE, CODEX]) {
      expect(await sender.send(dwarfId, turn('result', { kind: 'handoff' }))).toEqual({
        ok: false,
        error: {
          kind: 'channel-error',
          reason: 'a hand-off is not relayed into an observed session'
        }
      })
    }
    expect(writes).toEqual([])
    expect(queues).toEqual([])
  })

  it('[US-MSG-002.AC03] an observed Claude session gets the revalidated paths with the message, through its terminal relay', async () => {
    const { sender, writes, pasted } = mapped()
    const attached = turn('dig', {
      attachments: [
        { path: '/tmp/a.png', name: 'a.png', bytes: 1 },
        { path: '/tmp/notes.txt', name: 'notes.txt', bytes: 2 }
      ]
    })
    expect((await sender.send(CLAUDE, attached)).ok).toBe(true)
    expect(writes).toEqual([[PROCESS, 'dig']])
    expect(pasted).toEqual([['/tmp/a.png', '/tmp/notes.txt']])
  })

  it('[US-MSG-002.AC03, ADR-022] a Codex thread queue carries no file: the message is refused whole, never queued without them', async () => {
    const { sender, queues } = mapped()
    const attached = turn('dig', { attachments: [{ path: '/tmp/a.png', name: 'a.png', bytes: 1 }] })
    expect(await sender.send(CODEX, attached)).toEqual({
      ok: false,
      error: { kind: 'channel-error', reason: "an observed Codex thread's queue takes no files" }
    })
    expect(queues).toEqual([])
  })

  it('[ADR-012] a path no terminal can take whole is refused before anything is typed', async () => {
    const { sender, writes } = mapped()
    const attached = turn('dig', {
      attachments: [{ path: '/tmp/a\nb.png', name: 'a\nb.png', bytes: 1 }]
    })
    expect(await sender.send(CLAUDE, attached)).toEqual({
      ok: false,
      error: {
        kind: 'channel-error',
        reason: "an attached file's path cannot be typed into a terminal"
      }
    })
    expect(writes).toEqual([])
  })

  it('[ADR-012] a path that throws is a channel error, never a silent loss', async () => {
    const sender = new ObservedSessionTurnSender({
      targets: { targetOf: (dwarfId) => TARGETS.get(dwarfId) ?? null },
      terminal: {
        write: async () => {
          throw new Error('boom')
        }
      },
      codex: { queue: async () => 'queued' }
    })
    expect(await sender.send(CLAUDE, turn('dig'))).toEqual({
      ok: false,
      error: { kind: 'channel-error', reason: 'the write into the terminal did not complete' }
    })
  })
})

/*
 * APPENDED for AMENDMENT-29 (owner, 2026-10-24): an observed Claude SUBAGENT gets the subagent route
 * (ClaudeSubagentConsoleSend.ts) on a Windows Host, never the lead's own terminal relay.
 */
describe('ObservedSessionTurnSender: an observed Claude subagent (AMENDMENT-29)', () => {
  const SUBAGENT = '00000000-0000-7000-8000-0000000000c4' as DwarfId
  const SUB_TARGET: ObservedSendTarget = {
    providerId: 'claude',
    providerSessionId: 'claude-session-1',
    providerAgentId: 'a7725068ba6a77d24',
    process: PROCESS
  }

  function subagentWorld(
    outcome: SubagentSendOutcome = { kind: 'delivered' },
    opts: { reaches?: boolean; target?: ObservedSendTarget } = {}
  ) {
    const writes: string[] = []
    const routed: Array<[DwarfId, string]> = []
    const sender = new ObservedSessionTurnSender({
      targets: {
        targetOf: (dwarfId) => (dwarfId === SUBAGENT ? (opts.target ?? SUB_TARGET) : null)
      },
      terminal: {
        write: async (_target, text) => {
          writes.push(text)
          return 'written'
        }
      },
      codex: { queue: async () => 'queued' },
      subagents: {
        reaches: () => opts.reaches ?? true,
        send: async (dwarfId, text) => {
          routed.push([dwarfId, text])
          return outcome
        }
      }
    })
    return { sender, writes, routed }
  }

  it("[INV-33, ADR-012] a subagent whose lead runs in a Windows console has a send path: the subagent route takes the text, never the lead's relay", async () => {
    const { sender, writes, routed } = subagentWorld()
    expect(sender.canDeliverTo(SUBAGENT)).toBe(true)
    expect(await sender.send(SUBAGENT, turn('dig'))).toEqual({
      ok: true,
      value: {
        confidence: 'unconfirmed',
        heldUntilTurnEnd: false,
        correlation: '00000000-0000-7000-8000-0000000000a1',
        reactionEvidence: 'transcript-match'
      }
    })
    expect(routed).toEqual([[SUBAGENT, 'dig']])
    expect(writes).toEqual([])
  })

  it('[INV-33, ADR-014] off Windows, without a recorded lead process or without the route: no send path, as today', async () => {
    const worlds = [
      subagentWorld(undefined, { reaches: false }),
      subagentWorld(undefined, { target: { ...SUB_TARGET, process: null } })
    ]
    for (const { sender, writes, routed } of worlds) {
      expect(sender.canDeliverTo(SUBAGENT)).toBe(false)
      expect(await sender.send(SUBAGENT, turn('dig'))).toEqual({
        ok: false,
        error: { kind: 'session-closed' }
      })
      expect([writes, routed]).toEqual([[], []])
    }
    const without = new ObservedSessionTurnSender({
      targets: { targetOf: () => SUB_TARGET },
      terminal: { write: async () => 'written' },
      codex: { queue: async () => 'queued' }
    })
    expect(without.canDeliverTo(SUBAGENT)).toBe(false)
  })

  it('[ADR-022, S7.06, S7.07] each refusal and failure of the route is an honest delivery failure', async () => {
    const cases: Array<[SubagentSendOutcome, TurnSendFailure]> = [
      [{ kind: 'gone' }, { kind: 'session-closed' }],
      [
        { kind: 'not-targeted' },
        { kind: 'channel-error', reason: 'the terminal of that session cannot be targeted' }
      ],
      [
        { kind: 'incomplete' },
        { kind: 'channel-error', reason: 'the write into the terminal did not complete' }
      ],
      [
        { kind: 'refused', reason: 'draft' },
        { kind: 'channel-error', reason: SUBAGENT_REFUSAL_COPY.draft }
      ],
      [
        { kind: 'refused', reason: 'ambiguous' },
        { kind: 'channel-error', reason: SUBAGENT_REFUSAL_COPY.ambiguous }
      ],
      [
        { kind: 'refused', reason: 'not-found' },
        { kind: 'channel-error', reason: SUBAGENT_REFUSAL_COPY['not-found'] }
      ],
      [
        { kind: 'refused', reason: 'unrecognised-screen' },
        { kind: 'channel-error', reason: SUBAGENT_REFUSAL_COPY.unrecognised }
      ],
      [
        { kind: 'refused', reason: 'unsupported-version' },
        { kind: 'channel-error', reason: SUBAGENT_REFUSAL_COPY.unrecognised }
      ]
    ]
    for (const [outcome, error] of cases) {
      expect({
        outcome,
        result: await subagentWorld(outcome).sender.send(SUBAGENT, turn('dig'))
      }).toEqual({
        outcome,
        result: { ok: false, error }
      })
    }
    // Copy design has not written: each refusal is a marked placeholder, never invented text.
    for (const reason of Object.values(SUBAGENT_REFUSAL_COPY)) {
      expect(reason).toMatch(/^⟦COPY NEEDED: AMENDMENT-29 .+⟧$/)
    }
  })

  it('[US-MSG-002.AC03, ADR-022] a subagent view takes no file: the message is refused whole, nothing typed', async () => {
    const { sender, routed } = subagentWorld()
    const attached = turn('dig', { attachments: [{ path: 'C:\a.png', name: 'a.png', bytes: 1 }] })
    expect(await sender.send(SUBAGENT, attached)).toEqual({
      ok: false,
      error: { kind: 'channel-error', reason: SUBAGENT_REFUSAL_COPY.files }
    })
    expect(routed).toEqual([])
  })

  it('[ADR-012] a route that throws is a channel error, never a silent loss', async () => {
    const sender = new ObservedSessionTurnSender({
      targets: { targetOf: () => SUB_TARGET },
      terminal: { write: async () => 'written' },
      codex: { queue: async () => 'queued' },
      subagents: {
        reaches: () => true,
        send: async () => {
          throw new Error('boom')
        }
      }
    })
    expect(await sender.send(SUBAGENT, turn('dig'))).toEqual({
      ok: false,
      error: { kind: 'channel-error', reason: 'the write into the terminal did not complete' }
    })
  })
})
