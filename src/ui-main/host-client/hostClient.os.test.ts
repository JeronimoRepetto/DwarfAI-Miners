// L8 OS lane (17 §1.6, §1.8; ADR-003 items 1, 5–9, 12; TC-051-04): the attach suite of hostClient.contract.test.ts
// over this OS's real endpoint — the owner-only named pipe on Windows, the `0600` Unix socket elsewhere — against
// the real Host of this checkout (out/host/main.js, built here), run as the launcher runs it. The Host binds the
// endpoint its ADR-002 D2 rule names for a temporary data folder, and the client names the same one by the same rule;
// on POSIX the home and runtime folders are temporary too, so nothing of the owner's app is ever met. Every Host
// started is killed in the `finally`, and the temporary folder removed.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION, type SnapshotPage } from '@dwarfai/contracts'
import { RecordingUiLog } from '../hostLauncher/fakes/RecordingUiLog'
import { createNodeHostConnection, createNodeHungHostEnder } from '../hostLauncher'
import {
  buildRealHost,
  REPO_ROOT,
  startRealHost,
  type RealHost
} from '../hostLauncher/testing/realHost'
import type { HostEvent } from '../window/ports/hostClient'
import { createHostClient, HostCallError, type HostClientService } from './HostClient'

const WINDOWS = process.platform === 'win32'
const CASE_TIMEOUT_MS = 120_000
const CUT_0_CAPABILITIES = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'fixtures', 'ipc', 'capabilities', 'cut-0.json'), 'utf8')
) as string[]
// What this checkout's Host serves beyond the cut-0 release list: the preferences module's members and
// section, served from cut 1 (ISSUE-226), and the mines module's (ISSUE-093). Each release commits its own list (17 §1.6 "Versioning and
// capabilities"); until the cut-1 list is committed, the cut-0 list plus these is the exact set.
const SERVED_SINCE_CUT_0 = [
  'frame:preferences.changed',
  'frame:reset.progress',
  'frame:ui.resetPreferences',
  'preferences.get',
  'preferences.resetMetrics',
  'preferences.set',
  'section:preferences',
  'ui.resetPreferences.ack',
  // The mines module's members, section and board frames, served from cut 1 (ISSUE-093).
  'frame:dwarf.arrived',
  'frame:dwarf.changed',
  'frame:dwarf.departed',
  'frame:mine.changed',
  'frame:mine.removed',
  'frame:toast',
  'mines.adoptMainProject',
  'mines.declare',
  'mines.list',
  'mines.remove',
  'mines.resolveFile',
  'section:mines',
  // The crew module's section and B-M41, served from cut 1 (ISSUE-094).
  'section:dwarfs',
  'strangler.dwarfIdentities',
  // The ledger's frame, served from cut 1 (ISSUE-096).
  'frame:ledger.changed',
  // The attention frames, B-M07 and B-M08, served from cut 1 (ISSUE-119).
  'attention.clicked',
  'frame:attention.notify',
  'frame:attention.withdraw',
  'presence',
  // The conversation read side: B-M26, B-M27, the `tails` section and its frames, served from cut 1
  // (ISSUE-108).
  'conversation.feed',
  'conversation.mineHistory',
  'frame:conversation.appended',
  'frame:turn.ended',
  'section:tails'
]
const SERVED_SECTIONS = ['meta', 'preferences', 'mines', 'dwarfs', 'tails']

let entry = ''
let root = ''

beforeAll(async () => {
  entry = await buildRealHost()
  // On POSIX directly under /tmp, so the socket path fits sun_path on macOS.
  root = WINDOWS ? mkdtempSync(path.join(tmpdir(), 'dwarfai-051-os-')) : mkdtempSync('/tmp/dw051-')
}, CASE_TIMEOUT_MS)

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/** Waits until `check` holds, polling every 25 ms, for at most `ms`. */
async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe.runIf(['win32', 'darwin', 'linux'].includes(process.platform))(
  'HostClient over the real endpoint',
  () => {
    it(
      '[ADR-003] the same attach suite passes over the real named pipe or Unix socket',
      async () => {
        const hostDataDir = path.join(root, 'DwarfAI-test', 'host')
        mkdirSync(hostDataDir, { recursive: true })
        const env: Record<string, string> = WINDOWS
          ? {}
          : { HOME: path.join(root, 'home'), XDG_RUNTIME_DIR: path.join(root, 'xdg') }
        for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true, mode: 0o700 })
        const hosts: RealHost[] = []
        // The Hosts this test ended. The client can see a killed Host's endpoint close before Node reports the
        // process's exit (on Windows the pipe instances close during the teardown, the exit is signalled once it is
        // complete), so `alive` alone may still be true while nothing listens any more.
        const ended = new Set<RealHost>()
        let client: HostClientService | undefined
        try {
          const launches: string[] = []
          const log = new RecordingUiLog()
          client = createHostClient({
            // The launcher's part, as ADR-002 D4 has it: a Host that is gone is started again. Like the real
            // launcher, which attaches only to a Host that answers its hello probe, it never attaches to a Host this
            // test ended; it waits for that Host's exit before spawning the next one.
            launcher: {
              async ensureHostRunning() {
                const last = hosts.at(-1)
                if (last !== undefined && ended.has(last)) await last.exited
                else if (last?.alive === true) return 'attached'
                launches.push('spawned')
                hosts.push(await startRealHost({ entry, hostDataDir, env }))
                return 'spawned'
              }
            },
            ...createNodeHostConnection({
              hostDataDir,
              uiEnv: { ...process.env, ...env },
              ...(env.HOME === undefined ? {} : { home: env.HOME })
            }),
            protocolVersion: PROTOCOL_VERSION,
            client: { appVersion: '0.0.0-os051', buildId: 'os-test', pid: process.pid },
            timers: {
              now: () => Date.now(),
              after: (ms, run) => {
                const timer = setTimeout(run, ms)
                return () => clearTimeout(timer)
              }
            },
            log,
            hungHost: createNodeHungHostEnder({ hostDataDir, uiEnv: { ...process.env, ...env } })
          })
          const events: HostEvent[] = []
          client.subscribe((event) => events.push(event))
          const snapshots = (): SnapshotPage[] =>
            events.flatMap((e) => (e.kind === 'snapshot' ? [e.snapshot] : []))

          // hello first, events.subscribe, then the paged snapshot (TC-051-01).
          expect(await client.ensureHost()).toBe('available')
          await until(() => snapshots().length === 1).catch(() => {
            const c = client as unknown as Record<string, unknown>
            expect({
              events,
              state: client?.state(),
              ui: c.ui !== null,
              reader: c.reader !== null,
              log: log.entries
            }).toEqual({})
          })
          expect(client.state()).toMatchObject({ state: 'connected', compat: false })
          expect([...client.capabilities()].sort()).toEqual(
            [...CUT_0_CAPABILITIES, ...SERVED_SINCE_CUT_0].sort()
          )
          const first = snapshots()[0] as SnapshotPage
          expect(first.next).toBeUndefined()
          expect(first.chunks.map((c) => c.section)).toEqual(SERVED_SECTIONS)

          // A method the Host did not advertise is refused locally (TC-051-02).
          const refused = await client
            .call(
              'conversation.send' as never,
              { requestId: '01890a5d-ac96-774b-bcce-b302099a8001' } as never
            )
            .catch((error: unknown) => error)
          expect((refused as HostCallError).error.code).toBe('NOT_SUPPORTED')

          // A short-lived ui connection reads the snapshot and closes (OQ-47).
          const page = await client.withUiConnection((c) => c.snapshot({}))
          expect(page.chunks.map((c) => c.section)).toEqual(SERVED_SECTIONS)

          // The Host dies: the client reconnects, the launcher starts a new Host, and the new epoch is a fresh snapshot.
          // Every state change is recorded from before the kill, so the short-lived `reconnecting` is never missed.
          const states: string[] = []
          client.onStateChange((s) =>
            states.push(s.state === 'unavailable' ? `unavailable:${s.reason}` : s.state)
          )
          ended.add(hosts[0] as RealHost)
          await (hosts[0] as RealHost).kill()
          await until(() => snapshots().length === 2, 30_000).catch((error: unknown) => {
            const cause = error instanceof Error ? error.message : String(error)
            throw new Error(`${cause}; states since the kill: ${states.join(' → ')}`)
          })
          expect(states).toEqual(['reconnecting', 'connected'])
          expect(client.state()).toMatchObject({ state: 'connected' })
          expect(launches).toEqual(['spawned', 'spawned'])
          expect(snapshots()[1]?.epoch).not.toBe(first.epoch)

          // The uiToken never reaches the log.
          const token = readFileSync(path.join(hostDataDir, 'run', 'ui.token'), 'utf8').trim()
          expect(token.length).toBeGreaterThan(0)
          expect(JSON.stringify(log.entries)).not.toContain(token)
        } finally {
          client?.dispose()
          for (const host of hosts) await host.kill()
        }
      },
      CASE_TIMEOUT_MS
    )
  }
)
