#!/usr/bin/env node
// Checks, after packaging, that every app electron-builder packed into the release folder carries the Host's
// build manifest where the packaged UI reads it, and that the manifest matches the app byte for byte, as a
// fresh versioned copy must (ADR-002 D5). Without it the installed app cannot start its Host
// (`versioned-copy` fails MANIFEST_MISSING or MANIFEST_MISMATCH). No app is started: it reads files only.
//
//   node scripts/build/verify-packaged-host-manifest.mjs <release folder>
//
// The packed apps are electron-builder's unpacked output folders: `win-unpacked`, `linux-unpacked` (and
// `<os>-<arch>-unpacked`), and each `<Name>.app` in `mac` or `mac-<arch>`. A folder with none fails too.
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { verifyPackagedHostManifest } from './write-packaged-host-manifest.mjs'

const releaseDir = process.argv[2]
if (releaseDir === undefined) {
  console.error('usage: verify-packaged-host-manifest.mjs <release folder>')
  process.exit(2)
}

/** Every packed app under the release folder: its copy source, platform and a printable name. */
async function packedApps(dir) {
  const apps = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const folder = path.join(dir, entry.name)
    if (/^win(-[a-z0-9]+)?-unpacked$/.test(entry.name)) {
      apps.push({ sourceDir: folder, platform: 'win32', name: entry.name })
    } else if (/^linux(-[a-z0-9]+)?-unpacked$/.test(entry.name)) {
      apps.push({ sourceDir: folder, platform: 'linux', name: entry.name })
    } else if (/^mac(-[a-z0-9]+)?$/.test(entry.name)) {
      for (const inner of await readdir(folder, { withFileTypes: true })) {
        if (inner.isDirectory() && inner.name.endsWith('.app')) {
          apps.push({
            sourceDir: path.join(folder, inner.name),
            platform: 'darwin',
            name: `${entry.name}/${inner.name}`
          })
        }
      }
    }
  }
  return apps
}

const apps = await packedApps(releaseDir).catch(() => [])
if (apps.length === 0) {
  console.error(`host-manifest: no packed app under ${releaseDir}`)
  process.exit(1)
}
let failed = false
for (const app of apps) {
  const check = await verifyPackagedHostManifest(app.sourceDir, app.platform)
  if (check.ok) {
    console.log(`host-manifest: ${app.name} ok`)
  } else {
    failed = true
    console.error(`host-manifest: ${app.name} ${check.reason}`)
  }
}
process.exit(failed ? 1 : 0)
