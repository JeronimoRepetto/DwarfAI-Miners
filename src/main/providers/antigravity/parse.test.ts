import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  antigravityUserRequestText,
  extractAntigravityFeed,
  parseAntigravityTranscriptTail
} from './parse'

/*
 * Issue #237. The Antigravity CLI keeps a PRIVATE on-disk transcript, and the
 * format has changed across CLI versions — so every expectation here is read
 * off a sanitized capture of one exact version (1.1.26, see
 * __fixtures__/antigravity), and the parser's job is to degrade on anything it
 * does not recognise rather than to throw inside a poll tick.
 */

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'antigravity')
const transcript = readFileSync(join(FIXTURES, 'transcript.jsonl'), 'utf8')
const busyTranscript = readFileSync(join(FIXTURES, 'transcript-busy.jsonl'), 'utf8')
const partialTail = readFileSync(join(FIXTURES, 'transcript-partial-tail.jsonl'), 'utf8')
const toolCallsTranscript = readFileSync(join(FIXTURES, 'transcript-tool-calls.jsonl'), 'utf8')

describe('extractAntigravityFeed', () => {
  // AMENDED for #280 (was: 4 messages, and `find_by_name`/`view_file`/
  // `replace_file_content` at steps 1, 6 and 10 published nothing — #280
  // reads tool_calls too, so the same fixture now yields three more lines,
  // interleaved in step order with the two conversation turns either side).
  it('reads both halves of the conversation, in step order', () => {
    expect(extractAntigravityFeed(transcript, 50)).toEqual([
      { role: 'user', text: 'What does this project do?', timestamp: '2026-09-04T19:01:13Z' },
      {
        role: 'assistant',
        text: 'Searched *',
        timestamp: '2026-09-04T19:01:13Z',
        activity: { kind: 'search', target: '*' }
      },
      {
        role: 'assistant',
        text: 'It is a small command-line tool with one entry point and a test suite.',
        timestamp: '2026-09-04T19:01:18Z'
      },
      { role: 'user', text: 'Add a test for the parser.', timestamp: '2026-09-04T19:03:02Z' },
      {
        role: 'assistant',
        text: 'Read C:\\Users\\j\\Desktop\\Sample-Project\\src\\parse.ts',
        timestamp: '2026-09-04T19:03:03Z',
        activity: { kind: 'read', target: 'C:\\Users\\j\\Desktop\\Sample-Project\\src\\parse.ts' }
      },
      {
        role: 'assistant',
        text: 'Edited C:\\Users\\j\\Desktop\\Sample-Project\\src\\parse.test.ts',
        timestamp: '2026-09-04T19:03:09Z',
        activity: {
          kind: 'edit',
          target: 'C:\\Users\\j\\Desktop\\Sample-Project\\src\\parse.test.ts'
        }
      },
      {
        role: 'assistant',
        text: 'Added a test for the parser and ran the suite; it passes.',
        timestamp: '2026-09-04T19:03:12Z'
      }
    ])
  })

  /**
   * The tools this fixture does not carry `find_by_name`/`view_file`/
   * `replace_file_content` for (#280): `run_command`, `list_dir`,
   * `grep_search`, `write_to_file` and the two deliberate omissions in
   * `transcript-tool-calls.jsonl` — a tool this table has never mapped
   * (`manage_subagents`) and a subject the CLI's own truncation cut through.
   * Interleaved with the one spoken turn either side, in step order.
   */
  it('draws one line per tool call, in call order, and skips an unknown tool and a truncated subject', () => {
    expect(extractAntigravityFeed(toolCallsTranscript, 50)).toEqual([
      {
        role: 'user',
        text: 'Run the suite, then look around.',
        timestamp: '2026-09-07T10:00:00Z'
      },
      {
        role: 'assistant',
        text: 'Ran pnpm test',
        timestamp: '2026-09-07T10:00:02Z',
        activity: { kind: 'run', target: 'pnpm test' }
      },
      {
        role: 'assistant',
        text: 'Read C:\\Users\\j\\Desktop\\Sample-Project\\src',
        timestamp: '2026-09-07T10:00:04Z',
        activity: { kind: 'read', target: 'C:\\Users\\j\\Desktop\\Sample-Project\\src' }
      },
      {
        role: 'assistant',
        text: 'Searched FeedMessage',
        timestamp: '2026-09-07T10:00:06Z',
        activity: { kind: 'search', target: 'FeedMessage' }
      },
      {
        role: 'assistant',
        text: 'Edited C:\\Users\\j\\Desktop\\Sample-Project\\scratch\\note.md',
        timestamp: '2026-09-07T10:00:08Z',
        activity: {
          kind: 'edit',
          target: 'C:\\Users\\j\\Desktop\\Sample-Project\\scratch\\note.md'
        }
      },
      // step 5 (manage_subagents) and step 6 (run_command, truncated) both
      // publish nothing — see the two `it`s below for each in isolation.
      {
        role: 'assistant',
        text: 'Ran the suite and looked around; everything checks out.',
        timestamp: '2026-09-07T10:00:14Z'
      }
    ])
  })

  it('publishes no line for a tool call this table has never mapped', () => {
    const texts = extractAntigravityFeed(toolCallsTranscript, 50).map((message) => message.text)
    expect(texts.some((text) => text.includes('list'))).toBe(false)
    expect(texts.some((text) => text.includes('subagent'))).toBe(false)
  })

  it('publishes no line for a call whose subject the CLI truncated away', () => {
    const texts = extractAntigravityFeed(toolCallsTranscript, 50).map((message) => message.text)
    expect(texts.some((text) => text.includes('gh issue create'))).toBe(false)
    expect(texts.some((text) => text.startsWith('Ran ') && text.length <= 'Ran '.length)).toBe(
      false
    )
  })

  /*
   * The three kinds of record that are not a message, and the reason each one
   * is skipped rather than shown: GENERIC is tool output (the overwhelming
   * majority of the file's bytes), a PLANNER_RESPONSE carrying only
   * `tool_calls` is the model acting — drawn as its OWN line since #280,
   * never as the tool's raw name — and `thinking` is a field of its own, so
   * no tag-stripping heuristic is needed anywhere here.
   */
  it('shows no tool output, no raw tool name and no thinking', () => {
    const texts = extractAntigravityFeed(transcript, 50).map((message) => message.text)
    expect(texts.some((text) => text.includes('Found 3 results'))).toBe(false)
    expect(texts.some((text) => text.includes('find_by_name'))).toBe(false)
    expect(texts.some((text) => text.includes('Answering short'))).toBe(false)
  })

  it('shows neither a system message nor an error message as somebody speaking', () => {
    const texts = extractAntigravityFeed(transcript, 50).map((message) => message.text)
    expect(texts.some((text) => text.includes('SYSTEM_MESSAGE'))).toBe(false)
    expect(texts.some((text) => text.includes('The tool call failed'))).toBe(false)
  })

  it('skips a record type this build has never seen instead of throwing', () => {
    // The whole degradation contract in one assertion: an unknown `type` is
    // not a message, is not an error, and does not cost the records after it.
    const texts = extractAntigravityFeed(transcript, 50).map((message) => message.text)
    expect(texts.some((text) => text.includes('never seen'))).toBe(false)
    // AMENDED for #280 (was: toHaveLength(4)) — the fixture's three tool_calls
    // steps (find_by_name, view_file, replace_file_content) now each publish
    // one activity line, on top of the four spoken turns.
    expect(texts).toHaveLength(7)
  })

  it('bounds the answer to the last `limit` messages', () => {
    expect(extractAntigravityFeed(transcript, 1)).toEqual([
      {
        role: 'assistant',
        text: 'Added a test for the parser and ran the suite; it passes.',
        timestamp: '2026-09-04T19:03:12Z'
      }
    ])
  })

  it('reads a window whose final line was still being written', () => {
    // A byte tail read against a file the CLI is appending to routinely ends
    // mid-line, and so does a window that starts mid-line.
    expect(extractAntigravityFeed(partialTail, 50)).toEqual([
      { role: 'user', text: 'Rename the helper.', timestamp: '2026-09-04T19:20:01Z' },
      {
        role: 'assistant',
        text: 'Renamed it and updated the one call site.',
        timestamp: '2026-09-04T19:20:04Z'
      }
    ])
  })

  it('answers an empty window with no messages', () => {
    expect(extractAntigravityFeed('', 50)).toEqual([])
    expect(extractAntigravityFeed('\n  \n', 50)).toEqual([])
  })
})

describe('antigravityUserRequestText', () => {
  /*
   * A USER_INPUT record's `content` is an envelope: the human's own words in a
   * <USER_REQUEST> block, followed by harness-written blocks that the person
   * never typed (the local time, a settings change). Showing the envelope would
   * put the CLI's own bookkeeping in the panel under the user's face.
   */
  it('takes the human words out of the envelope the CLI wraps them in', () => {
    expect(
      antigravityUserRequestText(
        '<USER_REQUEST>\nWhat does this project do?\n</USER_REQUEST>\n' +
          '<ADDITIONAL_METADATA>\nThe current local time is: 2026-09-04T21:01:13+02:00.\n</ADDITIONAL_METADATA>'
      )
    ).toBe('What does this project do?')
  })

  it('keeps content that carries no envelope, rather than answering nothing', () => {
    expect(antigravityUserRequestText('a bare prompt')).toBe('a bare prompt')
  })

  it('keeps an unclosed envelope whole, because the words inside it are unknown', () => {
    expect(antigravityUserRequestText('<USER_REQUEST>\nhalf a prompt')).toBe(
      '<USER_REQUEST>\nhalf a prompt'
    )
  })
})

describe('parseAntigravityTranscriptTail', () => {
  it('names the newest step read, and what the planner last said', () => {
    expect(parseAntigravityTranscriptTail(transcript)).toEqual({
      latestStep: {
        stepIndex: 12,
        running: false,
        createdAtMs: Date.parse('2026-09-04T19:03:12Z')
      },
      lastMessage: 'Added a test for the parser and ran the suite; it passes.'
    })
  })

  /*
   * The ONE positive busy signal this store carries. `status` is written once,
   * when the step is appended, and never rewritten — verified on 1.1.26, where
   * a RUNNING step was followed by later DONE steps and kept its own RUNNING
   * word forever. So only the NEWEST step's status says anything about now,
   * and the provider still has to judge how old that word is.
   */
  it('reports a running newest step, which is the only evidence of an open turn', () => {
    expect(parseAntigravityTranscriptTail(busyTranscript).latestStep).toEqual({
      stepIndex: 2,
      running: true,
      createdAtMs: Date.parse('2026-09-04T19:14:31Z')
    })
  })

  it('never carries a running verdict forward past a later step', () => {
    // The append-only trap: a crashed turn leaves its RUNNING record in the
    // file, so reading "any RUNNING record" instead of "the newest one" would
    // mine forever on a session that finished minutes ago.
    const withLaterStep =
      busyTranscript +
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-09-04T19:15:40Z',
        content: 'The suite passed.'
      }) +
      '\n'
    expect(parseAntigravityTranscriptTail(withLaterStep).latestStep?.running).toBe(false)
  })

  it('says nothing at all about a window with no readable step in it', () => {
    expect(parseAntigravityTranscriptTail('')).toEqual({})
    expect(parseAntigravityTranscriptTail('{"step_index":')).toEqual({})
  })

  it('leaves the clock out when the record has no readable one', () => {
    const undated = JSON.stringify({
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: 'not a date',
      content: 'said something'
    })
    // Absent beats guessed, everywhere: an unparseable timestamp is not "now",
    // and a scan that read it as now would grant liveness on a broken clock.
    expect(parseAntigravityTranscriptTail(undated)).toEqual({
      latestStep: { stepIndex: 4, running: false },
      lastMessage: 'said something'
    })
  })
})
