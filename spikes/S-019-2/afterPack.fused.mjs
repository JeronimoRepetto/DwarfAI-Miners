// Spike S-019-2: the afterPack hook of the fused build (spikes/S-019-2/electron-builder.fused.cjs). It flips the fuse
// set of ADR-019 item 5 through electron-builder's own `addElectronFuses` (the documented afterPack alternative to the
// `electronFuses` option), then runs the product's afterPack, which writes `host-manifest.json` last.
//
// Why not `electronFuses`: electron-builder 26.15 flips those fuses after the afterPack hook, so the manifest lists the
// unfused binary. Windows rewrites the manifest in afterSign; macOS and Linux do not, and in run 39134423991 the Host's
// versioned copy of the fused build failed there with MANIFEST_MISMATCH. ISSUE-269, which flips the fuses for real,
// meets the same ordering.
import productAfterPack from '../../scripts/build/afterPack.mjs'

/** ADR-019 item 5, in electron-builder's `electronFuses` names (scripts/release/packaged/fuses.mjs RECORDED_FUSE_SET). */
export const ADR_019_ELECTRON_FUSES = {
  runAsNode: true,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true
}

/** Flips the set on the packed app's binary, then runs `afterPack` (the product's by default). */
export async function flipFusesThenAfterPack(context, afterPack = productAfterPack) {
  const fuses = await context.packager.generateFuseConfig(ADR_019_ELECTRON_FUSES)
  await context.packager.addElectronFuses(context, fuses)
  await afterPack(context)
}

export default function afterPackFused(context) {
  return flipFusesThenAfterPack(context)
}
