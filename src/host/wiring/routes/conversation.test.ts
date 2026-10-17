// L2 flow (17 §1.2; 11 F4 step 1; 12 UC-035; 16 §4.6; ADR-019 item 9; ISSUE-169): attachments
// through the conversation wiring — B-M28 `conversation.describeAttachments` and B-M24
// `conversation.send` served by `serveConversation` on the real Host `Dispatcher`, over one copy of
// the template database (the real `SqliteMessageLog`), the real `TurnSender` bridge to a recording
// session, and a `FakeAttachmentReader` over `FakeFs` passed where the composition root passes
// `FsAttachmentReader`. The reader's own rules are its contract's (attachmentReader.contract.ts).
//
// TC-169-03 (a path that fails re-validation at send: `attachment-refused` before any row).
import { describe, expect, it } from 'vitest'
import type { DwarfId, MineId, ProviderIdentity } from '../../kernel/domain/values'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeFs } from '../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../kernel/fakes/SequenceIdGenerator'
import { MAX_ATTACHMENT_BYTES } from '../../modules/conversation'
import { FakeAttachmentReader } from '../../modules/conversation/testing/FakeAttachmentReader'
import type { DwarfView } from '../../modules/crew'
import type { DriverSession, TurnInput } from '../../modules/suppliers'
import { SqliteLifecycleFactLog } from '../../platform/sqlite/SqliteLifecycleFactLog'
import { SqliteTransactionRunner } from '../../platform/sqlite/SqliteTransactionRunner'
import { openTemplateCopy } from '../../platform/sqlite/testing/templateDb'
import { Dispatcher } from '../../transport/dispatcher'
import { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { serveConversation, type ConversationRouteEvent } from './conversation'

const T0 = 1_790_000_000_000
const MINE = '00000000-0000-7000-8000-0000000001a9' as MineId
const DWARF = '00000000-0000-7000-8000-0000000016a9' as DwarfId
const IDENTITY: ProviderIdentity = { providerId: 'simulated', providerSessionId: 'session-169' }
const request = (n: number): string => `01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, '0')}`

/** What a file holds: it must never reach a row (INV-62). */
const BYTES_CANARY = 'canary-0169-file-content'
const FOLDER = '/home/p/picked'
const file = (name: string): string => `${FOLDER}/${name}`

/** Lets every pending promise continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

/** The conversation wiring served on a Host dispatcher, routed with a recording session. */
function world(options: { receives?: boolean } = {}) {
  const { db } = openTemplateCopy()
  const transactions = new SqliteTransactionRunner(db)
  const clock = new FakeClock(T0)
  const ids = new SequenceIdGenerator()
  transactions.inTransaction(() => {
    db.run(
      `INSERT INTO mines (id, canonical_path, name, name_norm, state, created_at, last_used_at)
       VALUES (?, '/work/mine-169', 'mine-169', 'mine-169', 'active', ?, ?)`,
      [MINE, T0, T0]
    )
    db.run(
      `INSERT INTO dwarfs (id, mine_id, provider_id, provider_session_id, base_name, rank,
         process_state, turn_state, arrived_at, last_activity_at)
       VALUES (?, ?, 'simulated', 'session-169', 'Durin', 'foreman', 'running', 'none-yet', ?, ?)`,
      [DWARF, MINE, T0, T0]
    )
  })
  const dispatcher = new Dispatcher({
    log: new RecordingDiagnosticsLog(),
    clock,
    scheduler: new FakeScheduler(clock),
    state: () => 'ready'
  })
  const served = serveConversation({ dispatcher, sections: new SectionRegistry() })
  const bus = new RecordingEventBus<ConversationRouteEvent>({ transactionScope: transactions })
  const wired = served.wire({
    db,
    transactions,
    lifecycleFacts: new SqliteLifecycleFactLog({ db, scope: transactions, ids, clock }),
    bus,
    clock,
    ids,
    hostEpoch: 'epoch-169',
    frames: { publishFrame: () => undefined }
  })
  const fs = new FakeFs()
  const reader = new FakeAttachmentReader(fs)
  const turns: TurnInput[] = []
  const session = {
    capabilities: { reactionEvidence: 'none' },
    sendTurn: async (turn: TurnInput) => {
      turns.push(turn)
      return { confidence: 'confirmed', heldUntilTurnEnd: false, correlation: 'c-169' }
    }
  } as unknown as DriverSession
  const dwarf = {
    identity: IDENTITY,
    departed: false,
    canReceiveMessages: options.receives ?? true
  } as unknown as DwarfView
  wired.route({
    crew: { get: (id) => (id === DWARF ? dwarf : null), crewOf: () => [] },
    mines: { list: () => [] },
    sessions: { sessionFor: () => session },
    attachments: reader
  })
  let calls = 0
  const call = async (method: string, params: unknown): Promise<unknown> => {
    calls += 1
    const res = await dispatcher.dispatch(
      { id: `r-${calls}`, method, params },
      { role: 'ui', clientId: 'ui-1' }
    )
    if (!res.ok) throw new Error(`refused: ${res.error.code}`)
    return res.result
  }
  return {
    db,
    fs,
    reader,
    turns,
    /** A regular file at `name` of `bytes` (its content the canary; its size as declared). */
    addFile(name: string, bytes: number): string {
      const path = file(name)
      fs.addFile(path, BYTES_CANARY)
      reader.declareSize(path, bytes)
      return path
    },
    describe: (paths: string[]) => call('conversation.describeAttachments', { paths }),
    send: (attachments: string[], n = 1) =>
      call('conversation.send', {
        dwarfId: DWARF,
        text: 'look at these',
        attachments,
        requestId: request(n)
      }),
    rows: () => db.all('SELECT * FROM messages WHERE dwarf_id = ?', [DWARF])
  }
}

describe('attachments (F4)', () => {
  it('[US-MSG-002.AC03] a message with accepted files hands them over in the turn input with their revalidated paths', async () => {
    const w = world()
    const notes = w.addFile('notes.txt', 12)
    const shot = w.addFile('shot.png', 2048)

    const sent = await w.send([notes, shot])
    await settle()

    expect(sent).toMatchObject({ ok: true })
    expect(w.turns).toHaveLength(1)
    expect(w.turns[0]?.attachments).toStrictEqual([
      { path: notes, name: 'notes.txt', bytes: 12 },
      { path: shot, name: 'shot.png', bytes: 2048 }
    ])
    // Re-validated at send, not trusted from the earlier describe (16 §4.6).
    expect(w.reader.described).toEqual([notes, shot])
  })

  it('[US-MSG-002.AC07] a message carrying many files accepts one more under the cap', async () => {
    const w = world()
    const many = Array.from({ length: 40 }, (_, n) => w.addFile(`page-${n}.txt`, 1_000_000))
    const oneMore = w.addFile('one-more.txt', 5)

    const picks = (await w.describe([...many, oneMore])) as Array<{ refusal?: string }>
    expect(picks).toHaveLength(41)
    expect(picks.filter((pick) => pick.refusal !== undefined)).toEqual([])

    expect(await w.send([...many, oneMore])).toMatchObject({ ok: true })
    await settle()
    expect(w.turns[0]?.attachments).toHaveLength(41)
  })

  it('[US-MSG-002.AC06] a file under the cap is sent as is and the Host applies no other size rule', async () => {
    const w = world()
    const atCap = w.addFile('film.mov', MAX_ATTACHMENT_BYTES)
    const empty = w.addFile('empty.txt', 0)

    expect(await w.send([atCap, empty])).toMatchObject({ ok: true })
    await settle()
    // Whether the dwarf can take it is the agent's to report, never the app's (US-MSG-002.AC06).
    expect(w.turns[0]?.attachments.map((a) => a.bytes)).toEqual([300_000_000, 0])
  })

  it('[US-MSG-002.AC04, INV-33] a dwarf that cannot receive refuses a send with files with cannot-receive', async () => {
    const w = world({ receives: false })
    const notes = w.addFile('notes.txt', 12)

    expect(await w.send([notes])).toStrictEqual({ ok: false, error: 'cannot-receive' })
    await settle()
    expect(w.rows()).toEqual([])
    expect(w.turns).toEqual([])
  })

  it('[US-MSG-002.AC05] one oversized file among several is refused alone and the others stay accepted', async () => {
    const w = world()
    const notes = w.addFile('notes.txt', 12)
    const huge = w.addFile('huge.mov', MAX_ATTACHMENT_BYTES + 1)
    const shot = w.addFile('shot.png', 64)

    expect(await w.describe([notes, huge, shot])).toStrictEqual([
      { path: notes, attachment: { path: notes, name: 'notes.txt', kind: 'file', bytes: 12 } },
      { path: huge, refusal: 'file-too-large' },
      { path: shot, attachment: { path: shot, name: 'shot.png', kind: 'image', bytes: 64 } }
    ])
  })

  it('[ADR-019] a send whose file changed since it was described answers attachment-refused before any row', async () => {
    const w = world()
    const notes = w.addFile('notes.txt', 12)
    const grows = w.addFile('grows.log', 10)
    const goes = w.addFile('goes.txt', 3)
    expect(
      ((await w.describe([notes, grows, goes])) as Array<{ refusal?: string }>).every(
        (pick) => pick.refusal === undefined
      )
    ).toBe(true)

    // It grew past the cap after it was described.
    w.reader.declareSize(grows, MAX_ATTACHMENT_BYTES + 1)
    expect(await w.send([notes, grows], 1)).toStrictEqual({
      ok: false,
      error: 'attachment-refused'
    })
    // It was deleted after it was described.
    w.fs.removeFile(goes)
    expect(await w.send([notes, goes], 2)).toStrictEqual({ ok: false, error: 'attachment-refused' })
    // A path the UI never got from a picker: a folder.
    await w.fs.makeDir(`${FOLDER}/sub`)
    expect(await w.send([`${FOLDER}/sub`], 3)).toStrictEqual({
      ok: false,
      error: 'attachment-refused'
    })
    await settle()
    expect(w.rows()).toEqual([])
    expect(w.turns).toEqual([])
  })

  it('[INV-62] no attachment bytes are stored in any row', async () => {
    const w = world()
    const notes = w.addFile('notes.txt', 12)
    const shot = w.addFile('shot.png', 64)

    expect(await w.send([notes, shot])).toMatchObject({ ok: true })
    await settle()

    expect(w.rows()).toHaveLength(1)
    const tables = w.db
      .all(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .map((row) => String(row['name']))
    const stored = tables.flatMap((table) => w.db.all(`SELECT * FROM "${table}"`))
    expect(JSON.stringify(stored)).not.toContain(BYTES_CANARY)
  })
})
