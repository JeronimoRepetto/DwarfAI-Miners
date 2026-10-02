// The directory the Host's versioned copy is made from (ADR-002 D5; SP-03 decision table). Node
// built-ins only and erasable TypeScript only, so scripts/build/write-host-manifest.mjs imports it as
// it is (Node 24 strips the types) and names the same directory the launcher copies; for that script the
// one local import names its `.ts`.
import path from 'node:path'
import { HOST_MANIFEST_FILE } from './hostManifest.ts'

export type CopyPlatform = 'win32' | 'darwin' | 'linux'

/**
 * The directory the copy is made from: the one holding the executable and its `resources`
 * (ADR-002 D5), or on macOS the `.app` bundle the executable sits in (`<Name>.app/Contents/MacOS/`),
 * whose `Contents/Resources` and `Contents/Frameworks` the Host needs too (SP-03).
 */
export function copySourceOf(execPath: string, platform: CopyPlatform): string {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const folder = paths.dirname(execPath)
  if (platform === 'darwin') {
    const contents = paths.dirname(folder)
    const bundle = paths.dirname(contents)
    if (
      paths.basename(folder) === 'MacOS' &&
      paths.basename(contents) === 'Contents' &&
      bundle.endsWith('.app')
    ) {
      return bundle
    }
  }
  return folder
}

/**
 * The resources folder of a packaged app inside its copy source (copySourceOf): `Contents/Resources`
 * of the macOS `.app` bundle, `resources` beside the executable elsewhere. It is the packaged app's
 * `process.resourcesPath`, where the packaging hook writes `host-manifest.json`
 * (scripts/build/write-packaged-host-manifest.mjs).
 */
export function packagedResourcesDirOf(sourceDir: string, platform: CopyPlatform): string {
  const paths = platform === 'win32' ? path.win32 : path.posix
  return platform === 'darwin' && sourceDir.endsWith('.app')
    ? paths.join(sourceDir, 'Contents', 'Resources')
    : paths.join(sourceDir, 'resources')
}

/**
 * Where this build's `host-manifest.json` is (ADR-002 D5). A development or test build reads it
 * beside its build output (scripts/build/write-host-manifest.mjs). A packaged build reads it from
 * its resources folder: outside `app.asar`, which the manifest lists and so cannot hold it, and
 * inside the copy source, whose check leaves the manifest's own path out.
 */
export function hostManifestPathOf(
  build: { packaged: boolean; outDir: string; resourcesPath: string },
  platform: CopyPlatform
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix
  return paths.join(build.packaged ? build.resourcesPath : build.outDir, HOST_MANIFEST_FILE)
}
