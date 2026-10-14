// OS lane (17 §1.8) for the S-018-1 packaged-app kit (`packagedTrayApp.mjs`): the arming gate of the packaged entry,
// the spike's electron-builder config, the signature summary and the report. Pure checks, so they run on every leg;
// building and running the packaged app happens on the maintainer's Mac only (17 §4, §0.3 of the rebuild manual).
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import gate from './packagedGate.cjs'
import {
  assessRun,
  builderConfig,
  buildReport,
  parseEvents,
  scrub,
  signatureSummary
} from './packagedReport.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const productionPackage = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'))
const SOURCE_SCAN_MS = 60_000

describe('S-018-1 packaged kit: the arming gate of the packaged entry', () => {
  it('[S-018-1] a packaged spike app started without the arming flag does nothing', () => {
    expect(gate.spikeEnvFromArgv(['/Applications/X.app/Contents/MacOS/x'])).toBeNull()
    expect(gate.spikeEnvFromArgv(['x', '--s0181-mode=click'])).toBeNull()
    expect(gate.spikeEnvFromArgv(['x', '-psn_0_12345'])).toBeNull()
  })

  it('[S-018-1] only the exact arming flag arms it, never a look-alike', () => {
    for (const lookAlike of [
      '--dwarfai-spike-s0181=0',
      '--dwarfai-spike-s0181=true',
      '--dwarfai-spike',
      '--DWARFAI-SPIKE-S0181',
      'dwarfai-spike-s0181'
    ]) {
      expect(gate.spikeEnvFromArgv(['x', lookAlike]), lookAlike).toBeNull()
    }
  })

  it('[S-018-1] the armed entry gets the same S0181_* settings the npm-Electron harness passes', () => {
    const argv = gate.spikeArgs({
      mode: 'click',
      idleMs: 600000,
      waitMs: 120000,
      eventsFile: '/tmp/e.jsonl',
      userData: '/tmp/u'
    })
    expect(argv[0]).toBe(gate.ARM_FLAG)
    expect(gate.spikeEnvFromArgv(['x', ...argv])).toEqual({
      S0181_MODE: 'click',
      S0181_IDLE_MS: '600000',
      S0181_WAIT_MS: '120000',
      S0181_EVENTS: '/tmp/e.jsonl',
      S0181_USER_DATA: '/tmp/u'
    })
  })

  it('[S-018-1] an armed start with an unknown or invalid spike setting is refused', () => {
    expect(() => gate.spikeEnvFromArgv(['x', gate.ARM_FLAG, '--s0181-mode=loud'])).toThrow(/mode/)
    expect(() => gate.spikeEnvFromArgv(['x', gate.ARM_FLAG, '--s0181-idle-ms=-1'])).toThrow(/idle/)
    expect(() => gate.spikeEnvFromArgv(['x', gate.ARM_FLAG, '--s0181-extra=1'])).toThrow(/unknown/)
  })

  // Reads every file under src/ synchronously: past the 5 s default on a loaded macOS runner.
  it(
    '[S-018-1] no production source names the spike entry or its arming flag',
    { timeout: SOURCE_SCAN_MS },
    () => {
      const offenders = []
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (
            /(dwarfai-spike-s0181|spikes\/S-018-1|packagedMain)/.test(readFileSync(full, 'utf8'))
          )
            offenders.push(path.relative(REPO, full))
        }
      }
      walk(path.join(REPO, 'src'))
      expect(offenders).toEqual([])
      expect(JSON.stringify(productionPackage.build)).not.toMatch(/spikes/)
    }
  )
})

describe('S-018-1 packaged kit: the spike build is the product build with its own identity', () => {
  const config = (sign) =>
    builderConfig({ productionPackage, sign, outDir: '/out', entitlements: '/e.plist' })

  it('[S-018-1] the spike app has its own bundle id and name, and its main is the gated entry', () => {
    const c = config('developer-id')
    expect(c.appId).toBe(`${productionPackage.build.appId}.spike.s0181`)
    expect(c.appId).not.toBe(productionPackage.build.appId)
    expect(c.productName).not.toBe(productionPackage.productName)
    expect(c.extraMetadata.main).toBe('packagedMain.cjs')
    expect(c.files).toEqual(['package.json', 'packagedMain.cjs', 'packagedGate.cjs', 'trayApp.cjs'])
    expect(c.afterPack).toBeUndefined()
    expect(c.afterSign).toBeUndefined()
  })

  it("[S-018-1] it uses the product's Electron and, signed with a Developer ID, the product's macOS signing settings", () => {
    const c = config('developer-id')
    expect(c.electronVersion).toBe(productionPackage.devDependencies.electron)
    expect(c.mac.hardenedRuntime).toBe(productionPackage.build.mac.hardenedRuntime)
    expect(c.mac.entitlements).toBe('/e.plist')
    expect(c.mac.entitlementsInherit).toBe('/e.plist')
    expect(c.mac.type).toBe('distribution')
    expect(c.mac.identity).toBeUndefined()
    expect(c.forceCodeSigning).toBe(true)
    expect(c.mac.notarize).toBe(false)
  })

  it('[S-018-1] ad-hoc and unsigned builds are explicit and never notarized', () => {
    const adhoc = config('adhoc')
    expect(adhoc.mac.identity).toBe('-')
    expect(adhoc.mac.hardenedRuntime).toBe(false)
    expect(adhoc.mac.notarize).toBe(false)
    const unsigned = config('unsigned')
    expect(unsigned.mac.identity).toBeNull()
    expect(unsigned.forceCodeSigning).toBe(false)
    expect(() => config('whatever')).toThrow(/sign/)
  })
})

const ADHOC_LINKER = `Executable=/x/Electron.app/Contents/MacOS/Electron
Identifier=Electron
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none`

const DEVELOPER_ID = `Executable=/x/S.app/Contents/MacOS/s
Identifier=com.jeronimorepetto.dwarfaiminers.spike.s0181
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=600 flags=0x10000(runtime) hashes=8+7 location=embedded
Authority=Developer ID Application: Jane Doe (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=ABCDE12345
Info.plist entries=30
Sealed Resources version=2 rules=13 files=4`

describe('S-018-1 packaged kit: signature summary', () => {
  it('[S-018-1] reads the linker-signed ad-hoc state the npm Electron run showed', () => {
    expect(signatureSummary(ADHOC_LINKER)).toEqual({
      identifier: 'Electron',
      kind: 'adhoc',
      flags: '0x20002(adhoc,linker-signed)',
      teamIdentifierSet: false,
      infoPlistBound: false,
      sealedResources: false
    })
  })

  it('[S-018-1] reports a Developer ID signature by its kind, never the name or team id', () => {
    const summary = signatureSummary(DEVELOPER_ID)
    expect(summary).toEqual({
      identifier: 'com.jeronimorepetto.dwarfaiminers.spike.s0181',
      kind: 'Developer ID Application',
      flags: '0x10000(runtime)',
      teamIdentifierSet: true,
      infoPlistBound: true,
      sealedResources: true
    })
    expect(JSON.stringify(summary)).not.toMatch(/Jane|ABCDE12345/)
  })
})

describe('S-018-1 packaged kit: report', () => {
  const clickRun = (events, exitCode = 0) => ({ mode: 'click', exitCode, events })
  const ok = [
    { event: 'idle', windows: 0 },
    { event: 'show', afterMs: 5 },
    { event: 'click', afterMs: 900, windows: 0 },
    { event: 'done', reason: 'click', windows: 0 }
  ]

  it('[S-018-1] parses the JSON lines the tray app writes and skips anything else', () => {
    expect(parseEvents('noise\n{"event":"ready"}\n{broken\r\n{"event":"done"}\n')).toEqual([
      { event: 'ready' },
      { event: 'done' }
    ])
  })

  it('[S-018-1, ADR-018] a click run passes only when the click reached the tray process with no window', () => {
    expect(assessRun(clickRun(ok))).toEqual({ passed: true, reasons: [] })
    expect(assessRun(clickRun(ok.filter((e) => e.event !== 'click'))).passed).toBe(false)
    expect(
      assessRun(clickRun(ok.map((e) => (e.event === 'click' ? { ...e, windows: 1 } : e)))).passed
    ).toBe(false)
    expect(assessRun(clickRun(ok, 70)).passed).toBe(false)
    expect(assessRun(clickRun([...ok, { event: 'error', where: 'x', message: 'y' }])).passed).toBe(
      false
    )
  })

  it('[S-018-1] launched through LaunchServices the exit code is unknown, so the clean end is read from the events', () => {
    expect(assessRun(clickRun(ok, null), { exitCodeKnown: false }).passed).toBe(true)
    expect(assessRun(clickRun(ok, null)).passed).toBe(false)
  })

  it('[S-018-1] the report keeps the npm-harness shape and adds what was packaged', () => {
    const report = buildReport({
      platform: 'darwin',
      osRelease: '25.6.0',
      mode: 'click',
      idleMs: 1500,
      waitMs: 120000,
      runs: [clickRun(ok)],
      packaged: { appId: 'a', sign: 'adhoc', launch: 'open', signature: null }
    })
    expect(Object.keys(report)).toEqual([
      'spike',
      'platform',
      'osRelease',
      'mode',
      'idleMs',
      'waitMs',
      'desktop',
      'runs',
      'packaged'
    ])
    expect(report.spike).toBe('S-018-1')
    expect(report.desktop).toBeNull()
    expect(report.packaged.assessment).toEqual({ passed: true, reasons: [] })
  })

  it('[S-018-1] scrubs every machine value, also in its JSON-escaped spelling', () => {
    const text = JSON.stringify({ a: 'C:\\Users\\jane\\x', b: '/Users/jane/y', c: 'jane' })
    const out = scrub(text, [
      ['C:\\Users\\jane', '<home>'],
      ['/Users/jane', '<home>'],
      ['jane', '<user>']
    ])
    expect(out).not.toMatch(/jane/)
    expect(JSON.parse(out)).toEqual({ a: '<home>\\x', b: '<home>/y', c: '<user>' })
  })

  it('[S-018-1] replaces a whole-word value only as a whole word, so the bundle id keeps its spelling', () => {
    const text = JSON.stringify({ appId: 'com.janedoe.app', who: 'jane', path: '/x/jane/y' })
    const out = scrub(text, [['jane', '<user>', { wholeWord: true }]])
    expect(JSON.parse(out)).toEqual({
      appId: 'com.janedoe.app',
      who: '<user>',
      path: '/x/<user>/y'
    })
  })
})
