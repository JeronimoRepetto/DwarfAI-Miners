// The Node HostCopyPreparer (ports.ts `HostCopyPreparer`; ADR-002 D5; ADR-027 item 2): makes or reuses the Host's
// versioned copy `<copy root>/<version>/` of the app directory that holds the executable (versionedCopy.ts), then
// collects the old copies (versionedCopyGc.ts). The launcher calls it only with the spawn gate held, right before
// the spawn (UC-002). Its contract is testing/copyPreparer.contract.ts.
//
// It answers the app directory under both its names: the one the executable is started from and its real path. They
// differ when the install is reached through a link (a Scoop `current` junction): Electron resolves the app archive's
// real path, so the Host entry is named under the real folder while the executable keeps the link's name, and the
// launcher must find both inside the copy (spawnHost.ts `hostSpawnInputFromCopy`).
import { homedir } from 'node:os'
import type { CopyRootBuild } from '@dwarfai/contracts'
import type { UiLog } from '../diagnostics/uiLogger'
import { plainFs } from './plainFs'
import type { HostCopyPreparer } from './ports'
import {
  copySourceOf,
  ensureVersionedCopy,
  errnoOf,
  nodeCopyOps,
  versionedCopyRoot,
  type CopyPlatform
} from './versionedCopy'
import { collectVersionedCopies } from './versionedCopyGc'

export interface CopyPreparerOptions {
  /** The app executable; the copy is made of the directory that holds it (ADR-002 D5). */
  execPath: string
  /** This build's `host-manifest.json`, describing that directory. */
  hostManifest: string
  /** The app version: the copy's folder name. */
  appVersion: string
  platform: CopyPlatform
  /** The build kind, which names the copy root: `host` for a release build, `host-dev` for a dev one (ADR-005 item 6). */
  build: CopyRootBuild
  /** The UI's environment, which names the per-OS copy root. */
  uiEnv: Readonly<Record<string, string | undefined>>
  /** The copy root to use instead of the ADR-002 D5 one (OS-lane tests use a temporary folder). */
  copyRoot?: string
  log: UiLog
}

/** Makes or reuses `host/<version>/`, then collects the old copies (ADR-002 D5; ADR-027 item 2). */
export function createCopyPreparer(options: CopyPreparerOptions): HostCopyPreparer {
  const { platform, uiEnv } = options
  return async () => {
    const root =
      options.copyRoot === undefined
        ? versionedCopyRoot({ platform, build: options.build, env: uiEnv, homeDir: homedir() })
        : { ok: true as const, value: options.copyRoot }
    if (!root.ok) return root
    const sourceDir = copySourceOf(options.execPath, platform)
    const copy = await ensureVersionedCopy({
      version: options.appVersion,
      sourceDir,
      manifestPath: options.hostManifest,
      root: root.value,
      platform,
      pid: process.pid,
      ops: nodeCopyOps,
      log: options.log,
      clock: { now: Date.now }
    })
    if (!copy.ok) return copy
    await collectVersionedCopies({
      root: root.value,
      inUse: options.appVersion,
      pid: process.pid,
      ops: nodeCopyOps,
      log: options.log
    })
    let sourceRealDir: string
    try {
      sourceRealDir = await plainFs.promises.realpath(sourceDir)
    } catch (error) {
      return { ok: false, errCode: `COPY_${errnoOf(error)}` }
    }
    return { ok: true, sourceDir, sourceRealDir, contentDir: copy.contentDir }
  }
}
