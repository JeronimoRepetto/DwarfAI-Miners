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
 * The one rank pairing that can stand in for an edge nobody declared, and the
 * rank the stand-in launcher must have.
 *
 * A `worker` is a DEPTH-1 spawn (see rankForSpawnDepth), so the only thing that
 * can have launched it is the root of its own session — and that root's id is
 * derivable from the worker's OWN fields, `${provider}:${sessionId}`, without
 * reading a single character of the worker's id. Claude's observed-session path
 * declares no edge, so this is what still names a foreman for its workers.
 *
 * Every other rank is deliberately absent, and the absence is load-bearing.
 * `rankForSpawnDepth` gives `worker2` to depth 2 AND DEEPER, so the agent above
 * one is a worker or another worker2 and no pairing describes it; a Codex
 * sub-agent is a session dwarf whose parent is another session dwarf, which no
 * pairing describes either. Those need the real edge, and they now have one.
 */
const LAUNCHER_RANK: Partial<Record<DwarfRole, DwarfRole>> = { worker: 'foreman' }

/**
 * The agent that launched `dwarf`, or undefined when nothing on the board
 * proves one — including for every root, whose prompt really was the human's.
 *
 * ONE question, asked of the board: which dwarf is at the other end of this
 * dwarf's parent edge? A provider that observed the spawn declares the edge
 * (`parentId`); a Claude subagent whose provider declares none falls back to
 * its session's own root, which its depth-1 rank proves is its launcher.
 * Neither route reads a substring of an id: that is what named the literal
 * `codex` for every Codex agent (#218) and the wrong session for a worker2
 * (#189).
 *
 * The launcher's RANK comes from the launcher's own board entry in both cases,
 * so nothing here infers one — which is why a worker2 launched by a worker and
 * a Codex agent launched by a foreman need no rule of their own.
 */
export function launchingAgentOf(dwarf: Dwarf, board: readonly Dwarf[]): MessageIssuer | undefined {
  const launcherId = launcherIdOf(dwarf)
  // A dwarf is never its own launcher. A session root's derived root id is its
  // own, and a provider that named an edge back to the dwarf itself has stated
  // no edge at all.
  if (launcherId === undefined || launcherId === dwarf.id) return undefined
  const launcher = board.find((candidate) => candidate.id === launcherId)
  if (launcher === undefined) return undefined
  // The rank check belongs to the DERIVED edge alone: it is what tells a
  // session root apart from another dwarf that happens to sit at that id. A
  // declared edge needs no such proof — the provider watched the spawn.
  if (dwarf.parentId === undefined && launcher.role !== LAUNCHER_RANK[dwarf.role]) {
    return undefined
  }
  return { role: launcher.role, name: launcher.name }
}

/**
 * The id of the dwarf at the other end of this dwarf's parent edge, declared or
 * derived — never parsed out of the dwarf's own id.
 */
function launcherIdOf(dwarf: Dwarf): string | undefined {
  if (dwarf.parentId !== undefined) return dwarf.parentId
  return LAUNCHER_RANK[dwarf.role] === undefined
    ? undefined
    : `${dwarf.provider}:${dwarf.sessionId}`
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
