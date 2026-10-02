// The environment of a real Host started by a test (realHost.ts): the Host detects the person's
// installed provider CLIs at start (ADR-009 D5, ISSUE-159), so a test Host gets a PATH of system
// folders only and a per-Host home, and none of the variables the CliInstallResolver reads a
// person's tool folders from. Then no real provider CLI resolves and none is ever spawned.
import { describe, expect, it } from 'vitest'
import { isolatedHostEnv } from './realHostEnv'

/** A person's environment, with their own tool folders and provider overrides. */
const WINDOWS_PERSON = {
  Path: 'C:\\Users\\j\\.agent-policy\\bin;C:\\Users\\j\\AppData\\Roaming\\npm;C:\\Windows\\System32',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  SystemRoot: 'C:\\Windows',
  USERPROFILE: 'C:\\Users\\j',
  HOMEDRIVE: 'C:',
  HOMEPATH: '\\Users\\j',
  APPDATA: 'C:\\Users\\j\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\j\\AppData\\Local',
  PNPM_HOME: 'C:\\Users\\j\\AppData\\Local\\pnpm',
  VOLTA_HOME: 'C:\\Users\\j\\AppData\\Local\\Volta',
  BUN_INSTALL: 'C:\\Users\\j\\.bun',
  SCOOP: 'C:\\Users\\j\\scoop',
  NPM_CONFIG_PREFIX: 'C:\\Users\\j\\npm',
  DWARFAI_AGY_PATH: 'C:\\Users\\j\\tools\\agy.exe',
  TEMP: 'C:\\Users\\j\\AppData\\Local\\Temp',
  LANG: 'en_US.UTF-8'
}

const POSIX_PERSON = {
  PATH: '/home/j/.local/bin:/home/j/.npm-global/bin:/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/j',
  SHELL: '/bin/zsh',
  XDG_CONFIG_HOME: '/home/j/.config',
  XDG_DATA_HOME: '/home/j/.local/share',
  XDG_RUNTIME_DIR: '/run/user/1000',
  npm_config_prefix: '/home/j/.npm-global',
  PNPM_HOME: '/home/j/.local/share/pnpm',
  TMPDIR: '/tmp',
  LANG: 'en_US.UTF-8'
}

const keyOf = (env: Record<string, string>, name: string): string[] =>
  Object.keys(env).filter((key) => key.toUpperCase() === name.toUpperCase())

describe('isolatedHostEnv', () => {
  it('[ADR-009] a Windows test Host has the system folders as its only PATH and a home of its own', () => {
    const env = isolatedHostEnv({
      base: WINDOWS_PERSON,
      home: 'C:\\tmp\\host-home',
      platform: 'win32'
    })

    expect(keyOf(env, 'PATH')).toEqual(['PATH'])
    expect(env.PATH).toBe('C:\\Windows\\System32;C:\\Windows')
    expect(env.USERPROFILE).toBe('C:\\tmp\\host-home')
    expect(env.HOME).toBe('C:\\tmp\\host-home')
    expect(env.APPDATA).toBe('C:\\tmp\\host-home\\AppData\\Roaming')
    expect(env.LOCALAPPDATA).toBe('C:\\tmp\\host-home\\AppData\\Local')
    for (const gone of [
      'HOMEDRIVE',
      'HOMEPATH',
      'PNPM_HOME',
      'VOLTA_HOME',
      'BUN_INSTALL',
      'SCOOP',
      'NPM_CONFIG_PREFIX',
      'DWARFAI_AGY_PATH'
    ]) {
      expect(keyOf(env, gone), gone).toEqual([])
    }
    // What the Host itself needs is kept.
    expect(env).toMatchObject({
      SystemRoot: 'C:\\Windows',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      TEMP: 'C:\\Users\\j\\AppData\\Local\\Temp',
      LANG: 'en_US.UTF-8'
    })
  })

  it('[ADR-009] a POSIX test Host has /usr/bin and /bin as its PATH, no login shell of the person and XDG folders of its own', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const env = isolatedHostEnv({ base: POSIX_PERSON, home: '/tmp/host-home', platform })

      expect(env.PATH).toBe('/usr/bin:/bin')
      expect(env.HOME).toBe('/tmp/host-home')
      expect(env.XDG_CONFIG_HOME).toBe('/tmp/host-home/.config')
      expect(env.XDG_DATA_HOME).toBe('/tmp/host-home/.local/share')
      expect(env.XDG_CACHE_HOME).toBe('/tmp/host-home/.cache')
      expect(env.XDG_STATE_HOME).toBe('/tmp/host-home/.local/state')
      for (const gone of ['SHELL', 'npm_config_prefix', 'PNPM_HOME']) {
        expect(keyOf(env, gone), gone).toEqual([])
      }
      expect(env).toMatchObject({ XDG_RUNTIME_DIR: '/run/user/1000', TMPDIR: '/tmp' })
    }
  })

  it("[ADR-009] the test's own overrides win over the isolation", () => {
    const env = isolatedHostEnv({
      base: POSIX_PERSON,
      home: '/tmp/host-home',
      platform: 'linux',
      overrides: { HOME: '/tmp/case/home', XDG_RUNTIME_DIR: '/tmp/case/run' }
    })

    expect(env.HOME).toBe('/tmp/case/home')
    expect(env.XDG_RUNTIME_DIR).toBe('/tmp/case/run')
    expect(env.PATH).toBe('/usr/bin:/bin')
  })
})
