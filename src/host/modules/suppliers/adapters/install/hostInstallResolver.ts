// The Host's `CliInstallResolver` (ADR-009 D5): the one place the resolver reads the running OS, the
// Host's own environment and home directory, and the OS realpath (R18: adapters only). The kernel
// ports come from the composition root (`host/main.ts`, wired by ISSUE-159).
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { FileSystem } from '../../../../kernel/ports/fileSystem'
import type { ProcessControl } from '../../../../kernel/ports/processControl'
import type { Scheduler } from '../../../../kernel/ports/scheduler'
import { CliInstallResolver } from './CliInstallResolver'
import type { HostEnv, Platform } from './searchDirs'

export interface HostInstallResolverDeps {
  readonly fs: Pick<FileSystem, 'stat' | 'readTextHead'>
  readonly processControl: ProcessControl
  readonly scheduler: Scheduler
  /** Defaults: the running OS, the Host's environment and home (tests pass their own). */
  readonly platform?: Platform
  readonly env?: HostEnv
  readonly home?: string
}

export function createHostInstallResolver(deps: HostInstallResolverDeps): CliInstallResolver {
  return new CliInstallResolver({
    platform: deps.platform ?? hostPlatform(),
    env: deps.env ?? process.env,
    home: deps.home ?? homedir(),
    fs: deps.fs,
    realpath: (path) => realpath(path).then(String, () => null),
    processControl: deps.processControl,
    scheduler: deps.scheduler
  })
}

function hostPlatform(): Platform {
  const running = process.platform
  return running === 'win32' || running === 'darwin' ? running : 'linux'
}
