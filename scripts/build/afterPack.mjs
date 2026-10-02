// electron-builder's afterPack hook (package.json `build.afterPack`): the steps that change the packed app,
// in order. The SDK runtime prune changes which files ship, so it runs first; the Host's build manifest
// lists the files that ship, so it runs last (write-packaged-host-manifest.mjs).
import pruneSdkRuntimes from '../pruneSdkRuntimes.mjs'
import writePackagedManifest from './write-packaged-host-manifest.mjs'

export default async function afterPack(context) {
  await pruneSdkRuntimes(context)
  await writePackagedManifest(context)
}
