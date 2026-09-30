// Spike SP-04 (testing strategy 17 §4; ADR-002, ADR-005; spike register SP-04): a throw-away packaged build whose
// Host, run under ELECTRON_RUN_AS_NODE, opens a temp database with node:sqlite, reports process.resourcesPath and
// resolves the person's own provider CLIs from PATH. Its scrubbed output is the raw evidence of
// spike-results/SP-04.md; it becomes the L8 packaged smoke once EPIC-17 builds it (later: ISSUE-271).
//
//   node spikes/SP-04/packagedHost.mjs [--out <file>]
//
// Builder mode (plain Node): packs this file into a temp Electron app with electron-builder (`dir` target, current
// OS, nothing signed, nothing published), runs the packaged executable with ELECTRON_RUN_AS_NODE=1 on its own copy of
// this file, once from inside app.asar and once from app.asar.unpacked, prints the scrubbed JSON and deletes the
// build. Probe mode (`--probe` under ELECTRON_RUN_AS_NODE=1): prints one JSON line and exits. The probe only looks
// the CLIs up; it never runs them and never reads their configuration or credentials (ADR-008 item 2).

import { execFileSync, spawnSync } from 'node:child_process'
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The provider CLIs a packaged Host resolves: the catalog's (claude, codex, agy, opencode), SP-07's, the ACP one. */
const PROVIDER_CLIS = ['claude', 'codex', 'agy', 'opencode', 'kimi', 'kiro-cli', 'claude-agent-acp']
const PRODUCT = 'DwarfAI-SP04'
const ELECTRON_VERSION = '44.0.0'

/**
 * Every match of `name` on PATH (with PATHEXT on Windows), in lookup order. Only the PATH position and the extension
 * are reported, never the directory: the directories are the person's own (privacy guard, 17 §5.2).
 */
function resolveOnPath(name) {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean)
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  const matches = []
  dirs.forEach((dir, pathIndex) => {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase())
      try {
        accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        matches.push({ pathIndex, ext: path.extname(candidate) || '(none)' })
      } catch {
        // not here
      }
    }
  })
  return matches
}

async function probe() {
  const report = {
    platform: process.platform,
    arch: process.arch,
    versions: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      modules: process.versions.modules
    },
    runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
    execPath: process.execPath,
    script: fileURLToPath(import.meta.url),
    resourcesPath: {
      type: typeof process.resourcesPath,
      value: process.resourcesPath ?? null,
      isExecDirResources:
        typeof process.resourcesPath === 'string' &&
        path.resolve(process.resourcesPath) === resourcesDirOf(process.execPath)
    },
    sqlite: null,
    clis: {},
    cmdShimSpawn: null
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'dwarfai-sp04-db-'))
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path.join(dir, 'dwarfai.db'))
    const journal = db.prepare('PRAGMA journal_mode = WAL').get()
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
    db.exec(
      'CREATE TABLE child (id INTEGER PRIMARY KEY, parent INTEGER NOT NULL REFERENCES parent(id))'
    )
    db.prepare('INSERT INTO parent (id) VALUES (?)').run(1)
    db.prepare('INSERT INTO child (id, parent) VALUES (?, ?)').run(1, 1)
    let foreignKeyEnforced = false
    try {
      db.prepare('INSERT INTO child (id, parent) VALUES (?, ?)').run(2, 99)
    } catch {
      foreignKeyEnforced = true
    }
    const version = db.prepare('SELECT sqlite_version() AS v').get()
    const rows = db.prepare('SELECT COUNT(*) AS n FROM child').get()
    db.close()
    report.sqlite = {
      ok: true,
      sqliteVersion: version.v,
      journalMode: journal.journal_mode,
      foreignKeyEnforced,
      rows: rows.n
    }
  } catch (error) {
    report.sqlite = { ok: false, error: String(error) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  for (const name of PROVIDER_CLIS) {
    const matches = resolveOnPath(name)
    report.clis[name] = { found: matches.length > 0, firstExt: matches[0]?.ext ?? null, matches }
  }
  if (process.platform === 'win32') report.cmdShimSpawn = cmdShimSpawn()
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

/**
 * Whether this runtime starts a `.cmd` file without a shell (npm-style CLI shims are `.cmd` on Windows). Uses a
 * synthetic `.cmd` in a temp directory, never one of the person's CLIs.
 */
function cmdShimSpawn() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dwarfai-sp04-cmd-'))
  try {
    const file = path.join(dir, 'probe.cmd')
    writeFileSync(file, '@echo cmd-ran\r\n')
    const direct = spawnSync(file, ['--version'], { encoding: 'utf8', windowsHide: true })
    const viaComSpec = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', file], {
      encoding: 'utf8',
      windowsHide: true
    })
    return {
      directShellFalse: { error: direct.error?.code ?? null, status: direct.status },
      viaComSpecShellFalse: {
        status: viaComSpec.status,
        ran: viaComSpec.stdout.includes('cmd-ran')
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The packaged app's resources directory for an executable path (macOS: `Contents/Resources`). */
function resourcesDirOf(execPath) {
  const dir = path.dirname(execPath)
  return process.platform === 'darwin'
    ? path.resolve(dir, '..', 'Resources')
    : path.resolve(dir, 'resources')
}

/** Replaces this machine's paths and account name in the output. */
function scrub(text, buildDir) {
  const variants = (value) => [value, value.replaceAll('\\', '\\\\'), value.replaceAll('\\', '/')]
  let out = text
  for (const value of variants(buildDir)) out = out.split(value).join('<build>')
  for (const value of variants(tmpdir())) out = out.split(value).join('<tmp>')
  for (const value of variants(homedir())) out = out.split(value).join('~')
  const user = userInfo().username
  if (user.length > 2) out = out.replace(new RegExp(`\\b${user}\\b`, 'gi'), 'j')
  return out
}

/** The electron-builder version the repository pins (package.json devDependencies). */
function builderVersion() {
  const repoPackage = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'package.json'
  )
  return JSON.parse(readFileSync(repoPackage, 'utf8')).devDependencies['electron-builder']
}

/** The packaged executable electron-builder's `dir` target wrote for the current OS. */
function packagedExecutable(outDir) {
  const candidates =
    process.platform === 'win32'
      ? [path.join(outDir, 'win-unpacked', `${PRODUCT}.exe`)]
      : process.platform === 'darwin'
        ? ['mac-arm64', 'mac', 'mac-universal'].flatMap((macDir) =>
            [PRODUCT, 'dwarfai-sp04'].map((name) =>
              path.join(outDir, macDir, `${PRODUCT}.app`, 'Contents', 'MacOS', name)
            )
          )
        : [path.join(outDir, 'linux-unpacked', 'dwarfai-sp04')]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`no packaged executable among ${candidates.length} candidates`)
  return found
}

/**
 * The environments the packaged Host is probed in: the builder's own (a terminal), and on macOS the default PATH a
 * Finder-launched app gets (`sysctl user.cs_path`), which is what a UI started from the Dock would pass down.
 */
function probeEnvironments() {
  const environments = [['terminalEnv', { ...process.env, ELECTRON_RUN_AS_NODE: '1' }]]
  if (process.platform === 'darwin') {
    const guiPath = execFileSync('sysctl', ['-n', 'user.cs_path'], { encoding: 'utf8' }).trim()
    environments.push([
      'guiDefaultPath',
      { ...process.env, PATH: guiPath, ELECTRON_RUN_AS_NODE: '1' }
    ])
  }
  return environments
}

async function buildAndRun() {
  const outIndex = process.argv.indexOf('--out')
  const outFile = outIndex > 0 ? process.argv[outIndex + 1] : null
  const buildDir = mkdtempSync(path.join(tmpdir(), 'dwarfai-sp04-'))
  try {
    const project = path.join(buildDir, 'app')
    cpSync(fileURLToPath(import.meta.url), path.join(project, 'host', 'packagedHost.mjs'))
    writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'dwarfai-sp04', version: '0.0.0', private: true, main: 'main.cjs' })
    )
    writeFileSync(path.join(project, 'main.cjs'), "require('electron').app.quit()\n")
    // An empty pnpm lockfile and node_modules make electron-builder collect (zero) dependencies with pnpm, the
    // repository's package manager (20 §1), instead of guessing npm from the environment.
    writeFileSync(
      path.join(project, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n"
    )
    mkdirSync(path.join(project, 'node_modules'))
    const { build, Platform } = await import('electron-builder')
    const started = Date.now()
    await build({
      projectDir: project,
      targets: Platform.current().createTarget('dir'),
      publish: 'never',
      config: {
        appId: 'com.dwarfai.spike.sp04',
        productName: PRODUCT,
        executableName: 'dwarfai-sp04',
        electronVersion: ELECTRON_VERSION,
        directories: { output: path.join(buildDir, 'out') },
        files: ['main.cjs', 'package.json', 'host/**'],
        asar: true,
        asarUnpack: ['host/**'],
        npmRebuild: false,
        win: { signAndEditExecutable: false },
        mac: { identity: null }
      }
    })
    const buildMs = Date.now() - started
    const exe = packagedExecutable(path.join(buildDir, 'out'))
    const resources = resourcesDirOf(exe)
    const runs = {}
    const scripts = [
      ['asar', path.join(resources, 'app.asar', 'host', 'packagedHost.mjs')],
      ['unpacked', path.join(resources, 'app.asar.unpacked', 'host', 'packagedHost.mjs')]
    ]
    for (const [envLabel, env] of probeEnvironments()) {
      for (const [scriptLabel, script] of scripts) {
        const label = envLabel === 'terminalEnv' ? scriptLabel : `${scriptLabel}-${envLabel}`
        const result = spawnSync(exe, [script, '--probe'], {
          env,
          encoding: 'utf8',
          timeout: 60000,
          windowsHide: true
        })
        let report = null
        try {
          report = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() ?? '')
        } catch {
          // kept as raw output below
        }
        runs[label] = {
          exitCode: result.status,
          report,
          stderr: result.stderr?.trim().slice(0, 2000) || null
        }
      }
    }
    const record = {
      date: new Date().toISOString().slice(0, 10),
      builder: { electronBuilder: builderVersion(), target: 'dir', buildMs },
      runs
    }
    const text = scrub(JSON.stringify(record, null, 2), buildDir)
    if (outFile) writeFileSync(outFile, `${text}\n`)
    process.stdout.write(`${text}\n`)
  } finally {
    rmSync(buildDir, { recursive: true, force: true })
  }
}

if (process.argv.includes('--probe')) await probe()
else await buildAndRun()
