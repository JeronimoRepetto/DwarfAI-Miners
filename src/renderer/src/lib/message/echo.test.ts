import { describe, expect, it } from 'vitest'
import { RELAY_PROVENANCE_LINE, type FeedMessage } from '../../types'
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
