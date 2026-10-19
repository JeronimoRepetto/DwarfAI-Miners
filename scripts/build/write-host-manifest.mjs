#!/usr/bin/env node
// Writes `host-manifest.json` for a development or test build (ADR-002 D5; lead decision
// 2026-09-30 in ISSUE-031): the file list + SHA-256 of the directory the Host's versioned copy is
// made from, which the launcher checks every fresh copy against before its atomic rename.
//
//   node scripts/build/write-host-manifest.mjs [--source <dir>] [--out <file>]
//
// - `--source` defaults to the directory the launcher copies when it runs on the Electron runtime
//   this repository installs: the folder holding the executable, or `Electron.app` on macOS
//   (copySource.ts, the same function the launcher uses).
// - `--out` defaults to `out/host-manifest.json`, beside the build output; `pnpm build` runs this
//   script right after `electron-vite build`, which empties `out/` first.
//
// Packaged builds get their manifest from the packaging job (later: ISSUE-270), written by the same
// buildManifest. Plain Node: the two TypeScript modules it imports use Node built-ins only, and Node
// 24 strips their types.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { copySourceOf } from '../../src/ui-main/hostLauncher/copySource.ts'
import { buildManifest, serializeManifest } from '../../src/ui-main/hostLauncher/hostManifest.ts'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function option(name) {
  const at = process.argv.indexOf(name)
  if (at === -1) return undefined
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return path.resolve(value)
}

function defaultSource() {
  // The `electron` package's main export is its executable's path.
  const electron = createRequire(path.join(rootDir, 'package.json'))('electron')
  const platform =
    process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'
  return copySourceOf(electron, platform)
}

const source = option('--source') ?? defaultSource()
const out = option('--out') ?? path.join(rootDir, 'out', 'host-manifest.json')
const manifest = await buildManifest(source)
mkdirSync(path.dirname(out), { recursive: true })
writeFileSync(out, serializeManifest(manifest), 'utf8')
console.log(`host-manifest.json: ${manifest.entries.length} entries`)
