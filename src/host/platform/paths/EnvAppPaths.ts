// The production AppPaths (16 §3; ADR-002 D2; AMENDMENT-10, OQ-78).
//
// - `userDataDir` is the value of DWARFAI_HOST_DATA_DIR, which the spawning UI sets to Electron
//   `userData` + `/host` (the hostDataDir). Missing or empty, construction is refused with a typed
//   error, which the boot turns into a logged refusal to start.
// - `resourcesPath` is used only when packaged (the rule of the legacy `resolveResourcePath`: a dev
//   build ignores it), so it is null in dev. Whether Electron sets `process.resourcesPath` under
//   ELECTRON_RUN_AS_NODE is UNVERIFIED (SP-04): the composition root passes what the process has.
// - Every value is read once and frozen: fixed for the Host's life.
import type { Result } from '../../kernel/domain/values'
import type { AppPaths } from '../../kernel/ports/appPaths'

export const HOST_DATA_DIR_ENV = 'DWARFAI_HOST_DATA_DIR'

/** What the composition root reads from the Host process, passed in once at boot. */
export interface HostProcessFacts {
  env: Readonly<Record<string, string | undefined>>
  execPath: string
  resourcesPath: string | undefined
  isPackaged: boolean
}

export type EnvAppPathsRefusal = 'host-data-dir-missing'

export class EnvAppPaths implements AppPaths {
  readonly userDataDir: string
  readonly execPath: string
  readonly resourcesPath: string | null
  readonly isPackaged: boolean

  private constructor(values: AppPaths) {
    this.userDataDir = values.userDataDir
    this.execPath = values.execPath
    this.resourcesPath = values.resourcesPath
    this.isPackaged = values.isPackaged
    Object.freeze(this)
  }

  static create(facts: HostProcessFacts): Result<EnvAppPaths, EnvAppPathsRefusal> {
    const userDataDir = facts.env[HOST_DATA_DIR_ENV]
    if (userDataDir === undefined || userDataDir === '') {
      return { ok: false, error: 'host-data-dir-missing' }
    }
    const resourcesPath =
      facts.isPackaged && facts.resourcesPath !== undefined && facts.resourcesPath !== ''
        ? facts.resourcesPath
        : null
    return {
      ok: true,
      value: new EnvAppPaths({
        userDataDir,
        execPath: facts.execPath,
        resourcesPath,
        isPackaged: facts.isPackaged
      })
    }
  }
}
