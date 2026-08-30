import { join } from 'node:path'

export interface ResourcePathOptions {
  isPackaged: boolean
  /** process.resourcesPath — used only when packaged. */
  resourcesPath: string
  /** app.getAppPath() (the project root pre-package, i.e. in dev). */
  appPath: string
}

/**
 * Where a file under `resources/` (tray and window icons, the transcript
 * viewer scripts) lives at runtime: alongside `resources/` at the project
 * root in dev, or directly under `process.resourcesPath` once packaged (see
 * `build.extraResources` in package.json, which copies resources/* there).
 *
 * Same convention as terminalLauncher's resolveViewerScriptPath, generalized
 * so icon-loading code does not have to duplicate it.
 */
export function resolveResourcePath(name: string, options: ResourcePathOptions): string {
  return options.isPackaged
    ? join(options.resourcesPath, name)
    : join(options.appPath, 'resources', name)
}
