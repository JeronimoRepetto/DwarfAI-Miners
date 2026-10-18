#!/usr/bin/env node
// Spike S-027-1 (ADR-027 D1; ADR-016 item 7; spike register S-027-1; OQ-59), Windows only. Three parts:
//
//   node spikes/S-027-1/scoopLayout.mjs layout --zip <zip> --out <dir>
//   node spikes/S-027-1/scoopLayout.mjs scoop --zip <zip> --next-zip <zip of the next version> --out <dir>
//        [--install-scoop] [--allow-local]
//   node spikes/S-027-1/scoopLayout.mjs portable --exe <portable exe> --out <dir> [--allow-local]
//
// `layout` reads the zip's entry list only (`tar -tf`): where the executable and `resources/app.asar` sit, so the
// manifest knows whether it needs `extract_dir`.
//
// `scoop` installs the zip through a real Scoop from a local manifest (spikes/_packaged and scripts/ci/packagingSpikes
// `scoopManifest`), the zips served on 127.0.0.1 only. Every install and uninstall hook logs the variables it can read.
// It starts the installed app with `--background` until the Host runs, then `scoop update`s to the next version with
// that Host running, then `scoop uninstall`s, recording each command's output, the hook log, whether the Host survived,
// and what is left. `--install-scoop` first installs Scoop for the current user with its official one-line installer
// (https://get.scoop.sh); nothing else is downloaded. Run it as a standard user (the workflow wraps it in
// scripts/ci/run-unelevated.mjs).
//
// `portable` starts electron-builder's `portable` exe with `--background` and records where it extracted itself and
// where the Host runs from (the register's "portable extraction behavior").
//
// The parts that clear state (scoop, portable) run on CI only unless --allow-local. Writes `<out>/S-027-1-<part>.json`.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { scoopManifest } from '../../scripts/ci/packagingSpikes.mjs'
import {
  assertDisposable,
  clearState,
  copyRoot,
  dwarfaiDataDirs,
  environmentFacts,
  isAlive,
  killTree,
  launch,
  listing,
  options,
  processes,
  readHostIdentity,
  scrub,
  waitFor,
  writeEvidence
} from '../_packaged/kit.mjs'

const APP = 'dwarfai-miners-spike'
const EXE = 'DwarfAI-Miners.exe'
const POWERSHELL = 'powershell.exe'

function zipEntries(zip) {
  return execFileSync('tar', ['-tf', zip], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => entry.replace(/\\/g, '/'))
}

function layout(args) {
  const entries = zipEntries(args.zip)
  const top = [...new Set(entries.map((entry) => entry.split('/')[0]))].sort()
  const exe = entries.find((entry) => entry.toLowerCase().endsWith(EXE.toLowerCase()))
  const asar = entries.find((entry) => entry.endsWith('resources/app.asar'))
  const result = {
    spike: 'S-027-1',
    part: 'layout',
    environment: environmentFacts(),
    zip: path.basename(args.zip),
    entries: entries.length,
    topLevel: top,
    executable: exe ?? null,
    appAsar: asar ?? null,
    singleTopFolder: top.length === 1 && entries.every((entry) => entry.includes('/')),
    hostManifest: entries.find((entry) => entry.endsWith('resources/host-manifest.json')) ?? null
  }
  writeEvidence(args.out, 'S-027-1-layout', result)
  console.log(
    `S-027-1 layout: ${result.entries} entries; executable at ${result.executable}; app.asar at ` +
      `${result.appAsar}; single top folder: ${result.singleTopFolder}`
  )
  return exe && asar ? 0 : 1
}

/** Runs one PowerShell command line asynchronously (the local file server keeps answering meanwhile). */
function powershell(command, timeoutMs = 600000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const out = []
    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true }
    )
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => out.push(chunk))
    const timer = setTimeout(() => killTree(child.pid), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({
        exitCode: code,
        ms: Date.now() - started,
        output: scrub(Buffer.concat(out).toString('utf8')).split(/\r?\n/).slice(-60).join('\n')
      })
    })
  })
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

function serve(files) {
  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? '/').slice(1))
    const file = files.get(name)
    if (!file) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/zip' })
    createReadStream(file).pipe(response)
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  )
}

function readHookLog(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line.replace(/^﻿/, ''))
      } catch {
        return { raw: line }
      }
    })
}

function versionOf(zip) {
  const match = path.basename(zip).match(/-(\d+\.\d+\.\d+)-/)
  if (!match) throw new Error(`no version in ${zip}`)
  return match[1]
}

async function scoop(args) {
  const scoopRoot = process.env.SCOOP ?? path.join(homedir(), 'scoop')
  const scoopPs1 = path.join(scoopRoot, 'shims', 'scoop.ps1')
  const evidence = { spike: 'S-027-1', part: 'scoop', environment: environmentFacts() }
  if (args['install-scoop'] && !existsSync(scoopPs1)) {
    evidence.scoopInstall = await powershell(
      'Invoke-Expression "& {$(Invoke-RestMethod -Uri \'https://get.scoop.sh\')}"'
    )
  }
  if (!existsSync(scoopPs1)) {
    evidence.error = 'Scoop is not installed for this user'
    writeEvidence(args.out, 'S-027-1-scoop', evidence)
    console.error(evidence.error)
    return 1
  }
  const scoopCmd = (rest) => powershell(`& '${scoopPs1}' ${rest}`)
  evidence.scoopVersion = await scoopCmd('--version')
  const work = mkdtempSync(path.join(tmpdir(), 'dwarfai-s0271-'))
  const hookLog = path.join(work, 'hooks.log')
  const manifestFile = path.join(work, `${APP}.json`)
  const zips = new Map([
    [path.basename(args.zip), path.resolve(args.zip)],
    [path.basename(args['next-zip']), path.resolve(args['next-zip'])]
  ])
  const { server, port } = await serve(zips)
  const writeManifest = (zip) => {
    const manifest = scoopManifest({
      version: versionOf(zip),
      url: `http://127.0.0.1:${port}/${encodeURIComponent(path.basename(zip))}`,
      hash: sha256(zip),
      executable: EXE,
      hookLog
    })
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
    return manifest.version
  }
  const appDir = path.join(scoopRoot, 'apps', APP)
  const current = path.join(appDir, 'current')
  const runs = []
  evidence.cleared = await clearState({ appDirs: [appDir] })
  try {
    evidence.baseVersion = writeManifest(args.zip)
    evidence.install = await scoopCmd(`install '${manifestFile}'`)
    evidence.install.appDir = listing(appDir)
    evidence.install.current = listing(current)
    evidence.install.hooks = readHookLog(hookLog)

    const exe = path.join(current, EXE)
    if (existsSync(exe)) {
      const run = launch(exe, ['--background'], {
        logFile: path.join(args.out, 'logs', 'S-027-1-scoop.log')
      })
      runs.push(run)
      const identity = await waitFor(() => {
        const found = readHostIdentity()
        return found && isAlive(found.pid) ? found : null
      }, 180000)
      const host = identity && processes().find((p) => p.pid === identity.pid)
      evidence.host = identity
        ? { pid: identity.pid, executable: host?.executable ?? null, copyRoot: listing(copyRoot()) }
        : null

      evidence.nextVersion = writeManifest(args['next-zip'])
      const hooksBefore = readHookLog(hookLog).length
      evidence.update = await scoopCmd(`update ${APP}`)
      evidence.update.hooks = readHookLog(hookLog).slice(hooksBefore)
      evidence.update.hostAlive = identity ? isAlive(identity.pid) : null
      evidence.update.appDir = listing(appDir)
      evidence.update.revertIntegrationsRan = evidence.update.hooks.some((hook) =>
        String(hook.commandLine ?? '').includes('--revert-integrations')
      )

      const running = readHostIdentity()
      const hooksBeforeUninstall = readHookLog(hookLog).length
      evidence.uninstall = await scoopCmd(`uninstall ${APP}`)
      evidence.uninstall.hooks = readHookLog(hookLog).slice(hooksBeforeUninstall)
      evidence.uninstall.hostAlive = running ? isAlive(running.pid) : null
      evidence.uninstall.leftovers = {
        appDir: listing(appDir),
        persist: listing(path.join(scoopRoot, 'persist', APP)),
        copyRoot: listing(copyRoot()),
        appData: dwarfaiDataDirs().map((dir) => path.basename(dir))
      }
    }
  } finally {
    for (const run of runs) {
      killTree(run.child.pid)
      run.flushLog()
    }
    server.close()
    evidence.clearedAfter = await clearState({ appDirs: [appDir] })
    rmSync(work, { recursive: true, force: true })
    writeEvidence(args.out, 'S-027-1-scoop', evidence)
  }
  console.log(
    `S-027-1 scoop: install exit ${evidence.install?.exitCode}; Host started: ${Boolean(evidence.host)}; ` +
      `update exit ${evidence.update?.exitCode}, hooks ${JSON.stringify(evidence.update?.hooks?.map((h) => `${h.hook}:${h.cmd}`) ?? [])}, ` +
      `Host alive ${evidence.update?.hostAlive}; uninstall exit ${evidence.uninstall?.exitCode}, hooks ` +
      `${JSON.stringify(evidence.uninstall?.hooks?.map((h) => `${h.hook}:${h.cmd}`) ?? [])}`
  )
  return evidence.install?.exitCode === 0 && evidence.host ? 0 : 1
}

async function portable(args) {
  const exe = path.resolve(args.exe)
  const before = new Set(processes().map((p) => p.pid))
  const evidence = {
    spike: 'S-027-1',
    part: 'portable',
    environment: environmentFacts(),
    exe: path.basename(exe),
    cleared: await clearState({ appDirs: [path.dirname(exe)] })
  }
  const run = launch(exe, ['--background'], {
    logFile: path.join(args.out, 'logs', 'S-027-1-portable.log')
  })
  try {
    const identity = await waitFor(() => {
      const found = readHostIdentity()
      return found && isAlive(found.pid) ? found : null
    }, 240000)
    const started = processes().filter(
      (p) => !before.has(p.pid) && /dwarfai/i.test(`${p.executable} ${p.commandLine}`)
    )
    evidence.hostStarted = Boolean(identity)
    evidence.processes = started.map((p) => ({
      executable: p.executable,
      commandLine: p.commandLine
    }))
    evidence.extractedTo = [
      ...new Set(started.map((p) => path.dirname(p.executable)).filter(Boolean))
    ]
    evidence.hostExecutable = identity
      ? (started.find((p) => p.pid === identity.pid)?.executable ?? null)
      : null
    evidence.runsInPlace = evidence.extractedTo.every(
      (dir) => dir.toLowerCase() === path.dirname(exe).toLowerCase()
    )
    killTree(run.child.pid)
    if (identity) killTree(identity.pid)
    await new Promise((resolve) => setTimeout(resolve, 5000))
    evidence.extractedAfterExit = evidence.extractedTo.map((dir) => ({
      dir,
      exists: existsSync(dir)
    }))
  } finally {
    killTree(run.child.pid)
    run.flushLog()
    evidence.clearedAfter = await clearState({ appDirs: [path.dirname(exe)] })
    writeEvidence(args.out, 'S-027-1-portable', evidence)
  }
  console.log(
    `S-027-1 portable: Host started ${evidence.hostStarted}; runs in place ${evidence.runsInPlace}; ` +
      `extracted to ${evidence.extractedTo.length} folder(s)`
  )
  return evidence.hostStarted ? 0 : 1
}

async function main() {
  const argv = process.argv.slice(2)
  if (process.platform !== 'win32') {
    console.error('S-027-1 runs on Windows only')
    return 2
  }
  const args = options(argv)
  const [part] = args._
  if (!args.out) return 2
  if (part === 'layout' && args.zip) return layout(args)
  assertDisposable(argv)
  if (part === 'scoop' && args.zip && args['next-zip']) return scoop(args)
  if (part === 'portable' && args.exe) return portable(args)
  console.error('usage: scoopLayout.mjs layout|scoop|portable (see the header)')
  return 2
}

process.exitCode = await main()
