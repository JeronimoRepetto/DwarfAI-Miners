import { describe, expect, it } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import {
  conventionalCliPaths,
  cliExecutableNames,
  createCliDetector,
  pathLookupCandidates
} from './cliDetection'

const HOME = '/home/j'

describe('cliExecutableNames', () => {
  it('offers the three Windows shim/exe spellings, most-native first', () => {
    expect(cliExecutableNames('claude', 'win32')).toEqual([
      'claude.exe',
      'claude.cmd',
      'claude.bat'
    ])
  })

  it('is a single bare name on POSIX', () => {
    expect(cliExecutableNames('codex', 'linux')).toEqual(['codex'])
    expect(cliExecutableNames('codex', 'darwin')).toEqual(['codex'])
  })
})

describe('conventionalCliPaths', () => {
  it('puts claude where the native installer does — the same path the relay addresses', () => {
    expect(conventionalCliPaths('claude', HOME, 'win32')).toEqual([
      '\\home\\j\\.local\\bin\\claude.exe'
    ])
    expect(conventionalCliPaths('claude', HOME, 'linux')).toEqual(['/home/j/.local/bin/claude'])
  })

  it('checks both the native bin and the npm-global shim for codex on Windows', () => {
    expect(conventionalCliPaths('codex', HOME, 'win32')).toEqual([
      '\\home\\j\\.local\\bin\\codex.exe',
      '\\home\\j\\AppData\\Roaming\\npm\\codex.cmd'
    ])
  })

  it('checks the native bin for codex on POSIX', () => {
    expect(conventionalCliPaths('codex', HOME, 'linux')).toEqual(['/home/j/.local/bin/codex'])
  })
})

describe('pathLookupCandidates', () => {
  it('joins every PATH entry with every executable name, in order', () => {
    const candidates = pathLookupCandidates('claude', '/usr/bin:/home/j/.local/bin', 'linux')
    expect(candidates).toEqual(['/usr/bin/claude', '/home/j/.local/bin/claude'])
  })

  it('splits on the platform delimiter and skips blank entries', () => {
    const candidates = pathLookupCandidates('codex', 'C:\\tools;;C:\\bin', 'win32')
    expect(candidates).toEqual([
      'C:\\tools\\codex.exe',
      'C:\\tools\\codex.cmd',
      'C:\\tools\\codex.bat',
      'C:\\bin\\codex.exe',
      'C:\\bin\\codex.cmd',
      'C:\\bin\\codex.bat'
    ])
  })

  it('returns nothing for an empty or missing PATH', () => {
    expect(pathLookupCandidates('claude', '', 'linux')).toEqual([])
    expect(pathLookupCandidates('claude', undefined, 'linux')).toEqual([])
  })
})

describe('createCliDetector', () => {
  it('reports a conventionally-installed claude, with its path and source', async () => {
    const fs = new FakeFs()
    fs.addFile('/home/j/.local/bin/claude', '#!/bin/sh\n')
    const detector = createCliDetector({ home: HOME, platform: 'linux', fs, env: {} })

    expect(await detector.detect('claude')).toEqual({
      cli: 'claude',
      installed: true,
      path: '/home/j/.local/bin/claude',
      source: 'convention'
    })
  })

  it('falls back to a PATH lookup when nothing is in a conventional place', async () => {
    const fs = new FakeFs()
    fs.addFile('/opt/tools/codex', 'binary')
    const detector = createCliDetector({
      home: HOME,
      platform: 'linux',
      fs,
      env: { PATH: '/opt/tools' }
    })

    expect(await detector.detect('codex')).toEqual({
      cli: 'codex',
      installed: true,
      path: '/opt/tools/codex',
      source: 'path'
    })
  })

  it('reports not installed, with a reason, when a CLI is nowhere — never throws', async () => {
    const detector = createCliDetector({
      home: HOME,
      platform: 'linux',
      fs: new FakeFs(),
      env: { PATH: '/usr/bin' }
    })

    const result = await detector.detect('claude')
    expect(result.installed).toBe(false)
    expect(result.path).toBeUndefined()
    expect(result.reason).toBeTruthy()
  })

  it('lets an explicit override win over a conventional install', async () => {
    const fs = new FakeFs()
    fs.addFile('/home/j/.local/bin/claude', 'convention')
    fs.addFile('/opt/custom/claude', 'override')
    const detector = createCliDetector({
      home: HOME,
      platform: 'linux',
      fs,
      env: {},
      overrides: { claude: '/opt/custom/claude' }
    })

    expect(await detector.detect('claude')).toEqual({
      cli: 'claude',
      installed: true,
      path: '/opt/custom/claude',
      source: 'override'
    })
  })

  it('honours an override even when it points nowhere, rather than silently falling back', async () => {
    const fs = new FakeFs()
    fs.addFile('/home/j/.local/bin/claude', 'convention')
    const detector = createCliDetector({
      home: HOME,
      platform: 'linux',
      fs,
      env: {},
      overrides: { claude: '/opt/custom/claude' }
    })

    const result = await detector.detect('claude')
    expect(result.installed).toBe(false)
    expect(result.source).toBe('override')
    expect(result.reason).toContain('/opt/custom/claude')
  })

  it('caches a verdict for the TTL, then re-probes once it is stale', async () => {
    const fs = new FakeFs()
    const clock = { now: 1_000 }
    const detector = createCliDetector({
      home: HOME,
      platform: 'linux',
      fs,
      env: {},
      now: () => clock.now,
      ttlMs: 60_000
    })

    expect((await detector.detect('claude')).installed).toBe(false)

    // A claude appears on disk, but the cached "absent" verdict holds until TTL.
    fs.addFile('/home/j/.local/bin/claude', 'now here')
    expect((await detector.detect('claude')).installed).toBe(false)

    clock.now += 60_000
    expect((await detector.detect('claude')).installed).toBe(true)
  })

  it('exposes a distinct never-probed state via peek', async () => {
    const fs = new FakeFs()
    fs.addFile('/home/j/.local/bin/claude', 'x')
    const detector = createCliDetector({ home: HOME, platform: 'linux', fs, env: {} })

    expect(detector.peek('claude')).toBe('unprobed')
    await detector.detect('claude')
    expect(detector.peek('claude')).toEqual({
      cli: 'claude',
      installed: true,
      path: '/home/j/.local/bin/claude',
      source: 'convention'
    })
  })
})
