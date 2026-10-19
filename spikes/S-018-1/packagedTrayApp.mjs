// Spike S-018-1, packaged kit (testing strategy 17 §4; ADR-018 item 5; spike register S-018-1). The npm-Electron
// harness (`trayNotification.os.test.ts`) cannot pass on macOS: macOS never registers the npm `Electron.app` for
// notifications. This kit runs the same tray app (`trayApp.cjs`) inside a real packaged bundle, made by the product's
// electron-builder with the product's macOS signing settings, so the record can say what a packaged app does.
//
//   node spikes/S-018-1/packagedTrayApp.mjs build --out <dir> [--sign developer-id|adhoc|unsigned] [--repo <dir>]
//   node spikes/S-018-1/packagedTrayApp.mjs run --app <bundle.app|exe> --report <file>
//        [--mode none|record|click] [--idle-ms <ms>] [--wait-ms <ms>] [--launch open|direct] [--repo <dir>]
//
// `--repo` is the DwarfAI-Miners checkout whose `package.json`, `build/entitlements.mac.plist` and installed
// electron-builder are used (default: the checkout this file is in). It lets a copy of this folder outside the
// checkout run against a clone that must stay untouched; nothing is written inside that checkout.
//
// `build` packs `packagedMain.cjs`, `packagedGate.cjs` and `trayApp.cjs` into a spike app with its own bundle id
// (`packagedReport.mjs` `builderConfig`), current OS and arch, electron-builder's `dir` target, nothing published or
// notarized. It is never part of the product build, and the app does nothing unless `run` arms it (`packagedGate.cjs`).
//
// `run` reads the bundle's signature (macOS), runs the app once in `none` mode and then once in the asked mode, the
// way the npm harness does, and writes the scrubbed report. `--launch open` (the macOS default) starts it through
// LaunchServices, as Finder does; `--launch direct` starts the executable itself and also observes its exit code.
// The tray app reports through a temp events file; nothing else is written outside the temp folders and the report.

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, release, tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import gate from './packagedGate.cjs'
import {
  builderConfig,
  buildReport,
  parseEvents,
  scrub,
  signatureSummary
} from './packagedReport.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO = path.resolve(HERE, '..', '..')
const KIT_FILES = ['packagedMain.cjs', 'packagedGate.cjs', 'trayApp.cjs']

function repoOf(options) {
  return options.repo ? path.resolve(options.repo) : DEFAULT_REPO
}

function productionPackage(repo) {
  return JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'))
}

async function build(options) {
  const repo = repoOf(options)
  const out = path.resolve(options.out)
  const sign = options.sign ?? (process.platform === 'darwin' ? 'developer-id' : 'unsigned')
  const config = builderConfig({
    productionPackage: productionPackage(repo),
    sign,
    outDir: out,
    entitlements: path.join(repo, 'build', 'entitlements.mac.plist')
  })
  const project = mkdtempSync(path.join(tmpdir(), 'dwarfai-s0181-build-'))
  try {
    for (const file of KIT_FILES) cpSync(path.join(HERE, file), path.join(project, file))
    writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({
        name: 'dwarfai-s0181-spike',
        version: '0.0.0',
        private: true,
        description: 'Spike S-018-1: notification from a windowless tray process',
        author: 'DwarfAI-Miners',
        main: 'packagedMain.cjs'
      })
    )
    // As in SP-04: an empty pnpm lockfile and node_modules make electron-builder collect (zero) dependencies with
    // pnpm, the repository's package manager, instead of guessing npm from the environment.
    writeFileSync(
      path.join(project, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n"
    )
    mkdirSync(path.join(project, 'node_modules'))
    const builderEntry = createRequire(path.join(repo, 'package.json')).resolve('electron-builder')
    const { build: electronBuild, Platform } = await import(pathToFileURL(builderEntry).href)
    await electronBuild({
      projectDir: project,
      targets: Platform.current().createTarget('dir'),
      publish: 'never',
      config
    })
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
  const app = findApp(out, config)
  process.stdout.write(`${JSON.stringify({ built: app, appId: config.appId, sign })}\n`)
}

/** The bundle (macOS) or executable electron-builder's `dir` target wrote under `out`. */
function findApp(out, config) {
  const candidates =
    process.platform === 'darwin'
      ? ['mac-arm64', 'mac', 'mac-universal'].map((dir) =>
          path.join(out, dir, `${config.productName}.app`)
        )
      : process.platform === 'win32'
        ? [config.executableName, config.productName].map((name) =>
            path.join(out, 'win-unpacked', `${name}.exe`)
          )
        : [path.join(out, 'linux-unpacked', config.executableName)]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`no packaged app among ${candidates.join(', ')}`)
  return found
}

/** The executable inside a macOS bundle, or the path itself elsewhere. */
function executableOf(app) {
  if (!app.endsWith('.app')) return app
  const dir = path.join(app, 'Contents', 'MacOS')
  const [name] = readdirSync(dir)
  return path.join(dir, name)
}

function codesign(app) {
  if (process.platform !== 'darwin') return { signature: null, verify: null }
  const display = spawnSync('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8' })
  const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', app], {
    encoding: 'utf8'
  })
  return {
    signature: signatureSummary(`${display.stdout}${display.stderr}`),
    verify: { ok: verify.status === 0, message: verify.stderr.trim().split('\n')[0] || null }
  }
}

function runOnce({ app, launch, mode, idleMs, waitMs }) {
  const work = mkdtempSync(path.join(tmpdir(), 'dwarfai-s0181-run-'))
  try {
    const eventsFile = path.join(work, 'events.jsonl')
    const args = gate.spikeArgs({
      mode,
      idleMs,
      waitMs,
      eventsFile,
      userData: path.join(work, 'user-data')
    })
    const timeout = idleMs + waitMs + 60_000
    const result =
      launch === 'open'
        ? spawnSync('open', ['-n', '-W', app, '--args', ...args], { encoding: 'utf8', timeout })
        : spawnSync(executableOf(app), args, { encoding: 'utf8', timeout, windowsHide: true })
    const events = parseEvents(existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8') : '')
    if (result.error) {
      events.push({
        event: 'runner',
        message: `${String(result.error.message)}; if the spike app still runs, quit it from Activity Monitor`
      })
    } else if (launch === 'open' && result.status !== 0) {
      events.push({
        event: 'runner',
        message: `open exited ${String(result.status)}: ${result.stderr.trim()}`
      })
    }
    return { mode, exitCode: launch === 'open' ? null : result.status, events }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function machineValues(app, repo) {
  const values = [
    [path.resolve(app), '<app>'],
    [repo, '<repo>'],
    [HERE, '<kit>'],
    [process.cwd(), '<cwd>'],
    [tmpdir(), '<tmp>'],
    [homedir(), '<home>']
  ]
  const withRealPaths = []
  for (const [value, placeholder] of values) {
    withRealPaths.push([value, placeholder])
    try {
      const real = realpathSync(value)
      if (real !== value) withRealPaths.push([real, placeholder])
    } catch {
      // Not a path.
    }
  }
  return [...withRealPaths, [userInfo().username, '<user>', { wholeWord: true }]]
}

function run(options) {
  const repo = repoOf(options)
  const app = path.resolve(options.app)
  const mode = options.mode ?? 'none'
  const launch = options.launch ?? (process.platform === 'darwin' ? 'open' : 'direct')
  if (!['open', 'direct'].includes(launch)) throw new Error('--launch must be open or direct')
  if (launch === 'open' && process.platform !== 'darwin')
    throw new Error('--launch open is macOS only')
  const idleMs = Number(options['idle-ms'] ?? 1500)
  const waitMs = Number(options['wait-ms'] ?? (mode === 'click' ? 120_000 : 15_000))
  const config = builderConfig({
    productionPackage: productionPackage(repo),
    sign: 'unsigned',
    outDir: '',
    entitlements: ''
  })
  const runs = (mode === 'none' ? ['none'] : ['none', mode]).map((runMode) =>
    runOnce({ app, launch, mode: runMode, idleMs, waitMs })
  )
  const report = buildReport({
    platform: process.platform,
    osRelease: release(),
    mode,
    idleMs,
    waitMs,
    runs,
    packaged: {
      appId: config.appId,
      productName: config.productName,
      electronVersion: config.electronVersion,
      launch,
      ...codesign(app)
    }
  })
  const file = path.resolve(options.report)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${scrub(JSON.stringify(report, null, 2), machineValues(app, repo))}\n`)
  process.stdout.write(
    `${JSON.stringify({ report: options.report, runs: runs.map((r) => r.events.at(-1)?.event ?? 'no events'), assessment: report.packaged.assessment })}\n`
  )
  if (report.packaged.assessment && !report.packaged.assessment.passed) process.exitCode = 1
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    sign: { type: 'string' },
    app: { type: 'string' },
    report: { type: 'string' },
    mode: { type: 'string' },
    'idle-ms': { type: 'string' },
    'wait-ms': { type: 'string' },
    launch: { type: 'string' },
    repo: { type: 'string' }
  }
})

if (positionals[0] === 'build' && values.out) await build(values)
else if (positionals[0] === 'run' && values.app && values.report) run(values)
else {
  process.stderr.write(
    'usage: packagedTrayApp.mjs build --out <dir> [--sign developer-id|adhoc|unsigned] [--repo <dir>]\n' +
      '       packagedTrayApp.mjs run --app <bundle.app|exe> --report <file> [--mode none|record|click]\n' +
      '                               [--idle-ms <ms>] [--wait-ms <ms>] [--launch open|direct] [--repo <dir>]\n'
  )
  process.exitCode = 2
}
