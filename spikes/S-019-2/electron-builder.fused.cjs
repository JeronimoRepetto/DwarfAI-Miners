// Spike S-019-2: the product's electron-builder configuration (package.json `build`) with the fuse set of ADR-019
// item 5, written to its own output folder. The packaging spike lane builds with it beside the ordinary build, so the
// record shows which fuses electron-builder flips on each target, whether asar integrity is embedded, and whether the
// fused build still starts its Host. It is never the release configuration: flipping the fuses for real is
// ISSUE-269's.
//
// The fuses are flipped by the afterPack hook (spikes/S-019-2/afterPack.fused.mjs) before the product's afterPack
// writes the Host manifest, not through `electronFuses`, which electron-builder 26.15 applies after afterPack (run
// 39134423991: MANIFEST_MISMATCH on macOS and Linux).
//
//   pnpm exec electron-builder --publish never --config spikes/S-019-2/electron-builder.fused.cjs
const path = process.getBuiltinModule('node:path')
const fs = process.getBuiltinModule('node:fs')

const root = path.resolve(__dirname, '..', '..')
const { build } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

module.exports = {
  ...build,
  directories: { ...build.directories, output: 'release-fused' },
  afterPack: 'spikes/S-019-2/afterPack.fused.mjs'
}
