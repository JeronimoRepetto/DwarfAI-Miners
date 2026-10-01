import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  canonicalHostDataDir,
  checkSocketPathLength,
  endpointFor,
  profileKey,
  type EndpointInput
} from './endpoint'

// L1 (17 §1.1): the one endpoint rule of ADR-002 D2 that the Host and the UI both run (lead
// decision 2026-09-30 in ISSUE-022). The hash and the platform are values, so every OS's rule runs
// on any host. Synthetic identities only (privacy-guard): user `j`, SID S-1-5-5-0-4242.

const sha256: EndpointInput['sha256'] = (text) =>
  createHash('sha256').update(text, 'utf8').digest('hex')

const SID = 'S-1-5-5-0-4242'
const WIN_DATA_DIR = 'C:\\Users\\j\\AppData\\Roaming\\DwarfAI-Miners\\host'
const MAC_DATA_DIR = '/Users/j/Library/Application Support/DwarfAI-Miners/host'
const LINUX_DATA_DIR = '/home/j/.config/DwarfAI-Miners/host'

const key = (canonical: string): string => sha256(canonical).slice(0, 12)

describe('the Host endpoint rule (ADR-002 D2, AM-17-01)', () => {
  it('[ADR-002] the Windows pipe name is \\\\.\\pipe\\dwarfai-host-<sha256(userSid)[0..16]>-<profileKey>', () => {
    const cases: Array<[string, string]> = [
      [WIN_DATA_DIR, WIN_DATA_DIR.toLowerCase()],
      // Separators are normalised, a trailing one dropped, then the path is case-folded.
      ['C:/Users/j/AppData/Roaming/DwarfAI-Miners/host/', WIN_DATA_DIR.toLowerCase()],
      [
        'C:\\Users\\j\\AppData\\Roaming\\DwarfAI-dev\\.\\x\\..\\host',
        'c:\\users\\j\\appdata\\roaming\\dwarfai-dev\\host'
      ]
    ]
    for (const [hostDataDir, canonical] of cases) {
      const result = endpointFor({ platform: 'win32', hostDataDir, userSid: SID, sha256 })

      expect(result, hostDataDir).toEqual({
        ok: true,
        value: {
          kind: 'named-pipe',
          path: `\\\\.\\pipe\\dwarfai-host-${sha256(SID).slice(0, 16)}-${key(canonical)}`
        }
      })
    }
    expect(endpointFor({ platform: 'win32', hostDataDir: WIN_DATA_DIR, sha256 })).toEqual({
      ok: false,
      error: { kind: 'user-sid-missing' }
    })
  })

  it('[ADR-002] macOS and Linux socket paths carry host-<profileKey>.sock under the D2 directories, with the Linux fallback under hostDataDir/run', () => {
    const macDir = '/Users/j/Library/Application Support/DwarfAI-Miners/run'
    expect(
      endpointFor({ platform: 'darwin', hostDataDir: MAC_DATA_DIR, home: '/Users/j', sha256 })
    ).toEqual({
      ok: true,
      value: { kind: 'unix-socket', dir: macDir, path: `${macDir}/host-${key(MAC_DATA_DIR)}.sock` }
    })
    // A dev build's userData folder names its own run directory, and its own key.
    const devDataDir = '/Users/j/Library/Application Support/DwarfAI-dev/host/'
    const devDir = '/Users/j/Library/Application Support/DwarfAI-dev/run'
    expect(
      endpointFor({ platform: 'darwin', hostDataDir: devDataDir, home: '/Users/j/', sha256 })
    ).toEqual({
      ok: true,
      value: {
        kind: 'unix-socket',
        dir: devDir,
        path: `${devDir}/host-${key(devDataDir.slice(0, -1))}.sock`
      }
    })

    expect(
      endpointFor({
        platform: 'linux',
        hostDataDir: LINUX_DATA_DIR,
        xdgRuntimeDir: '/run/user/1000/',
        sha256
      })
    ).toEqual({
      ok: true,
      value: {
        kind: 'unix-socket',
        dir: '/run/user/1000/dwarfai',
        path: `/run/user/1000/dwarfai/host-${key(LINUX_DATA_DIR)}.sock`
      }
    })
    // XDG_RUNTIME_DIR unset, empty or relative (the XDG spec says to ignore a relative one).
    for (const xdgRuntimeDir of [undefined, '', 'run/user/1000']) {
      expect(
        endpointFor({ platform: 'linux', hostDataDir: LINUX_DATA_DIR, xdgRuntimeDir, sha256 }),
        String(xdgRuntimeDir)
      ).toEqual({
        ok: true,
        value: {
          kind: 'unix-socket',
          dir: `${LINUX_DATA_DIR}/run`,
          path: `${LINUX_DATA_DIR}/run/host-${key(LINUX_DATA_DIR)}.sock`
        }
      })
    }

    expect(endpointFor({ platform: 'darwin', hostDataDir: MAC_DATA_DIR, sha256 })).toEqual({
      ok: false,
      error: { kind: 'home-missing' }
    })
    for (const hostDataDir of ['relative/host', '']) {
      expect(endpointFor({ platform: 'linux', hostDataDir, sha256 }), hostDataDir).toEqual({
        ok: false,
        error: { kind: 'host-data-dir-invalid' }
      })
    }
    // On macOS the folder holding hostDataDir names the run directory, so one is needed.
    expect(
      endpointFor({ platform: 'darwin', hostDataDir: '/host', home: '/Users/j', sha256 })
    ).toEqual({ ok: false, error: { kind: 'host-data-dir-invalid' } })
    expect(endpointFor({ platform: 'win32', hostDataDir: 'host', userSid: SID, sha256 })).toEqual({
      ok: false,
      error: { kind: 'host-data-dir-invalid' }
    })
  })

  it('[ADR-002] two hostDataDir values that differ only in case give one profileKey on Windows and two on a case-sensitive volume', () => {
    const upper = 'C:\\Users\\j\\AppData\\Roaming\\DwarfAI-Miners\\host'
    const lower = 'c:\\users\\j\\appdata\\roaming\\dwarfai-miners\\host'
    const win = (hostDataDir: string): string =>
      profileKey(
        canonicalHostDataDir(hostDataDir, { platform: 'win32', caseInsensitive: true }),
        sha256
      )
    expect(win(upper)).toBe(win(lower))
    expect(win(upper)).toMatch(/^[0-9a-f]{12}$/)

    const mac = (hostDataDir: string, caseInsensitiveVolume: boolean): unknown =>
      endpointFor({
        platform: 'darwin',
        hostDataDir,
        home: '/Users/j',
        caseInsensitiveVolume,
        sha256
      })
    const macUpper = '/Users/j/Library/Application Support/DwarfAI-Miners/Host'
    // A case-sensitive volume: two keys, two endpoints.
    expect(mac(MAC_DATA_DIR, false)).not.toEqual(mac(macUpper, false))
    // A case-insensitive volume (the default APFS): one key, one endpoint.
    expect(mac(MAC_DATA_DIR, true)).toEqual(mac(macUpper, true))
    // Linux volumes are case-sensitive.
    const linux = (hostDataDir: string): unknown =>
      endpointFor({ platform: 'linux', hostDataDir, xdgRuntimeDir: '/run/user/1000', sha256 })
    expect(linux(LINUX_DATA_DIR)).not.toEqual(linux(LINUX_DATA_DIR.toUpperCase()))
  })

  it('[FM-037] a socket path over 104 bytes on macOS or 108 on Linux fails fast with a typed error', () => {
    // `sun_path` holds the path and its terminating NUL: at most 103 bytes on macOS, 107 on Linux.
    const path = (bytes: number): string => `/${'a'.repeat(bytes - 1)}`
    expect(checkSocketPathLength('darwin', path(103))).toEqual({ ok: true, value: undefined })
    expect(checkSocketPathLength('darwin', path(104))).toEqual({
      ok: false,
      error: { kind: 'socket-path-too-long', bytes: 104, limit: 104 }
    })
    expect(checkSocketPathLength('linux', path(107))).toEqual({ ok: true, value: undefined })
    expect(checkSocketPathLength('linux', path(108))).toEqual({
      ok: false,
      error: { kind: 'socket-path-too-long', bytes: 108, limit: 108 }
    })
    // Bytes, not characters: two-byte UTF-8 characters count twice.
    expect(checkSocketPathLength('linux', `/${'é'.repeat(54)}`)).toEqual({
      ok: false,
      error: { kind: 'socket-path-too-long', bytes: 109, limit: 108 }
    })
    // A named pipe has no sun_path.
    expect(checkSocketPathLength('win32', path(300))).toEqual({ ok: true, value: undefined })

    // endpointFor applies it to the socket path it builds.
    const deepHome = `/Users/${'j'.repeat(60)}`
    expect(
      endpointFor({
        platform: 'darwin',
        hostDataDir: `${deepHome}/Library/Application Support/DwarfAI-Miners/host`,
        home: deepHome,
        sha256
      })
    ).toEqual({ ok: false, error: { kind: 'socket-path-too-long', bytes: 137, limit: 104 } })
  })
})
