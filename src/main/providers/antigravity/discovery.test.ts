import { readFileSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  antigravityConversationIdsFromLocks,
  antigravityHistoryPath,
  antigravityPresenceDir,
  antigravityTranscriptPath,
  parseAntigravityHistory
} from './discovery'

/*
 * Issue #237. Discovering an Antigravity conversation takes two files that
 * were never written for this app: a presence lock, which is the CLI saying a
 * conversation is running, and history.jsonl, which is the only place the
 * workspace behind a conversation id is recorded. Both are read defensively —
 * see the validated scope on why a lock is a HINT and not a contract.
 */

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'antigravity')
const history = readFileSync(join(FIXTURES, 'history.jsonl'), 'utf8')

const FIRST = '11111111-1111-4111-8111-111111111111'
const SECOND = '22222222-2222-4222-8222-222222222222'
const THIRD = '33333333-3333-4333-8333-333333333333'

describe('parseAntigravityHistory', () => {
  it('maps a conversation id to the workspace it was last used in', () => {
    const map = parseAntigravityHistory(history)
    expect(map.get(FIRST)).toEqual({
      workspace: 'C:\\Users\\j\\Desktop\\Sample-Project',
      timestampMs: 1788548761588
    })
  })

  /*
   * A conversation can be resumed somewhere else, and the file keeps both
   * records. The newest timestamp wins — reading the FIRST record would pin a
   * dwarf to a folder its session left, which is a phantom mine.
   */
  it('lets the newest record win when one conversation has several', () => {
    expect(parseAntigravityHistory(history).get(SECOND)).toEqual({
      workspace: 'C:\\Users\\j\\Desktop\\Sample-Project',
      timestampMs: 1788548999000
    })
  })

  it('keeps the newest record even when the older one is written after it', () => {
    // history.jsonl is append-ordered by the CLI, not by us, so the ordering
    // is the timestamp's job and never the line's position.
    const outOfOrder = [
      JSON.stringify({ display: 'b', timestamp: 200, workspace: '/w/new', conversationId: FIRST }),
      JSON.stringify({ display: 'a', timestamp: 100, workspace: '/w/old', conversationId: FIRST })
    ].join('\n')
    expect(parseAntigravityHistory(outOfOrder).get(FIRST)).toEqual({
      workspace: '/w/new',
      timestampMs: 200
    })
  })

  it('skips a record that names no conversation, which a slash command does', () => {
    // The first real record on the captured machine was a `/model` command
    // typed before any conversation existed. It carries a workspace and no id,
    // so there is nothing it could be attributed to.
    const map = parseAntigravityHistory(history)
    expect([...map.keys()].sort()).toEqual([FIRST, SECOND])
  })

  it('skips a record that names no workspace, rather than inventing one', () => {
    expect(parseAntigravityHistory(history).has(THIRD)).toBe(false)
  })

  it('reads a window whose final line was still being written', () => {
    // The fixture ends mid-record on purpose: this file is appended to while
    // the app reads it, and a bounded tail read also opens mid-line.
    expect(parseAntigravityHistory(history).size).toBe(2)
  })

  it('answers an empty file with an empty map', () => {
    expect(parseAntigravityHistory('').size).toBe(0)
  })

  it('skips a record whose timestamp is not a number', () => {
    const bad = JSON.stringify({ timestamp: 'yesterday', workspace: '/w', conversationId: FIRST })
    expect(parseAntigravityHistory(bad).size).toBe(0)
  })
})

describe('antigravityConversationIdsFromLocks', () => {
  it('names one conversation per lock file, without its suffix', () => {
    expect(
      antigravityConversationIdsFromLocks([
        { name: `${SECOND}.lock`, isDirectory: false },
        { name: `${FIRST}.lock`, isDirectory: false }
      ])
    ).toEqual([FIRST, SECOND])
  })

  it('ignores a directory and any file that is not a lock', () => {
    expect(
      antigravityConversationIdsFromLocks([
        { name: 'nested', isDirectory: true },
        { name: 'notes.txt', isDirectory: false },
        { name: '.lock', isDirectory: false },
        { name: `${FIRST}.lock`, isDirectory: false }
      ])
    ).toEqual([FIRST])
  })

  it('answers an empty presence directory with no conversations', () => {
    // listDir resolves to [] for a directory that does not exist, which is
    // what a machine with the CLI installed but never run looks like.
    expect(antigravityConversationIdsFromLocks([])).toEqual([])
  })
})

describe('store paths', () => {
  /*
   * Built with node:path so the same expectations hold on any host — the
   * platform-ports rule. The store layout itself is fixed by the CLI: the
   * transcript sits four directories under the conversation's brain folder.
   */
  it('places the transcript under the conversation brain folder', () => {
    expect(antigravityTranscriptPath('/home/j/.gemini/antigravity-cli', FIRST)).toBe(
      join(
        '/home/j/.gemini/antigravity-cli',
        'brain',
        FIRST,
        '.system_generated',
        'logs',
        'transcript.jsonl'
      )
    )
  })

  it('reads the same layout from a Windows root as from a POSIX one', () => {
    const fromWindows = antigravityTranscriptPath('C:\\Users\\j\\.gemini\\antigravity-cli', FIRST)
    const fromPosix = antigravityTranscriptPath('/home/j/.gemini/antigravity-cli', FIRST)
    const tail = ['brain', FIRST, '.system_generated', 'logs', 'transcript.jsonl']
    expect(
      fromWindows.endsWith(win32.join(...tail)) || fromWindows.endsWith(posix.join(...tail))
    ).toBe(true)
    expect(fromPosix.endsWith(win32.join(...tail)) || fromPosix.endsWith(posix.join(...tail))).toBe(
      true
    )
  })

  it('names the presence directory and the history file off the same root', () => {
    expect(antigravityPresenceDir('/root')).toBe(join('/root', 'presence'))
    expect(antigravityHistoryPath('/root')).toBe(join('/root', 'history.jsonl'))
  })
})
