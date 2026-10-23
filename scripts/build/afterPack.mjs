// electron-builder's afterPack hook (package.json `build.afterPack`): the steps that change the packed app. The
// Host's build manifest lists the files that ship, so it runs last (write-packaged-host-manifest.mjs). AMENDED for
// ISSUE-184, the step-3a deletion (was: `pruneSdkRuntimes.mjs` first, stripping the Agent SDK runtimes of the other
// targets): the Agent SDK left the tree, so nothing is pruned. AMENDED for ISSUE-269: the Electron fuses of ADR-019
// item 5 are flipped first (scripts/release/fuses.mjs), so the manifest hashes the fused binary. electron-builder's
// own `electronFuses` option would flip them after this hook, after the manifest (S-019-2).
import { flipFuses } from '../release/fuses.mjs'
import writePackagedManifest from './write-packaged-host-manifest.mjs'

/** Runs the afterPack steps in order: the fuses on the packed binary, then the Host manifest over the result. */
export async function runAfterPack(
  context,
  { flip = flipFuses, writeManifest = writePackagedManifest } = {}
) {
  await flip(context)
  await writeManifest(context)
}

export default async function afterPack(context) {
  await runAfterPack(context)
}
