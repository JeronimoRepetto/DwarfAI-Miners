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
import { claudeSettings, hookCommands, isHostEntry, welcomeStep } from './claudeHooksWorld.ts'

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
  async function cardShown(): Promise<{
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
    await expect(step.options).toBeVisible({ timeout: 60_000 })
    await step.activate.click()
    await expect(step.dialog).toBeHidden({ timeout: 30_000 })
    await expect
      .poll(() => hookCommands(claudeSettings(owned)).filter(isHostEntry).length, {
        timeout: 30_000
      })
      .toBeGreaterThan(0)
    const entry = hostEntry(owned)
    const session = seedWaitingSession(owned)
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

  // Waits on #1285 (the keystroke relay, PR #1288): this build's Host composes no relay that reaches a session's own
  // console, so an in-app Allow on an observed Claude dialog has no key path to the stub yet. Written in full and
  // marked here, never skipped silently: the rebase onto #1288 removes the mark (ISSUE-141 hand-off).
  test.fixme('[US-ASK-003.AC07] a permission answered in the app reaches the stub', async () => {
    const { owned } = await cardShown()
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
    // The stub's console received the measured Allow key ('1', no Enter); the relay's stub record is #1288's.
    expect(owned).toBeDefined()
  })

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
