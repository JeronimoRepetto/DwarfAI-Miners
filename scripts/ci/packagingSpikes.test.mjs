// layer: L7
import { describe, expect, it } from 'vitest'
import {
  dictionaryRequests,
  hostsOf,
  installDirOf,
  logEntriesOf,
  netLogUrls,
  nextPatchVersion,
  scoopManifest,
  trayProcessesOf,
  uiRecordsOf,
  scrubText,
  stepAsideOf,
  tarCommand
} from './packagingSpikes.mjs'

describe('packaging spike lane helpers (ISSUE-328)', () => {
  it('[S-027-3] the upgrade build takes the next patch version, dropping any pre-release tag', () => {
    expect(nextPatchVersion('0.13.1')).toBe('0.13.2')
    expect(nextPatchVersion('1.0.0-beta.3')).toBe('1.0.1')
    expect(() => nextPatchVersion('one')).toThrow(/not a semantic version/)
  })

  it('[S-027-1] writes a Scoop manifest for a local zip whose hooks log the variables scoop gives them', () => {
    const manifest = scoopManifest({
      version: '0.13.1',
      url: 'http://127.0.0.1:4567/DwarfAI-Miners-0.13.1-win-x64.zip',
      hash: 'ab'.repeat(32),
      executable: 'DwarfAI-Miners.exe',
      hookLog: 'C:\\evidence\\hooks.log'
    })
    expect(manifest).toMatchObject({
      version: '0.13.1',
      url: 'http://127.0.0.1:4567/DwarfAI-Miners-0.13.1-win-x64.zip',
      hash: 'ab'.repeat(32),
      shortcuts: [['DwarfAI-Miners.exe', 'DwarfAI-Miners']]
    })
    for (const hook of ['pre_install', 'post_install', 'pre_uninstall', 'post_uninstall']) {
      const script = manifest[hook].join('\n')
      expect(script, hook).toContain(`'${hook}'`)
      expect(script, hook).toContain("'C:\\evidence\\hooks.log'")
      expect(script, hook).toContain('$cmd')
    }
    expect(() =>
      scoopManifest({ version: '1', url: 'u', hash: 'h', executable: 'a.exe', hookLog: "it's" })
    ).toThrow(/quote/)
  })

  it('[S-019-3] reads the request URLs of a net log, even one cut off when the app was ended', () => {
    const log =
      '{"constants":{},"events":[{"params":{"url":"https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic"}},' +
      '{"params":{"url":"devtools://devtools/bundled"}},{"params":{"url":"https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic"}},' +
      '{"params":{"url":"https://example.org/a?b=1"'
    const urls = netLogUrls(log)
    expect(urls).toEqual([
      'https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic',
      'devtools://devtools/bundled',
      'https://example.org/a?b=1'
    ])
    expect(dictionaryRequests(urls)).toEqual([
      'https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic'
    ])
    expect(hostsOf(urls)).toEqual(['example.org', 'redirector.gvt1.com'])
  })

  // Run 39130693732: the CDN redirect of a dictionary download carries the client's public IP in its query (`mip=`).
  it('[S-019-3] lists dictionary requests without their query, so no client address reaches the evidence', () => {
    const urls = [
      'https://rr2---sn-x.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic?cms_redirect=yes&mip=203.0.113.7&mm=28',
      'https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic'
    ]
    expect(dictionaryRequests(urls)).toEqual([
      'https://rr2---sn-x.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic',
      'https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic'
    ])
  })

  it('[S-019-3] scrubs the runner home folder and user name from evidence text, in both path spellings', () => {
    const text =
      'C:\\Users\\dwarfai-ci\\AppData\\x and "C:\\\\Users\\\\dwarfai-ci\\\\y" by dwarfai-ci'
    expect(
      scrubText(text, [
        ['C:\\Users\\dwarfai-ci', '<home>'],
        ['dwarfai-ci', '<user>']
      ])
    ).toBe('<home>\\AppData\\x and "<home>\\\\y" by <user>')
  })

  // Run 39130693732: the user `runner` of the macOS and Linux runners turned the evidence key `runnerOs` into
  // `<user>Os`. A user or host name is replaced only where it stands as a whole word.
  it('[S-019-3] scrubs a user or host name only where it stands alone, never inside a longer word', () => {
    const text = '{"runnerOs":"Linux","home":"/home/runner/work","by":"runner","host":"runner-1"}'
    expect(scrubText(text, [['runner', '<user>', { word: true }]])).toBe(
      '{"runnerOs":"Linux","home":"/home/<user>/work","by":"<user>","host":"<user>-1"}'
    )
    expect(scrubText('runnerOs', [['runner', '<user>']]), 'a plain entry still replaces').toBe(
      '<user>Os'
    )
  })

  // Run 39130693732: in the workflow's bash step on Windows, `tar` is Git's GNU tar, which reads `D:\...` as a remote
  // host ("Cannot connect to D: resolve failed") and cannot read a zip at all. Windows' own bsdtar reads both.
  it('[S-027-1, S-019-2] reads a zip on Windows with the system bsdtar, never the tar first on PATH', () => {
    expect(tarCommand('win32', { SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\System32\\tar.exe'
    )
    expect(tarCommand('win32', {})).toBe('C:\\Windows\\System32\\tar.exe')
    expect(tarCommand('linux', { SystemRoot: 'C:\\Windows' })).toBe('tar')
  })

  // Run 39130693732: electron-builder's per-user nsis installer writes no InstallLocation in its uninstall key, so the
  // S-027-3 harness never found the installed app. The uninstaller sits in the install folder.
  it('[S-027-3] finds the nsis install folder from the uninstall string when the key has no InstallLocation', () => {
    const uninstall =
      '"C:\\Users\\j\\AppData\\Local\\Programs\\dwarfai-miners\\Uninstall DwarfAI-Miners.exe"'
    expect(
      installDirOf({ InstallLocation: null, UninstallString: `${uninstall} /currentuser` })
    ).toBe('C:\\Users\\j\\AppData\\Local\\Programs\\dwarfai-miners')
    expect(
      installDirOf({
        InstallLocation: 'D:\\Apps\\dwarfai',
        UninstallString: `${uninstall} /currentuser`
      }),
      'InstallLocation wins when present'
    ).toBe('D:\\Apps\\dwarfai')
    expect(installDirOf({ UninstallString: 'C:\\x\\un.exe /S' })).toBe('C:\\x')
    expect(installDirOf(null)).toBeNull()
    expect(installDirOf({ InstallLocation: null, UninstallString: null })).toBeNull()
  })

  // Run 39205769685: after the test ended the installed UI, the Host started the app `--background` from its own copy
  // (ADR-018 D5 respawn), outside the install folder. That 0.13.1 tray held the single-instance lock, so the upgraded
  // UI handed its launch to it and quit (ADR-002 D3) before writing any log.
  it('[S-027-3] finds the tray process the Host started from its copy, never the Host or an Electron helper', () => {
    const root = String.raw`C:\Users\j\AppData\Local\DwarfAI\host`
    const exe = String.raw`${root}\0.13.1\DwarfAI-Miners.exe`
    const hostEntry = String.raw`${root}\0.13.1\resources\app.asar\out\host\main.js`
    const installed = String.raw`C:\Programs\dwarfai-miners\DwarfAI-Miners.exe`
    const list = [
      { pid: 10, executable: exe, commandLine: `"${exe}" "${hostEntry}"` },
      { pid: 11, executable: exe, commandLine: `"${exe}" --background` },
      { pid: 12, executable: exe, commandLine: `"${exe}" --type=gpu-process --background` },
      { pid: 13, executable: installed, commandLine: `"${installed}" --background` },
      { pid: 14, executable: exe.toUpperCase(), commandLine: `"${exe}"  --background` }
    ]
    expect(trayProcessesOf(list, { copyRoot: root, hostPid: 10 }).map((p) => p.pid)).toEqual([
      11, 14
    ])
    expect(trayProcessesOf([], { copyRoot: root, hostPid: 10 })).toEqual([])
  })

  it('[S-027-3] reads the upgraded UI records of a product log, skipping other versions, the Host and torn lines', () => {
    const text = [
      '{"proc":"ui","appVersion":"0.13.1","event":"host.upgrade","outcome":"ok","causeClass":"attach"}',
      '{"proc":"host","appVersion":"0.13.2","event":"host.start","outcome":"ok"}',
      '{"proc":"ui","appVersion":"0.13.2","event":"host.upgrade","outcome":"ok","causeClass":"compat","pid":7}',
      '{"proc":"ui","appVersion":"0.13.2","event":"host.connect',
      '',
      '{"proc":"ui","appVersion":"0.13.2","event":"host.connection","outcome":"ok","causeClass":"connected"}'
    ].join('\r\n')
    expect(uiRecordsOf(text, '0.13.2')).toEqual([
      { event: 'host.upgrade', outcome: 'ok', causeClass: 'compat' },
      { event: 'host.connection', outcome: 'ok', causeClass: 'connected' }
    ])
    expect(uiRecordsOf('', '0.13.2')).toEqual([])
  })

  it('[S-027-3] reads every record of a product log with its process, version, pid and time, skipping torn lines', () => {
    const text = [
      '{"ts":"2026-10-19T10:00:00.000Z","proc":"host","pid":5,"appVersion":"0.13.1","event":"notifier.respawn","outcome":"ok"}',
      '{"ts":"2026-10-19T10:00:01.000Z","proc":"ui","pid":7,"appVersion":"0.13.2","event":"host.upgrade","outcome":"ok","causeClass":"attach","msg":"x"}',
      '{"ts":"2026-10-19T10:00:02.000Z","proc":"ui","pid":7,"appVe',
      '',
      'not json'
    ].join('\r\n')
    expect(logEntriesOf(text)).toEqual([
      {
        proc: 'host',
        appVersion: '0.13.1',
        pid: 5,
        ts: '2026-10-19T10:00:00.000Z',
        event: 'notifier.respawn',
        outcome: 'ok',
        causeClass: undefined
      },
      {
        proc: 'ui',
        appVersion: '0.13.2',
        pid: 7,
        ts: '2026-10-19T10:00:01.000Z',
        event: 'host.upgrade',
        outcome: 'ok',
        causeClass: 'attach'
      }
    ])
    expect(logEntriesOf('')).toEqual([])
  })

  // AMENDMENT-25: a newer launch makes the older UI step aside; the relaunched newer UI takes the lock and runs the
  // ADR-002 D8 decision at its own start.
  const entry = (ts, proc, pid, appVersion, event, causeClass) => ({
    ts: `2026-10-19T10:00:${ts}Z`,
    proc,
    pid,
    appVersion,
    event,
    outcome: 'ok',
    causeClass
  })
  const versions = {
    olderVersion: '0.13.1',
    newerVersion: '0.13.2',
    since: '2026-10-19T10:00:00.000Z'
  }

  it('[S-027-3] sees the older UI step aside and the newer UI then run the D8 decision', () => {
    const entries = [
      entry('00.500', 'ui', 11, '0.13.1', 'ui.single-instance', 'replaced-by-newer-launch'),
      entry('01.000', 'host', 5, '0.13.1', 'notifier.respawn', undefined),
      entry('01.700', 'ui', 21, '0.13.2', 'host.upgrade', 'attach')
    ]
    expect(stepAsideOf(entries, versions)).toEqual({
      steppedAside: { ts: '2026-10-19T10:00:00.500Z', pid: 11 },
      upgrade: { ts: '2026-10-19T10:00:01.700Z', pid: 21, decision: 'attach' },
      respawns: [{ ts: '2026-10-19T10:00:01.000Z', pid: 5 }],
      stepAside: true,
      msToDecision: 1200
    })
  })

  it('[S-027-3] is no step-aside without the older record, with records from before the step, or out of order', () => {
    const upgrade = entry('01.700', 'ui', 21, '0.13.2', 'host.upgrade', 'attach')
    const aside = (ts, version = '0.13.1') =>
      entry(ts, 'ui', 11, version, 'ui.single-instance', 'replaced-by-newer-launch')
    expect(stepAsideOf([upgrade], versions).stepAside).toBe(false)
    expect(stepAsideOf([aside('00.500')], versions)).toMatchObject({
      stepAside: false,
      upgrade: null,
      msToDecision: null
    })
    const early = { ...aside('00.500'), ts: '2026-10-19T09:59:59.000Z' }
    expect(stepAsideOf([early, upgrade], versions).steppedAside).toBeNull()
    expect(stepAsideOf([aside('00.500', '0.13.2'), upgrade], versions).steppedAside).toBeNull()
    expect(stepAsideOf([aside('02.000'), upgrade], versions).stepAside).toBe(false)
    const otherCause = { ...aside('00.500'), causeClass: 'other' }
    expect(stepAsideOf([otherCause, upgrade], versions).steppedAside).toBeNull()
  })
})
