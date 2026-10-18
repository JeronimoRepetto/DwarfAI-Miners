import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { CATALOG_PROVIDER_IDS } from '../../src/contracts/catalog/ids.ts'
import {
  createIsolatedProfile,
  disposeProfile,
  isProcessAlive,
  launchApp,
  waitForHostAttached,
  type IsolatedProfile,
  type LaunchedApp
} from '../_harness/launchApp.ts'
import { openHostDatabaseReadOnly } from '../_harness/readOnlyHost.ts'
import { chatOf, dwarfsOf, launchesOf, seedMine, uuidv7 } from '../cut-3a/claudeStreamWorld.ts'

/**
 * L9, step 3e (ISSUE-188 test 3; 21 §2 cut 3e exit; 15 §4.8; ADR-014 stop): in a development build (the E2E app is
 * never packaged) the step-3e router sends an Antigravity dwarf's launch (A-35), send (A-23) and stop (A-N29) to the
 * Host, whose `AntigravityNdjsonDriver` drives the stub `agy` (`agyStreamStub.mjs`): the launch is the Host's, the dwarf
 * is Owned, the sent text is a second stream-json turn, and Stop dwarf ends the stub's process with the dwarf departing
 * `stopped`. The stub writes down the argv and the environment it was started with: stream-json in and out, no `-p`,
 * no token in the environment.
 *
 * Synthetic (owner waiver 2026-10-18): Antigravity cannot be logged in or recorded on the development machine, so this
 * is the step's E2E against a stub, and the real-CLI check stays pending in `docs/strangler/parity-cut-3e.md`.
 *
 * The person's actions are the renderer's own `window.api` members with the `14` shapes. Before the 3e switch A-35
 * reaches today's runtime for Antigravity through `PerProviderShapeAdapter`, so this case fails at the launch (today's
 * held agy session is never the Host's).
 */

/** The Antigravity catalog id, from the one list (R12: never a hand-typed literal outside it). */
const ANTIGRAVITY = CATALOG_PROVIDER_IDS[2]
/** The stub's replies (`agyStreamStub.mjs` REPLIES), as the case expects them. */
const REPLIES = { first: 'Hello from the Antigravity stub.', next: 'Noted.' } as const
const STUB_MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agyStreamStub.mjs')

interface AgyRun {
  readonly pid: number
  readonly argv: readonly string[]
  readonly envNames: readonly string[]
  readonly tokenInEnv: boolean
}

/**
 * Installs the stub `agy` in `profile`: `agy.cmd` (Windows, read by the resolver for its quoted node entry and started
 * by the Host's driver with the person's `node`, never through `cmd.exe`) and `agy` (POSIX), each running `agy.mjs`.
 */
function createAgyWorld(profile: IsolatedProfile): { dir: string; runs(): AgyRun[] } {
  const dir = path.join(profile.root, 'agy-stub')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'agy.mjs'),
    [
      `import { runAgyStreamStub } from ${JSON.stringify(pathToFileURL(STUB_MODULE).href)}`,
      'runAgyStreamStub(import.meta.dirname)',
      ''
    ].join('\n')
  )
  writeFileSync(path.join(dir, 'agy.cmd'), '@echo off\r\nnode "%~dp0agy.mjs" %*\r\n')
  const posix = path.join(dir, 'agy')
  writeFileSync(
    posix,
    '#!/bin/sh\ncase "$0" in\n  */*) dir=${0%/*} ;;\n  *) dir=. ;;\nesac\nexec node "$dir/agy.mjs" "$@"\n'
  )
  chmodSync(posix, 0o755)
  return {
    dir,
    runs: () => {
      const runs = path.join(dir, 'runs')
      if (!existsSync(runs)) return []
      return readdirSync(runs)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(path.join(runs, name), 'utf8')) as AgyRun)
    }
  }
}

/** The app's whole `PATH`: the stub, node, and the OS tools the Host and today's runtime use. */
function agyOnlyPath(dir: string): string {
  const node = path.dirname(process.execPath)
  if (process.platform === 'win32') {
    const system = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32')
    const powershell = path.join(system, 'WindowsPowerShell', 'v1.0')
    return [dir, node, system, powershell].join(path.delimiter)
  }
  return [dir, node, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter)
}

test.describe.configure({ timeout: 300_000 })

test.describe('step 3e: an Antigravity dwarf through the Host in a development build (ISSUE-188)', () => {
  let profile: IsolatedProfile | undefined
  let launched: LaunchedApp | undefined

  test.afterEach(async () => {
    await launched?.teardown({ stopEverything: true })
    launched = undefined
    if (profile !== undefined) await disposeProfile(profile)
    profile = undefined
  })

  test('[ADR-001] in a development build an Antigravity stub dwarf launches, receives a message and stops through the Host', async () => {
    profile = createIsolatedProfile()
    const owned = profile
    const world = createAgyWorld(owned)
    launched = await launchApp({
      profile: owned,
      stubs: agyOnlyPath(world.dir),
      pathOnly: true,
      tracePath: test.info().outputPath('trace.zip')
    })
    const { window } = launched
    await waitForHostAttached(owned)
    const { mineId } = await seedMine(window, owned)

    // The development build's catalog offers Antigravity from the Host (ADR-009 D6: development builds keep it).
    await expect
      .poll(
        async () => {
          const listed = (await window.evaluate(
            'window.api.listAgentProviders({ refresh: true })'
          )) as {
            ok: boolean
            value?: Array<{ providerId: string; installed: boolean }>
          }
          return listed.value?.find((entry) => entry.providerId === ANTIGRAVITY)?.installed ?? null
        },
        { timeout: 60_000, message: 'A-36 lists the stub agy, installed' }
      )
      .toBe(true)

    // Launch (A-35): the Host's launch and an Owned Antigravity dwarf with the stub's first reply in its chat.
    const before = new Set((await dwarfsOf(window)).map((d) => d.id))
    const accepted = (await window.evaluate(
      `window.api.launchAgent(${JSON.stringify({
        mineId,
        way: { kind: 'supplier', providerId: ANTIGRAVITY },
        prompt: 'Say hello.',
        jevOn: false,
        jevAutoAccept: false,
        requestId: uuidv7()
      })})`
    )) as { ok: boolean; value?: { launchId: string } }
    expect(
      accepted,
      'A-35 accepts the Antigravity launch: ' + JSON.stringify(accepted)
    ).toMatchObject({ ok: true })
    const launchId = accepted.value!.launchId
    let dwarfId: string | undefined
    await expect
      .poll(
        async () => {
          const launch = (await launchesOf(window)).find((row) => row.launchId === launchId)
          if (launch !== undefined) {
            return launch.state === 'failed' ? `failed ${JSON.stringify(launch)}` : launch.state
          }
          dwarfId = (await dwarfsOf(window)).find(
            (d) => d.mineId === mineId && d.providerId === ANTIGRAVITY && !before.has(d.id)
          )?.id
          return dwarfId === undefined ? 'left the launches with no dwarf' : 'succeeded'
        },
        { timeout: 60_000, message: 'the Host settles the launch' }
      )
      .toBe('succeeded')
    expect((await dwarfsOf(window)).find((d) => d.id === dwarfId)).toMatchObject({
      providerId: ANTIGRAVITY,
      owned: true,
      presence: 'present'
    })
    await expect
      .poll(async () => (await chatOf(window, dwarfId!)).map((m) => m.text.trim()), {
        timeout: 60_000,
        message: 'the stub answered the first turn'
      })
      .toContain(REPLIES.first)
    const runs = world.runs().filter((run) => run.argv.includes('stream-json'))
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    expect(run.argv).toEqual(['--input-format', 'stream-json', '--output-format', 'stream-json'])
    expect(run.tokenInEnv, 'no token in the agy environment').toBe(false)
    expect(isProcessAlive(run.pid), 'the Host launched the stub agy').toBe(true)

    // Send (A-23): the text is a second stream-json turn, answered in the chat.
    const sent = (await window.evaluate(
      `window.api.sendDwarfText(${JSON.stringify({
        dwarfId,
        text: 'Carry on.',
        attachments: [],
        requestId: uuidv7()
      })})`
    )) as { ok: boolean; value?: { ok: boolean } }
    expect(sent, 'A-23 accepts the message').toMatchObject({ ok: true, value: { ok: true } })
    await expect
      .poll(async () => (await chatOf(window, dwarfId!)).map((m) => m.text.trim()), {
        timeout: 60_000,
        message: 'the stub answered the sent message'
      })
      .toContain(REPLIES.next)

    // Stop dwarf (A-N29): the whole session ends and the dwarf walks out.
    const stopped = await window.evaluate(
      `window.api.stopDwarf(${JSON.stringify({ dwarfId, requestId: uuidv7() })})`
    )
    expect(stopped, 'A-N29 ends the session').toMatchObject({ ok: true, value: { ok: true } })
    await expect
      .poll(() => isProcessAlive(run.pid), { timeout: 30_000, message: 'the stub agy ended' })
      .toBe(false)

    // Read only after the Host exited (the single writer, ADR-002 D1): the dwarf departed stopped.
    await launched.teardown({ stopEverything: true })
    launched = undefined
    const db = openHostDatabaseReadOnly(owned)
    try {
      const row = db
        .prepare('SELECT departure_cause AS cause FROM dwarfs WHERE id = ?')
        .get(dwarfId) as { cause: string | null } | undefined
      expect(row?.cause, 'the stopped dwarf departed stopped').toBe('stopped')
    } finally {
      db.close()
    }
  })
})
