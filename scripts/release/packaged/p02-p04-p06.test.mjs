// layer: L7
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeAsar } from './asarFixture.mjs'
import checkCsp, { id as cspId } from './p02-csp.packaged.mjs'
import checkAdapters, { id as adaptersId } from './p04-pinned-adapters.packaged.mjs'
import checkLogs, {
  id as logsId,
  launchCommand,
  runPackagedApp
} from './p06-log-location.packaged.mjs'

/**
 * The packaged checks P-02, P-04 and P-06 (`20` §2.3; ISSUE-271) over fixture artifact trees, one `mkdtemp` folder per
 * case: a packed Windows app (`win-unpacked/resources/app.asar`, as electron-builder lays it out) whose archive holds
 * the files a case needs. The real artifacts are checked by `pnpm test:packaged` in the `package` job.
 */

const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dwarfai-p02-p04-p06-'))
  dirs.push(dir)
  return dir
}

/** An artifact folder holding one packed Windows app whose `app.asar` holds `files`. */
function packedApp(files) {
  const artifactDir = tempDir()
  writeAsar(path.join(artifactDir, 'win-unpacked', 'resources', 'app.asar'), files)
  return artifactDir
}

const POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'"

function page(policy) {
  const meta =
    policy === null ? '' : `<meta http-equiv="Content-Security-Policy" content="${policy}" />`
  return `<!doctype html><html><head><meta charset="UTF-8" />${meta}</head><body></body></html>`
}

describe('P-02 packaged CSP (ADR-019 item 4; 20 §2.3)', () => {
  it('[ADR-019] P-02 passes a window index.html with the CSP and connect-src self', async () => {
    const artifactDir = packedApp({ 'out/renderer/index.html': page(POLICY) })

    const result = await checkCsp({ artifactDir })

    expect(cspId).toBe('P-02')
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('out/renderer/index.html')
  })

  it("[ADR-019] P-02 fails on a window index.html without connect-src 'self' or with a ws:// origin", async () => {
    const withoutConnect = packedApp({
      'out/renderer/index.html': page(POLICY.replace("; connect-src 'self'", ''))
    })
    const noConnect = await checkCsp({ artifactDir: withoutConnect })
    expect(noConnect.ok).toBe(false)
    expect(noConnect.detail).toMatch(/out\/renderer\/index\.html.*connect-src/)

    const withDevOrigin = packedApp({
      'out/renderer/index.html': page(
        POLICY.replace("connect-src 'self'", "connect-src 'self' ws://localhost:5173")
      )
    })
    const devOrigin = await checkCsp({ artifactDir: withDevOrigin })
    expect(devOrigin.ok).toBe(false)
    expect(devOrigin.detail).toMatch(/out\/renderer\/index\.html.*ws:\/\/localhost:5173/)

    const withoutPolicy = packedApp({ 'out/renderer/index.html': page(null) })
    const none = await checkCsp({ artifactDir: withoutPolicy })
    expect(none.ok).toBe(false)
    expect(none.detail).toMatch(/out\/renderer\/index\.html.*no Content-Security-Policy/)
  })

  it('[ADR-019] P-02 holds every window page to the CSP, not only the first', async () => {
    const artifactDir = packedApp({
      'out/renderer/index.html': page(POLICY),
      'out/renderer/other/window.html': page(
        POLICY.replace("connect-src 'self'", "connect-src 'self' https://example.com")
      )
    })

    const result = await checkCsp({ artifactDir })

    expect(result.ok).toBe(false)
    expect(result.detail).toContain('out/renderer/other/window.html')
    expect(result.detail).not.toContain('out/renderer/index.html:')
  })

  it('[ADR-019] P-02 fails a folder with no packed app or a packed app with no window page', async () => {
    const empty = await checkCsp({ artifactDir: tempDir() })
    expect(empty.ok).toBe(false)
    expect(empty.detail).toMatch(/no packed app/)

    const noPage = await checkCsp({ artifactDir: packedApp({ 'package.json': '{}' }) })
    expect(noPage.ok).toBe(false)
    expect(noPage.detail).toMatch(/no window page/)
  })
})

const row = (name, version, { compatible = true, bundle = true } = {}) => ({
  name,
  version,
  licence: 'MIT',
  compatible,
  bundle,
  notice: ''
})

const ROWS = [
  row('@napi-rs/keyring', '2.1.0'),
  row('@napi-rs/keyring-win32-x64-msvc', '2.1.0'),
  row('@agentclientprotocol/sdk', '1.6.0'),
  row('@zed-industries/codex-acp', '0.16.0', { compatible: false, bundle: false })
]

const manifest = (name, version) => JSON.stringify({ name, version })

/** The files of a packed app that bundles `packages` (`{ name: version }`) and pins `pins` in its own manifest. */
function bundling(packages, pins = packages) {
  const files = { 'package.json': JSON.stringify({ name: 'dwarfai-miners', dependencies: pins }) }
  for (const [name, version] of Object.entries(packages)) {
    files[`node_modules/${name}/package.json`] = manifest(name, version)
  }
  return files
}

describe('P-04 pinned bundled adapters (ADR-008 item 1; 20 §2.3)', () => {
  it('[ADR-008, S-008-1] P-04 passes a bundled adapter at its pinned version with a closed record', async () => {
    const artifactDir = packedApp(
      bundling({
        '@napi-rs/keyring': '2.1.0',
        '@napi-rs/keyring-win32-x64-msvc': '2.1.0',
        zod: '3.25.76'
      })
    )

    const result = await checkAdapters({ artifactDir, rows: ROWS })

    expect(adaptersId).toBe('P-04')
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('@napi-rs/keyring@2.1.0')
    expect(result.detail).toContain('@napi-rs/keyring-win32-x64-msvc@2.1.0')
    expect(result.detail).not.toContain('zod')
  })

  it('[ADR-008, S-008-1] P-04 fails on a bundled adapter whose version differs from its pin or has no closed record', async () => {
    const drifted = packedApp(
      bundling({ '@napi-rs/keyring': '2.0.9' }, { '@napi-rs/keyring': '2.1.0' })
    )
    const differs = await checkAdapters({ artifactDir: drifted, rows: ROWS })
    expect(differs.ok).toBe(false)
    expect(differs.detail).toMatch(/@napi-rs\/keyring@2\.0\.9.*pinned 2\.1\.0/)

    const unrecorded = packedApp(bundling({ '@agentclientprotocol/sdk': '1.7.0' }))
    const noRecord = await checkAdapters({ artifactDir: unrecorded, rows: ROWS })
    expect(noRecord.ok).toBe(false)
    expect(noRecord.detail).toMatch(/@agentclientprotocol\/sdk@1\.7\.0.*no S-008-1 row/)

    const notBundled = packedApp(bundling({ '@zed-industries/codex-acp': '0.16.0' }))
    const refused = await checkAdapters({ artifactDir: notBundled, rows: ROWS })
    expect(refused.ok).toBe(false)
    expect(refused.detail).toMatch(
      /@zed-industries\/codex-acp@0\.16\.0.*not GPL-3\.0-or-later compatible/
    )

    const inexact = packedApp(
      bundling({ '@napi-rs/keyring': '2.1.0' }, { '@napi-rs/keyring': '^2.1.0' })
    )
    const range = await checkAdapters({ artifactDir: inexact, rows: ROWS })
    expect(range.ok).toBe(false)
    expect(range.detail).toMatch(/@napi-rs\/keyring@2\.1\.0.*pinned \^2\.1\.0/)
  })

  it('[ADR-008, S-008-1] P-04 fails a folder with no packed app', async () => {
    const result = await checkAdapters({ artifactDir: tempDir(), rows: ROWS })
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/no packed app/)
  })
})

const WIN = { platform: 'win32', arch: 'x64' }

/** An artifact folder with a packed Windows app's executable in it. */
function windowsApp() {
  const artifactDir = tempDir()
  const dir = path.join(artifactDir, 'win-unpacked')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'DwarfAI-Miners.exe'), 'exe')
  return artifactDir
}

function put(file, content = '{"event":"x"}\n') {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

describe('P-06 log location (ADR-026 item 1; 20 §2.3)', () => {
  it('[ADR-026] P-06 passes when the packaged app writes its segments under userData/logs and prints the path', async () => {
    let started
    const result = await checkLogs({
      artifactDir: windowsApp(),
      ...WIN,
      run: async ({ executable, profile }) => {
        started = { executable, userDataDir: profile.userDataDir }
        put(path.join(profile.userDataDir, 'logs', 'ui-000001.jsonl'))
        put(path.join(profile.userDataDir, 'logs', 'host-000001.jsonl'))
      }
    })

    expect(logsId).toBe('P-06')
    expect(started, 'the check starts the packaged app').toBeDefined()
    expect(result.ok).toBe(true)
    expect(path.basename(started.executable)).toBe('DwarfAI-Miners.exe')
    expect(result.detail).toContain(path.join(started.userDataDir, 'logs'))
    expect(result.detail).toMatch(/2 log segments/)
  })

  it('[ADR-026] P-06 fails when the packaged app writes a log segment outside userData/logs', async () => {
    const outside = async (relative) =>
      checkLogs({
        artifactDir: windowsApp(),
        ...WIN,
        run: async ({ profile }) => {
          put(path.join(profile.userDataDir, 'logs', 'ui-000001.jsonl'))
          put(path.join(profile.root, ...relative))
        }
      })

    const besideLogs = await outside(['userData', 'host-000001.jsonl'])
    expect(besideLogs.ok).toBe(false)
    expect(besideLogs.detail).toMatch(/host-000001\.jsonl.*outside/)

    const inDefaultAppData = await outside([
      'home',
      'AppData',
      'Roaming',
      'DwarfAI-Miners',
      'logs',
      'ui-000002.jsonl'
    ])
    expect(inDefaultAppData.ok).toBe(false)
    expect(inDefaultAppData.detail).toMatch(/ui-000002\.jsonl.*outside/)

    const nested = await outside(['userData', 'logs', 'old', 'shim-000003.jsonl'])
    expect(nested.ok).toBe(false)
    expect(nested.detail).toMatch(/shim-000003\.jsonl.*outside/)
  })

  it('[ADR-026] P-06 fails when the app wrote no segment, found no app or could not run', async () => {
    const silent = await checkLogs({ artifactDir: windowsApp(), ...WIN, run: async () => {} })
    expect(silent.ok).toBe(false)
    expect(silent.detail).toMatch(/no log segment/)

    const noApp = await checkLogs({ artifactDir: tempDir(), ...WIN, run: async () => {} })
    expect(noApp.ok).toBe(false)
    expect(noApp.detail).toMatch(/no packed app executable/)

    const broken = await checkLogs({
      artifactDir: windowsApp(),
      ...WIN,
      run: async () => {
        throw new Error('the app exited with code 1')
      }
    })
    expect(broken.ok).toBe(false)
    expect(broken.detail).toMatch(/the app exited with code 1/)
  })
})

describe('P-06 starting the packaged app (ADR-026 item 1; 20 §2.3)', () => {
  it('[ADR-026] P-06 starts a Linux app without a display under xvfb-run and any other start directly', () => {
    const args = ['--background']
    const start = (platform, env) =>
      launchCommand({ executable: '/opt/app/dwarfai-miners', args, platform, env })

    expect(start('linux', {})).toEqual({
      command: 'xvfb-run',
      args: ['--auto-servernum', '/opt/app/dwarfai-miners', '--background']
    })
    expect(start('linux', { DISPLAY: ':0' }).command).toBe('/opt/app/dwarfai-miners')
    expect(start('win32', {}).command).toBe('/opt/app/dwarfai-miners')
    expect(start('darwin', {}).command).toBe('/opt/app/dwarfai-miners')
  })

  it('[ADR-026] P-06 reports the exit code and the stderr tail of an app that exits before it logs', async () => {
    const profile = {
      root: tempDir(),
      userDataDir: path.join(tempDir(), 'userData'),
      dataRoot: tempDir(),
      home: tempDir()
    }
    const crashing = () =>
      spawn(
        process.execPath,
        ['-e', "console.error('Missing X server or $DISPLAY'); process.exit(3)"],
        {
          stdio: ['ignore', 'ignore', 'pipe']
        }
      )

    const error = await runPackagedApp({
      executable: 'unused',
      profile,
      platform: 'win32',
      start: crashing
    }).then(
      () => null,
      (rejection) => rejection
    )

    expect(error, 'the run fails').toBeInstanceOf(Error)
    expect(error.message).toContain('exited before writing a log segment')
    expect(error.message).toContain('exit code 3')
    expect(error.message).toContain('Missing X server or $DISPLAY')
  })
})
