// `ObservedSessionTurnSender` (16 §4.6 row `TurnSender`: "or `ObservedSessionTurnSender` (observed
// relay)", as extended by AMENDMENT-16; 15 §3.1 `sendTurn` of rows C4, C5, X3, O3 and §3.3 limits;
// ADR-022 items 1–3; ISSUE-167): a message to an observed dwarf — a session the person started in
// their own terminal — behind the same `TurnSender` port the owned path uses, with the same truthful
// marks. Provider branching is adapter-local (R12).
//
// - An observed Claude session (C4, C5): the text is relayed into its terminal (ConsoleTextDelivery),
//   aimed at the process identity observation recorded and re-checked just before writing (ADR-012
//   item 3, ADR-014 item 1). The receipt is ✓ `unconfirmed` (no protocol ack exists) with
//   `transcript-match` evidence: ✓✓ only on the transcript echo of the relay text (S-022-1) and a
//   reply after it. Without a recorded process identity (a subagent, a session no registry names)
//   there is no send path: nothing is typed by guess.
// - An observed Codex thread (X3): the text is queued on the thread's own queue for its next turn
//   (CodexThreadQueue, `codex queue --thread`), never written into its terminal, so never mid-turn.
//   ✓ `unconfirmed` once persisted on the queue, ✓✓ on the rollout echo (`transcript-match`).
// - Any other provider (O3 OpenCode, A2 Antigravity, …): no recorded send path. `canDeliverTo` is
//   false, so crew's `canReceiveMessages` is false and the composer says so (INV-33); a send that
//   comes anyway answers `session-closed` with nothing written.
//
// The correlation is the turn's `messageId` (stable, reused by Retry); the relay cannot carry it, so
// the echo is matched by text (S-022-1; ADR-007 item 3). Failures: the session's process gone, or a
// thread the store no longer holds → `session-closed` (S7.07, Copy alone); nothing written because
// the terminal cannot be targeted, a write that did not finish, or a queue that failed →
// `channel-error` with its reason (S7.06, Retry). A delegation hand-off (ADR-013 item 6) is not
// relayed. Attachments (#1463): an observed Claude session gets each Host-revalidated path as a
// bracketed paste ahead of its words (ConsoleTextDelivery, legacy #408), and a path no terminal can
// take whole refuses the message before anything is typed; a Codex thread's queue carries text
// only, so a message with files is refused whole rather than queued without them. Nothing here logs
// the text or a path.
import type { ProcessIdentity } from '../../../../kernel/domain/processIdentity'
import type { DwarfId, ProviderId } from '../../../../kernel/domain/values'
import type { TurnInput } from '../../../suppliers'
import type {
  TurnHandOver,
  TurnSender,
  TurnSendFailure,
  TurnSendResult
} from '../../ports/turnSender'
import type { CodexQueueOutcome, CodexThreadQueue } from './CodexThreadQueue'
import { pastedPathOf } from './consoleText'
import type { ConsoleTextDelivery, TextWriteOutcome } from './ConsoleTextDelivery'

/** What the composition knows of an observed dwarf's session: its provider identity and process. */
export interface ObservedSendTarget {
  providerId: ProviderId
  providerSessionId: string
  /** The process identity observation recorded for the session (ADR-014 item 2), or null. */
  process: ProcessIdentity | null
}

export interface ObservedSessionTurnSenderDeps {
  /** The observed dwarf's session, or null for a dwarf that is unknown, departed or owned. */
  targets: { targetOf(dwarfId: DwarfId): ObservedSendTarget | null }
  terminal: Pick<ConsoleTextDelivery, 'write'>
  codex: Pick<CodexThreadQueue, 'queue'>
}

type SendPath = { kind: 'terminal'; process: ProcessIdentity } | { kind: 'queue'; thread: string }

const CLOSED: TurnSendResult = { ok: false, error: { kind: 'session-closed' } }

const channelError = (reason: string): TurnSendResult => ({
  ok: false,
  error: { kind: 'channel-error', reason }
})

const WRITE_FAILURE: Record<Exclude<TextWriteOutcome, 'written'>, TurnSendFailure> = {
  gone: { kind: 'session-closed' },
  'not-targeted': {
    kind: 'channel-error',
    reason: 'the terminal of that session cannot be targeted'
  },
  incomplete: { kind: 'channel-error', reason: 'the write into the terminal did not complete' }
}

const QUEUE_FAILURE: Record<Exclude<CodexQueueOutcome, 'queued'>, TurnSendFailure> = {
  'unknown-thread': { kind: 'session-closed' },
  'not-installed': { kind: 'channel-error', reason: 'codex is not installed' },
  refused: { kind: 'channel-error', reason: 'the message cannot be queued on that thread' },
  failed: { kind: 'channel-error', reason: 'the message could not be queued' }
}

export class ObservedSessionTurnSender implements TurnSender {
  constructor(private readonly deps: ObservedSessionTurnSenderDeps) {}

  /** Whether a send path exists for the dwarf (crew's `hasDeliveryRoute`, INV-33). */
  canDeliverTo(dwarfId: DwarfId): boolean {
    return this.pathOf(dwarfId) !== null
  }

  async send(dwarfId: DwarfId, turn: TurnInput): Promise<TurnSendResult> {
    const path = this.pathOf(dwarfId)
    if (path === null) return CLOSED
    if (turn.kind !== 'message') {
      return channelError('a hand-off is not relayed into an observed session')
    }
    const files = turn.attachments.map((file) => file.path)
    if (path.kind === 'terminal') {
      if (files.some((file) => pastedPathOf(file) === null)) {
        return channelError("an attached file's path cannot be typed into a terminal")
      }
      let written: TextWriteOutcome
      try {
        written = await this.deps.terminal.write(path.process, turn.text, files)
      } catch {
        written = 'incomplete'
      }
      return written === 'written' ? handedOver(turn) : { ok: false, error: WRITE_FAILURE[written] }
    }
    // The queue carries one text argument and nothing else (legacy `ATTACHMENT_CHANNELS`, #408).
    if (files.length > 0) return channelError("an observed Codex thread's queue takes no files")
    let queued: CodexQueueOutcome
    try {
      queued = await this.deps.codex.queue(path.thread, turn.text)
    } catch {
      queued = 'failed'
    }
    return queued === 'queued' ? handedOver(turn) : { ok: false, error: QUEUE_FAILURE[queued] }
  }

  private pathOf(dwarfId: DwarfId): SendPath | null {
    const target = this.deps.targets.targetOf(dwarfId)
    if (target === null) return null
    switch (target.providerId) {
      case 'claude':
        return target.process === null ? null : { kind: 'terminal', process: target.process }
      case 'codex':
        return { kind: 'queue', thread: target.providerSessionId }
      default:
        return null
    }
  }
}

/** ✓ unconfirmed: written or queued, with no protocol ack; ✓✓ only on the transcript echo. */
function handedOver(turn: TurnInput): { ok: true; value: TurnHandOver } {
  return {
    ok: true,
    value: {
      confidence: 'unconfirmed',
      heldUntilTurnEnd: false,
      correlation: turn.messageId,
      reactionEvidence: 'transcript-match'
    }
  }
}
