import { describe, expect, it } from 'vitest'
import { FakeFs } from '../adapters/fakeFs'
import {
  conventionalCliPaths,
  cliExecutableNames,
  createCliDetector,
  describeProgramFailure,
  describeShimRefusal,
  pathLookupCandidates,
  resolveProgram,
  resolveShimTarget
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

  /*
   * Issue #237. Every provider so far has been named after its own binary, so
   * the spellings were derived from the provider name directly. Antigravity
   * breaks that: the provider identity is the harness (`antigravity`, which is
   * what a dwarf carries on the wire) and the executable is `agy`. Deriving
   * the filename from the identity would look for a program nobody ships.
   */
  it('looks for the agy binary, not for the provider identity', () => {
    expect(cliExecutableNames('antigravity', 'win32')).toEqual(['agy.exe', 'agy.cmd', 'agy.bat'])
    expect(cliExecutableNames('antigravity', 'linux')).toEqual(['agy'])
    expect(cliExecutableNames('antigravity', 'darwin')).toEqual(['agy'])
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
      '\\home\\j\\AppData\\Roaming\\npm\\codex.cmd',
      '\\home\\j\\AppData\\Local\\pnpm\\bin\\codex.cmd'
    ])
  })

  /*
   * #413. A pnpm-global Codex install (the vendor-documented alternative to
   * npm) landed on neither the native bin nor the npm row, so it fell through
   * to a bare PATH guess — which detection never made for `.cmd`/`.bat`
   * shims before this issue, per the walk in cliExecutableNames. Verified on
   * a real pnpm machine: `%LOCALAPPDATA%\pnpm\bin` holds `codex.CMD` and
   * nothing an `.exe` probe would have found.
   */
  it("checks pnpm's own global bin for codex on Windows, derived from home rather than the live environment", () => {
    expect(conventionalCliPaths('codex', HOME, 'win32')).toContain(
      '\\home\\j\\AppData\\Local\\pnpm\\bin\\codex.cmd'
    )
  })

  it('checks the native bin for codex on POSIX', () => {
    expect(conventionalCliPaths('codex', HOME, 'linux')).toEqual(['/home/j/.local/bin/codex'])
  })

  /*
   * Both locations are what Antigravity's own installation documentation says,
   * and the Windows one was verified on this machine against CLI 1.1.26
   * (#237): `%LOCALAPPDATA%\agy\bin\agy.exe`. It is a location the generic
   * `~/.local/bin` convention does not reach, which is why adding the provider
   * name alone would have detected nothing on the one platform the CLI was
   * actually installed on. POSIX is `~/.local/bin/agy` — the shared native-bin
   * convention, with the executable's own name.
   */
  it('checks the documented agy install location on Windows', () => {
    expect(conventionalCliPaths('antigravity', HOME, 'win32')).toEqual([
      '\\home\\j\\.local\\bin\\agy.exe',
      '\\home\\j\\AppData\\Local\\agy\\bin\\agy.exe'
    ])
  })

  it('checks the documented agy install location on macOS and Linux', () => {
    expect(conventionalCliPaths('antigravity', HOME, 'linux')).toEqual(['/home/j/.local/bin/agy'])
    expect(conventionalCliPaths('antigravity', HOME, 'darwin')).toEqual(['/home/j/.local/bin/agy'])
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

  it('looks for agy on PATH, whichever OS is asked (#237)', () => {
    expect(pathLookupCandidates('antigravity', '/usr/local/bin', 'darwin')).toEqual([
      '/usr/local/bin/agy'
    ])
    expect(pathLookupCandidates('antigravity', 'C:\\bin', 'win32')).toEqual([
      'C:\\bin\\agy.exe',
      'C:\\bin\\agy.cmd',
      'C:\\bin\\agy.bat'
    ])
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

  /*
   * The whole walk on the one platform Antigravity was verified installed on
   * (#237): the file sits where the CLI's own installer puts it, which the
   * generic `~/.local/bin` convention does not cover, and the verdict names
   * the provider identity while the PATH it found is the executable's.
   */
  it('finds an agy installed where the Antigravity installer puts it on Windows', async () => {
    const fs = new FakeFs()
    fs.addFile('C:\\Users\\j\\AppData\\Local\\agy\\bin\\agy.exe', 'binary')
    const detector = createCliDetector({
      home: 'C:\\Users\\j',
      platform: 'win32',
      fs,
      env: {}
    })

    expect(await detector.detect('antigravity')).toEqual({
      cli: 'antigravity',
      installed: true,
      path: 'C:\\Users\\j\\AppData\\Local\\agy\\bin\\agy.exe',
      source: 'convention'
    })
  })

  it('reports an absent agy as absent, with a reason and no throw', async () => {
    const detector = createCliDetector({
      home: HOME,
      platform: 'linux',
      fs: new FakeFs(),
      env: {}
    })

    const verdict = await detector.detect('antigravity')
    expect(verdict.installed).toBe(false)
    expect(verdict.path).toBeUndefined()
  })

  /*
   * #544. A candidate this app cannot run used to END the walk: the probe
   * asked `exists` and nothing else, so a wrapper `.cmd` earlier on PATH
   * shadowed a readable install behind it, and the launcher only found out
   * far too late to look anywhere else. The guard fixture is the shape that
   * produced the bug — a launcher that forwards through another interpreter
   * and names no program this can spawn.
   */
  const GUARD_SHIM = '@echo off\r\npy "%~dp0..\\tools\\launch_guard.py" opencode %*\r\n'

  it('walks past a PATH shim it cannot read and finds the install behind it', async () => {
    const fs = new FakeFs()
    fs.addFile('C:\\guard\\bin\\opencode.cmd', GUARD_SHIM)
    fs.addFile(
      'C:\\pnpm\\bin\\opencode.cmd',
      '@SETLOCAL\r\n@"C:\\store\\opencode-ai\\bin\\opencode.exe"   %*'
    )
    const detector = createCliDetector({
      home: 'C:\\Users\\x',
      platform: 'win32',
      fs,
      env: { PATH: 'C:\\guard\\bin;C:\\pnpm\\bin' }
    })

    expect(await detector.detect('opencode')).toEqual({
      cli: 'opencode',
      installed: true,
      path: 'C:\\pnpm\\bin\\opencode.cmd',
      source: 'path'
    })
  })

  it('walks past an unreadable conventional shim on its way to PATH', async () => {
    const fs = new FakeFs()
    fs.addFile('C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd', '@echo off\r\nrem nothing\r\n')
    fs.addFile('C:\\real\\bin\\codex.exe', 'binary')
    const detector = createCliDetector({
      home: 'C:\\Users\\x',
      platform: 'win32',
      fs,
      env: { PATH: 'C:\\real\\bin' }
    })

    expect(await detector.detect('codex')).toEqual({
      cli: 'codex',
      installed: true,
      path: 'C:\\real\\bin\\codex.exe',
      source: 'path'
    })
  })

  /*
   * Absent and present-but-unrunnable are different facts, and the second one
   * has to say which file it gave up on — "not found in ~/.local/bin, a known
   * install location, or PATH" would be a lie about a machine that has the
   * CLI, and leaves the person nothing to act on.
   */
  it('names the refusal when every candidate is a shim it cannot read', async () => {
    const fs = new FakeFs()
    fs.addFile('C:\\guard\\bin\\opencode.cmd', GUARD_SHIM)
    const detector = createCliDetector({
      home: 'C:\\Users\\x',
      platform: 'win32',
      fs,
      env: { PATH: 'C:\\guard\\bin' }
    })

    const verdict = await detector.detect('opencode')
    expect(verdict.installed).toBe(false)
    expect(verdict.path).toBeUndefined()
    expect(verdict.reason).toContain('C:\\guard\\bin\\opencode.cmd')
    expect(verdict.reason).toContain('dialect was not understood')
  })

  /*
   * The fail-safe convention at the top of cliDetection.ts: a probe never
   * throws. A candidate whose bytes cannot be read at all is unrunnable, not
   * an exception that takes the poll tick down with it.
   */
  it('treats a candidate it cannot even read as unrunnable rather than throwing', async () => {
    const fs = new FakeFs()
    fs.addFile('C:\\guard\\bin\\opencode.cmd', GUARD_SHIM)
    fs.addFile('C:\\pnpm\\bin\\opencode.cmd', '@"C:\\store\\opencode.exe" %*')
    fs.onBeforeRead = async (path) => {
      if (path.includes('guard')) throw new Error('EACCES')
    }
    const detector = createCliDetector({
      home: 'C:\\Users\\x',
      platform: 'win32',
      fs,
      env: { PATH: 'C:\\guard\\bin;C:\\pnpm\\bin' }
    })

    expect(await detector.detect('opencode')).toEqual({
      cli: 'opencode',
      installed: true,
      path: 'C:\\pnpm\\bin\\opencode.cmd',
      source: 'path'
    })
  })

  /*
   * An override is a stated instruction, and the probe's own rule is that it
   * does not second-guess the user. A path they named is theirs even when
   * this app cannot read it; the refusal then reaches them at the launch,
   * naming the file they chose, rather than being swallowed here.
   */
  it('still honours an override that points at a shim it cannot read', async () => {
    const fs = new FakeFs()
    fs.addFile('C:\\custom\\opencode.cmd', GUARD_SHIM)
    const detector = createCliDetector({
      home: 'C:\\Users\\x',
      platform: 'win32',
      fs,
      env: {},
      overrides: { opencode: 'C:\\custom\\opencode.cmd' }
    })

    expect(await detector.detect('opencode')).toEqual({
      cli: 'opencode',
      installed: true,
      path: 'C:\\custom\\opencode.cmd',
      source: 'override'
    })
  })
})

/*
 * What a Windows batch shim actually runs (#193). Both fixtures are the real
 * shim text of the two package managers that produce one — npm's cmd-shim and
 * pnpm's — with only the home and pnpm's store hash made generic. Pure, over
 * the shim's text and path, so no host ever needs a `.cmd` to run this.
 */
describe('resolveShimTarget', () => {
  const NPM_DIR = 'C:\\Users\\x\\AppData\\Roaming\\npm'
  const NPM_SHIM_TEXT = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
  ].join('\r\n')

  const PNPM_DIR = 'C:\\Users\\x\\AppData\\Local\\pnpm\\bin'
  const PNPM_SHIM_TEXT = [
    '@SETLOCAL',
    '@IF EXIST "%~dp0\\node.exe" (',
    '  "%~dp0\\node.exe"  "%~dp0\\..\\global\\v11\\abcd-0123456789abc\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ') ELSE (',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    '  node  "%~dp0\\..\\global\\v11\\abcd-0123456789abc\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    ')'
  ].join('\r\n')

  it("resolves npm's cmd-shim to the JS entry beside it, and the node.exe it would prefer", () => {
    expect(resolveShimTarget(`${NPM_DIR}\\codex.cmd`, NPM_SHIM_TEXT)).toEqual({
      entry: `${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`,
      bundledNode: `${NPM_DIR}\\node.exe`
    })
  })

  it("resolves pnpm's shim, collapsing the `..` its store path goes through", () => {
    // `where codex` on a pnpm machine answers `...\pnpm\bin\codex.CMD`, upper-case.
    expect(resolveShimTarget(`${PNPM_DIR}\\codex.CMD`, PNPM_SHIM_TEXT)).toEqual({
      entry:
        'C:\\Users\\x\\AppData\\Local\\pnpm\\global\\v11\\abcd-0123456789abc\\node_modules\\@openai\\codex\\bin\\codex.js',
      bundledNode: `${PNPM_DIR}\\node.exe`
    })
  })

  it('takes an entry written as an absolute path as it is', () => {
    expect(
      resolveShimTarget('C:\\tools\\codex.bat', 'node "C:\\opt\\codex\\bin\\codex.js" %*')
    ).toEqual({ entry: 'C:\\opt\\codex\\bin\\codex.js', bundledNode: 'C:\\tools\\node.exe' })
  })

  // AMENDED for #502 (was: 'answers undefined for a shim that names no JS
  // entry, rather than guessing one', asserting a bare `toBe(undefined)`).
  // Plain `undefined` could not say which of two refusals this was; the
  // shape now names the fact and carries the shim's own path.
  it('names the shim path and "dialect not understood" for a shim that names no JS entry', () => {
    const shimPath = 'C:\\tools\\codex.cmd'
    expect(resolveShimTarget(shimPath, '@echo off\r\nrem nothing to run\r\n')).toEqual({
      kind: 'dialect-not-understood',
      shimPath
    })
  })

  // AMENDED for #502 (was: 'answers undefined when the entry hangs on a
  // variable only cmd.exe could expand', asserting a bare `toBe(undefined)`).
  it('names the shim path and the unexpanded entry when a variable still needs cmd.exe', () => {
    const shimPath = `${NPM_DIR}\\codex.cmd`
    const text = 'node "%APPDATA%\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
    expect(resolveShimTarget(shimPath, text)).toEqual({
      kind: 'needs-cmd-exe',
      shimPath,
      entry: '%APPDATA%\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'
    })
  })

  /*
   * #544. `opencode-ai` ships a compiled binary, so pnpm writes it a shim that
   * names `opencode.exe` and no `.js` at all — refused as an unknown dialect
   * although it is the easiest case there is: one program, spawn it, nothing
   * in between.
   */
  const OPENCODE_PNPM_TEXT = [
    '@SETLOCAL',
    '@"%~dp0\\..\\global\\v11\\abcd-0123456789abc\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*'
  ].join('\r\n')

  it('resolves a shim that names a native executable to that program, with no node entry', () => {
    expect(resolveShimTarget(`${PNPM_DIR}\\opencode.CMD`, OPENCODE_PNPM_TEXT)).toEqual({
      program:
        'C:\\Users\\x\\AppData\\Local\\pnpm\\global\\v11\\abcd-0123456789abc\\node_modules\\opencode-ai\\bin\\opencode.exe'
    })
  })

  /*
   * The load-bearing ordering. Every npm shim quotes `node.exe` as the program
   * it runs the `.js` WITH, so an executable read that went first would answer
   * `node.exe` for every Node CLI on the machine. The JS entry wins wherever
   * there is one, and this is the case that fails if that order is ever
   * flipped.
   */
  it('still answers the JS entry for a shim that also quotes node.exe', () => {
    expect(resolveShimTarget(`${NPM_DIR}\\codex.cmd`, NPM_SHIM_TEXT)).toEqual({
      entry: `${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`,
      bundledNode: `${NPM_DIR}\\node.exe`
    })
  })

  it('needs cmd.exe when an executable entry still hangs on a variable', () => {
    const shimPath = `${PNPM_DIR}\\opencode.cmd`
    expect(resolveShimTarget(shimPath, '@"%LOCALAPPDATA%\\opencode\\opencode.exe" %*')).toEqual({
      kind: 'needs-cmd-exe',
      shimPath,
      entry: '%LOCALAPPDATA%\\opencode\\opencode.exe'
    })
  })

  /*
   * A wrapper that forwards to another `.cmd` stays refused, on purpose:
   * chasing a chain of shims is how this app would end up running the very
   * wrapper it was trying to see past.
   */
  it('refuses a shim that only forwards to another shim', () => {
    const shimPath = 'C:\\Users\\x\\.wrapper\\bin\\opencode.cmd'
    expect(
      resolveShimTarget(shimPath, '@echo off\r\n"C:\\other\\bin\\opencode.cmd" %*\r\n')
    ).toEqual({ kind: 'dialect-not-understood', shimPath })
  })
})

/*
 * Issue #413. Lifted out of sessionLaunch/launchRunner.ts, where it was
 * `resolveLaunchProgram` and unexported, so the Codex queue tier
 * (textDelivery/codexQueue.ts) can share the exact same resolution instead of
 * growing a second copy that could drift from the launcher's. launchRunner.ts
 * still exercises this indirectly through launchClaudeSession — see its own
 * "starts an npm .cmd shim..." tests — and none of those changed.
 */
describe('resolveProgram', () => {
  const REAL_EXE = 'C:\\Users\\j\\.local\\bin\\codex.exe'
  const SHIM = 'C:\\tools\\codex.cmd'
  const ENTRY = 'C:\\tools\\node_modules\\@openai\\codex\\bin\\codex.js'
  const SHIM_TEXT = `node  "${ENTRY}" %*`

  it('is the path itself for a real executable, reading nothing from disk', async () => {
    const fs = new FakeFs()
    expect(await resolveProgram(REAL_EXE, fs)).toEqual({
      command: REAL_EXE,
      args: [],
      viaNodeEntry: false
    })
  })

  it("prefers the node.exe beside a shim, the shim's own first choice", async () => {
    const fs = new FakeFs()
    fs.addFile(SHIM, SHIM_TEXT)
    fs.addFile('C:\\tools\\node.exe', 'MZ')

    expect(await resolveProgram(SHIM, fs)).toEqual({
      command: 'C:\\tools\\node.exe',
      args: [ENTRY],
      viaNodeEntry: true
    })
  })

  it('falls back to node from PATH when no node.exe sits beside the shim', async () => {
    const fs = new FakeFs()
    fs.addFile(SHIM, SHIM_TEXT)

    expect(await resolveProgram(SHIM, fs)).toEqual({
      command: 'node',
      args: [ENTRY],
      viaNodeEntry: true
    })
  })

  // AMENDED for #502 (was: 'answers undefined, never a guess, when the shim
  // names no JS entry', asserting `toBeUndefined()`). The refusal now names
  // the fact and the shim's own path, which `launchRunner.ts` and the two
  // text-delivery tiers turn into the sentence the panel shows.
  it('names the shim path and "dialect not understood" when the shim names no JS entry', async () => {
    const fs = new FakeFs()
    fs.addFile(SHIM, '@echo off\r\nrem nothing to run\r\n')

    expect(await resolveProgram(SHIM, fs)).toEqual({
      kind: 'dialect-not-understood',
      shimPath: SHIM
    })
  })

  // NEW for #502: resolveShimTarget's own test above pins this fact in
  // isolation; this pins that resolveProgram (what every caller actually
  // calls) carries it through unchanged.
  it('names the shim path and the unexpanded entry when a variable still needs cmd.exe', async () => {
    const fs = new FakeFs()
    const text = 'node "%APPDATA%\\node_modules\\@openai\\codex\\bin\\codex.js" %*'
    fs.addFile(SHIM, text)

    expect(await resolveProgram(SHIM, fs)).toEqual({
      kind: 'needs-cmd-exe',
      shimPath: SHIM,
      entry: '%APPDATA%\\node_modules\\@openai\\codex\\bin\\codex.js'
    })
  })

  // FsLike's own contract: readTextHead REJECTS for a missing file rather than
  // answering empty (see fsLike.ts). This does not catch that — the caller
  // does (deliverViaCodexQueue, launchClaudeSession), both already proven to
  // fail closed rather than guess when the read itself throws.
  it('propagates rather than swallows a shim that cannot be read at all', async () => {
    const fs = new FakeFs()
    await expect(resolveProgram(SHIM, fs)).rejects.toThrow()
  })

  /*
   * #544. The executable dialect resolves to the program itself: no node, no
   * argv preceding the caller's own, and `viaNodeEntry: false` because there
   * is no node entry to speak of — the same answer a real `.exe` on PATH
   * already gets, reached through a shim.
   */
  it('spawns the executable a shim names directly, with no node in the command', async () => {
    const fs = new FakeFs()
    const exe = 'C:\\tools\\opencode\\opencode.exe'
    fs.addFile(SHIM, `@"${exe}" %*`)

    expect(await resolveProgram(SHIM, fs)).toEqual({
      command: exe,
      args: [],
      viaNodeEntry: false
    })
  })
})

/*
 * #502. Every resolveProgram caller turns a ShimRefusal into the panel's
 * sentence through this, so the wording lives in one place rather than once
 * per caller.
 */
describe('describeShimRefusal', () => {
  it('names the dialect fact for a shim whose text has no JS entry', () => {
    expect(
      describeShimRefusal({ kind: 'dialect-not-understood', shimPath: 'C:\\tools\\codex.cmd' })
    ).toBe('the shim was found but its dialect was not understood')
  })

  it('names the unexpanded entry for a shim still needing cmd.exe', () => {
    expect(
      describeShimRefusal({
        kind: 'needs-cmd-exe',
        shimPath: 'C:\\tools\\codex.cmd',
        entry: '%APPDATA%\\codex.js'
      })
    ).toBe('its entry still names a variable only cmd.exe can expand: %APPDATA%\\codex.js')
  })
})

/*
 * #502. The other half of a launch or delivery refusal's cause: what a
 * spawn or a shim read failed with, read the same way wherever either is
 * caught.
 */
describe('describeProgramFailure', () => {
  it("names the platform's own errno code when the exception carries one", () => {
    const error = Object.assign(new Error('spawn claude EACCES'), { code: 'EACCES' })
    expect(describeProgramFailure(error)).toBe('EACCES')
  })

  it('falls back to the exception message when there is no errno code', () => {
    expect(describeProgramFailure(new Error('FakeFs: no such file C:\\tools\\codex.cmd'))).toBe(
      'FakeFs: no such file C:\\tools\\codex.cmd'
    )
  })

  it('falls back to String() for a thrown value that is not an Error', () => {
    expect(describeProgramFailure('disk unplugged')).toBe('disk unplugged')
  })
})
