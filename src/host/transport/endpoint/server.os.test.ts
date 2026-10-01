// L8 OS lane (17 §1.8): the real modes of the Host's UI endpoint on this OS. Runs only in
// `pnpm test:os`.
//
// Windows: the ADR-003 security test (a second local user and a remote client are refused) needs
// the SP-05 pipe helper, which ISSUE-022 reports BLOCKED; until it exists the Windows half has no
// case here, and the interim rule (no byte before authentication, a logged degraded ACL) is
// proven on a real pipe by server.test.ts.
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import { NodeScheduler } from '../../platform/clock/NodeScheduler'
import { decideBind } from '../../wiring/singleInstance'
import { bindEndpoint } from './server'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe.runIf(process.platform !== 'win32')('the UI endpoint on POSIX', () => {
  it('[ADR-003] the socket is 0600 and its run directory 0700', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dwarfai-022-os-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const dir = join(root, 'run')
    // A run directory left wider by someone else is narrowed, not trusted.
    mkdirSync(dir, { mode: 0o755 })
    const path = join(dir, 'host-0123456789ab.sock')

    const outcome = await bindEndpoint(
      { kind: 'unix-socket', dir, path },
      {
        log: new RecordingDiagnosticsLog(),
        scheduler: new NodeScheduler({ onTaskError: () => {} }),
        decide: decideBind,
        probeExisting: () => Promise.resolve('no-hello')
      }
    )
    if (outcome.kind !== 'bound') throw new Error(`expected a bind, got ${outcome.kind}`)
    cleanups.push(() => outcome.endpoint.close())

    expect(lstatSync(path).isSocket()).toBe(true)
    expect((lstatSync(path).mode & 0o777).toString(8)).toBe('600')
    expect((lstatSync(dir).mode & 0o777).toString(8)).toBe('700')

    // A run directory the Host creates itself, with its missing parents, is 0700 too.
    const fresh = join(root, 'fresh', 'run')
    const second = await bindEndpoint(
      { kind: 'unix-socket', dir: fresh, path: join(fresh, 'host-0123456789ab.sock') },
      {
        log: new RecordingDiagnosticsLog(),
        scheduler: new NodeScheduler({ onTaskError: () => {} }),
        decide: decideBind,
        probeExisting: () => Promise.resolve('no-hello')
      }
    )
    if (second.kind !== 'bound') throw new Error(`expected a bind, got ${second.kind}`)
    cleanups.push(() => second.endpoint.close())
    expect((lstatSync(fresh).mode & 0o777).toString(8)).toBe('700')
  })
})
