// L8 OS lane (17 §1.8): `ObservedSessionTurnSender` over the real kernel `NodeProcessControl` and the
// real `ConsoleTextDelivery`, delivering to stub processes the test starts itself, never a real
// provider CLI and never a visible terminal. Runs only in `pnpm test:os`, one describe per OS.
//
// - Windows: the stub is a "terminal session" reading its own console's input buffer
//   (fixtures/bin/console-keys `reader`); the hidden console every `windowsHide` child gets is the
//   console the relay attaches to by pid. Everything it received is read back off the real buffer.
// - macOS and Linux: `ps` and `tmux` are a stub this test writes to its own temporary folder (the
//   tmux stub keeps the loaded buffer and records each paste and key); the identity check runs
//   against a real live process. A real tmux pane and a real Terminal.app tab are the maintainer's
//   lane (no tmux and no GUI terminal on CI runners).
// Every process is the test's own and is ended by closing its stdin, then awaited.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../../../kernel/domain/processIdentity'
import type { DwarfId, MessageId } from '../../../../kernel/domain/values'
import type { SpawnedProcess } from '../../../../kernel/ports/processControl'
import { NodeScheduler } from '../../../../platform/clock/NodeScheduler'
import { NodeProcessControl } from '../../../../platform/process/NodeProcessControl'
import type { TurnInput } from '../../../suppliers'
import { CodexThreadQueue } from './CodexThreadQueue'
import { ConsoleTextDelivery, type ConsoleTextDeliveryDeps } from './ConsoleTextDelivery'
import { ObservedSessionTurnSender } from './ObservedSessionTurnSender'

const READER = fileURLToPath(
  new URL('../../../../../../fixtures/bin/console-keys/console-keys.mjs', import.meta.url)
)
const SLEEPER = fileURLToPath(
  new URL('../../../../../../fixtures/bin/sleeper/sleeper.mjs', import.meta.url)
)
const DWARF = '00000000-0000-7000-8000-0000000000c1' as DwarfId
const MESSAGE = 'dig  the north\r\ntunnel — é ✓ 🙂 '
const RELAYED = 'dig the north tunnel — é ✓ 🙂'
/** How long a stub is watched after a send for anything beyond the one message. */
const QUIET_MS = 700

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const TURN: TurnInput = {
  messageId: '00000000-0000-7000-8000-0000000000a1' as MessageId,
  kind: 'message',
  text: MESSAGE,
  attachments: []
}

/** A turn carrying one Host-revalidated file (#1463), and what a terminal must receive for it. */
const ATTACHED_PATH = process.platform === 'win32' ? 'C:\\work\\red.png' : '/work/red.png'
const ATTACHED_TURN: TurnInput = {
  ...TURN,
  attachments: [{ path: ATTACHED_PATH, name: 'red.png', bytes: 3 }]
}
const PASTED = `\u001b[200~${ATTACHED_PATH}\u001b[201~`

/** The environment a stub process gets: only what node needs to start on each OS. */
function stubEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of ['PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'HOME']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

function lane() {
  const control = new NodeProcessControl()
  const children: SpawnedProcess[] = []
  const folders: string[] = []
  const taskErrors: unknown[] = []

  afterEach(async () => {
    for (const child of children) child.stdin?.end()
    await Promise.all(
      children.splice(0).map((child) => Promise.race([child.exited, sleep(10_000)]))
    )
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
    expect(taskErrors.splice(0)).toEqual([])
  })

  function start(args: readonly string[]): SpawnedProcess {
    const child = control.spawn({
      executable: process.execPath,
      args: [...args],
      env: stubEnv(),
      cwd: dirname(READER),
      processGroup: 'inherit',
      stdio: 'pipe'
    })
    children.push(child)
    return child
  }

  function folder(): string {
    const made = mkdtempSync(join(tmpdir(), 'dwarfai-relay-'))
    folders.push(made)
    return made
  }

  /** The adapter aimed at `process`, over the real relay. */
  function sender(
    process_: ProcessIdentity,
    overrides: Partial<ConsoleTextDeliveryDeps> = {}
  ): ObservedSessionTurnSender {
    const scheduler = new NodeScheduler({ onTaskError: (error) => taskErrors.push(error) })
    return new ObservedSessionTurnSender({
      targets: {
        targetOf: () => ({
          providerId: 'claude',
          providerSessionId: 'session-1',
          process: process_
        })
      },
      terminal: new ConsoleTextDelivery({
        processes: control,
        platform: process.platform,
        env: process.env,
        cwd: tmpdir(),
        scheduler,
        ...overrides
      }),
      codex: new CodexThreadQueue({
        processes: control,
        executable: async () => null,
        env: {},
        cwd: tmpdir(),
        scheduler
      })
    })
  }

  return { start, folder, sender }
}

describe.runIf(process.platform === 'win32')('ObservedSessionTurnSender on Windows (L8)', () => {
  const { start, sender } = lane()

  it('[ADR-022] a stub terminal session receives the relayed text exactly once', async () => {
    const child = start([READER, 'reader', '60000'])
    const chunks: string[] = []
    let buffered = ''
    let listening!: () => void
    const ready = new Promise<void>((resolve) => (listening = resolve))
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const parts = buffered.split('\n')
      buffered = parts.pop() ?? ''
      for (const line of parts) {
        const read = line.trim()
        if (read === 'ready') listening()
        else if (read.startsWith('key ')) chunks.push(read.slice(4))
      }
    })
    await ready
    const identity = await child.identity

    const result = await sender(identity).send(DWARF, TURN)
    expect(result).toMatchObject({ ok: true, value: { confidence: 'unconfirmed' } })
    const deadline = Date.now() + 10_000
    const received = () => Buffer.from(chunks.join(''), 'hex').toString('utf8')
    while (!received().endsWith('\r') && Date.now() < deadline) await sleep(50)
    await sleep(QUIET_MS)
    expect(received()).toBe(`${RELAYED}\r`)
  }, 60_000)

  // APPENDED for #1463: the files go first, each as a bracketed paste, then the words, then Enter.
  it('[US-MSG-002.AC03] a stub terminal session receives each file as a bracketed paste ahead of the text, exactly once', async () => {
    const child = start([READER, 'reader', '60000'])
    const chunks: string[] = []
    let buffered = ''
    let listening!: () => void
    const ready = new Promise<void>((resolve) => (listening = resolve))
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const parts = buffered.split('\n')
      buffered = parts.pop() ?? ''
      for (const line of parts) {
        const read = line.trim()
        if (read === 'ready') listening()
        else if (read.startsWith('key ')) chunks.push(read.slice(4))
      }
    })
    await ready
    const identity = await child.identity

    const result = await sender(identity).send(DWARF, ATTACHED_TURN)
    expect(result).toMatchObject({ ok: true, value: { confidence: 'unconfirmed' } })
    const deadline = Date.now() + 10_000
    const received = () => Buffer.from(chunks.join(''), 'hex').toString('utf8')
    while (!received().endsWith('\r') && Date.now() < deadline) await sleep(50)
    await sleep(QUIET_MS)
    expect(received()).toBe(`${PASTED}${RELAYED}\r`)
  }, 60_000)
})

/** A stub `ps` and `tmux` (the tmux one keeps its buffer and records each paste and key). */
const POSIX_TOOLS = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const [mode, tty, dir, ...args] = process.argv.slice(2)
if (mode === 'ps') process.stdout.write(tty + '\\n')
else if (args[0] === 'list-panes') process.stdout.write('%7 /dev/' + tty + ' 1\\n')
else if (args[0] === 'load-buffer') writeFileSync(dir + '/buffer', readFileSync(0))
else if (args[0] === 'paste-buffer') appendFileSync(dir + '/sent.jsonl', JSON.stringify(['paste', args, readFileSync(dir + '/buffer', 'utf8')]) + '\\n')
else if (args[0] === 'send-keys') appendFileSync(dir + '/sent.jsonl', JSON.stringify(['keys', args]) + '\\n')
else process.exit(1)
`

describe.runIf(process.platform !== 'win32')(
  'ObservedSessionTurnSender on macOS and Linux (L8)',
  () => {
    const { start, folder, sender } = lane()

    it('[ADR-022] a stub terminal session receives the relayed text exactly once', async () => {
      const identity = await start([SLEEPER, 'sleep', '60000']).identity
      const dir = folder()
      const tools = join(dir, 'tools.mjs')
      writeFileSync(tools, POSIX_TOOLS)
      const result = await sender(identity, {
        commands: {
          ps: { executable: process.execPath, prefix: [tools, 'ps', 'pts/77', dir] },
          tmux: { executable: process.execPath, prefix: [tools, 'tmux', 'pts/77', dir] }
        }
      }).send(DWARF, TURN)
      expect(result).toMatchObject({ ok: true, value: { confidence: 'unconfirmed' } })
      const sent = readFileSync(join(dir, 'sent.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as unknown)
      expect(sent).toEqual([
        ['paste', ['paste-buffer', '-p', '-d', '-b', 'dwarfai-miners', '-t', '%7'], RELAYED],
        ['keys', ['send-keys', '-t', '%7', 'Enter']]
      ])
    }, 60_000)

    // APPENDED for #1463: one buffer carries the file's bracketed paste, then the words.
    it('[US-MSG-002.AC03] a stub terminal session receives each file as a bracketed paste ahead of the text, exactly once', async () => {
      const identity = await start([SLEEPER, 'sleep', '60000']).identity
      const dir = folder()
      const tools = join(dir, 'tools.mjs')
      writeFileSync(tools, POSIX_TOOLS)
      const result = await sender(identity, {
        commands: {
          ps: { executable: process.execPath, prefix: [tools, 'ps', 'pts/77', dir] },
          tmux: { executable: process.execPath, prefix: [tools, 'tmux', 'pts/77', dir] }
        }
      }).send(DWARF, ATTACHED_TURN)
      expect(result).toMatchObject({ ok: true, value: { confidence: 'unconfirmed' } })
      const sent = readFileSync(join(dir, 'sent.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as unknown)
      expect(sent).toEqual([
        [
          'paste',
          ['paste-buffer', '-p', '-d', '-b', 'dwarfai-miners', '-t', '%7'],
          `${PASTED}${RELAYED}`
        ],
        ['keys', ['send-keys', '-t', '%7', 'Enter']]
      ])
    }, 60_000)
  }
)
