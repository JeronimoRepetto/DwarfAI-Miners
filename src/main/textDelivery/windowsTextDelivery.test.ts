import { describe, expect, it, vi } from 'vitest'
import { WINDOWS_COMMAND_LINE_LIMIT } from '../domain/types'
import { FakeFs } from '../adapters/fakeFs'
import type { ShellRunner } from '../platform/focus'
import { workerSentinel, type ConsoleWorkerProcess } from './consoleWorker'
import { buildConsoleInputWriteCommand } from './consoleInputWrite'
import { relayTimeoutMsFor } from './relayRunner'
import {
  WindowsTextDelivery,
  createConsoleWriteRunner,
  type ConsoleWriteProcess
} from './windowsTextDelivery'

/** Hands out the given clock readings in order, so stage timings are exact. */
function clockOf(...readings: number[]): () => number {
  let index = 0
  return () => readings[Math.min(index++, readings.length - 1)] ?? 0
}

/**
 * A long-lived shell that answers every request the instant it is written, so
 * a delivery can be awaited without a real process or a real timer.
 */
function autoReplyShell() {
  const written: string[] = []
  const kill = vi.fn()
  const end = vi.fn()
  let onData: ((chunk: string) => void) | undefined

  const process: ConsoleWorkerProcess = {
    stdin: {
      write: (chunk: string) => {
        written.push(chunk)
        const id = Number(/CONSOLE:(\d+):0/.exec(chunk)?.[1] ?? 0)
        onData?.(`${workerSentinel(id, 0)}\n`)
      },
      end
    },
    stdout: {
      setEncoding: vi.fn(),
      on: (_event, listener) => {
        onData = listener
      }
    },
    on: vi.fn(),
    kill
  }

  return { process, written, kill, end }
}

/**
 * The three answers the focus seam can give (#329).
 *
 * AMENDED throughout this file for #329: the seam answered a bare boolean
 * until keystrokes had to know WHICH window came forward. `own-console` is a
 * window this session is alone on, `terminal-host` one whose tab strip the
 * panel cannot see into — see FocusReach in platform/focus.ts.
 */
const OWN_CONSOLE = { focused: true, reach: 'own-console' } as const
const TERMINAL_HOST = { focused: true, reach: 'terminal-host' } as const
const NOT_FOCUSED = { focused: false, reach: null } as const

/**
 * The chunks a pid-write script carries, in the order it writes them (#402).
 *
 * Read back out of the script's base64 blobs rather than asserted as PowerShell
 * text, for the reason the blobs exist: the payload never appears in the script
 * as anything a tokenizer could reach.
 */
function chunksOf(script: string): string[] {
  return [...script.matchAll(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/g)].map((match) =>
    Buffer.from(match[1] ?? '', 'base64').toString('utf16le')
  )
}

function delivery(overrides: Partial<ConstructorParameters<typeof WindowsTextDelivery>[0]> = {}) {
  return new WindowsTextDelivery({
    home: 'C:\\Users\\j',
    relayModel: 'haiku',
    relayTimeoutMs: 60_000,
    env: { PATH: 'C:\\Windows' },
    focus: vi.fn().mockResolvedValue(OWN_CONSOLE),
    runPowerShell: vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 }),
    // AMENDED for #371: the pid write runs as its own hidden child rather than
    // through the keystroke transport, so it needs its own fake — a port built
    // here must never be able to reach a real powershell.exe, and a real one
    // would attach to whatever process holds the pid a test made up.
    runConsoleWrite: vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 }),
    runRelay: vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false }),
    ...overrides
  })
}

/**
 * The pid write (#371 step 2): text goes into the input buffer of the console
 * the session's own pid is attached to, so no window is raised, no keystroke is
 * synthesized, and which tab of a terminal host is in front stops mattering.
 *
 * AMENDED throughout this describe for #371. Every test here pinned the focus
 * step and the SendKeys command behind it, because this method typed into the
 * foreground until now; both are gone from this path. `focus.ts` is untouched
 * and still serves click-to-focus and the interrupt.
 */
describe('WindowsTextDelivery.sendToConsole', () => {
  it('writes into the console of the pid it was given, and raises no window at all', async () => {
    const focus = vi.fn()
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = delivery({ focus, runConsoleWrite })

    await expect(
      port.sendToConsole({ pid: 4242, text: 'run the tests', pressEnter: true })
    ).resolves.toEqual({ delivered: true, stages: { spawnMs: expect.any(Number) } })
    // The refusal this replaces began with a focus call; there is none to make.
    expect(focus).not.toHaveBeenCalled()
    const script = runConsoleWrite.mock.calls[0]?.[0] as string
    expect(script).toContain('AttachConsole(4242)')
    // AMENDED for #404: Enter now travels in its own WriteConsoleInputW call
    // rather than appended to the text's own — a live Claude Code TUI reads a
    // chunk carrying both as a paste, where a carriage return is line content
    // rather than a submit. AMENDED again for #402 for how that is read back:
    // the Enter is a second CHUNK, so the two calls are what states it.
    expect(chunksOf(script)).toEqual(['run the tests', '\r'])
    expect(script.match(/WriteConsoleInputW\(\$conin/g)?.length).toBe(2)
    // The text rides as base64, so nothing a shell re-parses ever holds it.
    expect(script).not.toContain('run the tests')
  })

  it('leaves the line unsent when pressEnter is false', async () => {
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = delivery({ runConsoleWrite })

    await port.sendToConsole({ pid: 4242, text: '1', pressEnter: false })
    // AMENDED for #404, and again for #402: see above.
    expect(chunksOf(String(runConsoleWrite.mock.calls[0]?.[0]))).toEqual(['1'])
  })

  it('fails closed on a pid the builder will not accept, and runs nothing', async () => {
    const runConsoleWrite = vi.fn()
    const port = delivery({ runConsoleWrite })

    const result = await port.sendToConsole({ pid: 0, text: 'hi', pressEnter: true })
    // A script built around a junk pid would attach to whatever process holds
    // that number, and a write into a stranger's console cannot be taken back.
    expect(result).toMatchObject({ delivered: false, neverStarted: true })
    expect(result.error).toBeTruthy()
    expect(runConsoleWrite).not.toHaveBeenCalled()
  })

  it('says the attach was refused, and that nothing was written, on exit 2', async () => {
    const port = delivery({
      runConsoleWrite: vi.fn().mockResolvedValue({ stdout: '', exitCode: 2 })
    })

    const result = await port.sendToConsole({ pid: 4242, text: 'hi', pressEnter: true })
    // The measured failure of a pid whose session has ended. Nothing reached a
    // console, so `neverStarted` lets the relay behind this carry the message.
    expect(result).toMatchObject({ delivered: false, neverStarted: true })
    expect(result.error).toMatch(/attach/i)
  })

  it('says the console input would not open, and that nothing was written, on exit 3', async () => {
    const port = delivery({
      runConsoleWrite: vi.fn().mockResolvedValue({ stdout: '', exitCode: 3 })
    })

    const result = await port.sendToConsole({ pid: 4242, text: 'hi', pressEnter: true })
    expect(result).toMatchObject({ delivered: false, neverStarted: true })
    expect(result.error).toMatch(/open/i)
    // A distinct sentence from the attach refusal: the runtime log has to be
    // able to say which of the three happened.
    expect(result.error).not.toMatch(/attach/i)
  })

  it('does not call a short write neverStarted, since some records may have landed', async () => {
    const port = delivery({
      runConsoleWrite: vi.fn().mockResolvedValue({ stdout: '', exitCode: 4 })
    })

    const result = await port.sendToConsole({ pid: 4242, text: 'hi', pressEnter: true })
    expect(result.delivered).toBe(false)
    // `WriteConsoleInput` reported fewer events than it was given, so part of
    // the message may be in the session already — relaying it again would put
    // the person's words in twice.
    expect(result.neverStarted).toBeUndefined()
    expect(result.error).toBeTruthy()
  })

  it('turns a crashing shell into a failed verdict instead of a rejection', async () => {
    const port = delivery({
      runConsoleWrite: vi.fn().mockRejectedValue(new Error('powershell.exe is missing'))
    })
    await expect(
      port.sendToConsole({ pid: 4242, text: 'hi', pressEnter: false })
    ).resolves.toMatchObject({ delivered: false })
  })

  it('keeps the message out of the failure text', async () => {
    const port = delivery({
      runConsoleWrite: vi.fn().mockResolvedValue({ stdout: '', exitCode: 4 })
    })
    const result = await port.sendToConsole({
      pid: 4242,
      text: 'my-secret-payload',
      pressEnter: false
    })
    expect(result.error).not.toContain('my-secret-payload')
  })
})

/**
 * `pasteToConsole` is the port method the runtime's MESSAGE route calls, and
 * since #371 nothing about it is a paste: it reaches the same pid write
 * `sendToConsole` does. The two names stay until the port's own vocabulary is
 * renamed, which is a runtime-side change this one keeps out.
 *
 * AMENDED throughout this describe for #371. The clipboard save/restore dance
 * these tests pinned no longer exists — the message never travels on the
 * person's clipboard, so there is nothing to borrow and nothing to put back —
 * and the seam it was asserted through is gone from the port's options.
 */
describe('WindowsTextDelivery.pasteToConsole', () => {
  it('writes the message into the session console rather than pasting it anywhere', async () => {
    const focus = vi.fn()
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = delivery({ focus, runConsoleWrite })

    await expect(
      port.pasteToConsole({ pid: 4242, text: 'run the tests', pressEnter: true })
    ).resolves.toEqual({ delivered: true, stages: { spawnMs: expect.any(Number) } })
    expect(focus).not.toHaveBeenCalled()
    const script = runConsoleWrite.mock.calls[0]?.[0] as string
    expect(script).toContain('AttachConsole(4242)')
    expect(script).not.toContain('SendWait')
    expect(script).not.toContain('run the tests')
  })

  it('is the same write a permission digit takes, so the two cannot drift apart', async () => {
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = delivery({ runConsoleWrite })

    await port.pasteToConsole({ pid: 4242, text: 'go', pressEnter: false })
    await port.sendToConsole({ pid: 4242, text: 'go', pressEnter: false })
    expect(runConsoleWrite.mock.calls[0]?.[0]).toBe(runConsoleWrite.mock.calls[1]?.[0])
  })

  it('leaves the message unsubmitted when pressEnter is false', async () => {
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = delivery({ runConsoleWrite })

    await port.pasteToConsole({ pid: 4242, text: 'hi', pressEnter: false })
    // AMENDED for #404: see the sendToConsole describe above.
    expect(runConsoleWrite.mock.calls[0]?.[0]).not.toContain('$enterUnits.Add([char]13)')
  })

  it('reports the fallback-triggering outcome when the attach was refused', async () => {
    const port = delivery({
      runConsoleWrite: vi.fn().mockResolvedValue({ stdout: '', exitCode: 2 })
    })

    const result = await port.pasteToConsole({ pid: 4242, text: 'hi', pressEnter: false })
    // `neverStarted` is the whole point: it proves nothing reached the console,
    // so the runtime may hand the same text to the relay without a double
    // delivery. It is the focus refusal's job that moved, not the flag's.
    expect(result).toMatchObject({ delivered: false, neverStarted: true })
  })

  it('turns a crashing shell into a failed verdict instead of a rejection', async () => {
    const port = delivery({
      runConsoleWrite: vi.fn().mockRejectedValue(new Error('powershell.exe is missing'))
    })

    const result = await port.pasteToConsole({ pid: 4242, text: 'hi', pressEnter: false })
    expect(result.delivered).toBe(false)
    // A throw can land after the write, so it is NOT neverStarted: the runtime
    // must not relay the same text behind it.
    expect(result.neverStarted).toBeUndefined()
  })

  it('keeps the message out of the failure text', async () => {
    const port = delivery({
      runConsoleWrite: vi.fn().mockResolvedValue({ stdout: '', exitCode: 4 })
    })
    const result = await port.pasteToConsole({
      pid: 4242,
      text: 'my-secret-payload',
      pressEnter: false
    })
    expect(result.error).not.toContain('my-secret-payload')
  })
})

describe('WindowsTextDelivery.relayToClaudeSession', () => {
  it('spawns one claude turn addressed at the target session', async () => {
    const runRelay = vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false })
    const port = delivery({ runRelay })

    await expect(
      port.relayToClaudeSession({ sessionName: 'sample-project-70', text: 'run the tests' })
    ).resolves.toEqual({ delivered: true })

    // AMENDED for #437 (the two `-p` assertions were
    // `expect(invocation.args[invocation.args.indexOf('-p') + 1]).toContain(...)`
    // for the session name and the message). The courier instruction is written
    // to the child's stdin now and nothing of it is in argv, so what the port
    // hands the runner is `instruction`; the spawn shape itself is pinned in
    // relayRunner.test.ts.
    const invocation = runRelay.mock.calls[0]?.[0]
    expect(invocation.command).toBe('C:\\Users\\j\\.local\\bin\\claude.exe')
    expect(invocation.args[invocation.args.indexOf('--model') + 1]).toBe('haiku')
    expect(invocation.instruction).toContain('sample-project-70')
    expect(invocation.instruction).toContain('run the tests')
    expect(invocation.args.join(' ')).not.toContain('run the tests')
    // AMENDED for #439 (was: `expect(invocation.timeoutMs).toBe(60_000)`). The
    // port still hands `relayTimeoutMs` in as the BASE unchanged; the scaling
    // now happens one level down, in `deliverViaRelay` (see relayRunner.ts and
    // relayRunner.test.ts, which pins the arithmetic on its own).
    expect(invocation.timeoutMs).toBe(relayTimeoutMsFor(60_000, 'run the tests'.length))
    expect(invocation.env.PATH).toBe('C:\\Users\\j\\.local\\bin;C:\\Windows')
  })

  it('treats a non-zero exit as an undelivered message', async () => {
    const port = delivery({
      runRelay: vi.fn().mockResolvedValue({ exitCode: 2, timedOut: false })
    })
    const result = await port.relayToClaudeSession({ sessionName: 'x', text: 'hi' })
    expect(result.delivered).toBe(false)
    expect(result.error).toBeTruthy()
  })

  // AMENDED for #439 (was: 'names the timeout when the relay ran out of
  // time', asserting only `delivered: false` and an error matching
  // /timed out/i). A courier killed by its own timeout may already have
  // delivered the message, so this is no longer an ordinary failure — see
  // relayRunner.test.ts, which pins the full reasoning on `deliverViaRelay`
  // itself.
  it('calls a killed relay unconfirmed rather than failed', async () => {
    const port = delivery({
      runRelay: vi.fn().mockResolvedValue({ exitCode: 1, timedOut: true })
    })
    const result = await port.relayToClaudeSession({ sessionName: 'x', text: 'hi' })
    expect(result.delivered).toBe(false)
    expect(result.unconfirmed).toBe(true)
    expect(result.error).toBe('The relay did not confirm in time; the message may have arrived.')
  })

  it('turns a failed spawn into a failed verdict instead of a rejection', async () => {
    const port = delivery({ runRelay: vi.fn().mockRejectedValue(new Error('ENOENT')) })
    await expect(
      port.relayToClaudeSession({ sessionName: 'x', text: 'hi' })
    ).resolves.toMatchObject({ delivered: false })
  })

  it('keeps the message out of the failure text', async () => {
    const port = delivery({
      runRelay: vi.fn().mockResolvedValue({ exitCode: 2, timedOut: false })
    })
    const result = await port.relayToClaudeSession({
      sessionName: 'x',
      text: 'my-secret-payload'
    })
    expect(result.error).not.toContain('my-secret-payload')
  })
})

describe('WindowsTextDelivery.sendInterrupt', () => {
  it('brings the hosting terminal forward before sending the interrupt keystroke', async () => {
    const order: string[] = []
    const focus = vi.fn().mockImplementation(async () => {
      order.push('focus')
      return OWN_CONSOLE
    })
    const runPowerShell = vi.fn().mockImplementation(async () => {
      order.push('interrupt')
      return { stdout: '', exitCode: 0 }
    })
    const port = delivery({ focus, runPowerShell })

    await expect(port.sendInterrupt({ pid: 42 })).resolves.toEqual({
      delivered: true,
      stages: { focusMs: expect.any(Number), spawnMs: expect.any(Number) }
    })
    expect(focus).toHaveBeenCalledWith(42)
    expect(order).toEqual(['focus', 'interrupt'])
    expect(runPowerShell.mock.calls[0]?.[0]).toContain("SendWait('{ESC}')")
  })

  it('never sends the keystroke when the terminal could not be foregrounded', async () => {
    const runPowerShell = vi.fn()
    const port = delivery({ focus: vi.fn().mockResolvedValue(NOT_FOCUSED), runPowerShell })

    const result = await port.sendInterrupt({ pid: 42 })
    expect(result.delivered).toBe(false)
    expect(result.error).toMatch(/foreground|terminal/i)
    expect(runPowerShell).not.toHaveBeenCalled()
  })

  it('reports a failure when the keystroke command exits non-zero', async () => {
    const port = delivery({
      runPowerShell: vi.fn().mockResolvedValue({ stdout: '', exitCode: 1 })
    })
    const result = await port.sendInterrupt({ pid: 42 })
    expect(result.delivered).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('turns a crashing shell into a failed verdict instead of a rejection', async () => {
    const port = delivery({
      runPowerShell: vi.fn().mockRejectedValue(new Error('powershell.exe is missing'))
    })
    await expect(port.sendInterrupt({ pid: 42 })).resolves.toMatchObject({ delivered: false })
  })
})

/**
 * A host-level focus is not enough for a keystroke (#329).
 *
 * Measured live: two Claude sessions in two tabs of ONE Windows Terminal
 * window, so neither `claude` owns a console of its own and the ancestor walk
 * reaches the shared host for both. Foregrounding that raises whichever tab the
 * person last used, and every keystroke after it went to THAT session — an Esc
 * meant for one foreman interrupted the other. Nothing typed is preferable, and
 * `neverStarted` is what lets the relay carry the message instead.
 *
 * AMENDED for #371: that refusal now covers the keystroke tiers ONLY. A message
 * and a permission digit are written into the session's own console by pid, and
 * a write consults no window, so the shared tab strip has nothing to refuse —
 * the two tests that pinned the refusal on those paths are replaced by the two
 * below, which pin the opposite and are what #371 exists for.
 */
/*
 * Attachments through the same write (#408). The route is the one #371 built
 * and #404 corrected; what is new is that a path travels inside bracketed-paste
 * markers, which is what makes the receiving CLI attach the file rather than
 * read a path as words. Measured 2026-09-16, `docs/console-hosting.md` §6.
 */
describe('WindowsTextDelivery.pasteToConsole — with attachments', () => {
  const shot = {
    path: 'C:\\work\\red.png',
    name: 'red.png',
    kind: 'image' as const,
    bytes: 900
  }
  const notes = {
    path: 'C:\\work\\notes.txt',
    name: 'notes.txt',
    kind: 'file' as const,
    bytes: 120
  }

  it('wraps the path in paste markers and gives Enter its own call behind it', async () => {
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = delivery({ runConsoleWrite })

    const result = await port.pasteToConsole({
      pid: 4242,
      text: 'look at this',
      pressEnter: true,
      attachments: [shot]
    })

    expect(result.delivered).toBe(true)
    const script = String(runConsoleWrite.mock.calls[0]?.[0])
    expect(chunksOf(script)).toEqual([`\u001b[200~${shot.path}\u001b[201~`, 'look at this', '\r'])
    // Three chunks means three calls, which is the rule a paste needs hardest:
    // with no pause the image attached and the Enter never submitted.
    expect(script.match(/WriteConsoleInputW\(\$conin/g)?.length).toBe(3)
    // The path rides as base64 like every other payload, so no shell re-parses it.
    expect(script).not.toContain(shot.path)
  })

  it('sends a message that is only files, with no empty chunk for the absent words', async () => {
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = delivery({ runConsoleWrite })

    await port.pasteToConsole({ pid: 4242, text: '', pressEnter: true, attachments: [shot] })
    expect(chunksOf(String(runConsoleWrite.mock.calls[0]?.[0]))).toEqual([
      `\u001b[200~${shot.path}\u001b[201~`,
      '\r'
    ])
  })

  it('pastes several files in the order the composer held them', async () => {
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = delivery({ runConsoleWrite })

    await port.pasteToConsole({
      pid: 4242,
      text: '',
      pressEnter: false,
      attachments: [shot, notes]
    })
    expect(chunksOf(String(runConsoleWrite.mock.calls[0]?.[0]))).toEqual([
      `\u001b[200~${shot.path}\u001b[201~`,
      `\u001b[200~${notes.path}\u001b[201~`
    ])
  })

  it('writes the old two-chunk shape when there is nothing attached', async () => {
    // The text-only path is untouched by #408, and this is what says so.
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = delivery({ runConsoleWrite })

    await port.pasteToConsole({ pid: 4242, text: 'plain', pressEnter: true, attachments: [] })
    expect(chunksOf(String(runConsoleWrite.mock.calls[0]?.[0]))).toEqual(['plain', '\r'])
  })

  it('fails closed on a junk pid even with files to send, and runs nothing', async () => {
    const runConsoleWrite = vi.fn()
    const port = delivery({ runConsoleWrite })

    const result = await port.pasteToConsole({
      pid: 0,
      text: '',
      pressEnter: true,
      attachments: [shot]
    })
    expect(result).toMatchObject({ delivered: false, neverStarted: true })
    expect(runConsoleWrite).not.toHaveBeenCalled()
  })
})

describe('WindowsTextDelivery — a host window is never proof of the session (#329)', () => {
  function hostFocused(overrides: Parameters<typeof delivery>[0] = {}) {
    return delivery({ focus: vi.fn().mockResolvedValue(TERMINAL_HOST), ...overrides })
  }

  it('delivers the message anyway, because the write never asks which tab is in front', async () => {
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = hostFocused({ runConsoleWrite })

    const result = await port.pasteToConsole({ pid: 4242, text: 'run the tests', pressEnter: true })
    // The multi-tab user whose words used to travel over the relay framed as a
    // peer's now has them arrive as their own prompt (#371, #378).
    expect(result.delivered).toBe(true)
    expect(runConsoleWrite.mock.calls[0]?.[0]).toContain('AttachConsole(4242)')
  })

  it('lands the permission digit in the session that drew the dialog, tab strip or not', async () => {
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = hostFocused({ runConsoleWrite })

    const result = await port.sendToConsole({ pid: 4242, text: '1', pressEnter: false })
    expect(result.delivered).toBe(true)
    expect(runConsoleWrite.mock.calls[0]?.[0]).toContain('AttachConsole(4242)')
  })

  /*
   * The keystroke this issue was reported for. Kick no longer takes this path
   * at all (it ends the process instead), but a permission DENY still presses
   * Esc through here, and an Esc into the wrong tab is the same lost turn.
   */
  it('sends no interrupt keystroke, which is the Esc that reached the wrong session', async () => {
    const runPowerShell = vi.fn()
    const port = hostFocused({ runPowerShell })

    const result = await port.sendInterrupt({ pid: 42 })
    expect(result).toMatchObject({ delivered: false, neverStarted: true })
    expect(result.error).toMatch(/shares its terminal window/i)
    expect(runPowerShell).not.toHaveBeenCalled()
  })

  /*
   * Two tests stood here and went with their subject in #371: one pinned that a
   * refused paste put the person's clipboard back, and one that the refusal
   * never quoted the message. The message path borrows no clipboard and states
   * no shared-window refusal any more — the privacy assertion lives on in
   * `pasteToConsole`'s own 'keeps the message out of the failure text', and the
   * refusal itself is still pinned on the two tiers that still synthesize a
   * keystroke — the interrupt above, and the question picker further down.
   */
})

/**
 * Issue #21: a Kick or Send that "feels slow" was previously logged as nothing
 * but a verdict. Each tier now reports how long its own stages took, so the
 * runtime can put real numbers in the log instead of guesses.
 */
describe('WindowsTextDelivery stage instrumentation', () => {
  /*
   * AMENDED for #371: the write by pid has one stage, because it has one step.
   * The focus stage this pinned belonged to the paste path, and the tiers that
   * still focus — the interrupt below — still report both.
   */
  it('times the one child the pid write spawns', async () => {
    const port = delivery({ now: clockOf(0, 30) })

    const result = await port.sendToConsole({ pid: 4242, text: 'hi', pressEnter: false })
    expect(result.stages).toEqual({ spawnMs: 30 })
  })

  it('times the interrupt path the same way', async () => {
    const port = delivery({ now: clockOf(0, 5, 5, 25) })

    const result = await port.sendInterrupt({ pid: 42 })
    expect(result.stages).toEqual({ focusMs: 5, spawnMs: 20 })
  })

  it('leaves the relay tier unmeasured here — the runtime times that call itself', async () => {
    const port = delivery({ now: clockOf(0, 5_210) })

    const result = await port.relayToClaudeSession({ sessionName: 'x', text: 'hi' })
    expect(result.stages).toBeUndefined()
  })

  it('still reports the stages of an attempt that failed', async () => {
    const port = delivery({
      now: clockOf(0, 9),
      focus: vi.fn().mockResolvedValue(NOT_FOCUSED)
    })

    const result = await port.sendInterrupt({ pid: 42 })
    expect(result.delivered).toBe(false)
    expect(result.stages).toEqual({ focusMs: 9 })
  })

  it('never puts the message anywhere near the timings', async () => {
    const port = delivery({ now: clockOf(0, 1, 1, 2) })

    const result = await port.sendToConsole({
      pid: 4242,
      text: 'my-secret-payload',
      pressEnter: false
    })
    expect(JSON.stringify(result)).not.toContain('my-secret-payload')
  })
})

/**
 * The persistent console worker: one powershell.exe carries every keystroke and
 * interrupt instead of paying a fresh -NoProfile start per action.
 */
describe('WindowsTextDelivery console transport', () => {
  function workerDelivery(
    spawnConsoleWorker: () => ConsoleWorkerProcess,
    fallback?: ShellRunner,
    runConsoleWrite?: ShellRunner
  ) {
    return new WindowsTextDelivery({
      home: 'C:\Users\j',
      relayModel: 'haiku',
      relayTimeoutMs: 60_000,
      env: { PATH: 'C:\Windows' },
      focus: vi.fn().mockResolvedValue(OWN_CONSOLE),
      runRelay: vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false }),
      spawnConsoleWorker,
      ...(fallback === undefined ? {} : { runPowerShell: fallback }),
      ...(runConsoleWrite === undefined ? {} : { runConsoleWrite })
    })
  }

  /*
   * AMENDED for #371: four tests here drove the transport through
   * `sendToConsole`, which no longer uses it — the pid write is a child of its
   * own (see the test below). They drive it through the keystroke tiers that
   * still do, which is the same transport and the same assertion.
   *
   * AMENDED again for #402: the answer tier left the shell with them, so the
   * two actions this drives are both interrupts. What it pins is unchanged —
   * one shell, spawned once, carrying every keystroke action in turn.
   */
  it('runs every console action through one long-lived shell', async () => {
    const shell = autoReplyShell()
    const spawn = vi.fn(() => shell.process)
    const port = workerDelivery(spawn)

    await expect(port.sendInterrupt({ pid: 42 })).resolves.toMatchObject({ delivered: true })
    await expect(port.sendInterrupt({ pid: 43 })).resolves.toMatchObject({ delivered: true })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(shell.written).toHaveLength(2)
  })

  /*
   * The decision this test exists for. `FreeConsole`/`AttachConsole` rebind the
   * CALLING process's console, so a write run on the shared shell would leave
   * that shell attached to somebody else's console for every later action —
   * and the queue behind it serializes the write against keystrokes it has
   * nothing to do with. The write gets a hidden child per action instead.
   */
  it('never routes the pid write through the long-lived shell', async () => {
    const shell = autoReplyShell()
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = workerDelivery(() => shell.process, undefined, runConsoleWrite)

    await expect(
      port.sendToConsole({ pid: 4242, text: 'hi', pressEnter: false })
    ).resolves.toMatchObject({ delivered: true })

    expect(shell.written).toHaveLength(0)
    expect(runConsoleWrite).toHaveBeenCalledTimes(1)
  })

  it('hands the existing command builders through untouched', async () => {
    const shell = autoReplyShell()
    const port = workerDelivery(() => shell.process)

    await port.sendInterrupt({ pid: 42 })

    const encoded = /FromBase64String\('([^']+)'\)/.exec(shell.written[0] ?? '')?.[1] ?? ''
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toContain("SendWait('{ESC}')")
  })

  it('falls back to a per-action spawn when the persistent shell cannot be started', async () => {
    const fallback = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = workerDelivery(() => {
      throw new Error('ENOENT')
    }, fallback)

    await expect(port.sendInterrupt({ pid: 42 })).resolves.toMatchObject({ delivered: true })
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('reports a failed verdict, never a rejection, when both transports are gone', async () => {
    const fallback = vi.fn().mockRejectedValue(new Error('powershell.exe is missing'))
    const port = workerDelivery(() => {
      throw new Error('ENOENT')
    }, fallback)

    await expect(port.sendInterrupt({ pid: 42 })).resolves.toMatchObject({ delivered: false })
  })

  it('shuts the persistent shell down cleanly on dispose', async () => {
    const shell = autoReplyShell()
    const port = workerDelivery(() => shell.process)

    await port.sendInterrupt({ pid: 42 })
    port.dispose()

    expect(shell.end).toHaveBeenCalled()
    expect(shell.kill).toHaveBeenCalled()
  })

  it('is safe to dispose a port that never opened a shell', () => {
    const port = workerDelivery(() => autoReplyShell().process)
    expect(() => port.dispose()).not.toThrow()
  })
})

/**
 * The Codex message queue (#97). Windows is the platform this channel was
 * actually proven on, and it needs no PowerShell, no window and no pid — only
 * the detected binary and the thread UUID.
 */
describe('WindowsTextDelivery.queueToCodexThread', () => {
  const THREAD_ID = '01a04d79-5c87-7a31-9b1a-4aacc350d6fd'

  it('spawns the detected codex.exe with the thread and the message as argv', async () => {
    const runCodexQueue = vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false })
    const port = delivery({
      codexBinary: async () => 'C:\\Users\\j\\.local\\bin\\codex.exe',
      runCodexQueue
    })

    await expect(
      port.queueToCodexThread({ threadId: THREAD_ID, text: 'run the tests' })
    ).resolves.toEqual({ delivered: true })
    expect(runCodexQueue.mock.calls[0]?.[0]).toMatchObject({
      command: 'C:\\Users\\j\\.local\\bin\\codex.exe',
      args: ['queue', '--thread', THREAD_ID, '--message', 'run the tests']
    })
  })

  /**
   * The npm-global install's `.cmd` cannot be spawned without a shell, and a
   * shell would re-parse the payload — so it is resolved to the node entry it
   * names and run directly, no shell involved, exactly as the launcher already
   * does (#193, #413). See resolveProgram in platform/cliDetection.ts.
   */
  it('resolves a .cmd shim to its node entry and queues through it, never a shell', async () => {
    const npmDir = 'C:\\Users\\j\\AppData\\Roaming\\npm'
    const npmShim = `${npmDir}\\codex.cmd`
    const npmEntry = `${npmDir}\\node_modules\\@openai\\codex\\bin\\codex.js`
    const fs = new FakeFs()
    fs.addFile(
      npmShim,
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ') ELSE (',
        '  SET "_prog=node"',
        '  SET PATHEXT=%PATHEXT:;.JS;=;%',
        ')',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
      ].join('\r\n')
    )
    const runCodexQueue = vi.fn().mockResolvedValue({ exitCode: 0, timedOut: false })
    const port = delivery({
      codexBinary: async () => npmShim,
      runCodexQueue,
      fs
    })

    const outcome = await port.queueToCodexThread({ threadId: THREAD_ID, text: 'hi' })

    expect(outcome).toEqual({ delivered: true })
    expect(runCodexQueue.mock.calls[0]?.[0]).toMatchObject({
      command: 'node',
      args: [npmEntry, 'queue', '--thread', THREAD_ID, '--message', 'hi']
    })
  })

  it('says the queue command could not be started when the shim cannot be read', async () => {
    const runCodexQueue = vi.fn()
    const port = delivery({
      codexBinary: async () => 'C:\\Users\\j\\AppData\\Roaming\\npm\\codex.cmd',
      runCodexQueue,
      fs: new FakeFs()
    })

    const outcome = await port.queueToCodexThread({ threadId: THREAD_ID, text: 'hi' })

    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toContain('could not be started')
    expect(runCodexQueue).not.toHaveBeenCalled()
  })

  it('refuses with a reason when codex was never detected', async () => {
    const outcome = await delivery({ runCodexQueue: vi.fn() }).queueToCodexThread({
      threadId: THREAD_ID,
      text: 'hi'
    })
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toBeTruthy()
  })

  it('never echoes the message back in a refusal', async () => {
    const outcome = await delivery({ runCodexQueue: vi.fn() }).queueToCodexThread({
      threadId: THREAD_ID,
      text: 'my-secret-payload'
    })
    expect(outcome.error).not.toContain('my-secret-payload')
  })
})

/**
 * The Codex resume tier (#450/#462) — the channel that reaches a thread
 * nothing is running. No test named this tier before #462 — this is new
 * coverage, not an amendment.
 */
describe('WindowsTextDelivery.resumeCodexThread', () => {
  const THREAD_ID = '01a0af41-d1c5-7621-ba46-75eaef3eaeb2'
  const CWD = 'C:\\Users\\j\\projects\\sample-project'

  it('reaches the detected codex.exe with a tuned resume argv', async () => {
    const runCodexResume = vi.fn().mockResolvedValue({ running: true })
    const port = delivery({
      codexBinary: async () => 'C:\\Users\\j\\.local\\bin\\codex.exe',
      runCodexResume,
      fs: new FakeFs()
    })

    await expect(
      port.resumeCodexThread({
        threadId: THREAD_ID,
        cwd: CWD,
        text: 'run the tests',
        tuning: { model: 'gpt-5.6-sol', effort: 'high' }
      })
    ).resolves.toEqual({ delivered: true })
    expect(runCodexResume.mock.calls[0]?.[0]).toMatchObject({
      command: 'C:\\Users\\j\\.local\\bin\\codex.exe',
      args: [
        'exec',
        '-m',
        'gpt-5.6-sol',
        '-c',
        'model_reasoning_effort=high',
        'resume',
        THREAD_ID,
        '-'
      ],
      cwd: CWD
    })
  })

  it('reaches the bare argv when no tuning was asked for', async () => {
    const runCodexResume = vi.fn().mockResolvedValue({ running: true })
    const port = delivery({
      codexBinary: async () => 'C:\\Users\\j\\.local\\bin\\codex.exe',
      runCodexResume,
      fs: new FakeFs()
    })

    await port.resumeCodexThread({ threadId: THREAD_ID, cwd: CWD, text: 'hi' })
    expect(runCodexResume.mock.calls[0]?.[0]).toMatchObject({
      args: ['exec', 'resume', THREAD_ID, '-']
    })
  })
})

/**
 * Kick's terminal tier: ask the session to exit cleanly, then force it if it
 * will not (#358, over #329).
 *
 * #329 made this a pure tree kill — no window, no keystroke — because a pid
 * cannot be the wrong session the way a foreground window can. But a taskkill /F
 * gives the Claude TUI no chance to reset the terminal modes it turned on
 * (mouse tracking above all), so the console prints endless SGR mouse reports
 * afterwards. So #358 tries a clean exit FIRST — but only on a console this
 * session is provably alone on (#329's shared-tab refusal stays), and only for a
 * pid re-verified at the moment of the act (#231's fail-closed guard stays). The
 * force kill is the same per-OS port a launched session's exit uses (#217) and
 * is the fallback whenever the clean exit is unsafe or does not take.
 */
describe('WindowsTextDelivery.endConsoleSession', () => {
  /** The creation time the provider verified and put on the wire. */
  const EXPECTED_START_MS = 1_788_001_972_136

  /**
   * AMENDED throughout this block for the #329 review: an end now names the
   * creation time it expects, and the port re-probes the pid before killing it.
   * The four cases below are unchanged in what they assert.
   *
   * AMENDED for #366: `ProcessEndPort` grew the two direct-pid signals the
   * POSIX end tier needs, so this fake carries them. They are asserted never to
   * be called — the Windows tier ends a TREE, and a direct signal here would be
   * the launched tier's group mistake in reverse.
   */
  function ender(
    endProcessTree = vi.fn().mockResolvedValue(true),
    processStartTimeMs = vi.fn().mockResolvedValue(EXPECTED_START_MS),
    extra: Parameters<typeof delivery>[0] = {}
  ) {
    const terminateProcess = vi.fn().mockResolvedValue(false)
    const killProcess = vi.fn().mockResolvedValue(false)
    const port = delivery({
      processEnd: { endProcessTree, terminateProcess, killProcess },
      processProbe: { isCodexProcessRunning: vi.fn(), processStartTimeMs },
      // #358: the graceful-first grace window polls the pid on an injected
      // delay, so a unit test resolves it instantly instead of waiting ~3s.
      sleep: async () => {},
      ...extra
    })
    return { port, endProcessTree, processStartTimeMs, terminateProcess, killProcess }
  }

  /*
   * AMENDED for #358 (was: "ends the session's own process tree without
   * touching a window", asserting focus was never called). #358 tries a clean
   * exit first, so it DOES focus the console now — but only to type into a
   * window this session is alone on. When the console will not come forward
   * there is nowhere safe to send the clean-exit keystroke, so no key is sent
   * and the forced tree kill still ends the session, exactly as #329 did.
   */
  it('sends no clean-exit keystroke when the console will not come forward, and force-kills the tree (#358)', async () => {
    const focus = vi.fn().mockResolvedValue(NOT_FOCUSED)
    // AMENDED for #504: `runPowerShell` used to be asserted uncalled outright
    // on this path. It is legitimately reached once now — read-only, to
    // resolve the ancestor chain the terminal reset may attach to — so the
    // guarantee this test actually owes is narrowed to what it always meant:
    // no KEYSTROKE of any kind reaches a console the panel is not sure of.
    // `SendKeys` rather than the clean exit's own `^c`, so a future key that
    // is not that one cannot slip onto this path unnoticed.
    const runPowerShell = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const { port, endProcessTree } = ender(undefined, undefined, { focus, runPowerShell })

    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: true })
    expect(endProcessTree).toHaveBeenCalledWith(4242)
    expect(runPowerShell.mock.calls.some((call) => String(call[0]).includes('SendKeys'))).toBe(
      false
    )
  })

  /*
   * taskkill exits 128 for a pid it cannot find, and the port already reports
   * that as false rather than as an ended session (see processEnd.ts). A second
   * kick therefore reports a refusal, never a second success — the exit-0-shaped
   * lie this repo keeps refusing to tell.
   */
  it('reports a refusal when the platform would not end the tree', async () => {
    const { port } = ender(vi.fn().mockResolvedValue(false))
    const outcome = await port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toBeTruthy()
  })

  it('turns a throwing port into a failed verdict instead of a rejection', async () => {
    const { port } = ender(vi.fn().mockRejectedValue(new Error('taskkill is missing')))
    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: false })
  })

  it('times the end the way every other tier times its own work', async () => {
    const { port } = ender(undefined, undefined, { now: clockOf(0, 40) })
    const outcome = await port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    expect(outcome.stages).toEqual({ spawnMs: 40 })
  })

  /*
   * The pid is re-verified at the moment of the act — #231's rule, which the
   * launched tier already holds — rather than trusted from the poll that
   * produced it. A poll can be two seconds old, a pid can be recycled in
   * between, and `taskkill /T` on a recycled pid ends a stranger's program and
   * everything under it.
   *
   * This is the one place in the app where UNKNOWN is a refusal. The liveness
   * guard fails OPEN because a wrong "dead" only hides a dwarf; a kill fails
   * CLOSED because it cannot be taken back.
   */
  it('probes the pid immediately before the kill, and kills only on agreement', async () => {
    const order: string[] = []
    const processStartTimeMs = vi.fn().mockImplementation(async () => {
      order.push('probe')
      return EXPECTED_START_MS
    })
    const endProcessTree = vi.fn().mockImplementation(async () => {
      order.push('kill')
      return true
    })
    const { port } = ender(endProcessTree, processStartTimeMs)

    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: true })
    // AMENDED for #358: the graceful attempt and its grace-window poll probe the
    // pid first, so the invariant is now that the FORCED path re-probes
    // immediately before it kills — the last two acts are that verified probe
    // and the kill it licenses.
    expect(order.slice(-2)).toEqual(['probe', 'kill'])
    // One pid throughout, asked about and then acted on — never a different one.
    expect(processStartTimeMs).toHaveBeenCalledWith(4242)
    expect(endProcessTree).toHaveBeenCalledWith(4242)
  })

  it('accepts a reading inside the same tolerance the provider used', async () => {
    const { port, endProcessTree } = ender(
      undefined,
      vi.fn().mockResolvedValue(EXPECTED_START_MS + 1_500)
    )
    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: true })
    expect(endProcessTree).toHaveBeenCalled()
  })

  it('kills nothing when the pid now belongs to another process', async () => {
    const { port, endProcessTree } = ender(
      undefined,
      vi.fn().mockResolvedValue(EXPECTED_START_MS + 60_000)
    )
    const outcome = await port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toMatch(/could not be verified/i)
    expect(endProcessTree).not.toHaveBeenCalled()
  })

  it('kills nothing when the probe cannot answer, unlike the liveness guard', async () => {
    const { port, endProcessTree } = ender(undefined, vi.fn().mockResolvedValue(null))
    const outcome = await port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    expect(outcome.delivered).toBe(false)
    expect(endProcessTree).not.toHaveBeenCalled()
  })

  it('kills nothing when the probe itself throws', async () => {
    const { port, endProcessTree } = ender(
      undefined,
      vi.fn().mockRejectedValue(new Error('powershell is missing'))
    )
    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: false })
    expect(endProcessTree).not.toHaveBeenCalled()
  })

  /*
   * The clean-exit-first path (#358). On a console this session is alone on, the
   * kick presses Ctrl+C twice — the measured way the Claude TUI exits and
   * restores the terminal — and polls the pid for a bounded grace. The moment
   * the pid stops being this session, the terminal was handed back by the TUI's
   * own exit, so the force kill is never reached.
   */
  it('asks the session to exit cleanly and, once it goes, never force-kills it', async () => {
    const endProcessTree = vi.fn().mockResolvedValue(true)
    const runPowerShell = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    // Verified alive at the keystroke, still there on the first look, then gone.
    const processStartTimeMs = vi
      .fn()
      .mockResolvedValueOnce(EXPECTED_START_MS)
      .mockResolvedValueOnce(EXPECTED_START_MS)
      .mockResolvedValue(null)
    const { port } = ender(endProcessTree, processStartTimeMs, { runPowerShell })

    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: true })
    // Ctrl+C twice was the whole act; the /F kill never ran.
    expect(runPowerShell.mock.calls[0]?.[0]).toContain("SendWait('^c')")
    expect(endProcessTree).not.toHaveBeenCalled()
  })

  /*
   * The fallback stays exactly the forced kill it always was. A session that
   * does not go within the grace window is force-killed, and the outcome is the
   * same delivered:true #329 produced — the clean exit is an attempt, never a
   * replacement for the guarantee.
   */
  it('force-kills the session when the clean exit does not take within the grace window', async () => {
    const endProcessTree = vi.fn().mockResolvedValue(true)
    const runPowerShell = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    // Never goes: verified alive at the keystroke and on every poll after it.
    const processStartTimeMs = vi.fn().mockResolvedValue(EXPECTED_START_MS)
    const { port } = ender(endProcessTree, processStartTimeMs, { runPowerShell })

    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: true })
    expect(runPowerShell.mock.calls[0]?.[0]).toContain("SendWait('^c')")
    expect(endProcessTree).toHaveBeenCalledWith(4242)
  })

  /*
   * #329's shared-tab refusal survives #358 unchanged. A keystroke into a
   * terminal-host window lands in whichever tab is active, so no clean-exit
   * keystroke is sent there — the kick goes straight to the forced tree kill,
   * which needs no window and cannot miss.
   */
  it('sends no clean-exit keystroke into a shared terminal window, and force-kills instead (#329)', async () => {
    const runPowerShell = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const { port, endProcessTree } = ender(undefined, undefined, {
      focus: vi.fn().mockResolvedValue(TERMINAL_HOST),
      runPowerShell
    })

    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: true })
    // AMENDED for #504: see the #358 case above — the forced path now reads
    // the ancestor chain through this same seam before it kills, so the
    // guarantee narrows to "no keystroke", not "no call at all".
    expect(runPowerShell.mock.calls.some((call) => String(call[0]).includes('SendKeys'))).toBe(
      false
    )
    expect(endProcessTree).toHaveBeenCalledWith(4242)
  })

  /*
   * The clean-exit keystroke obeys the same fail-closed pid guard the kill does
   * (#231): a pid whose creation time no longer matches is not proven to be this
   * session, so nothing is typed at it AND nothing is killed. The forced
   * fallback re-probes the same mismatch and refuses with SESSION_NOT_VERIFIED,
   * exactly as it did before #358.
   */
  it('sends no clean-exit keystroke when the pid no longer matches, and refuses as today', async () => {
    const endProcessTree = vi.fn().mockResolvedValue(true)
    const runPowerShell = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const processStartTimeMs = vi.fn().mockResolvedValue(EXPECTED_START_MS + 60_000)
    const { port } = ender(endProcessTree, processStartTimeMs, { runPowerShell })

    const outcome = await port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    expect(outcome.delivered).toBe(false)
    expect(outcome.error).toMatch(/could not be verified/i)
    expect(runPowerShell).not.toHaveBeenCalled()
    expect(endProcessTree).not.toHaveBeenCalled()
  })

  /*
   * The mirror of the POSIX tier's own guard (#366): each platform's end tier
   * uses the one act that is true of it. Windows kills the TREE, because
   * `taskkill /T` walks the live parent/child rows and reaches the session's own
   * tool processes; the direct-pid signals exist for POSIX, where a tree is not
   * addressable and a group is the wrong one.
   */
  it('never reaches for the direct-pid signals POSIX ends with (#366)', async () => {
    const { port, terminateProcess, killProcess, endProcessTree } = ender()
    await expect(
      port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
    ).resolves.toMatchObject({ delivered: true })
    expect(endProcessTree).toHaveBeenCalledWith(4242)
    expect(terminateProcess).not.toHaveBeenCalled()
    expect(killProcess).not.toHaveBeenCalled()
  })

  /*
   * #504, step 2 of #358: once the forced tree kill has actually ended the
   * session, the terminal it leaves behind gets the DECSET resets a killed
   * TUI never sent itself. `taskkill /T /F` has already removed the agent's
   * OWN pid by the time this runs (docs/console-hosting.md §6), so the
   * ancestor chain — the shell that launched it — must be read BEFORE the
   * kill, through the same `runPowerShell` seam every other query on this
   * port uses. A terminal HOST (Windows Terminal, VS Code, …) ends the walk
   * without becoming a candidate: attaching to its console is not this
   * session's console (#329's reasoning, applied to a write rather than a
   * keystroke).
   */
  describe('the terminal reset after a forced kill (#504)', () => {
    /** One WMI row, the shape `parseProcessRows` reads. */
    function row(pid: number, parentPid: number, name: string) {
      return { ProcessId: pid, ParentProcessId: parentPid, Name: name }
    }

    it('reads the ancestor chain before the kill and resets the shell that launched the session, never the agent or a terminal host', async () => {
      const runPowerShell = vi.fn().mockResolvedValue({
        stdout: JSON.stringify([
          row(4242, 1000, 'claude.exe'),
          row(1000, 500, 'powershell.exe'),
          row(500, 1, 'WindowsTerminal.exe')
        ]),
        exitCode: 0
      })
      const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
      const { port, endProcessTree } = ender(undefined, undefined, {
        focus: vi.fn().mockResolvedValue(NOT_FOCUSED),
        runPowerShell,
        runConsoleWrite
      })

      await expect(
        port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
      ).resolves.toMatchObject({ delivered: true })
      expect(endProcessTree).toHaveBeenCalledWith(4242)
      expect(runConsoleWrite).toHaveBeenCalledTimes(1)
      const script = String(runConsoleWrite.mock.calls[0]?.[0])
      expect(script).toContain('AttachConsole(1000)')
      // Neither the agent's own (already-dead) pid nor the terminal host it
      // sits under may be tried: the first is gone by the time this runs, and
      // the second draws several sessions in tabs of one window (#329).
      expect(script).not.toContain('AttachConsole(4242)')
      expect(script).not.toContain('AttachConsole(500)')
    })

    it('sends no terminal reset after a clean graceful exit — the TUI already restored its own terminal', async () => {
      const endProcessTree = vi.fn().mockResolvedValue(true)
      const runPowerShell = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
      const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
      // Verified alive at the keystroke, still there on the first look, then gone.
      const processStartTimeMs = vi
        .fn()
        .mockResolvedValueOnce(EXPECTED_START_MS)
        .mockResolvedValueOnce(EXPECTED_START_MS)
        .mockResolvedValue(null)
      const { port } = ender(endProcessTree, processStartTimeMs, {
        runPowerShell,
        runConsoleWrite
      })

      await expect(
        port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
      ).resolves.toMatchObject({ delivered: true })
      expect(endProcessTree).not.toHaveBeenCalled()
      expect(runConsoleWrite).not.toHaveBeenCalled()
    })

    it('runs no reset when the ancestor query finds no usable candidate, and still reports the session ended', async () => {
      const runPowerShell = vi.fn().mockResolvedValue({ stdout: '', exitCode: 1 })
      const runConsoleWrite = vi.fn()
      const { port, endProcessTree } = ender(undefined, undefined, {
        focus: vi.fn().mockResolvedValue(NOT_FOCUSED),
        runPowerShell,
        runConsoleWrite
      })

      await expect(
        port.endConsoleSession({ pid: 4242, expectedStartMs: EXPECTED_START_MS })
      ).resolves.toMatchObject({ delivered: true })
      expect(endProcessTree).toHaveBeenCalledWith(4242)
      expect(runConsoleWrite).not.toHaveBeenCalled()
    })

    /*
     * The hard constraint from the feature document: the restore is
     * best-effort and NEVER part of the kick's verdict. The session ended —
     * `endProcessTree` said so — so a reset that reports failure must not
     * turn that into a failed kick.
     */
    it('still reports the session ended when the reset script itself fails', async () => {
      const runPowerShell = vi.fn().mockResolvedValue({
        stdout: JSON.stringify([row(4242, 1000, 'claude.exe'), row(1000, 1, 'powershell.exe')]),
        exitCode: 0
      })
      const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 2 })
      const { port, endProcessTree } = ender(undefined, undefined, {
        focus: vi.fn().mockResolvedValue(NOT_FOCUSED),
        runPowerShell,
        runConsoleWrite
      })

      const outcome = await port.endConsoleSession({
        pid: 4242,
        expectedStartMs: EXPECTED_START_MS
      })
      expect(outcome).toMatchObject({ delivered: true })
      expect(endProcessTree).toHaveBeenCalledWith(4242)
    })

    /*
     * A throwing reset must not propagate into `endConsoleSession`'s catch —
     * that catch exists for a probe or a kill that did not happen, and this
     * repair runs only AFTER the kill already succeeded.
     */
    it('still reports the session ended when the reset script throws', async () => {
      const runPowerShell = vi.fn().mockResolvedValue({
        stdout: JSON.stringify([row(4242, 1000, 'claude.exe'), row(1000, 1, 'powershell.exe')]),
        exitCode: 0
      })
      const runConsoleWrite = vi.fn().mockRejectedValue(new Error('powershell.exe is missing'))
      const { port, endProcessTree } = ender(undefined, undefined, {
        focus: vi.fn().mockResolvedValue(NOT_FOCUSED),
        runPowerShell,
        runConsoleWrite
      })

      const outcome = await port.endConsoleSession({
        pid: 4242,
        expectedStartMs: EXPECTED_START_MS
      })
      expect(outcome.delivered).toBe(true)
      expect(outcome.error).toBeUndefined()
      expect(endProcessTree).toHaveBeenCalledWith(4242)
    })
  })
})

/*
 * The question-answer tier (#362): the digits of the chosen options, then the
 * confirmation a multi-select picker needs. Only Windows carries it — the POSIX
 * console adapter has no arrow key to press (#367) — and the runtime turns its
 * absence into a stated refusal there.
 *
 * AMENDED throughout this describe for #402. Every test here pinned a focus
 * step and a SendKeys command behind it, and both are gone: the keys are
 * written into the console the session's pid names, one `WriteConsoleInputW`
 * call per key, exactly as a message has been since #371. The measurement that
 * moved them is in docs/console-hosting.md §6 — a digit as a text record fires a
 * single-select and toggles a multi-select row, and `ESC [ C` as three text
 * records opens the summary an Enter then accepts. So the shared-window refusal
 * of #329 has nothing left to refuse on this path and its two tests went with
 * the focus call; `sendInterrupt` and the clean exit keep theirs.
 */
describe('WindowsTextDelivery.answerQuestionAtConsole', () => {
  it('writes the single-select digit into the console of that pid, raising no window', async () => {
    const focus = vi.fn()
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = delivery({ focus, runConsoleWrite })

    await expect(
      port.answerQuestionAtConsole({ pid: 42, digits: ['3'], submit: false })
    ).resolves.toEqual({ delivered: true, stages: { spawnMs: expect.any(Number) } })
    // The whole point of #402: an answer asks for no foreground at all, so a
    // session in one tab of a shared terminal window can be answered.
    expect(focus).not.toHaveBeenCalled()
    const script = String(runConsoleWrite.mock.calls[0]?.[0])
    expect(script).toContain('AttachConsole(42)')
    // One chunk, so one call: the digit selects and submits by itself.
    expect(script.match(/WriteConsoleInputW\(\$conin/g)?.length).toBe(1)
    expect(chunksOf(script)).toEqual(['3'])
  })

  it('writes the toggles, the cursor-right and the Enter as one call each, in order', async () => {
    // One child process and one attach, four calls inside it: #404's rule is
    // that a chunk reads as a keystroke only in a call of its own, and every key
    // of an answer is a keystroke.
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = delivery({ runConsoleWrite })

    await port.answerQuestionAtConsole({ pid: 42, digits: ['2', '4'], submit: true })
    expect(runConsoleWrite).toHaveBeenCalledTimes(1)
    const script = String(runConsoleWrite.mock.calls[0]?.[0])
    expect(chunksOf(script)).toEqual(['2', '4', '\u001b[C', '\r'])
    expect(script.match(/WriteConsoleInputW\(\$conin/g)?.length).toBe(4)
    expect(script.match(/Start-Sleep -Milliseconds 50/g)?.length).toBe(3)
  })

  it('synthesizes no keystroke at all, so it can never reach the foreground window', async () => {
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = delivery({ runConsoleWrite })

    await port.answerQuestionAtConsole({ pid: 42, digits: ['1'], submit: true })
    const script = String(runConsoleWrite.mock.calls[0]?.[0])
    for (const forbidden of ['SendKeys', 'SetForegroundWindow', 'System.Windows.Forms']) {
      expect(script).not.toContain(forbidden)
    }
  })

  it('never routes the answer through the long-lived console shell', async () => {
    // The attach rebinds the CALLING process's console, so this may no more run
    // on the shared worker than a message write may (#371).
    const runPowerShell = vi.fn()
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = delivery({ runPowerShell, runConsoleWrite })

    await port.answerQuestionAtConsole({ pid: 42, digits: ['1'], submit: false })
    expect(runPowerShell).not.toHaveBeenCalled()
    expect(runConsoleWrite).toHaveBeenCalledTimes(1)
  })

  it('refuses digits the builder will not accept, and writes nothing', async () => {
    const focus = vi.fn()
    const runConsoleWrite = vi.fn()
    const port = delivery({ focus, runConsoleWrite })

    const result = await port.answerQuestionAtConsole({ pid: 42, digits: [], submit: true })
    expect(result).toMatchObject({ delivered: false, neverStarted: true })
    expect(focus).not.toHaveBeenCalled()
    expect(runConsoleWrite).not.toHaveBeenCalled()
  })

  it('fails closed on a pid the write builder will not accept', async () => {
    // ADDED for #402: the answer is addressed by pid now, so it inherits the
    // guard the message write has — a script built around a junk pid would
    // attach to whatever process holds that number.
    const runConsoleWrite = vi.fn()
    const port = delivery({ runConsoleWrite })

    const result = await port.answerQuestionAtConsole({ pid: 0, digits: ['1'], submit: false })
    expect(result).toMatchObject({ delivered: false, neverStarted: true })
    expect(runConsoleWrite).not.toHaveBeenCalled()
  })

  it('carries the write script’s own exit codes, so a retry is licensed only where nothing landed', async () => {
    // ADDED for #402: the three measured failures reach the person as three
    // different sentences, and only the two that provably wrote nothing may be
    // sent again by another tier. Exit 4 left half an answer in the buffer.
    const attachRefused = delivery({
      runConsoleWrite: vi.fn().mockResolvedValue({ stdout: '', exitCode: 2 })
    })
    await expect(
      attachRefused.answerQuestionAtConsole({ pid: 42, digits: ['1'], submit: false })
    ).resolves.toMatchObject({ delivered: false, neverStarted: true })

    const shortWrite = delivery({
      runConsoleWrite: vi.fn().mockResolvedValue({ stdout: '', exitCode: 4 })
    })
    const partial = await shortWrite.answerQuestionAtConsole({
      pid: 42,
      digits: ['1', '2'],
      submit: true
    })
    expect(partial.delivered).toBe(false)
    expect(partial.neverStarted).toBeUndefined()
  })

  it('turns a crashing shell into a failed verdict instead of a rejection', async () => {
    const port = delivery({
      runConsoleWrite: vi.fn().mockRejectedValue(new Error('powershell.exe is missing'))
    })
    await expect(
      port.answerQuestionAtConsole({ pid: 42, digits: ['1'], submit: false })
    ).resolves.toMatchObject({ delivered: false })
  })

  /*
   * The second form of this request, which carries CHUNKS the runtime built
   * rather than digits this port turns into them (#481). The words are the
   * person's own, so the port cannot derive them — what it keeps is the write
   * and both of its fail-closed guards.
   */
  it('writes a typed answer as the reach, the words and the Enter, one call each', async () => {
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = delivery({ runConsoleWrite })

    await expect(
      port.answerQuestionAtConsole({ pid: 42, chunks: ['5', 'a quince', '\r'] })
    ).resolves.toEqual({ delivered: true, stages: { spawnMs: expect.any(Number) } })
    const script = String(runConsoleWrite.mock.calls[0]?.[0])
    expect(script).toContain('AttachConsole(42)')
    expect(chunksOf(script)).toEqual(['5', 'a quince', '\r'])
    expect(script.match(/WriteConsoleInputW\(\$conin/g)?.length).toBe(3)
  })

  it('raises no window for a typed answer either', async () => {
    const focus = vi.fn()
    const runConsoleWrite = vi.fn().mockResolvedValue({ stdout: '', exitCode: 0 })
    const port = delivery({ focus, runConsoleWrite })

    await port.answerQuestionAtConsole({ pid: 42, chunks: ['3', 'mine', '\r'] })
    expect(focus).not.toHaveBeenCalled()
  })

  it('refuses chunks carrying a key nobody measured, and writes nothing', async () => {
    // The free-text route's own fail-closed guard, run again at the port: the
    // payload is a person's words, and words that smuggled a carriage return
    // would submit the picker halfway through them.
    const runConsoleWrite = vi.fn()
    const port = delivery({ runConsoleWrite })

    const result = await port.answerQuestionAtConsole({
      pid: 42,
      chunks: ['3', 'ship it\rnow', '\r']
    })
    expect(result).toMatchObject({ delivered: false, neverStarted: true })
    expect(runConsoleWrite).not.toHaveBeenCalled()
  })

  it('refuses an empty chunk list for a typed answer', async () => {
    const runConsoleWrite = vi.fn()
    const port = delivery({ runConsoleWrite })

    const result = await port.answerQuestionAtConsole({ pid: 42, chunks: [] })
    expect(result).toMatchObject({ delivered: false, neverStarted: true })
    expect(runConsoleWrite).not.toHaveBeenCalled()
  })

  it('fails closed on a junk pid for a typed answer too', async () => {
    const runConsoleWrite = vi.fn()
    const port = delivery({ runConsoleWrite })

    const result = await port.answerQuestionAtConsole({ pid: 0, chunks: ['3', 'mine', '\r'] })
    expect(result).toMatchObject({ delivered: false, neverStarted: true })
    expect(runConsoleWrite).not.toHaveBeenCalled()
  })
})

/* --- The console write's own transport (#433) — one block, appended -------- */

/**
 * A child that answers whatever the test tells it to, so the transport can be
 * driven without a real powershell.exe — which on this path is not a
 * convenience but the same rule the injected runner above exists for: a real
 * child here would attach to whatever process holds the pid a test made up.
 */
function fakeConsoleWriteChild() {
  const written: string[] = []
  const kill = vi.fn()
  const state = { ended: false }
  let onClose: ((code: number | null) => void) | undefined
  let onError: ((error: Error) => void) | undefined

  const child: ConsoleWriteProcess = {
    stdin: {
      write: (chunk: string) => {
        written.push(chunk)
      },
      end: () => {
        state.ended = true
      },
      on: vi.fn()
    },
    on: (event, listener) => {
      if (event === 'close') onClose = listener as (code: number | null) => void
      else onError = listener as (error: Error) => void
    },
    kill
  }

  return {
    child,
    written,
    kill,
    state,
    close: (code: number | null) => onClose?.(code),
    fail: (error: Error) => onError?.(error)
  }
}

/** The script the runner handed to stdin, read back out of its one base64 blob. */
function scriptOnStdin(written: readonly string[]): string {
  const encoded = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(written.join(''))?.[1] ?? ''
  return Buffer.from(encoded, 'base64').toString('utf8')
}

/**
 * The transport #433 replaced, and why the shape it takes is not the obvious
 * one.
 *
 * The script used to travel in the child's COMMAND LINE, which Windows will not
 * let past 32,767 characters — a ceiling on the MESSAGE that had nothing to do
 * with the console (#431). It rides stdin now. What stdin costs is that
 * `powershell.exe -Command -` reads its input LINE BY LINE and runs each line
 * as a complete statement: measured 2026-09-16, a raw multi-line script handed
 * to it ran its first line, swallowed everything from the first unterminated
 * construct onwards and exited **0**, silently — the worst possible answer,
 * since a caller reads 0 as delivered. So the script travels as ONE line, the
 * idiom `consoleWorker.ts` has shipped since #21, and the measurement that made
 * this change is that `exit 2`, `exit 3` and `exit 4` all come back as the
 * child's own exit code through it [docs/console-hosting.md §6].
 */
describe('createConsoleWriteRunner', () => {
  it('spawns powershell with the script on stdin and nothing of it in the argv', async () => {
    const fake = fakeConsoleWriteChild()
    const spawn = vi.fn(
      (
        _command: string,
        _args: readonly string[],
        _options: { windowsHide: boolean; stdio: readonly string[] }
      ) => fake.child
    )
    const run = createConsoleWriteRunner({ spawn })

    const script = buildConsoleInputWriteCommand(4242, 'hola', true) ?? ''
    const settled = run(script)
    fake.close(0)
    await expect(settled).resolves.toEqual({ stdout: '', exitCode: 0 })

    expect(spawn).toHaveBeenCalledTimes(1)
    const call = spawn.mock.calls[0]
    expect(call?.[0]).toBe('powershell.exe')
    expect(call?.[1]).toEqual(['-NoProfile', '-NonInteractive', '-Command', '-'])
    // The whole of the argv, not just the flags: nothing of the script is on it.
    expect(call?.[1].join(' ')).not.toContain('AttachConsole')
    // Load-bearing, not tidiness: a visible child gets a console window, which
    // the Windows 11 default-terminal handoff turns into a Terminal window that
    // takes the foreground — the exact theft the pid write exists to remove.
    expect(call?.[2]).toMatchObject({ windowsHide: true })
  })

  it('hands the script over whole, and closes stdin so it runs', async () => {
    const fake = fakeConsoleWriteChild()
    const run = createConsoleWriteRunner({ spawn: () => fake.child })

    const script = buildConsoleInputWriteCommand(4242, 'hola', true) ?? ''
    const settled = run(script)
    fake.close(0)
    await settled

    expect(scriptOnStdin(fake.written)).toBe(script)
    // An unclosed stdin is a child waiting for a line that never comes.
    expect(fake.state.ended).toBe(true)
  })

  it('carries a thirty-thousand-code-point message, which the command line could not', async () => {
    // The measurement this change is for: 29,323 code points built a
    // 109,152-character command line and the spawn was refused with
    // ENAMETOOLONG in 2 ms (#431). Over stdin the same script is written whole
    // — measured live at 30,000 code points, exit 0 in 4,277 ms, the transcript
    // row 30,000 code points [docs/console-hosting.md §6].
    const fake = fakeConsoleWriteChild()
    const run = createConsoleWriteRunner({ spawn: () => fake.child })

    const text = 'x'.repeat(30_000)
    const script = buildConsoleInputWriteCommand(4242, text, true) ?? ''
    expect(script.length).toBeGreaterThan(WINDOWS_COMMAND_LINE_LIMIT * 3)
    const settled = run(script)
    fake.close(0)
    await settled

    expect(scriptOnStdin(fake.written)).toBe(script)
  })

  it('sends one line, because the stdin host runs each line as a whole statement', async () => {
    // Measured, not stylistic: a raw multi-line script over `-Command -` runs
    // its first line and silently abandons the rest with exit 0.
    const fake = fakeConsoleWriteChild()
    const run = createConsoleWriteRunner({ spawn: () => fake.child })

    const script = buildConsoleInputWriteCommand(4242, 'hola', true) ?? ''
    expect(script).toContain('\n')
    const settled = run(script)
    fake.close(0)
    await settled

    const sent = fake.written.join('')
    expect(sent.endsWith('\n')).toBe(true)
    expect(sent.trimEnd()).not.toContain('\n')
  })

  it.each([0, 2, 3, 4])('reports the script’s own exit code %i unchanged', async (code) => {
    // The contract `consoleWriteFailureFor` reads. Measured live over this exact
    // transport on 2026-09-16: 2 against a dead pid, 3 with CONIN$ made
    // unopenable, 4 with the handle opened read-only — each came back as the
    // child's own exit code [docs/console-hosting.md §6].
    const fake = fakeConsoleWriteChild()
    const run = createConsoleWriteRunner({ spawn: () => fake.child })

    const settled = run(buildConsoleInputWriteCommand(4242, 'hola', false) ?? '')
    fake.close(code)
    await expect(settled).resolves.toEqual({ stdout: '', exitCode: code })
  })

  it('rejects when the child never started, rather than reporting an exit code', async () => {
    // The guard #433 keeps: a missing powershell.exe or a refused spawn wrote
    // nothing, and reading that as an exit code would say the write failed
    // inside a console it never reached.
    const fake = fakeConsoleWriteChild()
    const run = createConsoleWriteRunner({ spawn: () => fake.child })

    const settled = run(buildConsoleInputWriteCommand(4242, 'hola', false) ?? '')
    fake.fail(new Error('spawn powershell.exe ENOENT'))
    await expect(settled).rejects.toThrow('ENOENT')
  })

  it('rejects a child the timeout had to kill, which may have written anything', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeConsoleWriteChild()
      const run = createConsoleWriteRunner({ spawn: () => fake.child, timeoutMs: 1_000 })

      const settled = run(buildConsoleInputWriteCommand(4242, 'hola', false) ?? '')
      const caught = settled.catch((error: Error) => error)
      vi.advanceTimersByTime(1_000)
      fake.close(null)

      expect(fake.kill).toHaveBeenCalledTimes(1)
      expect(await caught).toBeInstanceOf(Error)
    } finally {
      vi.useRealTimers()
    }
  })
})
/* --- end of the #433 block ------------------------------------------------- */
