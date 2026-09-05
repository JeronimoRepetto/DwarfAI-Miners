import { join } from 'node:path'
import type { FsLike } from '../adapters/fsLike'
import type { SqliteLike } from '../adapters/sqliteLike'
import { attributeIssuedMessages } from '../domain/messageIssuer'
import { redactSecrets } from '../domain/redactSecrets'
import {
  MINE_HISTORY_MESSAGE_LIMIT,
  type DwarfRole,
  type MessageIssuer,
  type MineHistorySpeaker
} from '../domain/types'
import { currentPlatform, normalizePathKey, type Platform } from '../platform/platform'
import { encodeClaudeProjectDir, extractClaudeFeed } from '../providers/claude/parse'
import { extractCodexFeed } from '../providers/codex/parse'
import {
  readFeedWindowWithReachedStart,
  type FeedExtractor,
  type FeedWindowRead
} from '../providers/feedWindow'
import { readCodexThreads, type CodexThread } from '../providers/codex/state'
import { rankForSpawnDepth } from '../sessionLaunch/heldCrew'

/**
 * What a mine's transcripts on disk remember (#192): every dwarf that has
 * spoken in one project folder, with its latest messages, read on request for
 * the Mine History panel.
 *
 * READ, NEVER STORED. Both providers this build has keep a session store of
 * their own — Claude Code writes `<root>/projects/<encoded cwd>/<session>.jsonl`
 * and a `<session>/subagents/agent-<id>.jsonl` per subagent, Codex registers
 * every thread's rollout path in `state_5.sqlite` — and those files outlive
 * the session that wrote them. Mirroring them into the app database would be a
 * second representation of the same truth, and it would drift; the maintainer
 * ruled it out in #192. The one caveat is Claude Code's own `cleanupPeriodDays`
 * (30 by default): "the latest 50 messages" is a safe claim, "everything ever
 * said" never was, and the panel's copy says so.
 *
 * Nothing here consults the live board. A speaker's rank comes from its
 * transcript's own POSITION — the root of a session is the foreman, a subagent
 * is ranked by the depth its sidecar states — because the dwarf it once was may
 * be gone, which is the whole reason the panel exists.
 */

/**
 * How many transcripts one read opens, newest by mtime first.
 *
 * The number of transcripts under a project is bounded only by the CLI's own
 * cleanup, and a busy month leaves hundreds. Sixty-four keeps one open of the
 * panel at 64 × FEED_WINDOW_CEILING_BYTES of reads in the absolute worst case
 * — every transcript longer than the ceiling and nearly all of it tool output
 * — and the read repeats on every live signal while the panel is open, so the
 * bound is spent per open rather than once. What it actually costs is the
 * NARROWEST window that holds fifty messages per file (see readFeedWindow),
 * which for an ordinary transcript is the first step and one read. The tabs
 * the panel then shows are the sixty-four most recently written sessions and
 * agents; anything older is left unread rather than sampled.
 */
export const MINE_HISTORY_TRANSCRIPT_LIMIT = 64

/** Bytes of a Claude subagent sidecar; the real files are ~150 bytes. */
const SIDECAR_MAX_BYTES = 4 * 1024

/**
 * Where a transcript sits in its session, which is the only thing that decides
 * its rank here. `spawnDepth` is what the subagent's own sidecar states, and it
 * is absent when the sidecar is missing or does not say.
 */
export type SpeakerPosition = { kind: 'root' } | { kind: 'subagent'; spawnDepth?: number }

/**
 * The rank a transcript's position makes it — the board's own rule
 * (`rankForSpawnDepth`, #157) applied to a depth read off disk rather than off
 * a stream. A root is the foreman whether or not it ever coordinated, exactly
 * as the live provider draws it; an unstated depth falls to `worker`, never to
 * `worker2`, because being deeper is the stronger claim and needs the proof.
 */
export function speakerRole(position: SpeakerPosition): DwarfRole {
  return position.kind === 'root' ? 'foreman' : rankForSpawnDepth(position.spawnDepth)
}

export interface MineHistoryReaderOptions {
  fs: FsLike
  /** Claude config roots, already home-expanded; a root with no folder for the mine is skipped. */
  claudeRoots: string[]
  /**
   * Codex's thread registry, when this build can read one. Omitted means Codex
   * history is not offered at all — a day-directory walk that reads every
   * rollout's head to find the ones for this cwd is the coal backfill's cost,
   * not something a panel can spend on open, so an install with no registry
   * (Codex before 0.150) gets Claude history alone.
   */
  codex?: { sqlite: SqliteLike; stateDbPath: string }
  /** Decides how the mine's path and a registry row's cwd are compared; defaults to this machine's. */
  platform?: Platform
}

/** The port the runtime reads through, so a test can hand it a fake. */
export interface MineHistorySource {
  read(cwd: string): Promise<MineHistorySpeaker[]>
}

/** One transcript found for the mine, before its tail is read. */
interface Candidate {
  provider: 'claude' | 'codex'
  id: string
  name: string
  path: string
  mtimeMs: number
  position: SpeakerPosition
  /**
   * The speaker id of whoever wrote this transcript's `user` turns, when the
   * position proves one: a subagent's launcher. Absent for every root — its
   * prompts really were the human's — and for a nested agent whose parent the
   * folder does not hold, which is left unnamed rather than guessed.
   */
  issuerId?: string
  /** Which text extractor reads this file. */
  extract: FeedExtractor
}

interface ClaudeSidecar {
  description?: string
  spawnDepth?: number
  parentAgentId?: string
}

const CLAUDE_AGENT_RE = /^agent-(.+)\.jsonl$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class MineHistoryReader implements MineHistorySource {
  private readonly fs: FsLike
  private readonly claudeRoots: string[]
  private readonly codex?: { sqlite: SqliteLike; stateDbPath: string }
  private readonly platform: Platform

  constructor(options: MineHistoryReaderOptions) {
    this.fs = options.fs
    this.claudeRoots = options.claudeRoots
    this.codex = options.codex
    this.platform = options.platform ?? currentPlatform()
  }

  async read(cwd: string): Promise<MineHistorySpeaker[]> {
    const candidates = [...(await this.claudeCandidates(cwd)), ...(await this.codexCandidates(cwd))]
    // Newest first, so the cap below drops the oldest files and nothing else.
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const chosen = candidates.slice(0, MINE_HISTORY_TRANSCRIPT_LIMIT)

    const speakers = new Map<string, MineHistorySpeaker>()
    for (const candidate of chosen) {
      const speaker = await this.readCandidate(candidate)
      if (speaker !== null) speakers.set(candidate.id, speaker)
    }

    // The issuer of a subagent's user turns is another SPEAKER, resolved after
    // every transcript is read so the launcher's name is the one its own
    // sidecar or registry row gave it. A launcher that never spoke — or that
    // fell outside the transcript cap — is still a candidate, so its name is
    // taken from there rather than left blank.
    const named = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    for (const candidate of chosen) {
      const speaker = speakers.get(candidate.id)
      if (speaker === undefined || candidate.issuerId === undefined) continue
      const launcher = named.get(candidate.issuerId)
      if (launcher === undefined) continue
      const issuer: MessageIssuer = { role: speakerRole(launcher.position), name: launcher.name }
      speaker.messages = attributeIssuedMessages(speaker.messages, issuer)
    }
    return [...speakers.values()]
  }

  /**
   * One transcript's tail, as a speaker — or null when it says nothing a
   * person could read, since a dwarf that has spoken is the whole definition
   * of a tab (#192). Redacted here, user text included, exactly where the live
   * feed redacts: preload and renderer never hold the raw string.
   */
  private async readCandidate(candidate: Candidate): Promise<MineHistorySpeaker | null> {
    let read: FeedWindowRead
    try {
      // Bounded by the fifty MESSAGES the panel promises rather than by a byte
      // window that happens to contain some of them (#215): the window walks
      // outwards until fifty are collected or the file starts. #227 carries
      // the walk's own reached-start fact onto the speaker instead of
      // dropping it, so the panel can say when it did not reach the start.
      read = await readFeedWindowWithReachedStart(
        this.fs,
        candidate.path,
        MINE_HISTORY_MESSAGE_LIMIT,
        candidate.extract
      )
    } catch {
      // Gone between the listing and the read: the CLI's cleanup, or a user
      // deleting a session. Not a speaker, and not an error worth a warning.
      return null
    }
    const messages = read.messages.map((message) => ({
      ...message,
      text: redactSecrets(message.text)
    }))
    if (messages.length === 0) return null
    const last = messages[messages.length - 1]!
    const lastMessageAt = Date.parse(last.timestamp)
    return {
      id: candidate.id,
      provider: candidate.provider,
      role: speakerRole(candidate.position),
      name: candidate.name,
      // A line that carried no timestamp leaves NaN, and the file's own mtime
      // is the honest stand-in: it is when something was last written here.
      lastMessageAt: Number.isFinite(lastMessageAt) ? lastMessageAt : candidate.mtimeMs,
      messages,
      // Always set, never left absent: this reader always knows one or the
      // other (see MineHistorySpeaker.reachedStart in contracts.ts).
      reachedStart: read.reachedStart
    }
  }

  /*
   * Claude: `<root>/projects/<encoded cwd>/` holds one `<session>.jsonl` per
   * session and a `<session>/subagents/` folder beside each that spawned agents
   * (docs/provider-formats.md §1). The encoding is lossy and never decoded —
   * the cwd is encoded forwards, which is all a lookup needs.
   */
  private async claudeCandidates(cwd: string): Promise<Candidate[]> {
    const candidates: Candidate[] = []
    for (const root of this.claudeRoots) {
      const projectDir = join(root, 'projects', encodeClaudeProjectDir(cwd))
      // listDir answers [] for a missing directory (see FsLike), so a root with
      // no folder for this mine costs one call and no probe.
      for (const entry of await this.fs.listDir(projectDir)) {
        if (entry.isDirectory) {
          candidates.push(...(await this.claudeSubagents(projectDir, entry.name)))
          continue
        }
        if (!entry.name.endsWith('.jsonl')) continue
        const sessionId = entry.name.slice(0, -'.jsonl'.length)
        const path = join(projectDir, entry.name)
        const stat = await this.fs.stat(path)
        if (stat === null) continue
        candidates.push({
          provider: 'claude',
          id: `claude:${sessionId}`,
          // The registry's own name for the session is gone with the process;
          // the live provider's fallback is the id's first eight characters.
          name: sessionId.slice(0, 8),
          path,
          mtimeMs: stat.mtimeMs,
          position: { kind: 'root' },
          extract: extractClaudeFeed
        })
      }
    }
    return candidates
  }

  /**
   * Every subagent transcript of one session, ranked and named by its sidecar
   * (`agent-<id>.meta.json`: `description`, `spawnDepth`, `parentAgentId` —
   * docs/provider-formats.md §1.4). The id scheme is the live provider's own,
   * `${sessionDwarfId}:${agentId}`, so a speaker and the worker it was are
   * one name.
   */
  private async claudeSubagents(projectDir: string, sessionId: string): Promise<Candidate[]> {
    const dir = join(projectDir, sessionId, 'subagents')
    const candidates: Candidate[] = []
    for (const entry of await this.fs.listDir(dir)) {
      const agentId = CLAUDE_AGENT_RE.exec(entry.name)?.[1]
      if (entry.isDirectory || agentId === undefined) continue
      const path = join(dir, entry.name)
      const stat = await this.fs.stat(path)
      if (stat === null) continue
      const sidecar = await this.readSidecar(join(dir, `agent-${agentId}.meta.json`))
      const position: SpeakerPosition = {
        kind: 'subagent',
        ...(sidecar.spawnDepth === undefined ? {} : { spawnDepth: sidecar.spawnDepth })
      }
      // Who wrote this agent's prompts (#175): a depth-1 agent can only have
      // been launched by its session's root, so that is proof; deeper, the
      // sidecar's own parentAgentId names the launcher, and without it nothing
      // does — the same fork messageIssuer.ts draws for the live board.
      const rank = speakerRole(position)
      const issuerId =
        rank === 'worker'
          ? `claude:${sessionId}`
          : sidecar.parentAgentId === undefined
            ? undefined
            : `claude:${sessionId}:${sidecar.parentAgentId}`
      candidates.push({
        provider: 'claude',
        id: `claude:${sessionId}:${agentId}`,
        // The live provider's own fallback name for a worker with no description.
        name: sidecar.description ?? `agent-${agentId.slice(0, 7)}`,
        path,
        mtimeMs: stat.mtimeMs,
        position,
        ...(issuerId === undefined ? {} : { issuerId }),
        extract: extractClaudeFeed
      })
    }
    return candidates
  }

  private async readSidecar(path: string): Promise<ClaudeSidecar> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await this.fs.readTextHead(path, SIDECAR_MAX_BYTES))
    } catch {
      // No sidecar, or one this app cannot read: the agent is still a speaker,
      // ranked and named from what its position alone can prove.
      return {}
    }
    if (!isRecord(parsed)) return {}
    const sidecar: ClaudeSidecar = {}
    if (typeof parsed.description === 'string' && parsed.description.trim() !== '') {
      sidecar.description = parsed.description
    }
    if (typeof parsed.spawnDepth === 'number' && Number.isFinite(parsed.spawnDepth)) {
      sidecar.spawnDepth = parsed.spawnDepth
    }
    if (typeof parsed.parentAgentId === 'string' && parsed.parentAgentId !== '') {
      sidecar.parentAgentId = parsed.parentAgentId
    }
    return sidecar
  }

  /*
   * Codex: the registry's `threads` table is authoritative for a thread's cwd
   * and names its rollout path outright (docs/codex-v2-format.md), so finding
   * the mine's threads is one read of a small table rather than a walk of the
   * day directories. `threads.cwd` carries the Windows extended-length prefix
   * and is compared by the same folding the board merges mines with.
   */
  private async codexCandidates(cwd: string): Promise<Candidate[]> {
    if (this.codex === undefined) return []
    const db = await this.codex.sqlite.openReadOnly(this.codex.stateDbPath)
    if (db === null) return []
    let threads: CodexThread[]
    try {
      // Every non-archived thread, however old: the panel's subject is exactly
      // the sessions the poll's liveness window no longer admits.
      threads = readCodexThreads(db, 0)
    } finally {
      db.close()
    }
    const wanted = normalizePathKey(cwd, this.platform)
    const mine = threads.filter((thread) => normalizePathKey(thread.cwd, this.platform) === wanted)

    const candidates: Candidate[] = []
    for (const thread of mine) {
      const stat = await this.fs.stat(thread.rolloutPath)
      if (stat === null) continue
      // The spawn blob proves a parent and nothing about depth beyond that, so
      // a spawned thread is a depth-1 worker — the same reading the live
      // provider gives it — and its user turns were issued by that parent.
      const position: SpeakerPosition =
        thread.parentThreadId === undefined ? { kind: 'root' } : { kind: 'subagent', spawnDepth: 1 }
      candidates.push({
        provider: 'codex',
        id: `codex:${thread.threadId}`,
        name: thread.agentName ?? `codex-${thread.threadId.slice(0, 8)}`,
        path: thread.rolloutPath,
        mtimeMs: stat.mtimeMs,
        position,
        ...(thread.parentThreadId === undefined
          ? {}
          : { issuerId: `codex:${thread.parentThreadId}` }),
        extract: extractCodexFeed
      })
    }
    return candidates
  }
}
