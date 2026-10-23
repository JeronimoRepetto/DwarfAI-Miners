// The copy source and the copy target of each packaged layout (ADR-027 items 1-2; ADR-002 D5; 20 §3.2 column "Host
// runs from"; SP-03 decision table). Neither install location is an execution path for the Host: the launcher copies
// the packaged app's own layout into `<copy root>/<version>/` and starts the Host from inside that copy.
//
// Layout (its `process.execPath`) -> copy source:
// - Windows Scoop zip (`…\apps\<app>\current\DwarfAI-Miners.exe`) -> the folder of the executable;
// - Windows `nsis` per-user install (`…\Programs\dwarfai-miners\DwarfAI-Miners.exe`) -> the folder of the executable;
// - macOS `.app` from the dmg or zip (`<Name>.app/Contents/MacOS/<Name>`) -> the whole `<Name>.app`;
// - Linux AppImage (`/tmp/.mount_<id>/dwarfai-miners`) -> the FUSE mount folder;
// - Linux deb (`/opt/DwarfAI-Miners/dwarfai-miners`) -> the folder of the executable.
//
// The source rule itself is copySourceOf (copySource.ts), which the build's manifest script shares. This adapter adds
// where the copy goes and where the Host runs inside it: `host/<version>/`, the `.app` keeping its name inside it on
// macOS, the executable at the same relative place. A link-reached install (a Scoop `current` junction) is copied from
// its real path by the copy itself (versionedCopy.ts); here the source keeps the name the app was started under.
import path from 'node:path'
import { copySourceOf, type CopyPlatform } from '../copySource'

export interface PackagedCopyRequest {
  /** The packaged UI's `process.execPath`. */
  execPath: string
  platform: CopyPlatform
  /** The app version: the copy's folder name. */
  version: string
  /** The per-OS copy root (`versionedCopyRoot`, ADR-027 item 2). */
  root: string
}

export interface PackagedCopyPlan {
  /** The install location the copy is made from; never run. */
  sourceDir: string
  /** `<root>/<version>`. */
  copyDir: string
  /** Where the copied app directory is: `copyDir`, or `copyDir/<Name>.app` on macOS. */
  contentDir: string
  /** The Host's execution path: the executable's place inside `contentDir`. */
  executable: string
}

export function packagedCopyPlan(request: PackagedCopyRequest): PackagedCopyPlan {
  const paths = request.platform === 'win32' ? path.win32 : path.posix
  const sourceDir = copySourceOf(request.execPath, request.platform)
  const copyDir = paths.join(request.root, request.version)
  const contentDir =
    request.platform === 'darwin' && sourceDir.endsWith('.app')
      ? paths.join(copyDir, paths.basename(sourceDir))
      : copyDir
  return {
    sourceDir,
    copyDir,
    contentDir,
    executable: paths.join(contentDir, paths.relative(sourceDir, request.execPath))
  }
}
