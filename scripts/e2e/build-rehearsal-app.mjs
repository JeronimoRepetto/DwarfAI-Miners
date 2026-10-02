#!/usr/bin/env node
// Builds the rollback build of the cut-0 rollback rehearsal (ISSUE-057; 21 §2.1 item 1; ADR-002 D8): an app folder of
// this tree with a higher app version and another `protocolVersion`, which `e2e/cut-0/rollback-rehearsal.e2e.ts`
// launches with the E2E harness (`launchApp({ appDir })`) against the Host of the repository's own build.
//
//   node scripts/e2e/build-rehearsal-app.mjs --out <dir> --protocol-version <n> [--app-version <x.y.z>]
//
// - `--out` must lie inside this repository, outside `out/`: the built bundles keep their dependencies external
//   (electron-vite's externalizeDepsPlugin), so Node resolves them from the repository's `node_modules` by walking up.
//   The folder is emptied first. Everything in it is a copy or a fresh build, never a link.
// - The folder holds what the launched app reads from its app path: `package.json` (the version raised, by default one
//   patch above this tree's), `out/` built by the three electron-vite configs with rehearsalBuild.mjs's plugin passed
//   inline (so the configs themselves stay untouched), `out/host-manifest.json` written by the same script as
//   `pnpm build`, and copies of `resources/` and, when built, `prebuilds/` (the Windows native helpers).
// - It checks that the UI-main and the Host bundles both carry the rehearsal's PROTOCOL_VERSION before it reports.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { build } from 'electron-vite'
import { REPO_ROOT, nextPatchVersion, rehearsalBuildPlugin } from './rehearsalBuild.mjs'

function option(name) {
  const at = process.argv.indexOf(name)
  if (at === -1) return undefined
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

const outOption = option('--out')
const protocolOption = option('--protocol-version')
if (outOption === undefined || protocolOption === undefined) {
  console.error(
    'usage: node scripts/e2e/build-rehearsal-app.mjs --out <dir> --protocol-version <n> [--app-version <x.y.z>]'
  )
  process.exit(2)
}
const outRoot = path.resolve(outOption)
const protocolVersion = Number(protocolOption)
const insideRepo = path.relative(REPO_ROOT, outRoot)
const insideOut = path.relative(path.join(REPO_ROOT, 'out'), outRoot)
if (insideRepo === '' || insideRepo.startsWith('..') || path.isAbsolute(insideRepo)) {
  throw new Error(`--out must be a folder inside the repository: ${outRoot}`)
}
if (!insideOut.startsWith('..')) throw new Error(`--out must not be inside out/: ${outRoot}`)

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
const appVersion = option('--app-version') ?? nextPatchVersion(pkg.version)

rmSync(outRoot, { recursive: true, force: true })
mkdirSync(outRoot, { recursive: true })
writeFileSync(
  path.join(outRoot, 'package.json'),
  `${JSON.stringify({ ...pkg, version: appVersion }, null, 2)}\n`,
  'utf8'
)

process.chdir(REPO_ROOT)
const plugin = rehearsalBuildPlugin({ outRoot, protocolVersion, appVersion })
for (const config of [
  'electron.vite.config.ts',
  'electron.vite.host.config.ts',
  'electron.vite.jevMcpServer.config.ts'
]) {
  await build({
    configFile: path.join(REPO_ROOT, config),
    root: REPO_ROOT,
    logLevel: 'warn',
    plugins: [plugin]
  })
}

execFileSync(
  process.execPath,
  [
    path.join(REPO_ROOT, 'scripts', 'build', 'write-host-manifest.mjs'),
    '--out',
    path.join(outRoot, 'out', 'host-manifest.json')
  ],
  { cwd: REPO_ROOT, stdio: 'inherit' }
)
for (const folder of ['resources', 'prebuilds']) {
  const from = path.join(REPO_ROOT, folder)
  if (existsSync(from)) cpSync(from, path.join(outRoot, folder), { recursive: true })
}

const stamped = `const PROTOCOL_VERSION = ${protocolVersion};`
for (const bundle of [path.join('ui-main', 'index.js'), path.join('host', 'main.js')]) {
  const file = path.join(outRoot, 'out', bundle)
  if (!readFileSync(file, 'utf8').includes(stamped)) {
    throw new Error(`${file} does not carry ${stamped}`)
  }
}
console.log(JSON.stringify({ appDir: outRoot, appVersion, protocolVersion }))
