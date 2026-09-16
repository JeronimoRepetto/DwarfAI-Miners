import { describe, expect, it } from 'vitest'
import { HELD_IMAGE_PLACEHOLDER } from '../../../../shared/heldSessionText'
import {
  HELD_MESSAGE_MAX_CHARS,
  RELAY_PROVENANCE_LINE,
  heldRetainedText,
  type DwarfAttachment,
  type FeedMessage
} from '../../types'
import { groupActivity } from './activityGroup'
import type { PanelMessage } from './conversation'
import {
  ECHO_LIMIT,
  ECHO_MATCH_WINDOW_MS,
  boundEchoes,
  echoRowsOf,
  mergeEchoes,
  reconcileEchoes,
  type MessageEcho
} from './echo'

const SENT_AT = Date.parse('2026-09-09T10:00:00.000Z')

function echo(overrides: Partial<MessageEcho> = {}): MessageEcho {
  return {
    id: 'e1',
    text: 'dig deeper',
    sentAt: SENT_AT,
    state: { phase: 'sending' },
    ...overrides
  }
}

function spoken(key: string, text = 'Found the seam.'): PanelMessage {
  return { from: 'agent', text, key }
}

function tool(key: string, text = 'Ran pnpm test'): PanelMessage {
  return { from: 'agent', text, key, activity: { kind: 'run', target: text } }
}

/** A transcript row for the person's own turn, stamped after the send by default. */
function turn(overrides: Partial<FeedMessage> = {}): FeedMessage {
  return {
    role: 'user',
    text: 'dig deeper',
    timestamp: new Date(SENT_AT + 2_000).toISOString(),
    ...overrides
  }
}

describe('echoRowsOf', () => {
  it("draws an echo as the person's own bubble, carrying its own verdict", () => {
    const one = echo({ state: { phase: 'delivered', via: 'claude-relay', awaitingReaction: true } })
    expect(echoRowsOf([one])).toEqual([
      { from: 'user', text: 'dig deeper', key: 'echo-e1', echo: one }
    ])
  })

  it('keys each echo by its own client-minted id, so two of the same words stay apart', () => {
    const rows = echoRowsOf([echo({ id: 'e1' }), echo({ id: 'e2' })])
    expect(rows.map((row) => row.key)).toEqual(['echo-e1', 'echo-e2'])
  })

  it('never marks an echo as activity, so nothing can fold it into a run', () => {
    // #294 groups consecutive tool calls; a message the person SAID is a
    // bubble whatever precedes it.
    expect(echoRowsOf([echo()])[0]!.activity).toBeUndefined()
  })

  it('keeps the order the messages were sent in', () => {
    const rows = echoRowsOf([echo({ id: 'a', text: 'one' }), echo({ id: 'b', text: 'two' })])
    expect(rows.map((row) => row.text)).toEqual(['one', 'two'])
  })
})

describe('mergeEchoes', () => {
  it('puts the echoes after everything the transcript produced', () => {
    const entries = groupActivity([spoken('a', 'dig here'), spoken('b', 'On my way.')], {
      ended: false
    })
    const merged = mergeEchoes(entries, echoRowsOf([echo()]))
    expect(merged.map((entry) => entry.kind)).toEqual(['message', 'message', 'message'])
    expect(merged.at(-1)).toEqual({
      kind: 'message',
      key: 'echo-e1',
      message: echoRowsOf([echo()])[0]
    })
  })

  it('leaves the transcript entries untouched when nothing is pending', () => {
    const entries = groupActivity([spoken('a')], { ended: false })
    expect(mergeEchoes(entries, [])).toEqual(entries)
  })

  it('leaves a growing run growing, because an echo is not the agent working', () => {
    // The run is still the last thing the AGENT did, and #294 labels an open
    // run "Working...". Appending the person's own words after the grouping
    // rather than before it is what keeps that true.
    const entries = groupActivity([tool('a')], { ended: false })
    const merged = mergeEchoes(entries, echoRowsOf([echo()]))
    const run = merged[0]!
    expect(run.kind === 'activity' && run.closed).toBe(false)
  })

  it('hands the very same row objects back, so the panel draws what it was given', () => {
    const rows = echoRowsOf([echo()])
    const merged = mergeEchoes([], rows)
    expect(merged[0]!.kind === 'message' && merged[0]!.message).toBe(rows[0])
  })
})

/**
 * The matching rule, spelled out (#309).
 *
 * An echo exists because the transcript does not have the person's words yet.
 * The moment it does, the echo has to go — and deciding that a transcript row
 * IS this send is a claim, so it is made on evidence and nothing else: the same
 * words, a `user` turn no agent issued, and a stamp that falls between the send
 * and the end of the reaction window. Anything short of all four leaves the
 * echo where it is, which is the same "when in doubt, stay" the delivery
 * verdict itself holds to.
 */
describe('reconcileEchoes', () => {
  it('drops an echo the transcript now carries', () => {
    expect(reconcileEchoes([echo()], [turn()])).toEqual([])
  })

  it('compares the words trimmed, since a transcript may keep whitespace the composer sent', () => {
    expect(
      reconcileEchoes([echo({ text: 'dig deeper' })], [turn({ text: ' dig deeper\n' })])
    ).toEqual([])
  })

  it('keeps an echo whose words are not in the transcript at all', () => {
    const kept = echo()
    expect(reconcileEchoes([kept], [turn({ text: 'something else' })])).toEqual([kept])
  })

  it('never reads the agent’s own reply as the person’s turn', () => {
    const kept = echo()
    expect(reconcileEchoes([kept], [turn({ role: 'assistant' })])).toEqual([kept])
  })

  it('never reads an AGENT-issued user turn as the person’s (#175)', () => {
    // A coordinator's instruction to its worker is written down as a `user`
    // turn and was never the human's — the same distinction panelMessagesOf
    // draws when it picks a portrait.
    const kept = echo()
    const issued = turn({ issuer: { role: 'foreman', name: 'coordinator' } })
    expect(reconcileEchoes([kept], [issued])).toEqual([kept])
  })

  it('lets one transcript row account for exactly one echo, oldest first', () => {
    // The same words sent twice. One row in the transcript is evidence of ONE
    // of them, and the other is still waiting to appear.
    const first = echo({ id: 'e1', sentAt: SENT_AT })
    const second = echo({ id: 'e2', sentAt: SENT_AT + 1_000 })
    expect(reconcileEchoes([first, second], [turn()])).toEqual([second])
  })

  it('drops both once the transcript carries both', () => {
    const first = echo({ id: 'e1', sentAt: SENT_AT })
    const second = echo({ id: 'e2', sentAt: SENT_AT + 1_000 })
    const rows = [turn(), turn({ timestamp: new Date(SENT_AT + 3_000).toISOString() })]
    expect(reconcileEchoes([first, second], rows)).toEqual([])
  })

  it('never reads a row written BEFORE the send as that send', () => {
    // The transcript already said these words once; saying them again is why
    // there is an echo at all.
    const kept = echo()
    const older = turn({ timestamp: new Date(SENT_AT - 1).toISOString() })
    expect(reconcileEchoes([kept], [older])).toEqual([kept])
  })

  it('never reads a row written long after the window closed as that send', () => {
    const kept = echo()
    const later = turn({
      timestamp: new Date(SENT_AT + ECHO_MATCH_WINDOW_MS + 1).toISOString()
    })
    expect(reconcileEchoes([kept], [later])).toEqual([kept])
  })

  it('keeps an echo when the row cannot be dated at all', () => {
    // The `lastMessage` stand-in carries an empty timestamp, and a row that
    // cannot be dated cannot be dated to THIS send.
    const kept = echo()
    expect(reconcileEchoes([kept], [turn({ timestamp: '' })])).toEqual([kept])
    expect(reconcileEchoes([kept], [turn({ timestamp: 'whenever' })])).toEqual([kept])
  })

  it('leaves everything alone for an empty transcript', () => {
    const kept = echo()
    expect(reconcileEchoes([kept], [])).toEqual([kept])
  })

  /*
   * #378. A message the relay carries now leads with RELAY_PROVENANCE_LINE,
   * because Claude Code frames a cross-session message as another session's
   * rather than the user's. The transcript reader takes the line off, and this
   * is the second place it has to come off: match on the words the composer
   * sent, or a relayed message is drawn twice — once as an echo nothing ever
   * accounts for, once as the transcript row — and its ✓ never reaches ✓✓.
   */
  it('accounts for an echo whose transcript row still carries the provenance line (#378)', () => {
    const sent = echo({ text: 'hello' })
    const row = turn({ text: `${RELAY_PROVENANCE_LINE}\nhello` })
    expect(reconcileEchoes([sent], [row])).toEqual([])
  })

  it("keeps the worker tag in the comparison, since it is not the author's line (#378)", () => {
    // `[for agent …]` names the RECIPIENT and the composer never typed it, so a
    // row carrying it is not this echo's words — only the provenance line ours
    // prepends comes off.
    const kept = echo({ text: 'hello' })
    const row = turn({ text: `${RELAY_PROVENANCE_LINE}\n[for agent Explorer] hello` })
    expect(reconcileEchoes([kept], [row])).toEqual([kept])
  })

  /*
   * #419. `toConsoleLine` flattens whitespace runs to a single space before the
   * pid write, and a console write of files pastes one token per attachment —
   * `[Image #<digits>]` for an image, the exact path for a file — with no
   * separator (measured in docs/console-hosting.md §6, #408). An echo's own
   * comparison has to read both, or the transcript row for exactly the
   * message somebody sent never accounts for it.
   *
   * Reopened after #420: that fix stripped tokens in send order, ahead of the
   * words, which held for the first live measurement only because it happened
   * not to test timing. Claude Code inserts an image's `[Image #N]` placeholder
   * once its own read of the file finishes, while a plain path or the words
   * paste in immediately — so the placeholder's position tracks how long the
   * read took, never send order, and a second measurement caught it landing
   * third among four tokens. The rule below is now "each expected token once,
   * anywhere," not "in the order they were attached."
   */
  describe('with attachments (#419)', () => {
    function attachment(overrides: Partial<DwarfAttachment> = {}): DwarfAttachment {
      return {
        path: 'C:\\mine\\seam.png',
        name: 'seam.png',
        kind: 'image',
        bytes: 10,
        ...overrides
      }
    }

    it('accounts for an echo sent with five attachments — two images and three files, tokens in send order', () => {
      // The exact shape #419 was originally filed over: two images and three
      // plain files, read back from a real transcript (docs/console-hosting.md
      // §6). Tokens happening to read back in send order is one instance of
      // the general "each token once, anywhere" rule below, not a stricter
      // requirement of it — see the reordered cases beneath this one.
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\a.jpg', name: 'a.jpg', kind: 'image' }),
        attachment({ path: 'C:\\mine\\debris.mp3', name: 'debris.mp3', kind: 'file' }),
        attachment({ path: 'C:\\mine\\b.gif', name: 'b.gif', kind: 'image' }),
        attachment({ path: 'C:\\mine\\notes.pdf', name: 'notes.pdf', kind: 'file' }),
        attachment({ path: 'C:\\mine\\config.txt', name: 'config.txt', kind: 'file' })
      ]
      const sent = echo({ text: 'dig deeper' })
      const row = turn({
        text: '[Image #2]C:\\mine\\debris.mp3[Image #3]C:\\mine\\notes.pdfC:\\mine\\config.txtdig deeper'
      })
      expect(reconcileEchoes([sent], [row], { [sent.id]: attachments })).toEqual([])
    })

    it('accounts for an attachments-only echo against a row that is exactly those tokens', () => {
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\a.jpg', kind: 'image' })
      ]
      const sent = echo({ text: '' })
      const row = turn({ text: '[Image #9]' })
      expect(reconcileEchoes([sent], [row], { [sent.id]: attachments })).toEqual([])
    })

    it('accounts for a two-line echo against the one-line row the console flattens it to', () => {
      const sent = echo({ text: 'dig deeper\nfound something' })
      const row = turn({ text: 'dig deeper found something' })
      expect(reconcileEchoes([sent], [row])).toEqual([])
    })

    it('still refuses a row outside the window even once its attachment tokens strip clean', () => {
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\a.jpg', kind: 'image' })
      ]
      const kept = echo({ text: 'dig deeper' })
      const later = turn({
        text: '[Image #4]dig deeper',
        timestamp: new Date(SENT_AT + ECHO_MATCH_WINDOW_MS + 1).toISOString()
      })
      expect(reconcileEchoes([kept], [later], { [kept.id]: attachments })).toEqual([kept])
    })

    it('refuses a row whose attachment tokens match but whose words differ', () => {
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\notes.pdf', name: 'notes.pdf', kind: 'file' })
      ]
      const kept = echo({ text: 'dig deeper' })
      const row = turn({ text: 'C:\\mine\\notes.pdfsomething else' })
      expect(reconcileEchoes([kept], [row], { [kept.id]: attachments })).toEqual([kept])
    })

    it('refuses a row carrying only the words when the echo was sent with attachments', () => {
      // The row a plain send would produce — no attachment token at all — must
      // not account for an echo that was sent with files.
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\a.jpg', kind: 'image' })
      ]
      const kept = echo({ text: 'dig deeper' })
      const row = turn({ text: 'dig deeper' })
      expect(reconcileEchoes([kept], [row], { [kept.id]: attachments })).toEqual([kept])
    })

    /*
     * The reopening (2026-09-16, after #420): chips were added image, mp3,
     * pdf, txt, then words, but the transcript's own row read
     * `<mp3 path><pdf path>[Image #5]<txt path><words>` — the image's
     * placeholder landed third, not first, because its read finished after
     * the two files beside it had already pasted in.
     */
    it('accounts for an echo whose image placeholder landed third, out of paste order (#419 reopened)', () => {
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\shot.png', name: 'shot.png', kind: 'image' }),
        attachment({ path: 'C:\\mine\\debris.mp3', name: 'debris.mp3', kind: 'file' }),
        attachment({ path: 'C:\\mine\\notes.pdf', name: 'notes.pdf', kind: 'file' }),
        attachment({ path: 'C:\\mine\\config.txt', name: 'config.txt', kind: 'file' })
      ]
      const sent = echo({ text: 'dig deeper' })
      const row = turn({
        text: 'C:\\mine\\debris.mp3C:\\mine\\notes.pdf[Image #5]C:\\mine\\config.txtdig deeper'
      })
      expect(reconcileEchoes([sent], [row], { [sent.id]: attachments })).toEqual([])
    })

    it('accounts for an echo whose image placeholder landed after the words entirely, the read finishing latest', () => {
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\shot.png', kind: 'image' })
      ]
      const sent = echo({ text: 'dig deeper' })
      const row = turn({ text: 'dig deeper[Image #7]' })
      expect(reconcileEchoes([sent], [row], { [sent.id]: attachments })).toEqual([])
    })

    it('accounts for two images whose placeholders read back in the reverse of paste order', () => {
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\a.jpg', name: 'a.jpg', kind: 'image' }),
        attachment({ path: 'C:\\mine\\notes.pdf', name: 'notes.pdf', kind: 'file' }),
        attachment({ path: 'C:\\mine\\b.gif', name: 'b.gif', kind: 'image' })
      ]
      const sent = echo({ text: 'dig deeper' })
      // The digit is Claude Code's own counter, never this app's — neither
      // marker is tied to a particular image, only the shape is matched, so
      // finding "#9" before "#2" here proves nothing was assumed about which
      // slot either belongs to.
      const row = turn({ text: '[Image #9]C:\\mine\\notes.pdf[Image #2]dig deeper' })
      expect(reconcileEchoes([sent], [row], { [sent.id]: attachments })).toEqual([])
    })

    it('refuses a row missing one of its expected attachment tokens, even with the rest present anywhere', () => {
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\a.jpg', kind: 'image' }),
        attachment({ path: 'C:\\mine\\notes.pdf', name: 'notes.pdf', kind: 'file' })
      ]
      const kept = echo({ text: 'dig deeper' })
      // The file's token made it into the row; the image's placeholder never
      // arrived at all — a partial match still must not account for the echo.
      const row = turn({ text: 'C:\\mine\\notes.pdfdig deeper' })
      expect(reconcileEchoes([kept], [row], { [kept.id]: attachments })).toEqual([kept])
    })

    it('refuses a row carrying an extra image placeholder nothing sent, since the remainder is not the words', () => {
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\notes.pdf', name: 'notes.pdf', kind: 'file' })
      ]
      const kept = echo({ text: 'dig deeper' })
      const row = turn({ text: 'C:\\mine\\notes.pdf[Image #3]dig deeper' })
      expect(reconcileEchoes([kept], [row], { [kept.id]: attachments })).toEqual([kept])
    })

    it("accounts for an echo even when a FILE's own path contains something shaped like an image marker", () => {
      // Proves the ordering choice in `stripAttachmentTokens`: paths come off
      // before markers, so this path is removed as one exact unit first. If a
      // marker search ran over the row before it, the unanchored pattern would
      // match the `[Image #5]`-shaped piece sitting inside this path and cut
      // it in half, and the path's own exact-match strip below would then fail.
      const attachments: DwarfAttachment[] = [
        attachment({
          path: 'C:\\mine\\shot[Image #5].png',
          name: 'shot[Image #5].png',
          kind: 'file'
        }),
        attachment({ path: 'C:\\mine\\a.jpg', kind: 'image' })
      ]
      const sent = echo({ text: 'dig deeper' })
      const row = turn({ text: 'C:\\mine\\shot[Image #5].png[Image #9]dig deeper' })
      expect(reconcileEchoes([sent], [row], { [sent.id]: attachments })).toEqual([])
    })
  })

  /*
   * #424. A session launched from the panel is held over the Agent SDK, and
   * its own user turn looks nothing like the console's: `heldContentFor`
   * (attachmentDelivery.ts) sends an image as a content block with no text at
   * all, and names anything else on its own line — `Attached file: <path>` —
   * joined to the words with newlines (measured in heldSession.test.ts's
   * `heldMessageEntries` cases). The rule above was written for the console's
   * shape only, so a held row never carried a `[Image #N]` marker or a bare
   * path for it to find, and the echo was never accounted for.
   *
   * `via: 'held-session'` on the echo's own `state` (DwarfSendState) is what
   * selects this shape instead of the console's — the same field the sprite
   * marker already reads, so no new plumbing carries it here.
   */
  describe('held-session attachments (#424)', () => {
    function attachment(overrides: Partial<DwarfAttachment> = {}): DwarfAttachment {
      return {
        path: 'C:\\mine\\seam.png',
        name: 'seam.png',
        kind: 'image',
        bytes: 10,
        ...overrides
      }
    }

    function heldEcho(overrides: Partial<MessageEcho> = {}): MessageEcho {
      return echo({
        state: { phase: 'delivered', via: 'held-session', awaitingReaction: true },
        ...overrides
      })
    }

    it('accounts for a held echo whose row names its files with "Attached file:" lines, no marker at all', () => {
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\notes.pdf', name: 'notes.pdf', kind: 'file' }),
        attachment({ path: 'C:\\mine\\config.txt', name: 'config.txt', kind: 'file' })
      ]
      const sent = heldEcho({ text: 'dig deeper' })
      const row = turn({
        text: 'Attached file: C:\\mine\\notes.pdf\nAttached file: C:\\mine\\config.txt\ndig deeper'
      })
      expect(reconcileEchoes([sent], [row], { [sent.id]: attachments })).toEqual([])
    })

    /*
     * AMENDED (#424, second pass): this used to assert the opposite — that an
     * image's own token was ABSENT from the row, because `heldMessageEntries`
     * dropped the block entirely and published no row at all for a wordless
     * send. Now that it publishes `[Image]` (see heldSession.test.ts), the
     * row this echo has to match carries it, and this pins the accounting the
     * fix actually restores — an images-only echo's own row, which used to
     * not exist.
     */
    it('accounts for a held echo sent with only an image, against the row heldMessageEntries now publishes for it', () => {
      const attachments: DwarfAttachment[] = [attachment({ kind: 'image' })]
      const sent = heldEcho({ text: 'dig deeper' })
      const row = turn({ text: `${HELD_IMAGE_PLACEHOLDER}\ndig deeper` })
      expect(reconcileEchoes([sent], [row], { [sent.id]: attachments })).toEqual([])
    })

    it('accounts for a held echo sent with an image and a file together — the placeholder ahead of the file', () => {
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\shot.png', kind: 'image' }),
        attachment({ path: 'C:\\mine\\notes.pdf', name: 'notes.pdf', kind: 'file' })
      ]
      const sent = heldEcho({ text: 'dig deeper' })
      const row = turn({
        text: `${HELD_IMAGE_PLACEHOLDER}\nAttached file: C:\\mine\\notes.pdf\ndig deeper`
      })
      expect(reconcileEchoes([sent], [row], { [sent.id]: attachments })).toEqual([])
    })

    it('refuses a held row missing the image placeholder, even though every other token is present', () => {
      // The exact row the FIRST pass of #424 would have accepted (image
      // silently dropped) — now correctly refused, since the echo was sent
      // with an image and this row carries no token for it at all.
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\shot.png', kind: 'image' }),
        attachment({ path: 'C:\\mine\\notes.pdf', name: 'notes.pdf', kind: 'file' })
      ]
      const kept = heldEcho({ text: 'dig deeper' })
      const row = turn({ text: 'Attached file: C:\\mine\\notes.pdf\ndig deeper' })
      expect(reconcileEchoes([kept], [row], { [kept.id]: attachments })).toEqual([kept])
    })

    it('accounts for two images beside a file and words, one placeholder per image, none of them numbered', () => {
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\a.png', kind: 'image' }),
        attachment({ path: 'C:\\mine\\b.png', kind: 'image' }),
        attachment({ path: 'C:\\mine\\notes.pdf', name: 'notes.pdf', kind: 'file' })
      ]
      const sent = heldEcho({ text: 'dig deeper' })
      const row = turn({
        text: `${HELD_IMAGE_PLACEHOLDER}\n${HELD_IMAGE_PLACEHOLDER}\nAttached file: C:\\mine\\notes.pdf\ndig deeper`
      })
      expect(reconcileEchoes([sent], [row], { [sent.id]: attachments })).toEqual([])
    })

    it('accounts for a plain held echo with no attachments at all, same as any other channel', () => {
      const sent = heldEcho()
      expect(reconcileEchoes([sent], [turn()])).toEqual([])
    })

    it('refuses a console-shaped row for a held echo — the bare path carries no "Attached file:" line', () => {
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\notes.pdf', name: 'notes.pdf', kind: 'file' })
      ]
      const kept = heldEcho({ text: 'dig deeper' })
      // Exactly the console's own shape (#419): the bare path, no separator.
      const row = turn({ text: 'C:\\mine\\notes.pdfdig deeper' })
      expect(reconcileEchoes([kept], [row], { [kept.id]: attachments })).toEqual([kept])
    })

    it('refuses a held-shaped row for a console echo, even though the bare path still matches inside it', () => {
      // The literal path IS found inside "Attached file: <path>" — the prefix
      // is not part of the console's own token — so the lookup alone would
      // wrongly accept this row. What actually refuses it is the leftover
      // "Attached file: " text the strip leaves behind: the remainder no
      // longer equals the echo's own words once normalized, so the second
      // half of `accountsFor`'s check is what is doing the real work here.
      const attachments: DwarfAttachment[] = [
        attachment({ path: 'C:\\mine\\notes.pdf', name: 'notes.pdf', kind: 'file' })
      ]
      const kept = echo({
        text: 'dig deeper',
        state: { phase: 'delivered', via: 'terminal', awaitingReaction: true }
      })
      const row = turn({ text: 'Attached file: C:\\mine\\notes.pdf\ndig deeper' })
      expect(reconcileEchoes([kept], [row], { [kept.id]: attachments })).toEqual([kept])
    })
  })
})

describe('boundEchoes', () => {
  it('keeps a list already inside the cap exactly as it is', () => {
    const echoes = [echo({ id: 'a' }), echo({ id: 'b' })]
    expect(boundEchoes(echoes)).toEqual(echoes)
  })

  it('drops the oldest once the cap is passed, keeping the newest in order', () => {
    const echoes = Array.from({ length: ECHO_LIMIT + 3 }, (_unused, index) =>
      echo({ id: `e${index}`, sentAt: SENT_AT + index })
    )
    const bounded = boundEchoes(echoes)
    expect(bounded).toHaveLength(ECHO_LIMIT)
    expect(bounded[0]!.id).toBe('e3')
    expect(bounded.at(-1)!.id).toBe(`e${ECHO_LIMIT + 2}`)
  })
})

/* --- Long messages and truncated rows (#431) — one block, appended --------- */

/*
 * Issue #431 raised the message ceiling from a 4,000-character keystroke budget
 * to what a channel can really carry, which put two things in front of the
 * reconciliation that had never been there: a row far longer than any message
 * this panel used to allow, and — on a held session — a row the store CUT.
 *
 * The observed feed publishes a user turn whole: nothing in the Claude
 * transcript parse truncates one, and `trimFeed` bounds how MANY rows a feed
 * carries, never how long one is. The held store is the one that cuts, at
 * HELD_MESSAGE_MAX_CHARS and with no marker (`retainHeldMessage`), because that
 * conversation rides every poll's snapshot.
 */
describe('reconcileEchoes: a message longer than the old cap (#431)', () => {
  const LONG = 'dig '.repeat(2_600).trim()

  it('retires an echo whose observed row carries all ten thousand characters', () => {
    // The observed feed truncates nothing, so this is a plain equality — and
    // the case the panel used to be unable to produce at all.
    expect(LONG.length).toBeGreaterThan(10_000)
    const kept = reconcileEchoes([echo({ text: LONG })], [turn({ text: LONG })])
    expect(kept).toEqual([])
  })

  it('retires an echo whose HELD row is exactly the truncation of its words', () => {
    // The row the held store kept, built the way `retainHeldMessage` builds it.
    const row = turn({ text: heldRetainedText(LONG) })
    expect(row.text).toHaveLength(HELD_MESSAGE_MAX_CHARS)
    expect(reconcileEchoes([echo({ text: LONG })], [row])).toEqual([])
  })

  it('keeps an echo whose row merely STARTS with the same words', () => {
    // The whole reason this is a truncation check and not a prefix one: a row
    // that begins with the person's sentence and goes on is a different row,
    // and crediting it would throw away the only copy of their words.
    const prefix = turn({ text: heldRetainedText(LONG).slice(0, 500) })
    expect(reconcileEchoes([echo({ text: LONG })], [prefix])).toEqual([echo({ text: LONG })])
  })

  it('keeps an echo whose row is a cut of a DIFFERENT long message', () => {
    const other = 'hew '.repeat(2_500).trim()
    const row = turn({ text: heldRetainedText(other) })
    expect(reconcileEchoes([echo({ text: LONG })], [row])).toEqual([echo({ text: LONG })])
  })

  it('never reads a short row as a truncation, since nothing could have cut it', () => {
    // A message inside the bound is retained whole, so a row shorter than the
    // bound is evidence about its own words and nothing else.
    const short = 'dig deeper'
    expect(reconcileEchoes([echo({ text: short })], [turn({ text: 'dig' })])).toEqual([
      echo({ text: short })
    ])
  })

  it('leaves a long echo with attachments alone rather than guessing at its cut row', () => {
    // A held row puts the attached files' own lines AHEAD of the words and cuts
    // the whole string, so what survives the cut is not the truncation of the
    // echo's words — it is the truncation of something this panel did not build.
    // Refusing to match is the safe direction: the echo stays and expires.
    const shot: DwarfAttachment = {
      path: 'C:\\shots\\seam.png',
      name: 'seam.png',
      kind: 'image',
      bytes: 10
    }
    const one = echo({
      text: LONG,
      state: { phase: 'delivered', via: 'held-session', awaitingReaction: true }
    })
    const row = turn({ text: heldRetainedText(`${HELD_IMAGE_PLACEHOLDER}\n${LONG}`) })
    expect(reconcileEchoes([one], [row], { e1: [shot] })).toEqual([one])
  })
})
/* --- end of the #431 block ------------------------------------------------- */
