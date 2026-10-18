#!/usr/bin/env node
// Spike S-027-3 (ADR-027 D1; ADR-016 item 7; ADR-002; spike register S-027-3), Windows only: the per-user `nsis`
// installer and its uninstaller against a Host running from its versioned copy.
//
//   node spikes/S-027-3/installerVsHost.mjs --base <Setup-x.y.z.exe> --next <Setup-x.y.z+1.exe> --out <dir>
//        [--allow-local]
//
// Run it as a standard user (the workflow wraps it in scripts/ci/run-unelevated.mjs): the Host refuses to start
// elevated (ADR-002 D6). It clears the DwarfAI state of the user (CI only unless --allow-local), then:
//   1. installs `--base` silently (`/S`) and starts the installed app with `--background` until the Host writes
//      `host.identity`;
//   2. runs `--next` silently with that Host running, watching every process the installer starts, and records whether
//      it finished or blocked, whether the Host survived, the command line the old uninstaller received (the upgrade
//      flag, UNVERIFIED in the register) and whether anything ran `--revert-integrations`;
//   3. starts the upgraded app with `--background` and records what happens to the running older Host (the ADR-002 D8
//      upgrade handshake): its identity, the copies under the copy root;
//   4. uninstalls silently with a Host running, with the same watch, and records what is left: install folder, Host
//      copies, app data, the uninstall registry key, shortcuts.
// Writes `<out>/S-027-3.json`. Exits 1 when the base install or the first Host start failed.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  assertDisposable,
  clearState,
  copyRoot,
  dwarfaiDataDirs,
  environmentFacts,
  findPackedApps,
  isAlive,
  killTree,
  launch,
  listing,
  options,
  processes,
  readHostIdentity,
  waitFor,
  writeEvidence
} from '../_packaged/kit.mjs'

const UNINSTALL_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'

function uninstallEntry() {
  const json = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-ItemProperty '${UNINSTALL_KEY}' -ErrorAction SilentlyContinue | ` +
        "Where-Object { $_.DisplayName -like '*DwarfAI*' } | " +
        'Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString,QuietUninstallString | ' +
        'ConvertTo-Json -Compress'
    ],
    { encoding: 'utf8', windowsHide: true }
  ).trim()
  return json === '' ? null : [JSON.parse(json)].flat()[0]
}

/** The executable and arguments of an uninstall string (`"C:\...\Uninstall X.exe" /currentuser /S`). */
function splitCommand(command) {
  const match = command.match(/^"([^"]+)"\s*(.*)$/) ?? command.match(/^(\S+)\s*(.*)$/)
  return { file: match[1], args: match[2].split(/\s+/).filter(Boolean) }
}

const WATCHED = /dwarfai|uninst|un_a\.exe|au_\.exe|\.tmp\\|--revert-integrations|--updated/i

/**
 * Runs `file args`, polling the process table until it exits (or `untilDone()` holds, for an uninstaller that
 * relaunches itself from %TEMP%) or `timeoutMs` passes. Returns the timing and every new watched process seen.
 */
async function runWatched(file, args, { timeoutMs = 300000, untilDone = null } = {}) {
  const before = new Set(processes().map((p) => p.pid))
  const seen = new Map()
  const started = Date.now()
  const child = spawn(file, args, { stdio: 'ignore', windowsHide: true })
  let exitCode = null
  const exited = new Promise((resolve) =>
    child.on('exit', (code) => {
      exitCode = code
      resolve()
    })
  )
  child.on('error', () => {})
  let done = false
  while (!done && Date.now() - started < timeoutMs) {
    for (const p of processes()) {
      if (before.has(p.pid) || p.pid === process.pid || seen.has(p.pid)) continue
      if (WATCHED.test(`${p.executable} ${p.commandLine}`)) {
        seen.set(p.pid, { executable: p.executable, commandLine: p.commandLine })
      }
    }
    const childDone = child.exitCode !== null || exitCode !== null
    done = untilDone ? childDone && untilDone() : childDone
    if (!done) await new Promise((resolve) => setTimeout(resolve, 300))
  }
  const blocked = !done
  if (blocked) killTree(child.pid)
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))])
  const commandLines = [...seen.values()].map((p) => p.commandLine)
  return {
    exitCode,
    ms: Date.now() - started,
    blocked,
    processes: [...seen.values()],
    revertIntegrationsRan: commandLines.some((line) => line.includes('--revert-integrations')),
    uninstallerCommandLines: commandLines.filter((line) => /uninst|un_a\.exe|au_\.exe/i.test(line))
  }
}

function hostFacts(identity) {
  if (!identity) return null
  const p = processes().find((candidate) => candidate.pid === identity.pid)
  return {
    pid: identity.pid,
    alive: isAlive(identity.pid),
    executable: p?.executable ?? null,
    commandLine: p?.commandLine ?? null
  }
}

function leftovers(installLocation) {
  const programs = path.join(
    process.env.APPDATA ?? '',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs'
  )
  const desktop = path.join(process.env.USERPROFILE ?? '', 'Desktop')
  const shortcut = (dir) =>
    existsSync(dir) ? readdirSync(dir).filter((name) => /dwarfai/i.test(name)) : []
  return {
    installDir: installLocation ? listing(installLocation) : null,
    copyRoot: listing(copyRoot()),
    appData: dwarfaiDataDirs().map((dir) => ({ dir: path.basename(dir), entries: listing(dir) })),
    uninstallKey: uninstallEntry(),
    startMenuShortcuts: shortcut(programs),
    desktopShortcuts: shortcut(desktop)
  }
}

async function startHost(exe, out, label, previousPid = null) {
  const started = Date.now()
  const run = launch(exe, ['--background'], {
    logFile: path.join(out, 'logs', `S-027-3-${label}.log`)
  })
  const identity = await waitFor(() => {
    const current = readHostIdentity()
    return current && current.pid !== previousPid && isAlive(current.pid) ? current : null
  }, 180000)
  return { run, identity, ms: identity ? Date.now() - started : null }
}

async function main() {
  const argv = process.argv.slice(2)
  if (process.platform !== 'win32') {
    console.error('S-027-3 runs on Windows only')
    return 2
  }
  assertDisposable(argv)
  const args = options(argv)
  if (!args.base || !args.next || !args.out) {
    console.error('usage: installerVsHost.mjs --base <setup.exe> --next <setup.exe> --out <dir>')
    return 2
  }
  const evidence = {
    spike: 'S-027-3',
    environment: environmentFacts(),
    base: path.basename(args.base),
    next: path.basename(args.next),
    cleared: await clearState()
  }
  const runs = []
  try {
    evidence.install = await runWatched(path.resolve(args.base), ['/S'])
    const entry = uninstallEntry()
    evidence.install.entry = entry
    const installLocation = entry?.InstallLocation ?? null
    const app = installLocation ? findPackedApps(installLocation, 1)[0] : null
    evidence.install.installDir = installLocation ? listing(installLocation) : null
    if (!app) return 1

    const first = await startHost(app.executable, args.out, 'base')
    runs.push(first.run)
    evidence.firstHost = {
      startMs: first.ms,
      ...hostFacts(first.identity),
      copyRoot: listing(copyRoot())
    }
    if (!first.identity) return 1

    evidence.upgrade = await runWatched(path.resolve(args.next), ['/S'])
    evidence.upgrade.hostAfter = hostFacts(first.identity)
    evidence.upgrade.entryAfter = uninstallEntry()
    evidence.upgrade.installDirAfter = listing(installLocation)
    evidence.upgrade.copyRootAfter = listing(copyRoot())

    const upgradedApp = findPackedApps(installLocation, 1)[0]
    if (upgradedApp) {
      const second = await startHost(upgradedApp.executable, args.out, 'next', first.identity.pid)
      runs.push(second.run)
      evidence.upgradeHandshake = {
        newHostMs: second.ms,
        newHost: hostFacts(second.identity),
        oldHostAlive: isAlive(first.identity.pid),
        identityNow: hostFacts(readHostIdentity()),
        copyRoot: listing(copyRoot())
      }
    }

    const running = readHostIdentity()
    const now = uninstallEntry()
    const command = splitCommand(now?.QuietUninstallString ?? `${now?.UninstallString ?? ''} /S`)
    evidence.uninstall = await runWatched(command.file, command.args, {
      timeoutMs: 180000,
      untilDone: () => uninstallEntry() === null || !existsSync(command.file)
    })
    evidence.uninstall.command = { file: path.basename(command.file), args: command.args }
    evidence.uninstall.hostRunningBefore = hostFacts(running)
    evidence.uninstall.hostAfter = running
      ? { pid: running.pid, alive: isAlive(running.pid) }
      : null
    await new Promise((resolve) => setTimeout(resolve, 5000))
    evidence.uninstall.leftovers = leftovers(installLocation)
    return 0
  } finally {
    for (const run of runs) {
      killTree(run.child.pid)
      run.flushLog()
    }
    evidence.clearedAfter = await clearState()
    writeEvidence(args.out, 'S-027-3', evidence)
    console.log(
      `S-027-3: install exit ${evidence.install?.exitCode}; Host started: ${Boolean(evidence.firstHost?.alive)}; ` +
        `upgrade exit ${evidence.upgrade?.exitCode}, blocked ${evidence.upgrade?.blocked}, Host survived ` +
        `${evidence.upgrade?.hostAfter?.alive}, old uninstaller args: ` +
        `${JSON.stringify(evidence.upgrade?.uninstallerCommandLines ?? [])}, revert ran ` +
        `${evidence.upgrade?.revertIntegrationsRan}; uninstall blocked ${evidence.uninstall?.blocked}, revert ran ` +
        `${evidence.uninstall?.revertIntegrationsRan}`
    )
  }
}

process.exitCode = await main()
