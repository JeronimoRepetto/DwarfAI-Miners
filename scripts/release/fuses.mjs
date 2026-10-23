// The Electron fuse step of ADR-019 item 5 (`18` C-09, T-09; `20` §2.1 `package`; ISSUE-269).
//
// electron-builder's afterPack hook (scripts/build/afterPack.mjs) calls `flipFuses` on every packed app, before the
// Host manifest is written. The set comes from fuses.expected.json, the per-target record of spike S-019-2, which P-01
// (packaged/p01-fuses.packaged.mjs) also reads back from each artifact, so the step and its check share one source.
//
// Why not electron-builder's `electronFuses` option: electron-builder 26.15 (app-builder-lib platformPackager `doPack`)
// flips those fuses after the afterPack hook, so the Host manifest afterPack writes would list the unfused binary and
// the packaged Host's versioned copy fails with MANIFEST_MISMATCH on macOS and Linux (S-019-2, run 39134423991). The
// packager's own `generateFuseConfig` and `addElectronFuses`, documented for use inside afterPack, flip the same set
// with the @electron/fuses electron-builder already ships, so no dependency is added.
import { readFileSync } from 'node:fs'

/** The recorded fuse set: `{ fuses: { <wire name>: 'enabled' | 'disabled' }, targets: { <platform>: … } }`. */
export function loadExpectedFuses() {
  return JSON.parse(readFileSync(new URL('./fuses.expected.json', import.meta.url), 'utf8'))
}

/**
 * The fuses P-01 asserts on one target (`win32`, `darwin`, `linux`) and that target's known limits. A known limit the
 * target flips (`flipped: true`) is still asserted on the wire; one it cannot flip is left out, every other fuse kept.
 */
export function expectedFusesFor(doc, target) {
  const record = doc.targets?.[target]
  if (record === undefined)
    throw new Error(`no recorded fuse set for ${target} in fuses.expected.json`)
  const knownLimits = record.knownLimits ?? []
  const unflippable = new Set(knownLimits.filter((limit) => !limit.flipped).map(({ fuse }) => fuse))
  const fuses = Object.fromEntries(
    Object.entries(doc.fuses).filter(([name]) => !unflippable.has(name))
  )
  return { fuses, knownLimits }
}

/** A wire name as electron-builder's `electronFuses` option names it: `RunAsNode` → `runAsNode`. */
function optionNameOf(fuse) {
  return fuse[0].toLowerCase() + fuse.slice(1)
}

/** The fuses one target flips, in electron-builder's option names, `true` for enabled. */
export function electronBuilderFuseOptions(doc, target) {
  const { fuses } = expectedFusesFor(doc, target)
  return Object.fromEntries(
    Object.entries(fuses).map(([name, state]) => [optionNameOf(name), state === 'enabled'])
  )
}

/** Flips the recorded set on the packed app of an afterPack `context`, through electron-builder's own fuse writer. */
export async function flipFuses(context, doc = loadExpectedFuses()) {
  const { packager, electronPlatformName } = context
  const config = await packager.generateFuseConfig(
    electronBuilderFuseOptions(doc, electronPlatformName)
  )
  await packager.addElectronFuses(context, config)
}
