// layer: L4
// The `--help` probe of an ACP agent installed as an npm script on Windows (ADR-029 row 8; issue #1360; ADR-009 D4,
// D5; ISSUE-238): the one resolver answers the `.mjs` / `.js` entry the shim names, which Windows cannot start by
// itself and which R17 forbids starting through a shell. The launch already runs it with the person's own `node`
// (`adapterLaunch`); the probe must too, or the help is never read, `launch` stays closed and the agent is offered
// nowhere (the step-4b OpenCode E2E found it: a Host-launched `opencode acp` never started on Windows).
import type { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../../../kernel/fakes/FakeClock'
import { FakeProcessControl } from '../../../../../kernel/fakes/FakeProcessControl'
import { FakeScheduler } from '../../../../../kernel/fakes/FakeScheduler'
import type { SpawnSpec, SpawnedProcess } from '../../../../../kernel/ports/processControl'
import { createInstallDetection } from '../../../application/detection'
import type { CatalogRecord } from '../../../domain/profile'
import { FakeInstallResolver } from '../../../ports/fakes/FakeInstallResolver'
import type { InstalledProvider } from '../../../ports/providerDriver'
import { CATALOG_RECORDS, OPENCODE_ACP } from '../../catalog/profiles'
import { AcpDriver } from './AcpDriver'

const OPENCODE = CATALOG_RECORDS.find((record) => record.profile.id === 'opencode') as CatalogRecord
const ENTRY = 'C:/Users/j/AppData/Roaming/npm/node_modules/opencode-ai/bin/opencode.mjs'
const NODE = 'C:/Program Files/nodejs/node.exe'
const HELP = 'Commands:\n  opencode acp                 start ACP (Agent Client Protocol) server\n'

/** A driver on win32 whose resolver answers the npm entry for `opencode` and the person's `node`. */
function windowsDriver() {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  const processes = new FakeProcessControl({ clock })
  const resolver = new FakeInstallResolver()
  resolver.install('opencode', { path: ENTRY, version: '1.18.32' })
  resolver.install('node', { path: NODE, version: '24.0.0' })
  // Every spawn prints the help and exits 0, as the agent's `--help` does.
  const spawn = (spec: SpawnSpec): SpawnedProcess => {
    const spawned = processes.spawn(spec)
    void spawned.identity.then((identity) => {
      ;(spawned.stdout as PassThrough | null)?.end(HELP)
      ;(spawned.stderr as PassThrough | null)?.end()
      processes.exit(identity.pid, { code: 0, signal: null })
    })
    return spawned
  }
  const driver = new AcpDriver({
    record: OPENCODE,
    row: OPENCODE_ACP.row,
    agentArgs: OPENCODE_ACP.agentArgs,
    detection: createInstallDetection({
      resolver,
      fs: { stat: async () => ({ mtimeMs: 0, size: 1, isDirectory: false }) },
      scheduler
    }),
    processControl: { ...processes, spawn } as unknown as FakeProcessControl,
    clock,
    scheduler,
    loginEnv: { PATH: 'C:/Program Files/nodejs' },
    home: 'C:/Users/j',
    platform: 'win32',
    redact: (text) => text
  })
  return { driver, processes }
}

const INSTALL: InstalledProvider = {
  providerId: OPENCODE.profile.id,
  binaryPath: ENTRY,
  version: '1.18.32',
  resolvedVia: 'path',
  statMtimeMs: 0
}

describe('AcpDriver on Windows with an npm script entry (#1360)', () => {
  it('[ADR-009] the --help probe runs the npm entry with the person node, so launch opens', async () => {
    const { driver, processes } = windowsDriver()
    const capabilities = await driver.probe(INSTALL)
    expect(processes.spawns.map((spawned) => [spawned.executable, spawned.args])).toEqual([
      [NODE, [ENTRY, '--help']]
    ])
    expect(capabilities.launch).toBe(true)
  })
})
