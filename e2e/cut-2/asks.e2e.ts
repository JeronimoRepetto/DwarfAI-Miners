import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  createIsolatedProfile,
  disposeProfile,
  launchApp,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { STUB_BIN } from '../_harness/stubs.ts'
import { createProcessProbe } from '../../src/main/platform/processProbe.ts'
import {
  claudeSettings,
  hookCommands,
  isHostEntry,
  welcomeStep,
  expectStepShown
} from './claudeHooksWorld.ts'

/**
 * L9, cut 2 (ISSUE-141; 21 §2 cut 2 exit "L9 E2E: ask answered in the app, ask answered in the terminal closes the
 * card, reopen shows the card again"; ADR-010, ADR-012): an observed Claude session's permission dialog, as the Host
 * broker owns it from the cut-2 switch. The session is the profile's own (`CLAUDE_CONFIG_DIR`), its transcript written
 * as Claude Code writes one, with one Bash call waiting on its dialog; the dialog's hook reaches the Host's ingress
 * with the channel token of the entry the first-run step's Activate wrote, as the entry's own `curl` would send it.
 * The card is read through the renderer's own A-N01 (`window.api.getHostSnapshot`, the `asks` section the message
 * panel draws its card from, ADR-033 item 3).
 */

test.describe.configure({ timeout: 240_000 })

/** The renderer's `window.api` member a case calls, as `evaluate` reaches it. */
interface RendererApi {
  api: { answerDwarfPermission(request: unknown): Promise<unknown> }
}

const SESSION = '00000000-0000-4000-8000-0000000141a1'
const CALL = 'toolu_01CutTwoAskBash'
/** The measured Claude Code version of the key map (keyMap.ts), so the channel answers on a measured map. */
const VERSION = '2.1.261'

/** The open asks of the Host's snapshot, as the panel reads them. */
async function openAsks(
  window: Page
): Promise<Array<{ id: string; kind: string; providerRequestId: string; currentStep: number }>> {
  const answer = (await window.evaluate("window.api.getHostSnapshot({ sections: ['asks'] })")) as {
    ok: boolean
    value?: { chunks: Array<{ section: string; data: { asks: unknown[] } }> }
  }
  if (!answer.ok || answer.value === undefined) return []
  return answer.value.chunks
    .filter((chunk) => chunk.section === 'asks')
    .flatMap((chunk) => chunk.data.asks) as Array<{
    id: string
    kind: string
    providerRequestId: string
    currentStep: number
  }>
}

/** A Claude session waiting on the permission dialog of one Bash call, in the profile's own Claude folder. */
function seedWaitingSession(profile: IsolatedProfile): { transcript: string; cwd: string } {
  const cwd = path.join(profile.root, 'moria')
  mkdirSync(cwd, { recursive: true })
  const folder = path.join(
    profile.claudeConfigDir,
    'projects',
    cwd.replaceAll(/[^A-Za-z0-9]/g, '-')
  )
  mkdirSync(folder, { recursive: true })
  const transcript = path.join(folder, `${SESSION}.jsonl`)
  const startedAt = Date.now()
  const record = (index: number, type: 'user' | 'assistant', message: unknown) =>
    JSON.stringify({
      type,
      uuid: `00000000-0000-4000-8000-0000000142${String(index).padStart(2, '0')}`,
      parentUuid:
        index === 1
          ? null
          : `00000000-0000-4000-8000-0000000142${String(index - 1).padStart(2, '0')}`,
      isSidechain: false,
      sessionId: SESSION,
      cwd,
      version: VERSION,
      timestamp: new Date(startedAt + index * 1_000).toISOString(),
      message
    })
  writeFileSync(
    transcript,
    [
      record(1, 'user', { role: 'user', content: 'Run the tests, please.' }),
      record(2, 'assistant', {
        id: 'msg_0000000000000000000141a2',
        type: 'message',
        role: 'assistant',
        model: 'sample-model',
        content: [{ type: 'tool_use', id: CALL, name: 'Bash', input: { command: 'pnpm test' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 }
      }),
      ''
    ].join('\n')
  )
  return { transcript, cwd }
}

/** 100 ns ticks between 1601-01-01 and 1970-01-01 (Claude Code's registry writes `procStart` as a Windows FILETIME). */
const FILETIME_EPOCH_OFFSET = 116_444_736_000_000_000n

/** The session's own terminal: a stub console that reports every key its input buffer receives. */
interface StubConsole {
  /** Every key the console received, as the stub reports it (`key <hex>`). */
  keys(): string[]
  dispose(): void
}

/**
 * The waiting session's process, as the keystroke relay reaches it (ADR-012 item 3; #1285): a stub "terminal session"
 * (`fixtures/bin/console-keys`, `reader` mode, never a provider CLI, 17 §1.8) reading its OWN console's input buffer,
 * the hidden console a `windowsHide` child gets (no window is shown), named by Claude Code's own session registry
 * (`sessions/<pid>.json`, with the process's creation time as a Windows FILETIME), so observation records its process
 * identity (ADR-014 item 1) and the relay attaches to that console by pid. Windows only: on macOS and Linux the relay
 * needs a tmux pane or a Terminal.app tab, which are the maintainer's lane.
 */
async function startStubConsole(profile: IsolatedProfile, cwd: string): Promise<StubConsole> {
  const reader = path.join(STUB_BIN, 'console-keys', 'console-keys.mjs')
  const child: ChildProcess = spawn(process.execPath, [reader, 'reader', '200000'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true
  })
  const lines: string[] = []
  let buffered = ''
  const ready = new Promise<void>((resolve, reject) => {
    child.once('exit', () => reject(new Error('the stub console exited before it listened')))
    child.stdout!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const parts = buffered.split(/\r?\n/)
      buffered = parts.pop() ?? ''
      for (const line of parts) {
        if (line === 'ready') resolve()
        else if (line.startsWith('key ')) lines.push(line)
      }
    })
  })
  const dispose = (): void => {
    child.stdin?.end()
    if (child.exitCode === null) child.kill()
  }
  try {
    await ready
    const pid = child.pid
    const started = pid === undefined ? null : await createProcessProbe().processStartTimeMs(pid)
    if (pid === undefined || started === null) throw new Error('the stub console has no identity')
    const sessions = path.join(profile.claudeConfigDir, 'sessions')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(
      path.join(sessions, `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: SESSION,
        cwd,
        status: 'busy',
        procStart: String(BigInt(Math.round(started)) * 10_000n + FILETIME_EPOCH_OFFSET)
      })
    )
  } catch (error) {
    dispose()
    throw error
  }
  return { keys: () => [...lines], dispose }
}

/** The person answered the dialog at the session's own terminal: the call's result is in the transcript. */
function answerAtTheTerminal(transcript: string, cwd: string): void {
  appendFileSync(
    transcript,
    JSON.stringify({
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000014299',
      parentUuid: '00000000-0000-4000-8000-000000014202',
      isSidechain: false,
      sessionId: SESSION,
      cwd,
      version: VERSION,
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: CALL, content: 'All tests passed.' }]
      }
    }) + '\n'
  )
}

/** The token and port of DwarfAI's own hook entry, as its `curl` command names them (ADR-016 items 1, 2). */
function hostEntry(profile: IsolatedProfile): { port: number; token: string } {
  const command = hookCommands(claudeSettings(profile)).find(isHostEntry)
  const port = /127\.0\.0\.1:(\d+)\/hooks\/claude\//.exec(command ?? '')?.[1]
  const token = /x-dwarfai-token:\s*([0-9A-Za-z_-]+)/i.exec(command ?? '')?.[1]
  if (port === undefined || token === undefined)
    throw new Error('no DwarfAI hook entry in settings.json')
  return { port: Number(port), token }
}

/** One hook call, as the entry's `curl` sends it to the Host's ingress. */
async function hook(
  entry: { port: number; token: string },
  body: Record<string, string>
): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${entry.port}/hooks/claude/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dwarfai-token': entry.token },
    body: JSON.stringify(body)
  })
  return response.status
}

test.describe('cut 2: an observed Claude permission through the Host broker (ISSUE-141)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  /** The app on a profile whose Claude hook entry is DwarfAI's (Activate), with the session's dialog open as a card. */
  let stubConsole: StubConsole | undefined

  test.afterEach(() => {
    stubConsole?.dispose()
    stubConsole = undefined
  })

  async function cardShown(withConsole = false): Promise<{
    owned: IsolatedProfile
    session: { transcript: string; cwd: string }
    entry: { port: number; token: string }
  }> {
    const owned = createIsolatedProfile()
    profile = owned
    launched = await launchApp({
      profile: owned,
      stubs: path.join(STUB_BIN, 'claude'),
      tracePath: test.info().outputPath('trace.zip')
    })
    await waitForHostAttached(owned)
    const step = welcomeStep(launched.window)
    await expectStepShown(launched.window)
    await step.activate.click()
    await expect(step.dialog).toBeHidden({ timeout: 30_000 })
    await expect
      .poll(() => hookCommands(claudeSettings(owned)).filter(isHostEntry).length, {
        timeout: 30_000
      })
      .toBeGreaterThan(0)
    const entry = hostEntry(owned)
    const session = seedWaitingSession(owned)
    if (withConsole) stubConsole = await startStubConsole(owned, session.cwd)
    // The dialog's hooks, as Claude Code raises them: the permission request, then its notification. A hook can
    // reach the Host before its observer has drawn the session's dwarf, so it is raised again until the card shows.
    await expect
      .poll(
        async () => {
          const bodies: Array<Record<string, string>> = [
            { hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
            { hook_event_name: 'Notification', notification_type: 'permission_prompt' }
          ]
          for (const body of bodies) {
            expect(
              await hook(entry, {
                ...body,
                session_id: SESSION,
                cwd: session.cwd,
                transcript_path: session.transcript
              })
            ).toBeLessThan(300)
          }
          return (await openAsks(launched!.window)).map((ask) => [ask.kind, ask.providerRequestId])
        },
        { timeout: 90_000, intervals: [2_000], message: 'the Host opens the permission card' }
      )
      .toEqual([['permission', CALL]])
    return { owned, session, entry }
  }

  // The keystroke relay (#1285, PR #1288) presses the measured Allow key in the session's own console. On Windows that
  // console is a hidden stub (startStubConsole), so the case is declared on the Windows leg only: an OS split, as the OS
  // lane declares one describe per OS (`describe.runIf`, 17 §1.8), never a skip (17 §5.4). On macOS and Linux the relay
  // needs a real tmux pane (the CI images are not known to ship one, and this lane installs nothing) or a Terminal.app
  // tab: there the L8 OS lane proves the relay's tmux path against stub `ps`/`tmux` tools and a real live process on
  // every PR (`ConsoleKeystrokeDelivery.os.test.ts`, its macOS and Linux describe), and a real pane or tab stays the
  // maintainer's lane.
  if (process.platform === 'win32') {
    test('[US-ASK-003.AC07] a permission answered in the app reaches the stub', async () => {
      await cardShown(true)
      const window = launched!.window
      const [ask] = await openAsks(window)
      const outcome = await window.evaluate(
        (askId) =>
          (globalThis as unknown as RendererApi).api.answerDwarfPermission({
            askId: askId as never,
            decision: 'allow',
            requestId: '01920000-0000-7000-a000-0000000141a7'
          }),
        ask!.id
      )
      expect(outcome).toEqual({ ok: true, value: { kind: 'accepted' } })
      // The session's console received the measured Allow key, '1' with no Enter, and nothing else.
      await expect
        .poll(() => stubConsole!.keys(), {
          timeout: 30_000,
          message: 'the Allow key reaches the console'
        })
        .toEqual(['key 31'])
    })
  }

  test('[US-OBS-004.AC09] a permission answered in the stub terminal closes the card with no notice', async () => {
    const { session, entry } = await cardShown()
    const window = launched!.window
    answerAtTheTerminal(session.transcript, session.cwd)
    // The next hook of the session (the tool ran) makes the Host re-read the transcript: the call is resolved there.
    await expect
      .poll(
        async () => {
          await hook(entry, {
            hook_event_name: 'PostToolUse',
            tool_name: 'Bash',
            session_id: SESSION,
            cwd: session.cwd,
            transcript_path: session.transcript
          })
          return openAsks(window)
        },
        { timeout: 60_000, intervals: [2_000], message: 'the card closes' }
      )
      .toEqual([])
    // With no notice: no toast was raised for it.
    await expect(window.locator('.dm-toast')).toHaveCount(0)
  })

  test('[US-RES-003.AC02, NFR-PERS-03, BR-07] after a reopen the card shows again on its step', async () => {
    const { owned } = await cardShown()
    const [before] = await openAsks(launched!.window)
    // The window closes and the app quits; the detached Host keeps the open ask (ADR-002 D1; OQ-03).
    await launched!.teardown()
    launched = await launchApp({
      profile: owned,
      stubs: path.join(STUB_BIN, 'claude'),
      tracePath: test.info().outputPath('trace-reopen.zip')
    })
    await waitForHostAttached(owned)
    await expect
      .poll(async () => openAsks(launched!.window), {
        timeout: 60_000,
        message: 'the card shows again after the reopen'
      })
      .toEqual([before])
  })
})
