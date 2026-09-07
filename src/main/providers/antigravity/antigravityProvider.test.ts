import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeFs } from '../../adapters/fakeFs'
import type { Provider } from '../provider'
import { AntigravityProvider } from './antigravityProvider'
import { antigravityTranscriptPath } from './discovery'

/*
 * Issue #237, observer slice. An Antigravity session started in a terminal
 * outside this app appears on the board with its feed, and nothing more: no
 * launch, no held stream, no message, no interrupt, no question answered. The
 * capability seams stay silent (this provider implements no textDelivery), so
 * the panel disables those actions with its own honest reason rather than
 * offering a control with nothing behind it.
 *
 * Everything asserted here is read off sanitized captures of CLI 1.1.26 — see
 * __fixtures__/antigravity/README.md, and docs/provider-formats.md §3 for the format.
 */

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__', 'antigravity')
const transcript = readFileSync(join(FIXTURES, 'transcript.jsonl'), 'utf8')
const busyTranscript = readFileSync(join(FIXTURES, 'transcript-busy.jsonl'), 'utf8')

const ROOT = '/home/j/.gemini/antigravity-cli'
const CONVERSATION = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const WORKSPACE = '/home/j/projects/sample-project'
/** Two minutes after the newest step in `transcript.jsonl`. */
const NOW = Date.parse('2026-09-04T19:05:12Z')

interface StoreOptions {
  /** Conversations with a presence lock on disk. */
  locked?: readonly string[]
  /** conversationId -> the transcript text to lay down, or none at all. */
  transcripts?: Readonly<Record<string, string>>
  /** conversationId -> [workspace, timestamp] history record. */
  history?: Readonly<Record<string, [string, number]>>
  /** Extra raw history lines, appended verbatim. */
  historyLines?: readonly string[]
  mtimeMs?: number
}

function store(options: StoreOptions = {}): FakeFs {
  const fs = new FakeFs()
  for (const id of options.locked ?? [CONVERSATION]) {
    fs.addFile(join(ROOT, 'presence', `${id}.lock`), '')
  }
  const transcripts = options.transcripts ?? { [CONVERSATION]: transcript }
  for (const [id, text] of Object.entries(transcripts)) {
    fs.addFile(antigravityTranscriptPath(ROOT, id), text, options.mtimeMs ?? NOW)
  }
  const history = options.history ?? { [CONVERSATION]: [WORKSPACE, NOW - 60_000] }
  const lines = Object.entries(history).map(([conversationId, [workspace, timestamp]]) =>
    JSON.stringify({ display: 'a prompt', timestamp, workspace, conversationId })
  )
  fs.addFile(join(ROOT, 'history.jsonl'), [...lines, ...(options.historyLines ?? [])].join('\n'))
  return fs
}

/*
 * AMENDED for #237, step 5: this helper gained an optional `heldWorkspaceOf`.
 * Every existing call passes none, so every existing assertion is unchanged —
 * the provider defaults to answering "this panel holds nothing", which is what
 * it always did.
 */
function provider(
  fs: FakeFs,
  now: () => number = () => NOW,
  heldWorkspaceOf?: (sessionId: string) => string | undefined
): AntigravityProvider {
  return new AntigravityProvider({
    fs,
    storeRoot: ROOT,
    busyWindowS: 120,
    lockGraceS: 30,
    staleLockWindowS: 86_400,
    now,
    ...(heldWorkspaceOf === undefined ? {} : { heldWorkspaceOf })
  })
}

describe('AntigravityProvider identity', () => {
  it('answers to the provider identity, not to its executable name', () => {
    expect(provider(store()).kind).toBe('antigravity')
  })
})

describe('AntigravityProvider.scan', () => {
  it('puts a locked conversation in the workspace its history records', async () => {
    const [snapshot] = await provider(store()).scan()

    expect(snapshot?.provider).toBe('antigravity')
    expect(snapshot?.sessionId).toBe(CONVERSATION)
    expect(snapshot?.cwd).toBe(WORKSPACE)
    expect(snapshot?.dwarfs).toHaveLength(1)
  })

  it('names the dwarf off the conversation and carries the last thing it said', async () => {
    const [snapshot] = await provider(store()).scan()
    const [dwarf] = snapshot?.dwarfs ?? []

    expect(dwarf?.id).toBe(`antigravity:${CONVERSATION}`)
    expect(dwarf?.provider).toBe('antigravity')
    expect(dwarf?.name).toBe('agy-11111111')
    expect(dwarf?.lastMessage).toBe('Added a test for the parser and ran the suite; it passes.')
    expect(dwarf?.sessionId).toBe(CONVERSATION)
  })

  /*
   * Rank is topology, and this slice reads none: an Antigravity subagent gets
   * its own conversation directory, and the parent edge lives in the parent's
   * own subagent tool events, which nothing here parses yet. So the absence of
   * spawn evidence reads as `worker`, never as `foreman` — being the root of a
   * crew is the stronger claim, and claiming it needs the proof.
   */
  it('leaves an unproven rank at worker rather than promoting it', async () => {
    const [snapshot] = await provider(store()).scan()

    expect(snapshot?.dwarfs[0]?.role).toBe('worker')
  })

  /*
   * The invariant that must not bend (contracts.ts, issue #34/#60): `waiting`
   * on a SESSION means a structured block a human can act on, and this store
   * carries no approval, question or input-request record of any kind. A quiet
   * conversation is therefore `idle`, and the dwarf beside it is the resting
   * `waiting` DwarfStatus, which is a different claim entirely.
   */
  it('never reports a session as waiting, however quiet it is', async () => {
    const quiet = provider(store(), () => NOW + 3_600_000)
    const [snapshot] = await quiet.scan()

    expect(snapshot?.status).toBe('idle')
    expect(snapshot?.dwarfs[0]?.status).toBe('waiting')
    expect(snapshot?.dwarfs[0]?.waitingReason).toBeUndefined()
    expect(snapshot?.dwarfs[0]?.pendingQuestion).toBeUndefined()
  })

  it('reports busy from a running newest step that is still fresh', async () => {
    const fs = store({ transcripts: { [CONVERSATION]: busyTranscript } })
    const nowMs = Date.parse('2026-09-04T19:14:41Z')
    const [snapshot] = await provider(fs, () => nowMs).scan()

    expect(snapshot?.status).toBe('busy')
    expect(snapshot?.dwarfs[0]?.status).toBe('working')
  })

  /*
   * `status` is written once when a step is appended and never rewritten, so a
   * crashed turn leaves a RUNNING record on disk forever. Freshness is the only
   * thing that keeps that from mining for eternity.
   */
  it('stops believing a running step once it is older than the busy window', async () => {
    const fs = store({ transcripts: { [CONVERSATION]: busyTranscript } })
    const nowMs = Date.parse('2026-09-04T19:14:31Z') + 121_000
    const [snapshot] = await provider(fs, () => nowMs).scan()

    expect(snapshot?.status).toBe('idle')
  })

  /*
   * The one liveness signal a frozen Windows mtime cannot contradict (issue
   * #1): the file got bigger between two scans, so somebody is writing to it
   * right now — whatever its newest record's own status word says.
   */
  it('reports busy from transcript growth between two scans', async () => {
    const fs = store()
    const agy = provider(fs)
    await agy.scan()

    fs.addFile(
      antigravityTranscriptPath(ROOT, CONVERSATION),
      transcript +
        JSON.stringify({
          step_index: 13,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-09-04T19:05:10Z',
          content: '<USER_REQUEST>\nAnd again.\n</USER_REQUEST>'
        }) +
        '\n',
      NOW
    )
    const [snapshot] = await agy.scan()

    expect(snapshot?.status).toBe('busy')
  })

  it('reports the newest activity it can prove as the snapshot clock', async () => {
    // Three clocks, and the newest of them wins: the newest step's own
    // created_at, the history record's timestamp, and the file's mtime.
    const [snapshot] = await provider(store()).scan()

    expect(snapshot?.updatedAt).toBe(NOW)
  })

  /*
   * Windows freezes the mtime of a file held open across a long session (issue
   * #1) — measured at 5.3 hours on a rollout that was still being appended to.
   * The step's own `created_at` lives INSIDE the file, so a frozen mtime
   * cannot hide it, and reading the mtime alone would age a live conversation
   * out of the store.
   */
  it('reads the step clock inside the file, not just the mtime outside it', async () => {
    const fs = store({ mtimeMs: 0, history: { [CONVERSATION]: [WORKSPACE, 0] } })
    const [snapshot] = await provider(fs).scan()

    expect(snapshot?.updatedAt).toBe(Date.parse('2026-09-04T19:03:12Z'))
  })

  /*
   * A presence lock is the CLI's own statement that a conversation is running,
   * and it is the reason an open-but-quiet session stays on the board where a
   * transcript mtime alone would drop it. It is still only a hint.
   */
  it('shows nothing for a conversation with no lock at all', async () => {
    expect(await provider(store({ locked: [] })).scan()).toEqual([])
  })

  it('keeps a conversation for the grace window after its lock disappears', async () => {
    const fs = store()
    const clock = { now: NOW }
    const agy = provider(fs, () => clock.now)
    expect(await agy.scan()).toHaveLength(1)

    fs.removeFile(join(ROOT, 'presence', `${CONVERSATION}.lock`))
    // Inside the grace window: a lock can be replaced between two reads, and
    // dropping a dwarf on one missed listing makes the board flicker.
    clock.now = NOW + 20_000
    expect(await agy.scan()).toHaveLength(1)
  })

  it('never resurrects a conversation this provider has not seen locked', async () => {
    // The grace window is a memory of a lock this provider actually read, not
    // a benefit of the doubt for any id in history.jsonl.
    const fresh = provider(store({ locked: [] }))
    expect(await fresh.scan()).toEqual([])
  })

  it('lets a conversation go once its lock has been gone past the grace window', async () => {
    const fs = store()
    const clock = { now: NOW }
    const agy = provider(fs, () => clock.now)
    await agy.scan()

    fs.removeFile(join(ROOT, 'presence', `${CONVERSATION}.lock`))
    clock.now = NOW + 31_000
    expect(await agy.scan()).toEqual([])
  })

  /*
   * The other half of "a lock is not a contract": a crash leaves the file
   * behind, and without a bound a ghost dwarf would stand in the mine forever.
   * The window is deliberately generous — an interactive session legitimately
   * sits idle for hours between prompts, and this app has always taken the
   * generous side when the evidence runs out.
   */
  it('treats a lock over a long-silent conversation as stale', async () => {
    const nowMs = NOW + 86_401_000
    expect(await provider(store(), () => nowMs).scan()).toEqual([])
  })

  it('shows a conversation with no workspace record at all in no mine', async () => {
    // history.jsonl is the only place the folder behind a conversation id is
    // written down. Nothing else recovers one, and a mine invented from an id
    // would be a phantom project.
    expect(await provider(store({ history: {} })).scan()).toEqual([])
  })

  it('reads a history file whose final line was still being written', async () => {
    const fs = store({ historyLines: ['{"display":"half a rec'] })
    expect(await provider(fs).scan()).toHaveLength(1)
  })

  it('survives a store with no presence directory and no history at all', async () => {
    // The ordinary state of a machine with the CLI installed and never run.
    expect(await provider(new FakeFs()).scan()).toEqual([])
  })

  it('shows a locked conversation whose transcript is not on disk yet', async () => {
    // A conversation the CLI has locked and recorded a prompt for, whose first
    // transcript record has not been flushed. Absent evidence is not absence
    // of a session.
    const [snapshot] = await provider(store({ transcripts: {} })).scan()

    expect(snapshot?.sessionId).toBe(CONVERSATION)
    expect(snapshot?.status).toBe('idle')
    expect(snapshot?.dwarfs[0]?.lastMessage).toBeUndefined()
  })

  it('reports one snapshot per locked conversation, in id order', async () => {
    const fs = store({
      locked: [OTHER, CONVERSATION],
      transcripts: { [CONVERSATION]: transcript, [OTHER]: transcript },
      history: {
        [CONVERSATION]: [WORKSPACE, NOW - 60_000],
        [OTHER]: ['/home/j/projects/other-project', NOW - 30_000]
      }
    })

    expect((await provider(fs).scan()).map((snapshot) => snapshot.sessionId)).toEqual([
      CONVERSATION,
      OTHER
    ])
  })

  /*
   * Tokens are the ore this app mines, and they must never be invented. The
   * private transcript carries no usage figure anywhere — verified on 1.1.26 —
   * so an observed Antigravity session mines nothing rather than mining a
   * message count or a byte size wearing a token's name.
   */
  it('claims no tokens, because this store records none', async () => {
    const [snapshot] = await provider(store()).scan()
    const [dwarf] = snapshot?.dwarfs ?? []

    expect(dwarf?.tokensUsed).toBeUndefined()
    expect(dwarf?.tokensObserved).toBeUndefined()
  })

  /*
   * A global `agy.exe` cannot be mapped to a particular conversation — its
   * command line carries no conversation id — so guessing one would make the
   * panel focus somebody else's window. Absent means the panel offers the
   * transcript-tail fallback instead, which is honest.
   */
  it('guesses no pid for a session it only observes', async () => {
    const [snapshot] = await provider(store()).scan()

    expect(snapshot?.dwarfs[0]?.pid).toBeUndefined()
  })

  /*
   * AMENDED for #237, step 4 (was: also asserted `port.firstPrompt` was
   * undefined, pinning the observer slice's own scope). A detached launch
   * needs the receipt firstPrompt supplies (#191) — the panel's own proof of
   * which dwarf on the board is the session it just started — so it is
   * implemented now; see the firstPrompt describe block below. What is still
   * true, and still asserted here, is that no SEND channel exists: detection
   * is not delivery.
   */
  it('offers no send channel into a session it cannot reach', () => {
    // No textDelivery method at all: the runtime resolves the whole capability
    // matrix to null, and the action bar disables every control with its own
    // reason. Read through the port rather than the class, because the port
    // is what the runtime holds.
    const port: Provider = provider(store())

    expect(port.textDelivery).toBeUndefined()
  })
})

describe('AntigravityProvider.feed', () => {
  it('answers null for a dwarf no scan has seen', async () => {
    expect(await provider(store()).feed('antigravity:nobody', 12)).toBeNull()
  })

  // AMENDED for #280 (was: ['user', 'assistant', 'user', 'assistant'], before
  // this fixture's three tool_calls steps — find_by_name, view_file,
  // replace_file_content — published activity lines of their own).
  it('reads the conversation both ways round after a scan', async () => {
    const agy = provider(store())
    await agy.scan()

    const feed = await agy.feed(`antigravity:${CONVERSATION}`, 12)
    expect(feed?.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'user',
      'assistant',
      'assistant',
      'assistant'
    ])
  })

  it('redacts what leaves the provider, user text included', async () => {
    const secret = `sk-ant-${'a'.repeat(40)}`
    const fs = store({
      transcripts: {
        [CONVERSATION]:
          JSON.stringify({
            step_index: 0,
            source: 'USER_EXPLICIT',
            type: 'USER_INPUT',
            status: 'DONE',
            created_at: '2026-09-04T19:01:13Z',
            content: `<USER_REQUEST>\nmy key is ${secret}\n</USER_REQUEST>`
          }) + '\n'
      }
    })
    const agy = provider(fs)
    await agy.scan()

    const feed = await agy.feed(`antigravity:${CONVERSATION}`, 12)
    expect(feed?.[0]?.text).not.toContain(secret)
  })

  it('answers an empty conversation for a transcript that has gone away', async () => {
    const fs = store()
    const agy = provider(fs)
    await agy.scan()

    fs.removeFile(antigravityTranscriptPath(ROOT, CONVERSATION))
    expect(await agy.feed(`antigravity:${CONVERSATION}`, 12)).toEqual([])
  })
})

/*
 * #237, step 4. The receipt a detached launch is recognised by (#191): the
 * opening prompt the child's session recorded, off the head of the same
 * transcript feed() reads the tail of — envelope stripped by the same
 * extractAntigravityFeed the live feed uses, so a match here is a match
 * against the words a person actually typed rather than the CLI's own
 * <USER_REQUEST> wrapper.
 */
describe('AntigravityProvider.firstPrompt', () => {
  it("reads the opening prompt off the transcript's own head, envelope stripped", async () => {
    const agy = provider(store())
    await agy.scan()

    await expect(agy.firstPrompt(`antigravity:${CONVERSATION}`)).resolves.toBe(
      'What does this project do?'
    )
  })

  it('answers undefined for a dwarf no scan has seen', async () => {
    await expect(provider(store()).firstPrompt('antigravity:nobody')).resolves.toBeUndefined()
  })

  it('answers undefined when the transcript has gone away', async () => {
    const fs = store()
    const agy = provider(fs)
    await agy.scan()
    fs.removeFile(antigravityTranscriptPath(ROOT, CONVERSATION))

    await expect(agy.firstPrompt(`antigravity:${CONVERSATION}`)).resolves.toBeUndefined()
  })

  it('answers raw, unredacted text — the same rule every other firstPrompt implementation holds', async () => {
    const secret = `sk-ant-${'a'.repeat(40)}`
    const fs = store({
      transcripts: {
        [CONVERSATION]:
          JSON.stringify({
            step_index: 0,
            source: 'USER_EXPLICIT',
            type: 'USER_INPUT',
            status: 'DONE',
            created_at: '2026-09-04T19:01:13Z',
            content: `<USER_REQUEST>\nmy key is ${secret}\n</USER_REQUEST>`
          }) + '\n'
      }
    })
    const agy = provider(fs)
    await agy.scan()

    await expect(agy.firstPrompt(`antigravity:${CONVERSATION}`)).resolves.toContain(secret)
  })
})

describe('AntigravityProvider.transcriptPath', () => {
  it('names the file a terminal can tail live', async () => {
    const agy = provider(store())
    await agy.scan()

    expect(agy.transcriptPath(`antigravity:${CONVERSATION}`)).toBe(
      antigravityTranscriptPath(ROOT, CONVERSATION)
    )
  })

  it('names nothing for a dwarf no scan has seen', () => {
    expect(provider(store()).transcriptPath('antigravity:nobody')).toBeUndefined()
  })

  it('names nothing for a conversation whose transcript is not on disk', async () => {
    // Opening a terminal to tail a file that does not exist is worse than
    // saying there is nothing to tail.
    const agy = provider(store({ transcripts: {} }))
    await agy.scan()

    expect(agy.transcriptPath(`antigravity:${CONVERSATION}`)).toBeUndefined()
  })
})

/*
 * Issue #237, step 5. The measurement that made this seam necessary, and it is
 * worth stating plainly because it reads like a bug otherwise: an Antigravity
 * conversation started in stream-json print mode — which is exactly what a
 * HELD session is — writes NO `history.jsonl` record. Measured on CLI 1.1.26,
 * 2026-09-07, across four probe conversations: a presence lock appeared for
 * every one of them and not one got a workspace record.
 *
 * `history.jsonl` is the only thing in this store that says which folder a
 * conversation belongs to, so without a second source the session this panel
 * launched and is holding is dropped by its own observer — no dwarf, in any
 * mine. The held registry is that source, and what it answers is first-hand
 * rather than inferred: this app chose the folder and started the process in
 * it, and the CLI's own `init` message echoed the same path back.
 */
describe('AntigravityProvider and a conversation this panel holds (#237, step 5)', () => {
  it('places a held conversation the store records no workspace for', async () => {
    const fs = store({ locked: [CONVERSATION], history: {} })
    const held = provider(
      fs,
      () => NOW,
      (id) => (id === CONVERSATION ? WORKSPACE : undefined)
    )

    const [snapshot] = await held.scan()
    expect(snapshot?.sessionId).toBe(CONVERSATION)
    expect(snapshot?.cwd).toBe(WORKSPACE)
  })

  it('still drops a conversation nobody records and nobody holds', async () => {
    // The #166 guard is untouched: a mine invented from a conversation id is
    // still a phantom project, and "this panel holds nothing" is the answer
    // for every session it did not start.
    const fs = store({ locked: [CONVERSATION], history: {} })
    expect(
      await provider(
        fs,
        () => NOW,
        () => undefined
      ).scan()
    ).toEqual([])
  })

  it('prefers the store’s own record over the held folder when both exist', async () => {
    // The store's record is the CLI's own writing about a conversation it
    // resumed, and a resumed session can have moved. The held folder is the
    // fallback for a conversation the store never described, not an override.
    const fs = store({
      locked: [CONVERSATION],
      history: { [CONVERSATION]: [WORKSPACE, NOW - 60_000] }
    })
    const held = provider(
      fs,
      () => NOW,
      () => '/home/j/projects/somewhere-else'
    )

    const [snapshot] = await held.scan()
    expect(snapshot?.cwd).toBe(WORKSPACE)
  })
})
