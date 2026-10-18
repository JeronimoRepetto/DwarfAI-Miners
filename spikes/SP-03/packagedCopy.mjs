#!/usr/bin/env node
// Spike SP-03, packaged half (ADR-002 D5; ADR-027 D2; spike register SP-03): the Host's versioned copy made by a real
// packaged app on its first start, per layout (Windows zip and nsis install, macOS `.app`, Linux AppImage and deb).
//
//   node spikes/SP-03/packagedCopy.mjs (--app <executable|AppImage> | --find <dir>) --layout <name> --out <dir>
//        [--timeout-ms 180000] [--allow-local]
//
// It clears the DwarfAI state of the current user (spikes/_packaged/kit.mjs `clearState`; CI only unless
// --allow-local), starts the app with `--background` and measures, from the spawn: when `host/<version>/` with its
// stored `host-manifest.json` appears under the copy root, when the Host writes `host.identity`, and the copy's size
// and file count. It then ends the UI process alone and records whether the Host lives on (and, for an AppImage, the
// FUSE mounts before and after), ends the Host, and starts the app again to measure the start with the copy already
// in place. On macOS it also records `codesign` and `spctl` on the bundle before and after. Writes
// `<out>/SP-03-<layout>.json`; exits 1 when the Host never started.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  assertDisposable,
  clearState,
  copyRoot,
  environmentFacts,
  isAlive,
  killTree,
  launch,
  options,
  PLATFORM,
  processes,
  readHostIdentity,
  resolveApp,
  treeStats,
  waitFor,
  writeEvidence
} from '../_packaged/kit.mjs'

function completedCopy() {
  const root = copyRoot()
  if (!existsSync(root)) return null
  for (const entry of readdirSync(root)) {
    if (entry.includes('.tmp')) continue
    const dir = path.join(root, entry)
    if (existsSync(path.join(dir, 'host-manifest.json'))) return { version: entry, dir }
  }
  return null
}

function fuseMounts() {
  if (PLATFORM !== 'linux') return null
  try {
    return readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .filter((line) => line.includes('.mount_'))
      .map((line) => line.split(' ').slice(0, 3).join(' '))
  } catch {
    return null
  }
}

function macSignature(bundle) {
  if (PLATFORM !== 'darwin' || !bundle) return null
  const tool = (file, args) => {
    const result = spawnSync(file, args, { encoding: 'utf8' })
    return { status: result.status, output: `${result.stdout}${result.stderr}`.trim() }
  }
  return {
    codesign: tool('codesign', ['-dv', '--verbose=2', bundle]),
    verify: tool('codesign', ['--verify', '--deep', '--strict', bundle]),
    spctl: tool('spctl', ['-a', '-vv', bundle])
  }
}

function hostProcess(identity) {
  if (!identity) return null
  const found = processes().find((p) => p.pid === identity.pid)
  return found ? { executable: found.executable, commandLine: found.commandLine } : null
}

/** Ends the launched UI process only (not its children): the Host must outlive it (ADR-002 D1). */
function endUiOnly(pid) {
  if (!isAlive(pid)) return
  if (PLATFORM === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' })
  else process.kill(pid, 'SIGTERM')
}

async function startOnce(app, logFile, timeoutMs, previousPid) {
  const started = Date.now()
  const run = launch(app, ['--background'], { logFile })
  let copyAtMs = null
  const identity = await waitFor(() => {
    if (copyAtMs === null && completedCopy()) copyAtMs = Date.now() - started
    const current = readHostIdentity()
    return current && current.pid !== previousPid && isAlive(current.pid) ? current : null
  }, timeoutMs)
  return {
    run,
    copyAtMs,
    hostAtMs: identity ? Date.now() - started : null,
    identity,
    uiExited: run.child.exitCode
  }
}

async function main() {
  const argv = process.argv.slice(2)
  assertDisposable(argv)
  const args = options(argv)
  const app = resolveApp(args)
  if (!app || !args.layout || !args.out) {
    console.error(
      'usage: packagedCopy.mjs (--app <path> | --find <dir>) --layout <name> --out <dir>'
    )
    return 2
  }
  const timeoutMs = Number(args['timeout-ms'] ?? 180000)
  const bundle = PLATFORM === 'darwin' ? app.slice(0, app.indexOf('.app') + 4) : null
  const appDirs = [path.dirname(app)]
  const evidence = {
    spike: 'SP-03',
    layout: args.layout,
    environment: environmentFacts(),
    app: path.basename(app),
    appBytes: statSync(app).size,
    signatureBefore: macSignature(bundle),
    cleared: await clearState({ appDirs })
  }
  const logDir = path.join(args.out, 'logs')
  const first = await startOnce(app, path.join(logDir, `SP-03-${args.layout}-first.log`), timeoutMs)
  const copy = completedCopy()
  evidence.firstStart = {
    copyCompleteMs: first.copyAtMs,
    hostIdentityMs: first.hostAtMs,
    uiExitCode: first.uiExited,
    copy: copy ? { version: copy.version, ...treeStats(copy.dir) } : null,
    copyTopLevel: copy ? readdirSync(copy.dir).sort() : null,
    hostProcess: hostProcess(first.identity),
    fuseMounts: fuseMounts()
  }
  if (first.identity) {
    endUiOnly(first.run.child.pid)
    await new Promise((resolve) => setTimeout(resolve, 10000))
    evidence.afterUiEnded = {
      hostAlive: isAlive(first.identity.pid),
      hostProcess: hostProcess(first.identity),
      fuseMounts: fuseMounts()
    }
    killTree(first.identity.pid)
    await waitFor(() => !isAlive(first.identity.pid), 15000)
    const second = await startOnce(
      app,
      path.join(logDir, `SP-03-${args.layout}-second.log`),
      timeoutMs,
      first.identity.pid
    )
    evidence.secondStart = { hostIdentityMs: second.hostAtMs, copyReused: Boolean(completedCopy()) }
    killTree(second.run.child.pid)
    second.run.flushLog()
  }
  killTree(first.run.child.pid)
  first.run.flushLog()
  evidence.signatureAfter = macSignature(bundle)
  evidence.clearedAfter = await clearState({ appDirs })
  writeEvidence(args.out, `SP-03-${args.layout}`, evidence)
  console.log(
    `SP-03 ${args.layout}: copy ${evidence.firstStart.copy?.bytes ?? '-'} bytes in ` +
      `${evidence.firstStart.copy?.files ?? '-'} files, complete at ${first.copyAtMs ?? '-'} ms, Host at ` +
      `${first.hostAtMs ?? '-'} ms; second start Host at ${evidence.secondStart?.hostIdentityMs ?? '-'} ms; ` +
      `Host outlived the UI: ${evidence.afterUiEnded?.hostAlive ?? '-'}`
  )
  return first.identity ? 0 : 1
}

process.exitCode = await main()
