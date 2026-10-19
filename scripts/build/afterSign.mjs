// electron-builder's afterSign hook (package.json `build.afterSign`). electron-builder 26 calls it after its
// signing step whenever that step reports success, signed or not (WinPackager and MacPackager `signApp`; never
// on Linux, which has no signing step and so changes nothing after afterPack).
//
// - Windows: the signing step edits the executable's resources (icon, version) and signs the executables when
//   a certificate is configured, so the manifest afterPack wrote no longer matches. It is written again here,
//   over the files that ship. Authenticode signs each file on its own, so the manifest beside them changes no
//   signature.
// - macOS: nothing is written. An unsigned build is unchanged since afterPack; a signed bundle seals every
//   file in it, so a file added now would break its signature. A signed build's manifest therefore lists the
//   binaries as they were before signing, and verify-packaged-host-manifest.mjs fails such a build: the
//   signed layout is ISSUE-270's, behind its SP-03 gate.
import writePackagedManifest from './write-packaged-host-manifest.mjs'

export default async function afterSign(context) {
  if (context.electronPlatformName === 'win32') await writePackagedManifest(context)
}
