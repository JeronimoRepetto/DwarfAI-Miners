import { describe, expect, it } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import type { FsLike } from '../adapters/fsLike'
import { extractClaudeFeed } from './claude/parse'
import { FIRST_PROMPT_HEAD_BYTES, firstUserMessageIn, readFirstPrompt } from './firstPrompt'

const PATH = 'C:\\store\\session.jsonl'

function userLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: '2026-09-04T10:00:00Z',
    message: { role: 'user', content: text }
  })
}

function assistantLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-04T10:00:01Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })
}

/** Records what each read asked for, which is the bound this module promises. */
function recordingFs(fs: FsLike): { fs: FsLike; asked: number[] } {
  const asked: number[] = []
  return {
    asked,
    fs: {
      ...fs,
      readTextHead: (path, maxBytes) => {
        asked.push(maxBytes)
        return fs.readTextHead(path, maxBytes)
      }
    } as FsLike
  }
}

const claudeFirst = firstUserMessageIn(extractClaudeFeed)

describe('reading the first thing a person said in a session', () => {
  /*
   * The whole reason this reads the HEAD. Every other transcript read in this
   * app takes a tail, because what the panel draws is the latest words; the
   * launch receipt needs the OPENING one, and in a session of any length the
   * two are nowhere near each other.
   */
  it('answers the opening prompt, not the latest one', async () => {
    const fake = new FakeFs()
    fake.addFile(
      PATH,
      [userLine('dig the east gallery'), assistantLine('digging'), userLine('now shore it')].join(
        '\n'
      )
    )

    await expect(readFirstPrompt(fake, PATH, claudeFirst)).resolves.toBe('dig the east gallery')
  })

  /*
   * Absent is not "no match": a session whose store exists before its first
   * turn is recorded has said nothing yet, and the caller is entitled to ask
   * again rather than to conclude this dwarf is somebody else's.
   */
  it('answers nothing for a session that has not recorded a human turn yet', async () => {
    const fake = new FakeFs()
    fake.addFile(PATH, assistantLine('thinking'))

    await expect(readFirstPrompt(fake, PATH, claudeFirst)).resolves.toBeUndefined()
  })

  /*
   * These reads are scheduled off the poll against a board that is already a
   * moment old, so the file really can be gone by the time one runs. A throw
   * here would surface as an unhandled rejection with no caller to catch it.
   */
  it('answers nothing rather than throwing when the transcript has gone', async () => {
    await expect(readFirstPrompt(new FakeFs(), PATH, claudeFirst)).resolves.toBeUndefined()
  })

  it('asks for a bounded head and never for the whole file', async () => {
    const fake = new FakeFs()
    fake.addFile(PATH, userLine('dig'))
    const recording = recordingFs(fake)

    await readFirstPrompt(recording.fs, PATH, claudeFirst)

    expect(recording.asked).toEqual([FIRST_PROMPT_HEAD_BYTES])
  })

  /*
   * A head read slices at a byte offset, so its LAST line is routinely half a
   * record. The opening prompt is ahead of that cut, and the fragment must not
   * take the read down with it.
   */
  it('reads past a record the head window cut in half', async () => {
    const fake = new FakeFs()
    const whole = [userLine('dig the east gallery'), assistantLine('x'.repeat(200))].join('\n')
    const recording = recordingFs(fake)
    fake.addFile(PATH, whole)

    await expect(readFirstPrompt(recording.fs, PATH, claudeFirst, 120)).resolves.toBe(
      'dig the east gallery'
    )
  })

  /*
   * The extractors bound by the LAST `limit` messages, which is the opposite
   * end from the one being looked for — so the search has to see every message
   * the window held. The bound is the window's bytes, not a message count.
   */
  it('finds the opening prompt behind more messages than any feed would show', async () => {
    const fake = new FakeFs()
    const lines = [userLine('dig the east gallery')]
    for (let index = 0; index < 200; index++) lines.push(assistantLine(`step ${index}`))
    fake.addFile(PATH, lines.join('\n'))

    await expect(readFirstPrompt(fake, PATH, claudeFirst)).resolves.toBe('dig the east gallery')
  })
})
