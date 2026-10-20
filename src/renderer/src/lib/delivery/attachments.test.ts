import { describe, expect, it } from 'vitest'
import {
  MAX_DWARF_ATTACHMENTS,
  MAX_DWARF_ATTACHMENT_BYTES,
  MAX_DWARF_ATTACHMENTS_TOTAL_BYTES,
  type DwarfAttachment,
  type DwarfAttachmentPick
} from '../../types'
import {
  ATTACH_HINT,
  NO_ATTACH_AT_ALL_HINT,
  acceptAttachments,
  attachHint,
  refusalSentence
} from './attachments'

/*
 * Issue #408. The design's rule for the composer's alert ink: the sentence NAMES
 * the limit that refused a file, never a bare "no". The arithmetic itself is the
 * wire's (`refuseAttachment`) and is not repeated here — what this file owns is
 * which sentence the person reads, and which files survived the drop.
 */
const pick = (name = 'red.png', over: Partial<DwarfAttachment> = {}): DwarfAttachmentPick => {
  const attachment: DwarfAttachment = {
    path: `C:\\work\\${name}`,
    name,
    kind: 'image',
    bytes: 1024,
    ...over
  }
  return { path: attachment.path, attachment }
}

describe('refusalSentence', () => {
  it('names the count limit with its number, not a bare refusal', () => {
    const sentence = refusalSentence('too-many', 'red.png')
    expect(sentence).toContain(String(MAX_DWARF_ATTACHMENTS))
  })

  it('names the file and the per-file limit in megabytes', () => {
    const sentence = refusalSentence('file-too-large', 'huge.png')
    expect(sentence).toContain('huge.png')
    expect(sentence).toContain(String(MAX_DWARF_ATTACHMENT_BYTES / (1024 * 1024)))
  })

  it('names the total limit, which is a different number from the per-file one', () => {
    const sentence = refusalSentence('total-too-large', 'huge.png')
    expect(sentence).toContain(String(MAX_DWARF_ATTACHMENTS_TOTAL_BYTES / (1024 * 1024)))
    expect(sentence).not.toBe(refusalSentence('file-too-large', 'huge.png'))
  })

  /*
   * Issue #417: both byte limits bind on an image alone now — a plain file's
   * size costs nothing, so these two sentences only ever fire for one, and
   * must say so rather than naming "a file" the way a size limit no longer
   * applies to.
   */
  it.each(['file-too-large', 'total-too-large'] as const)(
    'says "image", not a bare "file", in the %s sentence',
    (refusal) => {
      expect(refusalSentence(refusal, 'huge.png')).toContain('image')
    }
  )

  it.each([
    ['directory', 'src'],
    ['unreadable', 'gone.png'],
    ['already-attached', 'red.png']
  ] as const)('names the file in the %s sentence', (refusal, name) => {
    expect(refusalSentence(refusal, name)).toContain(name)
  })

  it('gives every refusal its own sentence, so none of them reads as another', () => {
    const all = (
      [
        'directory',
        'unreadable',
        'already-attached',
        'too-many',
        'file-too-large',
        'total-too-large'
      ] as const
    ).map((refusal) => refusalSentence(refusal, 'x.png'))
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('acceptAttachments', () => {
  it('keeps what fits and says nothing when everything did', () => {
    const result = acceptAttachments([], [pick('a.png'), pick('b.png')])
    expect(result.attachments.map((item) => item.name)).toEqual(['a.png', 'b.png'])
    expect(result.refusal).toBeNull()
  })

  it('adds to what is already pending rather than replacing it', () => {
    const already = pick('a.png').attachment as DwarfAttachment
    const result = acceptAttachments([already], [pick('b.png')])
    expect(result.attachments).toHaveLength(2)
    expect(result.attachments[0]).toBe(already)
  })

  it("carries main's own refusal through, so a folder is named as a folder", () => {
    const result = acceptAttachments([], [{ path: 'C:\\work\\src', refusal: 'directory' }])
    expect(result.attachments).toEqual([])
    expect(result.refusal).toBe(refusalSentence('directory', 'src'))
  })

  it('keeps the files that fit and reports only the first refusal', () => {
    // A drop of five onto a nearly full composer must not produce five
    // sentences; the person needs the reason it stopped, once.
    const already = Array.from({ length: MAX_DWARF_ATTACHMENTS - 1 }, (_unused, index) => ({
      path: `C:\\work\\p${index}.png`,
      name: `p${index}.png`,
      kind: 'image' as const,
      bytes: 10
    }))
    const result = acceptAttachments(already, [pick('a.png'), pick('b.png')])
    expect(result.attachments).toHaveLength(MAX_DWARF_ATTACHMENTS)
    expect(result.refusal).toBe(refusalSentence('too-many', 'b.png'))
  })

  it('refuses a file the composer already holds, by path and not by name', () => {
    const already = pick().attachment as DwarfAttachment
    const result = acceptAttachments([already], [pick()])
    expect(result.attachments).toEqual([already])
    expect(result.refusal).toBe(refusalSentence('already-attached', 'red.png'))
  })

  it('names a pick with neither an attachment nor a reason as unreadable', () => {
    // Defensive: main answers one or the other, and a payload that answers
    // neither must still become a sentence rather than a silently dropped file.
    const result = acceptAttachments([], [{ path: 'C:\\work\\odd.png' }])
    expect(result.attachments).toEqual([])
    expect(result.refusal).toBe(refusalSentence('unreadable', 'odd.png'))
  })
})

describe('attachHint', () => {
  /*
   * AMENDED for #1463 (was: three cases reading `capabilities.attach` and `capabilities.sendText`):
   * the Host board carries no capability record, and US-MSG-002.AC04 makes a file follow text, so
   * the hint reads the one fact the composer reads — whether the session can receive a message.
   */
  it('[US-MSG-002.AC01] says what the control does where a message, and so a file, can travel', () => {
    const hint = attachHint(true)
    expect(hint).toBe(ATTACH_HINT)
    expect(hint.toLowerCase()).not.toContain("can't")
  })

  it('[US-MSG-002.AC04] says a session that cannot be written to takes no files, naming no way out', () => {
    expect(attachHint(false)).toBe(NO_ATTACH_AT_ALL_HINT)
  })
})
