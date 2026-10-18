// Spike S-019-2: the product's electron-builder configuration (package.json `build`) with the fuse set of ADR-019
// item 5 asked of electron-builder 26.15 (`electronFuses`), written to its own output folder. The packaging spike
// lane builds with it beside the ordinary build, so the record shows which fuses electron-builder flips on each
// target and whether asar integrity is embedded. It is never the release configuration: flipping the fuses for real
// is ISSUE-269's.
//
//   pnpm exec electron-builder --publish never --config spikes/S-019-2/electron-builder.fused.cjs
const path = process.getBuiltinModule('node:path')
const fs = process.getBuiltinModule('node:fs')

const root = path.resolve(__dirname, '..', '..')
const { build } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

module.exports = {
  ...build,
  directories: { ...build.directories, output: 'release-fused' },
  electronFuses: {
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true
  }
}
