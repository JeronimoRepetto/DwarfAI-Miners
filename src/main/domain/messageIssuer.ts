import type { Dwarf, DwarfRole, FeedMessage, MessageIssuer } from './types'

/**
 * Who wrote the `user` half of a subagent's own transcript (#175).
 *
 * A subagent is a dwarf no human can type into — nothing outside its parent
 * session can address it at all, which is why both paths that build one stamp
 * `attendance: 'unattended'` as its own fact rather than inheriting it. Its
 * transcript nevertheless opens with an ordinary `user` record carrying the
 * task it was given, because that is how the CLI writes a prompt down whoever
 * issued it. The panel read the record and drew the user's face against an
 * instruction the coordinator wrote.
 *
 * So the fact is derived from the board rather than read off the message, and
 * it is derived from PROOF rather than from shape: a dwarf whose launcher this
 * cannot identify gets no issuer at all and keeps the panel's existing reading,
 * because naming the wrong agent is a worse claim than naming none.
 */

/**
 * The one rank whose launcher the board can prove, and the rank that launcher
 * must have.
 *
 * A `worker` is a DEPTH-1 spawn (see rankForSpawnDepth), so the only thing that
 * can have launched it is the root of its own session — and a subagent's dwarf
 * id is its session dwarf's id with its own agent id appended, in both the
 * observed path (`${mainDwarfId}:${agentId}`) and the held one (`crewDwarfId`).
 * That makes the launcher findable and the finding checkable.
 *
 * A `worker2` is deliberately absent, and its absence is the load-bearing part.
 * `rankForSpawnDepth` gives that rank to depth 2 AND DEEPER, so the agent above
 * one is a worker or another worker2 — unknowable from the rank — and its id
 * names the session it belongs to rather than the agent that spawned it. The
 * fact that would settle it is `HeldCrew`'s own `parentTaskId`, which is not on
 * the wire; nothing renders a worker2's transcript today (a held crew member is
 * no provider's feed source), so it is left unproved rather than guessed.
 */
const LAUNCHER_RANK: Partial<Record<DwarfRole, DwarfRole>> = { worker: 'foreman' }

/**
 * The agent that launched `dwarf`, or undefined when nothing on the board
 * proves one — including for every root, whose prompt really was the human's.
 */
export function launchingAgentOf(dwarf: Dwarf, board: readonly Dwarf[]): MessageIssuer | undefined {
  const expected = LAUNCHER_RANK[dwarf.role]
  if (expected === undefined) return undefined
  const separator = dwarf.id.lastIndexOf(':')
  if (separator <= 0) return undefined
  const launcherId = dwarf.id.slice(0, separator)
  const launcher = board.find((candidate) => candidate.id === launcherId)
  // A launcher of the wrong rank is not this dwarf's launcher: a session dwarf
  // and a subagent of it share the same id prefix, and only the rank tells the
  // prefix that is a session from one that is a coincidence.
  if (launcher === undefined || launcher.role !== expected) return undefined
  return { role: launcher.role, name: launcher.name }
}

/**
 * Name `issuer` as the author of every `user` turn in `messages`.
 *
 * EVERY one of them, not only the first. The first is what issue #175 saw,
 * because the launch prompt is what opens a subagent's transcript — but a feed
 * is a bounded tail, so the oldest line it carries is whichever survived
 * truncation, and a first-only rule would attribute an arbitrary mid-run turn
 * on a long-running agent. The broader rule needs no position at all: nothing
 * outside this subagent's parent session can address it, so no `user` turn in
 * its transcript was typed by a human.
 *
 * Assistant turns are returned untouched, identity included: they are the dwarf
 * speaking for itself, and the panel already draws them as such.
 */
export function attributeIssuedMessages(
  messages: readonly FeedMessage[],
  issuer: MessageIssuer | undefined
): FeedMessage[] {
  if (issuer === undefined) return [...messages]
  return messages.map((message) => (message.role === 'user' ? { ...message, issuer } : message))
}
