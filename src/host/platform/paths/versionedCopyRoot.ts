// The OS facts behind the `host.upgrade.request.targetDir` rule (14 §1.10; ADR-002 D5): this
// process's platform, the versioned-copy root named by the one rule the UI's launcher uses too
// (contracts `versionedCopyRoot`, from the environment the Host inherited from the UI and this
// Host's build kind, which is its UI's: a dev Host accepts only the dev copy root), and the
// native `realpath` that resolves every link of an existing path. R18: the OS knowledge is read
// here, under host/platform; the rule itself is the transport's (methods/hostUpgradeRequest.ts).
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { versionedCopyRoot, type CopyRootBuild, type EndpointPlatform } from '@dwarfai/contracts'

export interface HostCopyRootFacts {
  platform: EndpointPlatform
  /** The ADR-002 D5 root, or null when it cannot be named (no LOCALAPPDATA, no home folder). */
  root: string | null
  /** Resolves every link of an existing path; throws when it does not exist. */
  realpath(target: string): string
}

export function hostCopyRootFacts(options: {
  /** This Host's build kind (releaseDataDir.ts `buildKindOf`). */
  build: CopyRootBuild
  /** The environment; default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>
}): HostCopyRootFacts {
  const env = options.env ?? process.env
  const platform: EndpointPlatform =
    process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
  const root = versionedCopyRoot({ platform, build: options.build, env, homeDir: homedir() })
  return {
    platform,
    root: root.ok ? root.value : null,
    realpath: (target) => realpathSync.native(target)
  }
}
