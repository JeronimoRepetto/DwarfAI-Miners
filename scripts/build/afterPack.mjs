// electron-builder's afterPack hook (package.json `build.afterPack`): the steps that change the packed app. The
// Host's build manifest lists the files that ship, so it runs last (write-packaged-host-manifest.mjs). AMENDED for
// ISSUE-184, the step-3a deletion (was: `pruneSdkRuntimes.mjs` first, stripping the Agent SDK runtimes of the other
// targets): the Agent SDK left the tree, so nothing is pruned.
import writePackagedManifest from './write-packaged-host-manifest.mjs'

export default async function afterPack(context) {
  await writePackagedManifest(context)
}
