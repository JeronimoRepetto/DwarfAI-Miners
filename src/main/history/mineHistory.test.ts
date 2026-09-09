import { describe, expect, it, vi } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import type { FsLike } from '../adapters/fsLike'
import { MemorySqlite } from '../adapters/memorySqlite'
import { MINE_HISTORY_MESSAGE_LIMIT } from '../domain/types'
import { CODEX_STATE_SCHEMA, subagentSource, threadInsert } from '../providers/codex/stateSeed'
import { FEED_WINDOW_CEILING_BYTES, FEED_WINDOW_STEPS } from '../providers/feedWindow'
import { MINE_HISTORY_TRANSCRIPT_LIMIT, MineHistoryReader, speakerRole } from './mineHistory'

/*
 * The Mine History panel (#192) reads what a mine's transcripts on disk
 * remember, for dwarfs that may be long gone. Nothing here touches a real
 * home directory: every path below is a fixture path, and the fake fs is the
 * only disk.
 */

const ROOT = 'C:\\claude-home'
const CWD = 'C:\\work\\project'
/** encodeClaudeProjectDir(CWD): every non-alphanumeric character becomes a dash. */
const PROJECT_DIR = `${ROOT}\\projects\\C--work-project`
const SESSION = '5efdffdd-53df-4509-b30d-c9e56552a22e'
const OTHER_SESSION = '7a1b2c3d-0000-4000-8000-000000000001'
const AGENT = 'a5d803981d4c3340f'
const NESTED_AGENT = 'b6e914a92e5d4451a'

const STATE_DB = 'C:\\codex-home\\state_5.sqlite'
const CODEX_THREAD = '01a04d79-5c87-7a31-9b1a-4aacc350d6fd'
const CODEX_CHILD = '01a04d79-5c87-7a31-9b1a-4aacc350d6fe'
const CODEX_ROLLOUT = 'C:\\codex-home\\sessions\\2026\\09\\01\\rollout-' + CODEX_THREAD + '.jsonl'
const CODEX_CHILD_ROLLOUT =
  'C:\\codex-home\\sessions\\2026\\09\\01\\rollout-' + CODEX_CHILD + '.jsonl'

/** One Claude `user` record, in the shape extractClaudeFeed reads. */
function userLine(text: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
    timestamp,
    cwd: CWD,
    sessionId: SESSION
  })
}

/** One Claude `assistant` text record. */
function assistantLine(text: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timestamp,
    cwd: CWD,
    sessionId: SESSION
  })
}

/** A tool result: a `user` record the feed deliberately skips. */
function toolResultLine(timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: 'toolu_01', type: 'tool_result', content: 'ok' }]
    },
    toolUseResult: { stdout: 'ok' },
    timestamp
  })
}

/**
 * A tool result big enough to matter to a byte window: 4 KiB of output on one
 * `user` record the feed skips. This is what a transcript is mostly made of,
 * and why a byte tail is a poor proxy for a message count (#215).
 */
function bulkyToolResultLine(timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ tool_use_id: 'toolu_01', type: 'tool_result', content: 'x'.repeat(4 * 1024) }]
    },
    toolUseResult: { stdout: 'x'.repeat(16) },
    timestamp
  })
}

function codexUserLine(text: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'user_message', message: text }
  })
}

function codexAssistantLine(text: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
  })
}

/** One `history.jsonl` record — docs/provider-formats.md §3.1.4. */
function antigravityHistoryLine(
  conversationId: string,
  workspace: string,
  timestamp: number
): string {
  return JSON.stringify({ display: 'hi', timestamp, workspace, conversationId })
}

/** One `USER_INPUT` transcript step, envelope and all — docs/provider-formats.md §3.1.2. */
function antigravityUserStep(text: string, createdAt: string, stepIndex: number): string {
  return JSON.stringify({
    step_index: stepIndex,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: createdAt,
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`
  })
}

/** One `PLANNER_RESPONSE` transcript step. */
function antigravityAssistantStep(text: string, createdAt: string, stepIndex: number): string {
  return JSON.stringify({
    step_index: stepIndex,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: createdAt,
    content: text
  })
}

function lines(...records: string[]): string {
  return records.join('\n') + '\n'
}

const AT_9 = '2026-09-01T09:00:00.000Z'
const AT_10 = '2026-09-01T10:00:00.000Z'
const AT_11 = '2026-09-01T11:00:00.000Z'
const AT_12 = '2026-09-01T12:00:00.000Z'

describe('speakerRole', () => {
  it('reads the root of a session as the foreman, whatever else it did', () => {
    expect(speakerRole({ kind: 'root' })).toBe('foreman')
  })

  it("ranks a subagent by its sidecar's own depth through the board's rule", () => {
    expect(speakerRole({ kind: 'subagent', spawnDepth: 1 })).toBe('worker')
    expect(speakerRole({ kind: 'subagent', spawnDepth: 2 })).toBe('worker2')
    expect(speakerRole({ kind: 'subagent', spawnDepth: 3 })).toBe('worker2')
  })

  it('falls to worker, never worker2, when the sidecar states no depth', () => {
    expect(speakerRole({ kind: 'subagent' })).toBe('worker')
  })
})

describe('MineHistoryReader over Claude transcripts', () => {
  function reader(fs: FsLike, roots: string[] = [ROOT]): MineHistoryReader {
    return new MineHistoryReader({ fs, claudeRoots: roots, platform: 'win32' })
  }

  it('answers nothing for a mine whose project folder no transcript was ever written to', async () => {
    await expect(reader(new FakeFs()).read(CWD)).resolves.toEqual([])
  })

  it('reads a root transcript as one foreman speaker, oldest message first', async () => {
    const fs = new FakeFs()
    fs.addFile(
      `${PROJECT_DIR}\\${SESSION}.jsonl`,
      lines(userLine('dig here', AT_9), assistantLine('Found the seam.', AT_10)),
      50_000
    )

    const speakers = await reader(fs).read(CWD)
    expect(speakers).toEqual([
      {
        id: `claude:${SESSION}`,
        provider: 'claude',
        role: 'foreman',
        name: SESSION.slice(0, 8),
        lastMessageAt: Date.parse(AT_10),
        messages: [
          { role: 'user', text: 'dig here', timestamp: AT_9 },
          { role: 'assistant', text: 'Found the seam.', timestamp: AT_10 }
        ],
        // Small fixture, well inside the narrowest window (#227).
        reachedStart: true
      }
    ])
  })

  it('names a subagent from its sidecar and ranks it by the depth the sidecar states', async () => {
    const fs = new FakeFs()
    fs.addFile(`${PROJECT_DIR}\\${SESSION}.jsonl`, lines(userLine('dig here', AT_9)), 1)
    const subagents = `${PROJECT_DIR}\\${SESSION}\\subagents`
    fs.addFile(`${subagents}\\agent-${AGENT}.jsonl`, lines(assistantLine('Mapped it.', AT_10)), 1)
    fs.addFile(
      `${subagents}\\agent-${AGENT}.meta.json`,
      JSON.stringify({ agentType: 'general-purpose', description: 'Map the seam', spawnDepth: 1 }),
      1
    )
    fs.addFile(
      `${subagents}\\agent-${NESTED_AGENT}.jsonl`,
      lines(assistantLine('Deeper still.', AT_11)),
      1
    )
    fs.addFile(
      `${subagents}\\agent-${NESTED_AGENT}.meta.json`,
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'Check the map',
        spawnDepth: 2,
        parentAgentId: AGENT
      }),
      1
    )

    const speakers = await reader(fs).read(CWD)
    const byId = new Map(speakers.map((speaker) => [speaker.id, speaker]))
    expect(byId.get(`claude:${SESSION}:${AGENT}`)).toMatchObject({
      role: 'worker',
      name: 'Map the seam',
      provider: 'claude'
    })
    expect(byId.get(`claude:${SESSION}:${NESTED_AGENT}`)).toMatchObject({
      role: 'worker2',
      name: 'Check the map'
    })
  })

  it('falls back to worker and an id-derived name when a subagent has no sidecar', async () => {
    const fs = new FakeFs()
    fs.addFile(
      `${PROJECT_DIR}\\${SESSION}\\subagents\\agent-${AGENT}.jsonl`,
      lines(assistantLine('Mapped it.', AT_10)),
      1
    )

    const [speaker] = await reader(fs).read(CWD)
    expect(speaker).toMatchObject({
      id: `claude:${SESSION}:${AGENT}`,
      role: 'worker',
      name: `agent-${AGENT.slice(0, 7)}`
    })
  })

  /*
   * #175, one rank along: a subagent's transcript opens with the prompt its
   * launcher wrote, as an ordinary `user` record. Drawing it under the human's
   * face would be the exact error that issue fixed, so the launcher is named
   * — from position, since the board that proves it live may be empty.
   */
  it("names the root foreman as the issuer of a depth-1 subagent's user turns", async () => {
    const fs = new FakeFs()
    fs.addFile(`${PROJECT_DIR}\\${SESSION}.jsonl`, lines(userLine('dig here', AT_9)), 1)
    const subagents = `${PROJECT_DIR}\\${SESSION}\\subagents`
    fs.addFile(
      `${subagents}\\agent-${AGENT}.jsonl`,
      lines(userLine('Map the seam.', AT_10), assistantLine('Mapped it.', AT_11)),
      1
    )
    fs.addFile(`${subagents}\\agent-${AGENT}.meta.json`, JSON.stringify({ spawnDepth: 1 }), 1)

    const speakers = await reader(fs).read(CWD)
    const worker = speakers.find((speaker) => speaker.id === `claude:${SESSION}:${AGENT}`)
    expect(worker?.messages).toEqual([
      {
        role: 'user',
        text: 'Map the seam.',
        timestamp: AT_10,
        issuer: { role: 'foreman', name: SESSION.slice(0, 8) }
      },
      { role: 'assistant', text: 'Mapped it.', timestamp: AT_11 }
    ])
    // The root's own prompt really was the human's: no issuer.
    const root = speakers.find((speaker) => speaker.id === `claude:${SESSION}`)
    expect(root?.messages[0]).toEqual({ role: 'user', text: 'dig here', timestamp: AT_9 })
  })

  it("names the launching worker as the issuer of a nested subagent's user turns, by its sidecar's parent", async () => {
    const fs = new FakeFs()
    const subagents = `${PROJECT_DIR}\\${SESSION}\\subagents`
    fs.addFile(`${subagents}\\agent-${AGENT}.jsonl`, lines(assistantLine('Mapped it.', AT_10)), 1)
    fs.addFile(
      `${subagents}\\agent-${AGENT}.meta.json`,
      JSON.stringify({ description: 'Map the seam', spawnDepth: 1 }),
      1
    )
    fs.addFile(
      `${subagents}\\agent-${NESTED_AGENT}.jsonl`,
      lines(userLine('Check the map.', AT_11), assistantLine('Checked.', AT_12)),
      1
    )
    fs.addFile(
      `${subagents}\\agent-${NESTED_AGENT}.meta.json`,
      JSON.stringify({ description: 'Check the map', spawnDepth: 2, parentAgentId: AGENT }),
      1
    )

    const speakers = await reader(fs).read(CWD)
    const nested = speakers.find((speaker) => speaker.id === `claude:${SESSION}:${NESTED_AGENT}`)
    expect(nested?.messages[0]?.issuer).toEqual({ role: 'worker', name: 'Map the seam' })
  })

  it('leaves a nested subagent whose parent it cannot find without an issuer rather than guessing one', async () => {
    const fs = new FakeFs()
    const subagents = `${PROJECT_DIR}\\${SESSION}\\subagents`
    fs.addFile(
      `${subagents}\\agent-${NESTED_AGENT}.jsonl`,
      lines(userLine('Check the map.', AT_11), assistantLine('Checked.', AT_12)),
      1
    )
    fs.addFile(
      `${subagents}\\agent-${NESTED_AGENT}.meta.json`,
      JSON.stringify({ spawnDepth: 2, parentAgentId: 'gone' }),
      1
    )

    const [nested] = await reader(fs).read(CWD)
    expect(nested?.messages[0]).toEqual({ role: 'user', text: 'Check the map.', timestamp: AT_11 })
  })

  it('keeps only the latest MINE_HISTORY_MESSAGE_LIMIT messages of a long transcript', async () => {
    const fs = new FakeFs()
    const records: string[] = []
    for (let index = 0; index < MINE_HISTORY_MESSAGE_LIMIT + 10; index++) {
      const at = new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString()
      records.push(assistantLine(`reply ${index}`, at))
    }
    fs.addFile(`${PROJECT_DIR}\\${SESSION}.jsonl`, lines(...records), 1)

    const [speaker] = await reader(fs).read(CWD)
    expect(speaker?.messages).toHaveLength(MINE_HISTORY_MESSAGE_LIMIT)
    expect(speaker?.messages[0]?.text).toBe('reply 10')
    expect(speaker?.messages.at(-1)?.text).toBe(`reply ${MINE_HISTORY_MESSAGE_LIMIT + 9}`)
  })

  /*
   * Issue #215. The panel promises "the latest 50 messages" per dwarf and used
   * to show the last 50 messages of the last 256 KiB — two windows in series
   * with the narrow one first, and the narrow one a byte count over a file
   * whose bytes are nearly all tool output. Reported as "I open the history of
   * a finished agent and my first message is not there", and it was outside the
   * window by construction rather than by chance.
   */
  it('reaches the launch prompt behind more than 256 KiB of tool traffic', async () => {
    const fs = new FakeFs()
    // One 4 KiB tool result per record, 80 of them: 320 KiB of traffic behind
    // the prompt, and far fewer than fifty readable messages in front of it.
    const noise = Array.from({ length: 80 }, (_, index) =>
      bulkyToolResultLine(new Date(Date.UTC(2026, 8, 1, 9, index)).toISOString())
    )
    fs.addFile(
      `${PROJECT_DIR}\\${SESSION}.jsonl`,
      lines(userLine('dig the north seam', AT_9), ...noise, assistantLine('Dug it.', AT_12)),
      1
    )

    const [speaker] = await reader(fs).read(CWD)
    expect(speaker?.messages[0]).toEqual({
      role: 'user',
      text: 'dig the north seam',
      timestamp: AT_9
    })
    expect(speaker?.messages.map((message) => message.text)).toEqual([
      'dig the north seam',
      'Dug it.'
    ])
  })

  it('is not a speaker when the transcript holds nothing a person could read', async () => {
    const fs = new FakeFs()
    fs.addFile(`${PROJECT_DIR}\\${SESSION}.jsonl`, lines(toolResultLine(AT_9)), 1)
    await expect(reader(fs).read(CWD)).resolves.toEqual([])
  })

  it('redacts secrets before anything leaves the process, user text included', async () => {
    const fs = new FakeFs()
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    fs.addFile(`${PROJECT_DIR}\\${SESSION}.jsonl`, lines(userLine(`use ${token}`, AT_9)), 1)

    const [speaker] = await reader(fs).read(CWD)
    expect(speaker?.messages[0]?.text).not.toContain(token)
  })

  it('falls back to the file mtime for the last-message time when the line carries none', async () => {
    const fs = new FakeFs()
    fs.addFile(
      `${PROJECT_DIR}\\${SESSION}.jsonl`,
      lines(JSON.stringify({ type: 'user', message: { role: 'user', content: 'dig' } })),
      123_456
    )
    const [speaker] = await reader(fs).read(CWD)
    expect(speaker?.lastMessageAt).toBe(123_456)
  })

  it('scans every configured root, and skips a root with no project folder', async () => {
    const fs = new FakeFs()
    const secondRoot = 'C:\\claude-work'
    fs.addFile(`${PROJECT_DIR}\\${SESSION}.jsonl`, lines(userLine('one', AT_9)), 1)
    fs.addFile(
      `${secondRoot}\\projects\\C--work-project\\${OTHER_SESSION}.jsonl`,
      lines(userLine('two', AT_10)),
      1
    )

    const speakers = await reader(fs, [ROOT, secondRoot, 'C:\\nowhere']).read(CWD)
    expect(speakers.map((speaker) => speaker.id).sort()).toEqual([
      `claude:${SESSION}`,
      `claude:${OTHER_SESSION}`
    ])
  })

  /*
   * Amended for #215, which retired MINE_HISTORY_TAIL_BYTES — the single fixed
   * window this used to name. The claim it was making is unchanged and still
   * the one worth pinning: a read is bounded and never asks for the whole
   * file. What it now names is the walk's own narrowest and widest steps
   * (readFeedWindow), so the bound is still asserted against a constant rather
   * than a literal.
   */
  it('reads a bounded window of every transcript, never the whole file', async () => {
    const fs = new FakeFs()
    fs.addFile(`${PROJECT_DIR}\\${SESSION}.jsonl`, lines(userLine('dig', AT_9)), 1)
    const readTextTail = vi.fn(fs.readTextTail.bind(fs))
    const bounded: FsLike = {
      ...fs,
      readTextTail,
      readTextHead: fs.readTextHead.bind(fs),
      readJson: fs.readJson.bind(fs),
      listDir: fs.listDir.bind(fs),
      stat: fs.stat.bind(fs),
      exists: fs.exists.bind(fs)
    }

    await reader(bounded).read(CWD)
    expect(readTextTail).toHaveBeenCalledWith(
      `${PROJECT_DIR}\\${SESSION}.jsonl`,
      FEED_WINDOW_STEPS[0]
    )
    // A short transcript costs one read: the walk stops at the first window
    // the file did not fill, and never reaches the ceiling.
    expect(readTextTail).toHaveBeenCalledTimes(1)
    for (const [, bytes] of readTextTail.mock.calls) {
      expect(bytes).toBeLessThanOrEqual(FEED_WINDOW_CEILING_BYTES)
    }
  })

  /*
   * The number of transcripts under a project is bounded only by Claude Code's
   * own cleanup, so the read is: the NEWEST files by mtime, up to the limit,
   * and the rest are left unread rather than turning one open into a walk of
   * the whole month.
   */
  it('reads at most MINE_HISTORY_TRANSCRIPT_LIMIT transcripts, newest by mtime first', async () => {
    const fs = new FakeFs()
    for (let index = 0; index < MINE_HISTORY_TRANSCRIPT_LIMIT + 5; index++) {
      const session = `session-${String(index).padStart(3, '0')}`
      fs.addFile(`${PROJECT_DIR}\\${session}.jsonl`, lines(userLine(`dig ${index}`, AT_9)), index)
    }

    const speakers = await reader(fs).read(CWD)
    expect(speakers).toHaveLength(MINE_HISTORY_TRANSCRIPT_LIMIT)
    // The five oldest files (mtime 0..4) are the ones left unread.
    const ids = new Set(speakers.map((speaker) => speaker.id))
    for (let index = 0; index < 5; index++) {
      expect(ids.has(`claude:session-${String(index).padStart(3, '0')}`)).toBe(false)
    }
  })
})

/*
 * #227: the read behind `messages` already knows whether it reached the
 * transcript's own start (readFeedWindow's own fact), and the reader now
 * carries it onto the speaker rather than dropping it.
 */
describe('MineHistoryReader and the reached-start flag', () => {
  function reader(fs: FsLike, roots: string[] = [ROOT]): MineHistoryReader {
    return new MineHistoryReader({ fs, claudeRoots: roots, platform: 'win32' })
  }

  it('marks reachedStart true when the whole transcript sits inside the narrowest window', async () => {
    const fs = new FakeFs()
    fs.addFile(
      `${PROJECT_DIR}\\${SESSION}.jsonl`,
      lines(userLine('dig here', AT_9), assistantLine('Found the seam.', AT_10)),
      1
    )

    const [speaker] = await reader(fs).read(CWD)
    expect(speaker?.reachedStart).toBe(true)
  })

  /*
   * The real ceiling, not a scaled-down stand-in: FEED_WINDOW_CEILING_BYTES of
   * tool noise between the launch prompt and the last reply, so even the
   * widest step the reader ever takes still has file behind it. Slow to build
   * (a multi-megabyte fixture) but the one place that proves the flag survives
   * the reader's own plumbing at the size it is meant for, not just the walk
   * feedWindow.test.ts already proves with injected steps.
   */
  it('marks reachedStart false when the transcript outgrows the widest window, and still returns what it did read', async () => {
    const fs = new FakeFs()
    const noise: string[] = []
    let bytes = 0
    let index = 0
    while (bytes <= FEED_WINDOW_CEILING_BYTES) {
      const line = bulkyToolResultLine(new Date(Date.UTC(2026, 8, 1, 9, index)).toISOString())
      noise.push(line)
      bytes += Buffer.byteLength(line, 'utf8') + 1
      index++
    }
    fs.addFile(
      `${PROJECT_DIR}\\${SESSION}.jsonl`,
      lines(userLine('dig the north seam', AT_9), ...noise, assistantLine('Dug it.', AT_12)),
      1
    )

    const [speaker] = await reader(fs).read(CWD)
    expect(speaker?.reachedStart).toBe(false)
    // The launch prompt is more than a ceiling's worth of noise behind the
    // read; only the reply the widest window could still reach comes back.
    expect(speaker?.messages.map((message) => message.text)).toEqual(['Dug it.'])
  })
})

describe('MineHistoryReader over Codex rollouts', () => {
  function readerWith(fs: FsLike, sqlite: MemorySqlite): MineHistoryReader {
    return new MineHistoryReader({
      fs,
      claudeRoots: [ROOT],
      codex: { sqlite, stateDbPath: STATE_DB },
      platform: 'win32'
    })
  }

  function seeded(): MemorySqlite {
    const sqlite = new MemorySqlite()
    sqlite.define(STATE_DB, CODEX_STATE_SCHEMA)
    return sqlite
  }

  it("finds the mine's threads through the registry, past the extended-length prefix and case", async () => {
    const fs = new FakeFs()
    const sqlite = seeded()
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: CODEX_THREAD,
        cwd: '\\\\?\\c:\\WORK\\project',
        rolloutPath: CODEX_ROLLOUT,
        updatedAtMs: 1
      })
    )
    fs.addFile(
      CODEX_ROLLOUT,
      lines(codexUserLine('dig here', AT_9), codexAssistantLine('Found the seam.', AT_10)),
      1
    )

    await expect(readerWith(fs, sqlite).read(CWD)).resolves.toEqual([
      {
        id: `codex:${CODEX_THREAD}`,
        provider: 'codex',
        role: 'foreman',
        name: `codex-${CODEX_THREAD.slice(0, 8)}`,
        lastMessageAt: Date.parse(AT_10),
        messages: [
          { role: 'user', text: 'dig here', timestamp: AT_9 },
          { role: 'assistant', text: 'Found the seam.', timestamp: AT_10 }
        ],
        // Small fixture, well inside the narrowest window (#227).
        reachedStart: true
      }
    ])
  })

  it('ignores a thread bound to another folder', async () => {
    const fs = new FakeFs()
    const sqlite = seeded()
    sqlite.exec(
      STATE_DB,
      threadInsert({ id: CODEX_THREAD, cwd: 'C:\\work\\other', rolloutPath: CODEX_ROLLOUT })
    )
    fs.addFile(CODEX_ROLLOUT, lines(codexUserLine('dig here', AT_9)), 1)

    await expect(readerWith(fs, sqlite).read(CWD)).resolves.toEqual([])
  })

  it('ranks a spawned Codex thread as a worker named by its nickname, issued by its parent', async () => {
    const fs = new FakeFs()
    const sqlite = seeded()
    sqlite.exec(STATE_DB, threadInsert({ id: CODEX_THREAD, cwd: CWD, rolloutPath: CODEX_ROLLOUT }))
    sqlite.exec(
      STATE_DB,
      threadInsert({
        id: CODEX_CHILD,
        cwd: CWD,
        rolloutPath: CODEX_CHILD_ROLLOUT,
        source: subagentSource(CODEX_THREAD, 'Bernoulli')
      })
    )
    fs.addFile(CODEX_ROLLOUT, lines(codexUserLine('dig here', AT_9)), 1)
    fs.addFile(
      CODEX_CHILD_ROLLOUT,
      lines(codexUserLine('Audit the seam.', AT_10), codexAssistantLine('Audited.', AT_11)),
      1
    )

    const speakers = await readerWith(fs, sqlite).read(CWD)
    const child = speakers.find((speaker) => speaker.id === `codex:${CODEX_CHILD}`)
    expect(child).toMatchObject({ role: 'worker', name: 'Bernoulli', provider: 'codex' })
    expect(child?.messages[0]?.issuer).toEqual({
      role: 'foreman',
      name: `codex-${CODEX_THREAD.slice(0, 8)}`
    })
  })

  it('skips a registered thread whose rollout is gone from disk', async () => {
    const fs = new FakeFs()
    const sqlite = seeded()
    sqlite.exec(STATE_DB, threadInsert({ id: CODEX_THREAD, cwd: CWD, rolloutPath: CODEX_ROLLOUT }))
    await expect(readerWith(fs, sqlite).read(CWD)).resolves.toEqual([])
  })

  it('answers from Claude alone when the registry database is missing', async () => {
    const fs = new FakeFs()
    fs.addFile(`${PROJECT_DIR}\\${SESSION}.jsonl`, lines(userLine('dig here', AT_9)), 1)
    const speakers = await readerWith(fs, new MemorySqlite()).read(CWD)
    expect(speakers.map((speaker) => speaker.id)).toEqual([`claude:${SESSION}`])
  })
})

/*
 * #237, step 3. Antigravity's own store has no session file per project the
 * way Claude does and no registry table the way Codex does — history.jsonl
 * is the only place a conversation's workspace is recorded at all (see
 * providers/antigravity/discovery.ts), so it is what this reads, defensively
 * parsed the same way the live observer parses it.
 */
describe('MineHistoryReader over Antigravity conversations', () => {
  const ANTIGRAVITY_ROOT = 'C:\\antigravity-home'
  const CONVERSATION = 'aaaaaaaa-1111-4111-8111-111111111111'
  const OTHER_CONVERSATION = 'bbbbbbbb-2222-4222-8222-222222222222'
  const TRANSCRIPT = (id: string): string =>
    `${ANTIGRAVITY_ROOT}\\brain\\${id}\\.system_generated\\logs\\transcript.jsonl`

  function reader(fs: FsLike): MineHistoryReader {
    return new MineHistoryReader({
      fs,
      claudeRoots: [],
      antigravity: { storeRoot: ANTIGRAVITY_ROOT },
      platform: 'win32'
    })
  }

  it("finds a conversation through history.jsonl's workspace map and reads its transcript", async () => {
    const fs = new FakeFs()
    fs.addFile(
      `${ANTIGRAVITY_ROOT}\\history.jsonl`,
      lines(antigravityHistoryLine(CONVERSATION, CWD, 1)),
      1
    )
    fs.addFile(
      TRANSCRIPT(CONVERSATION),
      lines(
        antigravityUserStep('dig here', AT_9, 0),
        antigravityAssistantStep('Found the seam.', AT_10, 1)
      ),
      1
    )

    await expect(reader(fs).read(CWD)).resolves.toEqual([
      {
        id: `antigravity:${CONVERSATION}`,
        provider: 'antigravity',
        // No parent edge is read from this store (see AntigravityProvider's
        // own class comment): every conversation ranks the same way the live
        // board draws it — absence of spawn evidence, never a foreman claim.
        role: 'worker',
        name: `agy-${CONVERSATION.slice(0, 8)}`,
        lastMessageAt: Date.parse(AT_10),
        messages: [
          { role: 'user', text: 'dig here', timestamp: AT_9 },
          { role: 'assistant', text: 'Found the seam.', timestamp: AT_10 }
        ],
        // Small fixture, well inside the narrowest window (#227).
        reachedStart: true
      }
    ])
  })

  it('ignores a conversation history.jsonl records for a different workspace', async () => {
    const fs = new FakeFs()
    fs.addFile(
      `${ANTIGRAVITY_ROOT}\\history.jsonl`,
      lines(antigravityHistoryLine(CONVERSATION, 'C:\\work\\other', 1)),
      1
    )
    fs.addFile(TRANSCRIPT(CONVERSATION), lines(antigravityUserStep('dig here', AT_9, 0)), 1)

    await expect(reader(fs).read(CWD)).resolves.toEqual([])
  })

  it('skips a conversation history.jsonl names whose transcript is gone from disk', async () => {
    const fs = new FakeFs()
    fs.addFile(
      `${ANTIGRAVITY_ROOT}\\history.jsonl`,
      lines(antigravityHistoryLine(CONVERSATION, CWD, 1)),
      1
    )
    await expect(reader(fs).read(CWD)).resolves.toEqual([])
  })

  it('answers nothing for Antigravity when this build has no store root for it', async () => {
    const fs = new FakeFs()
    fs.addFile(`${PROJECT_DIR}\\${SESSION}.jsonl`, lines(userLine('dig here', AT_9)), 1)
    const speakers = await new MineHistoryReader({
      fs,
      claudeRoots: [ROOT],
      platform: 'win32'
    }).read(CWD)
    expect(speakers.map((speaker) => speaker.id)).toEqual([`claude:${SESSION}`])
  })

  it('finds every conversation history.jsonl maps to the same mine', async () => {
    const fs = new FakeFs()
    fs.addFile(
      `${ANTIGRAVITY_ROOT}\\history.jsonl`,
      lines(
        antigravityHistoryLine(CONVERSATION, CWD, 1),
        antigravityHistoryLine(OTHER_CONVERSATION, CWD, 2)
      ),
      1
    )
    fs.addFile(TRANSCRIPT(CONVERSATION), lines(antigravityUserStep('dig here', AT_9, 0)), 1)
    fs.addFile(TRANSCRIPT(OTHER_CONVERSATION), lines(antigravityUserStep('map there', AT_10, 0)), 1)

    const speakers = await reader(fs).read(CWD)
    expect(speakers.map((speaker) => speaker.id).sort()).toEqual(
      [`antigravity:${CONVERSATION}`, `antigravity:${OTHER_CONVERSATION}`].sort()
    )
  })

  it('is not a speaker when the transcript holds nothing a person could read', async () => {
    const fs = new FakeFs()
    fs.addFile(
      `${ANTIGRAVITY_ROOT}\\history.jsonl`,
      lines(antigravityHistoryLine(CONVERSATION, CWD, 1)),
      1
    )
    // A GENERIC tool-output step: nobody speaking, by the same rule
    // extractAntigravityFeed already holds live.
    fs.addFile(
      TRANSCRIPT(CONVERSATION),
      lines(
        JSON.stringify({
          step_index: 0,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'DONE',
          created_at: AT_9,
          content: 'tool output'
        })
      ),
      1
    )

    await expect(reader(fs).read(CWD)).resolves.toEqual([])
  })
})

describe('MineHistoryReader over a resumed subagent (#338)', () => {
  function reader(fs: FsLike): MineHistoryReader {
    return new MineHistoryReader({ fs, claudeRoots: [ROOT], platform: 'win32' })
  }

  it('lists the turns a resumed agent took after the ending that took it off the board', async () => {
    // The live board keys an agent's presence on its ending (#179, #338); this
    // panel keys nothing on one, and the difference is the point of it. A
    // resumed agent's later turns are in the same file its earlier ones are,
    // so they read out together whether or not the provider ever redrew the
    // dwarf — which is exactly the guarantee the reported bug leaned on while
    // the board was wrong.
    const fs = new FakeFs()
    const subagents = `${PROJECT_DIR}\\${SESSION}\\subagents`
    fs.addFile(
      `${subagents}\\agent-${AGENT}.jsonl`,
      lines(
        userLine('Map the seam.', AT_9),
        assistantLine('Mapped it.', AT_10),
        // The agent stopped here, and was resumed by SendMessage.
        userLine('Now check the second seam.', AT_11),
        assistantLine('Checked it.', AT_12)
      ),
      1
    )
    fs.addFile(
      `${subagents}\\agent-${AGENT}.meta.json`,
      JSON.stringify({ description: 'Map the seam', spawnDepth: 1 }),
      1
    )

    const worker = (await reader(fs).read(CWD)).find(
      (speaker) => speaker.id === `claude:${SESSION}:${AGENT}`
    )
    expect(worker?.messages.map((message) => message.text)).toEqual([
      'Map the seam.',
      'Mapped it.',
      'Now check the second seam.',
      'Checked it.'
    ])
    expect(worker?.lastMessageAt).toBe(Date.parse(AT_12))
  })
})

/**
 * A mine folded from several worktrees (#348) has its transcripts in several
 * places on disk, because a provider files one under the cwd the session ran
 * in. One read has to open all of them.
 */
describe('MineHistoryReader.readAcross (#348)', () => {
  const FORGE = 'C:\\work\\forge'
  /** encodeClaudeProjectDir(FORGE). */
  const FORGE_DIR = `${ROOT}\\projects\\C--work-forge`
  const FORGE_SESSION = '8b2c3d4e-0000-4000-8000-000000000002'

  function reader(fs: FsLike): MineHistoryReader {
    return new MineHistoryReader({ fs, claudeRoots: [ROOT], platform: 'win32' })
  }

  /** One Claude assistant record filed under a second cwd. */
  function forgeLine(text: string, timestamp: string): string {
    return JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      timestamp,
      cwd: FORGE,
      sessionId: FORGE_SESSION
    })
  }

  it('reads the project s own transcripts AND every worktree s, in one answer', async () => {
    const fs = new FakeFs()
    fs.addFile(
      `${PROJECT_DIR}\\${SESSION}.jsonl`,
      lines(userLine('dig here', AT_9), assistantLine('Found the seam.', AT_10)),
      50_000
    )
    fs.addFile(
      `${FORGE_DIR}\\${FORGE_SESSION}.jsonl`,
      lines(forgeLine('Forging on the branch.', AT_10)),
      60_000
    )

    const speakers = await reader(fs).readAcross([CWD, FORGE])

    expect(speakers.map((speaker) => speaker.id).sort()).toEqual(
      [`claude:${SESSION}`, `claude:${FORGE_SESSION}`].sort()
    )
  })

  it('opens one folder once, however many spellings of it a caller passes', async () => {
    const fs = new FakeFs()
    fs.addFile(
      `${PROJECT_DIR}\\${SESSION}.jsonl`,
      lines(userLine('dig here', AT_9), assistantLine('Found the seam.', AT_10)),
      50_000
    )

    // A speaker read twice would arrive with its messages doubled.
    const speakers = await reader(fs).readAcross([CWD, 'c:\WORK\project'])
    expect(speakers).toHaveLength(1)
    expect(speakers[0]!.messages).toHaveLength(2)
  })

  it('reads exactly the one folder when read() is asked for one', async () => {
    const fs = new FakeFs()
    fs.addFile(
      `${FORGE_DIR}\\${FORGE_SESSION}.jsonl`,
      lines(forgeLine('Forging on the branch.', AT_10)),
      60_000
    )

    await expect(reader(fs).read(CWD)).resolves.toEqual([])
    await expect(reader(fs).read(FORGE)).resolves.toHaveLength(1)
  })
})
