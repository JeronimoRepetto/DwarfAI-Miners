import { FakeInstallResolver } from '../ports/fakes/FakeInstallResolver'
import { layMachine } from './cliResolverMachine'
import {
  runInstallResolverContract,
  type InstallLayout,
  type MachineInstall,
  type ResolverMachine,
  type ResolverUnderTest
} from './installResolver.contract'
import { AGY_PLACES, SHIM_TABLE } from './installResolver.fixtures'

/** The search order of ADR-009 D5 and AMENDMENT-13, as the double needs it to pick one install. */
const ORDER: readonly InstallLayout[] = [
  'override',
  'path',
  'path-link',
  'path-cmd',
  'path-bat',
  'npm',
  'homebrew',
  'pnpm',
  'volta',
  'bun',
  'scoop',
  'winget',
  'local-bin',
  'login-shell'
]

function fakeOn(machine: ResolverMachine): ResolverUnderTest {
  const resolver = new FakeInstallResolver()
  const first = new Map<string, MachineInstall>()
  const ranked = [...machine.installs].sort(
    (a, b) => ORDER.indexOf(a.layout) - ORDER.indexOf(b.layout)
  )
  for (const install of ranked) if (!first.has(install.binary)) first.set(install.binary, install)
  for (const install of first.values()) {
    resolver.install(install.binary, {
      path: install.target,
      version: install.version,
      quarantined: install.quarantined === true,
      loginShellOnly: install.layout === 'login-shell'
    })
  }
  return {
    resolver,
    spawned: () => [],
    loginShellReads: () => resolver.loginShellReads
  }
}

runInstallResolverContract('FakeInstallResolver', fakeOn, SHIM_TABLE, AGY_PLACES)
runInstallResolverContract('CliInstallResolver over FakeFs', layMachine, SHIM_TABLE, AGY_PLACES)
