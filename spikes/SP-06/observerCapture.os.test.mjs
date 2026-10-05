// OS lane (17 §1.8) for the SP-06 recording tools. They run on the maintainer's machines, one per OS, so their
// tests run on each OS's real file system and path rules (a Windows `<REPO>` is `C:\…`, a POSIX one `/tmp/…`).
// Every input is synthetic; no provider CLI runs here (17 §5.5).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runScrub } from '../../scripts/fixtures/scrub.mjs'
import { runCapture, sseToJsonl } from './captureTranscript.mjs'
import { idCorrespondence, parseJsonl } from './idCorrespondence.mjs'

const LANE = { RUN_INTEGRATION: '1', DWARFAI_REAL_CLI: 'claude' }
const quiet = () => {}
let dirs = []
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dwarfai-sp06-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

const jsonl = (records) => records.map((record) => `${JSON.stringify(record)}\n`).join('')

/** A Claude transcript and its stream-json stream of one session: shared message ids, one usage update. */
function claudeSession(repo) {
  const usage = (output) => ({
    input_tokens: 12,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  })
  const assistant = (uuid, id, output, stopReason) => ({
    type: 'assistant',
    uuid,
    sessionId: 'session-1111-aaaa',
    cwd: repo,
    timestamp: '2026-10-05T10:00:01.000Z',
    message: { id, role: 'assistant', usage: usage(output), stop_reason: stopReason }
  })
  // msg_01 is written twice (a partial row, then its final stop-state row); msg_02 once.
  const transcript = [
    { type: 'user', uuid: 'uuid-0001-user', sessionId: 'session-1111-aaaa', cwd: repo },
    assistant('uuid-0002-asst', 'msg_01AAAA1111', 3, null),
    assistant('uuid-0003-asst', 'msg_01AAAA1111', 8, 'end_turn'),
    assistant('uuid-0004-asst', 'msg_02BBBB2222', 5, 'end_turn')
  ]
  const stream = [
    { type: 'system', subtype: 'init', session_id: 'session-1111-aaaa', cwd: repo },
    {
      type: 'assistant',
      uuid: 'uuid-0003-asst',
      session_id: 'session-1111-aaaa',
      message: { id: 'msg_01AAAA1111', usage: usage(8) }
    },
    {
      type: 'assistant',
      uuid: 'uuid-9999-asst',
      session_id: 'session-1111-aaaa',
      message: { id: 'msg_02BBBB2222', usage: usage(6) }
    },
    {
      type: 'assistant',
      uuid: 'uuid-8888-asst',
      session_id: 'session-1111-aaaa',
      message: { id: 'msg_03CCCC3333', usage: usage(1) }
    },
    { type: 'result', subtype: 'success', session_id: 'session-1111-aaaa' }
  ]
  return { transcript, stream }
}

describe('SP-06 recording tools (OS lane, synthetic input)', () => {
  it('[SP-06] the capture refuses outside the real-CLI lane and writes a raw transcript that scrub.mjs turns into a fixture set', () => {
    const root = tempDir()
    const repo = path.join(tempDir(), 'dwarfai-rec-1')
    mkdirSync(repo)
    const { transcript, stream } = claudeSession(repo)
    const transcriptFile = path.join(root, 'transcript.jsonl')
    const streamFile = path.join(root, 'stream.jsonl')
    writeFileSync(transcriptFile, jsonl(transcript))
    writeFileSync(streamFile, jsonl(stream))
    const fixturesRoot = path.join(root, 'fixtures')
    const request = {
      provider: 'claude',
      version: '2.1.99',
      caseName: 'one-turn',
      repo,
      source: transcriptFile,
      fixturesRoot,
      now: () => Date.UTC(2026, 9, 5),
      log: quiet
    }

    for (const env of [
      { ...LANE, CI: 'true' },
      { DWARFAI_REAL_CLI: 'claude' },
      { ...LANE, DWARFAI_REAL_CLI: 'codex' }
    ]) {
      expect(runCapture({ ...request, env }), `refused with ${JSON.stringify(env)}`).toBe(2)
    }
    expect(existsSync(fixturesRoot), 'a refused capture writes nothing').toBe(false)
    expect(
      runCapture({ ...request, env: LANE, version: '../up' }),
      'a version that leaves its folder'
    ).toBe(2)

    expect(runCapture({ ...request, env: LANE })).toBe(0)
    expect(runCapture({ ...request, env: LANE, source: streamFile, stream: 'stream' })).toBe(0)
    const folder = path.join(fixturesRoot, 'claude', 'observer', '2.1.99')
    expect(readdirSync(folder).sort()).toEqual([
      'one-turn.raw.jsonl',
      'one-turn.raw.meta.json',
      'one-turn.raw.stream.jsonl'
    ])
    const meta = JSON.parse(readFileSync(path.join(folder, 'one-turn.raw.meta.json'), 'utf8'))
    expect(meta).toMatchObject({
      driver: 'observer',
      providerVersion: '2.1.99',
      repoRoot: repo,
      capturedAt: '2026-10-05'
    })

    const raws = readdirSync(folder).map((name) => path.join(folder, name))
    const identity = { home: path.dirname(root), user: 'nobody-s06', host: 'placeholder-host' }
    expect(runScrub(raws, { identity, log: quiet })).toBe(0)
    const written = readdirSync(folder).sort()
    expect(written).toEqual([
      'meta.json',
      'one-turn-crlf.jsonl',
      'one-turn-stream-crlf.jsonl',
      'one-turn-stream-with-extra.jsonl',
      'one-turn-stream.jsonl',
      'one-turn-with-extra.jsonl',
      'one-turn.jsonl'
    ])
    const scrubbed = readFileSync(path.join(folder, 'one-turn.jsonl'), 'utf8')
    expect(scrubbed, 'the throwaway repository became <REPO>').toContain('<REPO>')
    expect(scrubbed.includes(repo), 'no real path survives').toBe(false)
    // The scrubber maps ids consistently across the case, so the correspondence survives scrubbing.
    const read = (name) => parseJsonl(readFileSync(path.join(folder, name), 'utf8'))
    expect(
      idCorrespondence('claude', read('one-turn-stream.jsonl'), read('one-turn.jsonl')).units
    ).toEqual(idCorrespondence('claude', stream, transcript).units)
  })

  it('[SP-06] an SSE body becomes one JSON event per line, other lines dropped', () => {
    const body =
      'event: message\r\ndata: {"type":"session.idle","properties":{}}\r\n\r\n: ping\ndata: not json\ndata:{"type":"x"}\n'
    expect(sseToJsonl(body)).toBe('{"type":"session.idle","properties":{}}\n{"type":"x"}\n')
  })

  it('[SP-06, ADR-006] the id correspondence reports the unit keys a live stream and a transcript share and whether their usage agrees', () => {
    const { transcript, stream } = claudeSession('/work/repo')
    const result = idCorrespondence('claude', stream, transcript)
    expect(result.units).toEqual({
      stream: 3,
      transcript: 2,
      shared: 2,
      onlyStream: 1,
      onlyTranscript: 0,
      usageEqual: 1,
      usageDiffers: 1
    })
    expect(result.sharedIdPaths).toEqual(
      expect.arrayContaining([
        { stream: 'message.id', transcript: 'message.id', shared: 2 },
        { stream: 'uuid', transcript: 'uuid', shared: 1 },
        { stream: 'session_id', transcript: 'sessionId', shared: 1 }
      ])
    )
    expect(JSON.stringify(result), 'counts only: no id is printed').not.toMatch(
      /msg_|uuid-0|session-1111/
    )
    expect(idCorrespondence('codex', stream, transcript).units, 'units are Claude-only').toBeNull()
  })
})
