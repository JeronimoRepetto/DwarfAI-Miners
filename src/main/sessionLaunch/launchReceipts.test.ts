import { describe, expect, it, vi } from 'vitest'
import type { Dwarf, Mine } from '../domain/types'
import {
  FIRST_PROMPT_READ_ATTEMPTS,
  LaunchReceiptRegistry,
  stampLaunchReceipts
} from './launchReceipts'

const MINE_PATH = 'C:\\work\\project'
const OTHER_PATH = 'C:\\work\\other'
const PROMPT = 'dig the east gallery'

function dwarf(overrides: Partial<Dwarf> = {}): Dwarf {
  return {
    id: `codex:${overrides.sessionId ?? 'thread-1'}`,
    provider: 'codex',
    role: 'worker',
    name: 'codex-01a04d79',
    status: 'working',
    sessionId: 'thread-1',
    ...overrides
  }
}

function mine(path: string, dwarfs: Dwarf[]): Mine {
  return {
    id: `mine:${path}`,
    path,
    name: 'project',
    tier: 'bronze',
    dwarfs,
    tokensObserved: 0,
    updatedAt: 1
  }
}

/**
 * A transcript reader keyed by dwarf id, standing in for what each provider
 * reads off the head of its own store. Counting the calls is half the point:
 * this read is off the poll and must not become a per-poll cost.
 */
function reader(firstPrompts: Record<string, string | undefined>) {
  const reads: string[] = []
  return {
    reads,
    firstPrompt: vi.fn(async (subject: Dwarf) => {
      reads.push(subject.id)
      return firstPrompts[subject.id]
    })
  }
}

function registry(firstPrompts: Record<string, string | undefined>) {
  const read = reader(firstPrompts)
  return { read, receipts: new LaunchReceiptRegistry({ firstPrompt: read.firstPrompt }) }
}

describe('proving which dwarf a detached launch became', () => {
  /*
   * The whole of #191's second half. A detached launch leaves no held
   * conversation, so the only receipt it can leave is in the session's own
   * store: the prompt this panel wrote to that child's stdin, recorded by the
   * provider as the first thing a human said.
   */
  it('claims the dwarf whose session opened with the prompt this launch sent', async () => {
    const { receipts } = registry({ 'codex:mine': PROMPT, 'codex:theirs': 'shore the north wall' })
    const launchId = receipts.issue({ provider: 'codex', minePath: MINE_PATH, prompt: PROMPT })

    await receipts.observe([
      mine(MINE_PATH, [dwarf({ sessionId: 'theirs' }), dwarf({ sessionId: 'mine' })])
    ])

    expect(receipts.receiptOf('codex:mine')).toBe(launchId)
    expect(receipts.receiptOf('codex:theirs')).toBeUndefined()
  })

  /*
   * Evidence, never timing. "The dwarf that was not here a moment ago" would
   * adopt whatever happened to start next, which is the refusal every other
   * rule in this flow is built on.
   */
  it('claims nobody when the only new session opened with somebody else’s words', async () => {
    const { receipts } = registry({ 'codex:theirs': 'shore the north wall' })
    receipts.issue({ provider: 'codex', minePath: MINE_PATH, prompt: PROMPT })

    await receipts.observe([mine(MINE_PATH, [dwarf({ sessionId: 'theirs' })])])

    expect(receipts.receiptOf('codex:theirs')).toBeUndefined()
  })

  /*
   * A session that finished before the poll first drew it is exactly the case
   * this has to serve — the reply is already written, and the panel opens on
   * the ended state with it visible. So 'leaving' is admitted here, unlike in
   * the kill register (#217), where a departed session's retained pid is stale.
   */
  it('claims a session that had already ended by the time its dwarf was drawn', async () => {
    const { receipts } = registry({ 'codex:done': PROMPT })
    const launchId = receipts.issue({ provider: 'codex', minePath: MINE_PATH, prompt: PROMPT })

    await receipts.observe([mine(MINE_PATH, [dwarf({ sessionId: 'done', status: 'leaving' })])])

    expect(receipts.receiptOf('codex:done')).toBe(launchId)
  })

  it('never claims a session in another mine, however well its words match', async () => {
    const { receipts } = registry({ 'codex:mine': PROMPT })
    receipts.issue({ provider: 'codex', minePath: MINE_PATH, prompt: PROMPT })

    await receipts.observe([mine(OTHER_PATH, [dwarf({ sessionId: 'mine' })])])

    expect(receipts.receiptOf('codex:mine')).toBeUndefined()
  })

  it('never claims another provider’s session', async () => {
    const { receipts } = registry({ 'claude:s1': PROMPT })
    receipts.issue({ provider: 'codex', minePath: MINE_PATH, prompt: PROMPT })

    await receipts.observe([
      mine(MINE_PATH, [dwarf({ id: 'claude:s1', provider: 'claude', sessionId: 's1' })])
    ])

    expect(receipts.receiptOf('claude:s1')).toBeUndefined()
  })

  /*
   * A Codex child thread is a FORK, so the first user record in its own
   * rollout is the human's original prompt (#218) — the same words this launch
   * sent. The parent EDGE is what separates it from the session root, and a
   * launch started one session, not the crew it went on to spawn.
   */
  it('never claims a spawned agent that inherited the same opening prompt', async () => {
    const { receipts } = registry({ 'codex:child': PROMPT, 'codex:root': PROMPT })
    const launchId = receipts.issue({ provider: 'codex', minePath: MINE_PATH, prompt: PROMPT })

    await receipts.observe([
      mine(MINE_PATH, [
        dwarf({ sessionId: 'child', parentId: 'codex:root' }),
        dwarf({ sessionId: 'root' })
      ])
    ])

    expect(receipts.receiptOf('codex:child')).toBeUndefined()
    expect(receipts.receiptOf('codex:root')).toBe(launchId)
  })

  /*
   * Two launches with identical prompts are indistinguishable by their own
   * evidence. The tie breaks on id, exactly as it does on the renderer's side,
   * so the answer cannot depend on the order one poll happened to list them in.
   */
  it('breaks a tie on id rather than on the order the poll listed them', async () => {
    const forwards = registry({ 'codex:a': PROMPT, 'codex:b': PROMPT })
    const first = forwards.receipts.issue({
      provider: 'codex',
      minePath: MINE_PATH,
      prompt: PROMPT
    })
    await forwards.receipts.observe([
      mine(MINE_PATH, [dwarf({ sessionId: 'b' }), dwarf({ sessionId: 'a' })])
    ])

    const backwards = registry({ 'codex:a': PROMPT, 'codex:b': PROMPT })
    const second = backwards.receipts.issue({
      provider: 'codex',
      minePath: MINE_PATH,
      prompt: PROMPT
    })
    await backwards.receipts.observe([
      mine(MINE_PATH, [dwarf({ sessionId: 'a' }), dwarf({ sessionId: 'b' })])
    ])

    expect(forwards.receipts.receiptOf('codex:a')).toBe(first)
    expect(backwards.receipts.receiptOf('codex:a')).toBe(second)
  })

  it('gives two launches in one mine the two sessions their own words name', async () => {
    const { receipts } = registry({ 'codex:a': 'dig', 'codex:b': 'shore' })
    const digging = receipts.issue({ provider: 'codex', minePath: MINE_PATH, prompt: 'dig' })
    const shoring = receipts.issue({ provider: 'codex', minePath: MINE_PATH, prompt: 'shore' })

    await receipts.observe([
      mine(MINE_PATH, [dwarf({ sessionId: 'a' }), dwarf({ sessionId: 'b' })])
    ])

    expect(receipts.receiptOf('codex:a')).toBe(digging)
    expect(receipts.receiptOf('codex:b')).toBe(shoring)
  })

  it('keeps the session it claimed when a later one matches too', async () => {
    const { receipts } = registry({ 'codex:a': PROMPT, 'codex:b': PROMPT })
    const launchId = receipts.issue({ provider: 'codex', minePath: MINE_PATH, prompt: PROMPT })

    await receipts.observe([mine(MINE_PATH, [dwarf({ sessionId: 'a' })])])
    await receipts.observe([
      mine(MINE_PATH, [dwarf({ sessionId: 'a' }), dwarf({ sessionId: 'b' })])
    ])

    expect(receipts.receiptOf('codex:a')).toBe(launchId)
    expect(receipts.receiptOf('codex:b')).toBeUndefined()
  })

  /*
   * The prompt is trimmed on the way to the child, and a CLI is free to add a
   * newline of its own when it writes the turn down. Exact equality of the
   * trimmed strings, and nothing looser: this is the whole proof.
   */
  it('matches the trimmed prompt and nothing that merely resembles it', async () => {
    const { receipts } = registry({
      'codex:spaced': `\n${PROMPT}\n`,
      'codex:longer': `${PROMPT} and the west one`
    })
    const launchId = receipts.issue({ provider: 'codex', minePath: MINE_PATH, prompt: PROMPT })

    await receipts.observe([
      mine(MINE_PATH, [dwarf({ sessionId: 'longer' }), dwarf({ sessionId: 'spaced' })])
    ])

    expect(receipts.receiptOf('codex:spaced')).toBe(launchId)
    expect(receipts.receiptOf('codex:longer')).toBeUndefined()
  })
})

describe('what the receipt read costs', () => {
  /*
   * The read walks a transcript's head, so it must never become a per-poll
   * cost. A session that has answered once is never asked again.
   */
  it('reads a dwarf that has spoken exactly once, however many polls pass', async () => {
    const { read, receipts } = registry({ 'codex:theirs': 'shore the north wall' })
    receipts.issue({ provider: 'codex', minePath: MINE_PATH, prompt: PROMPT })
    const board = [mine(MINE_PATH, [dwarf({ sessionId: 'theirs' })])]

    await receipts.observe(board)
    await receipts.observe(board)
    await receipts.observe(board)

    expect(read.reads).toEqual(['codex:theirs'])
  })

  /*
   * The opposite case, and the reason a single read is not enough: a store can
   * exist before its first prompt is flushed to it. Nothing is not a mismatch,
   * so the dwarf is asked again — a bounded number of times, so a session that
   * never speaks cannot cost a read forever.
   */
  it('asks again while a session has said nothing, and gives up bounded', async () => {
    const silent: Record<string, string | undefined> = { 'codex:slow': undefined }
    const read = reader(silent)
    const receipts = new LaunchReceiptRegistry({ firstPrompt: read.firstPrompt })
    receipts.issue({ provider: 'codex', minePath: MINE_PATH, prompt: PROMPT })
    const board = [mine(MINE_PATH, [dwarf({ sessionId: 'slow' })])]

    for (let poll = 0; poll < FIRST_PROMPT_READ_ATTEMPTS + 3; poll++) await receipts.observe(board)

    expect(read.reads).toHaveLength(FIRST_PROMPT_READ_ATTEMPTS)
  })

  it('adopts a session that speaks on a later poll than the one that drew it', async () => {
    const answers: Record<string, string | undefined> = { 'codex:slow': undefined }
    const read = reader(answers)
    const receipts = new LaunchReceiptRegistry({ firstPrompt: read.firstPrompt })
    const launchId = receipts.issue({ provider: 'codex', minePath: MINE_PATH, prompt: PROMPT })
    const board = [mine(MINE_PATH, [dwarf({ sessionId: 'slow' })])]

    await receipts.observe(board)
    expect(receipts.receiptOf('codex:slow')).toBeUndefined()

    answers['codex:slow'] = PROMPT
    await receipts.observe(board)

    expect(receipts.receiptOf('codex:slow')).toBe(launchId)
  })

  it('reads nothing at all once every launch has its session', async () => {
    const { read, receipts } = registry({ 'codex:mine': PROMPT })
    receipts.issue({ provider: 'codex', minePath: MINE_PATH, prompt: PROMPT })
    const board = [mine(MINE_PATH, [dwarf({ sessionId: 'mine' })])]

    await receipts.observe(board)
    const afterClaim = read.reads.length
    await receipts.observe(board)

    expect(read.reads).toHaveLength(afterClaim)
  })

  it('reads nothing at all when no launch is waiting for a session', async () => {
    const { read, receipts } = registry({ 'codex:mine': PROMPT })

    await receipts.observe([mine(MINE_PATH, [dwarf({ sessionId: 'mine' })])])

    expect(read.reads).toEqual([])
  })

  /*
   * A read that failed is a read that answered nothing, not a mismatch: a
   * provider whose store went away between the board and the read has said
   * nothing about who this session belongs to.
   */
  it('survives a read that threw and claims nobody on it', async () => {
    const receipts = new LaunchReceiptRegistry({
      firstPrompt: () => Promise.reject(new Error('transcript gone'))
    })
    receipts.issue({ provider: 'codex', minePath: MINE_PATH, prompt: PROMPT })

    await receipts.observe([mine(MINE_PATH, [dwarf({ sessionId: 'mine' })])])

    expect(receipts.receiptOf('codex:mine')).toBeUndefined()
  })
})

describe('stampLaunchReceipts', () => {
  it('marks only the dwarf whose launch was proved', () => {
    const stamped = stampLaunchReceipts(
      [mine(MINE_PATH, [dwarf({ sessionId: 'a' }), dwarf({ sessionId: 'b' })])],
      (dwarfId) => (dwarfId === 'codex:a' ? 'receipt:1' : undefined)
    )

    expect(stamped[0]!.dwarfs.map((entry) => entry.launchId)).toEqual(['receipt:1', undefined])
  })

  it('leaves a board with nothing to stamp exactly as it found it', () => {
    const board = [mine(MINE_PATH, [dwarf({ sessionId: 'a' })])]

    expect(stampLaunchReceipts(board, () => undefined)).toEqual(board)
  })
})
