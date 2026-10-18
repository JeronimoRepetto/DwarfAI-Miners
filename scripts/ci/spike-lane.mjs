#!/usr/bin/env node
// Helpers of the manually dispatched spike lane (.github/workflows/spikes.yml; docs/spikes-lane.md; testing strategy
// 17 §4). They read and write files only; nothing here starts the app or touches a credential.
//
//   node scripts/ci/spike-lane.mjs plan                 reads SPIKES (the dispatch input) and writes `run=<json>`, one
//                                                       boolean per spike id, to $GITHUB_OUTPUT
//   node scripts/ci/spike-lane.mjs layout <release>     writes `dir`, `exe` and `appimage` (absolute paths) of the
//                                                       packaged app `pnpm package` wrote for this runner's OS to
//                                                       $GITHUB_OUTPUT
//   node scripts/ci/spike-lane.mjs environment <label> <dir> <spike>...
//                                                       writes <dir>/environment-<label>.json: runner image, OS
//                                                       release, tool versions, commit and date of the evidence
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { release } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The spikes the lane can run, in the order of docs/spikes-lane.md. */
export const SPIKE_IDS = ['SP-16', 'SP-04', 'SP-03', 'SP-05', 'S-019-1', 'S-030-1', 'S-027-4']

/** `all`, or spike ids separated by commas or spaces, as one boolean per known id. Throws on an unknown id. */
export function planSpikes(input) {
  const words = String(input ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
  if (words.length === 0)
    throw new Error(`no spike selected; use "all" or some of ${SPIKE_IDS.join(', ')}`)
  const all = words.length === 1 && words[0] === 'all'
  for (const word of all ? [] : words) {
    if (!SPIKE_IDS.includes(word)) {
      throw new Error(`unknown spike id ${word}; known: all, ${SPIKE_IDS.join(', ')}`)
    }
  }
  return Object.fromEntries(SPIKE_IDS.map((id) => [id, all || words.includes(id)]))
}

/**
 * Where electron-builder put the unpacked app of this OS under `releaseDir` (package.json `build`): the folder the
 * Host's versioned copy is taken from (SP-03), the executable that runs the Host under ELECTRON_RUN_AS_NODE (SP-04),
 * and on Linux the AppImage among `files` (the names in `releaseDir`).
 */
export function packagedLayout({ platform, arch, releaseDir, files, productName, executableName }) {
  if (platform === 'win32') {
    const dir = path.join(releaseDir, 'win-unpacked')
    return { dir, exe: path.join(dir, `${productName}.exe`), appImage: null }
  }
  if (platform === 'darwin') {
    const dir = path.join(releaseDir, arch === 'arm64' ? 'mac-arm64' : 'mac', `${productName}.app`)
    return { dir, exe: path.join(dir, 'Contents', 'MacOS', productName), appImage: null }
  }
  const dir = path.join(releaseDir, 'linux-unpacked')
  const appImage = files.find((name) => name.endsWith('.AppImage'))
  return {
    dir,
    exe: path.join(dir, executableName),
    appImage: appImage === undefined ? null : path.join(releaseDir, appImage)
  }
}

/**
 * The environment of one evidence folder, for the front matter of its spike-results record (17 §4: OS, tool
 * versions, date). Only the runner image and public versions: no runner name, home path or account.
 */
export function environmentRecord({ label, spikes, env, osRelease, node, pkg, now }) {
  const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) }
  return {
    label,
    date: now.toISOString().slice(0, 10),
    spikes,
    runner: {
      os: env.RUNNER_OS ?? null,
      arch: env.RUNNER_ARCH ?? null,
      image: env.ImageOS ?? null,
      imageVersion: env.ImageVersion ?? null
    },
    osRelease,
    versions: {
      node,
      electron: deps.electron ?? null,
      electronBuilder: deps['electron-builder'] ?? null,
      napiRsKeyring: deps['@napi-rs/keyring'] ?? null
    },
    commit: env.GITHUB_SHA ?? null,
    run: { id: env.GITHUB_RUN_ID ?? null, attempt: env.GITHUB_RUN_ATTEMPT ?? null }
  }
}

function writeOutputs(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`)
  for (const line of lines) process.stdout.write(`${line}\n`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
}

function readPackage() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
}

function main([command, ...args]) {
  if (command === 'plan') {
    writeOutputs({ run: JSON.stringify(planSpikes(process.env.SPIKES)) })
    return
  }
  if (command === 'layout') {
    // Absolute, so the steps hand Node a native path on every OS (bash's $PWD is POSIX-shaped on Windows).
    const releaseDir = path.resolve(args[0] ?? 'release')
    const pkg = readPackage()
    const layout = packagedLayout({
      platform: process.platform,
      arch: process.arch,
      releaseDir,
      files: existsSync(releaseDir) ? readdirSync(releaseDir) : [],
      productName: pkg.build.productName,
      executableName: pkg.build.linux?.executableName ?? pkg.build.executableName ?? pkg.name
    })
    if (!existsSync(layout.exe)) {
      const listing = existsSync(layout.dir) ? readdirSync(layout.dir).join(', ') : '(missing)'
      throw new Error(`no packaged executable at ${layout.exe}; ${layout.dir} holds: ${listing}`)
    }
    writeOutputs({ dir: layout.dir, exe: layout.exe, appimage: layout.appImage ?? '' })
    return
  }
  if (command === 'environment') {
    const [label, dir, ...spikes] = args
    if (!label || !dir) throw new Error('usage: environment <label> <dir> <spike>...')
    const record = environmentRecord({
      label,
      spikes,
      env: process.env,
      osRelease: release(),
      node: process.version,
      pkg: readPackage(),
      now: new Date()
    })
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, `environment-${label}.json`),
      `${JSON.stringify(record, null, 2)}\n`
    )
    return
  }
  throw new Error(
    'usage: spike-lane.mjs plan | layout <release> | environment <label> <dir> <spike>...'
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`spike-lane: ${error.message}\n`)
    process.exit(1)
  }
}
