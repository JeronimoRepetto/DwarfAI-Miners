import { describe, expect, it } from 'vitest'
import type { DwarfAttachment } from '../domain/types'
// Moved to shared for #424 — the renderer's echo reconciliation needs the
// exact same literal (see shared/heldSessionText.ts).
import { ATTACHED_FILE_PREFIX } from '../../shared/heldSessionText'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  consoleChunksFor,
  heldContentFor,
  type AttachmentReader
} from './attachmentDelivery'

/*
 * Issue #408. Both halves of this file are the measurement of 2026-09-16 turned
 * into code (`docs/console-hosting.md` §6), so the tests name what was measured
 * rather than what looks tidy: a path inside bracketed-paste markers attaches
 * an IMAGE and arrives as TEXT for anything else, and the Enter must be a chunk
 * of its own behind them.
 */
const image = (name = 'red.png'): DwarfAttachment => ({
  path: `C:\\work\\${name}`,
  name,
  kind: 'image',
  bytes: 900
})
const file = (name = 'notes.txt'): DwarfAttachment => ({
  path: `C:\\work\\${name}`,
  name,
  kind: 'file',
  bytes: 120
})

const paste = (attachment: DwarfAttachment): string =>
  `${BRACKETED_PASTE_START}${attachment.path}${BRACKETED_PASTE_END}`

describe('consoleChunksFor', () => {
  it('wraps the path in the paste markers that make a CLI attach it', () => {
    const shot = image()
    expect(consoleChunksFor('', [shot], false)).toEqual([paste(shot)])
  })

  it('gives Enter a chunk of its own, which is what submits rather than pastes', () => {
    // #404's rule, and #408 measured that a paste needs it even harder: with no
    // pause at all the composer kept the image and never submitted.
    const shot = image()
    expect(consoleChunksFor('', [shot], true)).toEqual([paste(shot), '\r'])
  })

  it('sends every attachment as its own paste, in the order the composer held them', () => {
    // Measured: two pastes then Enter arrived as two image blocks, in order.
    const a = image('red.png')
    const b = image('green.png')
    expect(consoleChunksFor('', [a, b], false)).toEqual([paste(a), paste(b)])
  })

  it('puts the words after the files, the order the measurement used', () => {
    const shot = image()
    expect(consoleChunksFor('look at this', [shot], true)).toEqual([
      paste(shot),
      'look at this',
      '\r'
    ])
  })

  it('pastes a non-image path too, because that is how the session is told about it', () => {
    // It arrives as text rather than as bytes, which is what `kind` already
    // says; the route is the same one.
    const notes = file()
    expect(consoleChunksFor('', [notes], false)).toEqual([paste(notes)])
  })

  it('never emits an empty chunk, which the sequence builder refuses outright', () => {
    expect(consoleChunksFor('', [], true)).toEqual(['\r'])
    expect(consoleChunksFor('   ', [image()], false)).toEqual([paste(image())])
  })

  it('flattens the words exactly as a text-only message is flattened', () => {
    // A console has no way to take a literal newline without submitting the
    // line, so a pasted paragraph would send its first line and type the rest.
    const chunks = consoleChunksFor('two\nlines', [], false)
    expect(chunks).toEqual(['two lines'])
  })

  /*
   * Issue #425: a single `WriteConsoleInput` call carrying a long message
   * loses its own beginning, so the words are bounded here — where the chunk
   * list is built — the same way a text-only message is, before Enter and
   * after every attachment's own paste chunk.
   */
  it('splits long words into bounded chunks, after the pastes and before Enter', () => {
    const shot = image()
    const words = 'a'.repeat(1_500)
    const chunks = consoleChunksFor(words, [shot], true) as string[]
    expect(chunks[0]).toBe(paste(shot))
    const enter = chunks.at(-1)
    const wordChunks = chunks.slice(1, -1)
    expect(enter).toBe('\r')
    expect(wordChunks.length).toBeGreaterThan(1)
    for (const chunk of wordChunks) expect(chunk.length).toBeLessThanOrEqual(500)
    expect(wordChunks.join('')).toBe(words)
  })

  it('refuses rather than splits a pasted path that exceeds the bound', () => {
    // A path chunk carries the bracketed-paste markers as well as the path,
    // and paths are short by nature — splitting one would hand the receiving
    // CLI half a path inside paste markers, which attaches nothing. #425 asks
    // for a refusal here instead of a guess at where a path could safely break.
    const longPath: DwarfAttachment = {
      path: 'C:\\work\\' + 'x'.repeat(600) + '.png',
      name: 'x'.repeat(600) + '.png',
      kind: 'image',
      bytes: 900
    }
    expect(consoleChunksFor('', [longPath], true)).toBeNull()
  })
})

const reader = (bytes: Record<string, { base64: string; mediaType: string }>): AttachmentReader => {
  return async (path) => bytes[path] ?? null
}

describe('heldContentFor', () => {
  it('leaves a text-only message a plain string, so nothing before #408 changes shape', async () => {
    expect(await heldContentFor('dig here', [], reader({}))).toBe('dig here')
  })

  it('carries an image as a content block with its own bytes', async () => {
    const shot = image()
    const content = await heldContentFor(
      'look',
      [shot],
      reader({ [shot.path]: { base64: 'QUJD', mediaType: 'image/png' } })
    )
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      { type: 'text', text: 'look' }
    ])
  })

  it('names a non-image by its path instead of pretending to carry it', async () => {
    // The same promise the console route makes, so a person sees one behaviour:
    // the session is told where the file is and opens it with its own tools.
    const notes = file()
    const content = await heldContentFor('read this', [notes], reader({}))
    expect(content).toEqual([
      { type: 'text', text: `${ATTACHED_FILE_PREFIX}${notes.path}\nread this` }
    ])
  })

  it('keeps the images in order, and the words after them', async () => {
    const a = image('red.png')
    const b = image('green.png')
    const content = await heldContentFor(
      'both',
      [a, b],
      reader({
        [a.path]: { base64: 'AA', mediaType: 'image/png' },
        [b.path]: { base64: 'BB', mediaType: 'image/png' }
      })
    )
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BB' } },
      { type: 'text', text: 'both' }
    ])
  })

  it('carries an image with no words at all, which is a whole message', async () => {
    const shot = image()
    const content = await heldContentFor(
      '',
      [shot],
      reader({ [shot.path]: { base64: 'QUJD', mediaType: 'image/png' } })
    )
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }
    ])
  })

  it('fails whole when ONE image cannot be read, never sending the rest', async () => {
    // Half a message delivered with a ✓ beside it is the dishonesty the issue
    // names; the caller reports the failure and the words stay unsent too.
    const a = image('red.png')
    const b = image('gone.png')
    const content = await heldContentFor(
      'both',
      [a, b],
      reader({ [a.path]: { base64: 'AA', mediaType: 'image/png' } })
    )
    expect(content).toBeNull()
  })
})
