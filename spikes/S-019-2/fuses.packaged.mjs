#!/usr/bin/env node
// Spike S-019-2 (ADR-019 item 5; spike register S-019-2; testing strategy 17 §4: "fuse set per target, packaged
// builds, becomes the release check"): reads the fuse wire and the asar integrity of every packed app under the given
// folders, and compares the wire with the set ADR-019 item 5 records.
//
//   node spikes/S-019-2/fuses.packaged.mjs --root <dir> [--root <dir> ...] --label <name> --out <dir>
//
// A root is electron-builder's output folder (its `win-unpacked`, `mac-arm64/*.app`, `linux-unpacked` folders) or a
// folder the artifacts were extracted into (spikes/_packaged/extract.mjs), so the record reads what each artifact
// ships. Reads files only. Writes `<out>/<label>.json` and prints one line per app; exits 1 only when no app was found,
// because a difference from the recorded set is the spike's evidence, not a harness failure.
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  asarHeaderLength,
  asarHeaderSha256,
  findWindowsAsarIntegrity,
  parseAsarHeader,
  readMacAsarIntegrity
} from '../../scripts/release/packaged/asar.mjs'
import {
  compareFuses,
  readFuseWire,
  RECORDED_FUSE_SET
} from '../../scripts/release/packaged/fuses.mjs'
import {
  environmentFacts,
  findPackedApps,
  list,
  options,
  writeEvidence
} from '../_packaged/kit.mjs'

function readAsarHeaderOnly(file) {
  const fd = openSync(file, 'r')
  try {
    const first = Buffer.alloc(16)
    readSync(fd, first, 0, 16, 0)
    const whole = Buffer.alloc(asarHeaderLength(first))
    readSync(fd, whole, 0, whole.length, 0)
    return parseAsarHeader(whole)
  } finally {
    closeSync(fd)
  }
}

/** The fuse and integrity facts of one packed app. */
export function inspectApp(app, rootDir) {
  const binary = readFileSync(app.fuseFile)
  const wire = readFuseWire(binary)
  const header = readAsarHeaderOnly(app.asar)
  const headerHash = asarHeaderSha256(header.headerString)
  const recorded =
    app.os === 'darwin'
      ? readMacAsarIntegrity(readFileSync(app.infoPlist, 'utf8'))
      : app.os === 'win32'
        ? findWindowsAsarIntegrity(readFileSync(app.executable))
        : null
  return {
    app: path.relative(rootDir, app.appDir).split(path.sep).join('/'),
    os: app.os,
    fuseFile: path.relative(app.appDir, app.fuseFile).split(path.sep).join('/'),
    wire,
    differencesFromAdr019: wire.found ? compareFuses(wire.fuses, RECORDED_FUSE_SET) : null,
    asarIntegrity: {
      headerSha256: headerHash,
      recorded,
      matches: recorded ? recorded.some((record) => record.value === headerHash) : null
    }
  }
}

function main() {
  const args = options(process.argv.slice(2))
  const roots = list(args.root)
  if (roots.length === 0 || !args.label || !args.out) {
    console.error(
      'usage: fuses.packaged.mjs --root <dir> [--root <dir>] --label <name> --out <dir>'
    )
    return 2
  }
  const apps = []
  for (const root of roots) {
    for (const app of findPackedApps(root)) {
      try {
        apps.push({ root: path.basename(path.resolve(root)), ...inspectApp(app, root) })
      } catch (error) {
        apps.push({ root, app: app.appDir, error: String(error?.message ?? error) })
      }
    }
  }
  writeEvidence(args.out, args.label, {
    spike: 'S-019-2',
    label: args.label,
    environment: environmentFacts(),
    recordedSet: RECORDED_FUSE_SET,
    apps
  })
  for (const app of apps) {
    if (app.error) {
      console.log(`${app.app}: ERROR ${app.error}`)
      continue
    }
    const fuses = app.wire.fuses.map((fuse) => `${fuse.name}=${fuse.state}`).join(' ')
    const diff = app.differencesFromAdr019?.map((d) => d.name).join(',') || 'none'
    console.log(
      `${app.root}/${app.app}: ${fuses} | differs from ADR-019: ${diff} | asar integrity recorded: ` +
        `${app.asarIntegrity.recorded ? 'yes' : 'no'}, matches header: ${app.asarIntegrity.matches}`
    )
  }
  if (apps.length === 0) {
    console.error(`no packed app under ${roots.join(', ')}`)
    return 1
  }
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
