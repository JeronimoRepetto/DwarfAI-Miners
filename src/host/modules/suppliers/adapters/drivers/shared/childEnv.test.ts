import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../../../kernel/domain/errors'
import { childEnv, type LoginEnvironment } from './childEnv'
import { relayEntry } from './relayEntry'

const SPAWN_TAG = 'v1:install-1:launch-1:epoch-1'

const POSIX_LOGIN: LoginEnvironment = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/person',
  TMPDIR: '/tmp/person',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  LC_CTYPE: 'en_US.UTF-8',
  HTTPS_PROXY: 'http://proxy.example:3128',
  https_proxy: 'http://proxy.example:3128',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
  SSL_CERT_FILE: '/etc/ssl/cert.pem',
  SSL_CERT_DIR: '/etc/ssl/certs'
}

function build(
  loginEnv: LoginEnvironment,
  overrides: {
    providerVars?: readonly string[]
    loopbackRelay?: boolean
    platform?: NodeJS.Platform
  } = {}
): Record<string, string> {
  return childEnv(loginEnv, SPAWN_TAG, {
    providerVars: overrides.providerVars ?? [],
    loopbackRelay: overrides.loopbackRelay ?? false,
    platform: overrides.platform ?? 'linux'
  })
}

describe('childEnv (15 §4)', () => {
  it('[C-23, INV-59] a login environment holding ELECTRON_RUN_AS_NODE, NODE_OPTIONS, DWARFAI_DELEGATION_TOKEN and a token-shaped variable yields a child environment with none of them', () => {
    const env = build({
      ...POSIX_LOGIN,
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      NODE_OPTIONS: '--require /host/preload.js',
      DWARFAI_DELEGATION_TOKEN: 'secret-delegation-token',
      DWARFAI_MCP_CREDENTIAL_FILE: '/run/mcp/launch-1.cred',
      DWARFAI_HOST_INTERNAL: 'internal',
      SERVICE_ACCESS_TOKEN: 'ghp_0123456789abcdef0123456789abcdef0123',
      UNLISTED_VARIABLE: 'value'
    })

    expect(Object.keys(env).sort()).toEqual([...Object.keys(POSIX_LOGIN), 'DWARFAI_SPAWN'].sort())
    expect(Object.values(env)).not.toContain('secret-delegation-token')
    expect(Object.values(env)).not.toContain('ghp_0123456789abcdef0123456789abcdef0123')
  })

  it('[C-23] DWARFAI_SPAWN is present with the spawn tag and no other DWARFAI_ variable is present', () => {
    const env = build({
      ...POSIX_LOGIN,
      DWARFAI_SPAWN: 'v1:stale:stale:stale',
      DWARFAI_PROFILE: 'dev'
    })

    expect(env.DWARFAI_SPAWN).toBe(SPAWN_TAG)
    expect(Object.keys(env).filter((name) => name.startsWith('DWARFAI_'))).toEqual([
      'DWARFAI_SPAWN'
    ])
  })

  it('[C-23] with a loopback relay NO_PROXY and no_proxy gain 127.0.0.1, localhost and ::1, and without one they are copied unchanged', () => {
    const login = { ...POSIX_LOGIN, NO_PROXY: 'corp.example', no_proxy: 'corp.example,localhost' }

    const relayed = build(login, { loopbackRelay: true })
    expect(relayed.NO_PROXY).toBe('corp.example,127.0.0.1,localhost,::1')
    expect(relayed.no_proxy).toBe('corp.example,localhost,127.0.0.1,::1')

    const unset = build(POSIX_LOGIN, { loopbackRelay: true })
    expect(unset.NO_PROXY).toBe('127.0.0.1,localhost,::1')
    expect(unset.no_proxy).toBe('127.0.0.1,localhost,::1')

    const plain = build(login)
    expect(plain.NO_PROXY).toBe('corp.example')
    expect(plain.no_proxy).toBe('corp.example,localhost')
    expect(build(POSIX_LOGIN)).not.toHaveProperty('NO_PROXY')
    expect(build(POSIX_LOGIN)).not.toHaveProperty('no_proxy')
  })

  it('[C-23] the relay entry carries the credential file path and ELECTRON_RUN_AS_NODE only in its own env', () => {
    const credentialFilePath = '/home/person/.local/share/dwarfai/run/mcp/launch-1.cred'
    const entry = relayEntry({
      command: '/opt/dwarfai/versions/1.0.0/dwarfai',
      args: ['--dwarfai-mcp-relay'],
      credentialFilePath,
      platform: 'linux'
    })

    expect(entry).toEqual({
      command: '/opt/dwarfai/versions/1.0.0/dwarfai',
      args: ['--dwarfai-mcp-relay'],
      env: { ELECTRON_RUN_AS_NODE: '1', DWARFAI_MCP_CREDENTIAL_FILE: credentialFilePath }
    })

    const providerEnv = build({ ...POSIX_LOGIN, ...entry.env }, { loopbackRelay: true })
    expect(providerEnv).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(providerEnv).not.toHaveProperty('DWARFAI_MCP_CREDENTIAL_FILE')
    expect(Object.values(providerEnv)).not.toContain(credentialFilePath)
  })

  it('[C-23] a relay entry refuses a credential that is not an absolute file path, so a value never takes the path’s place', () => {
    for (const notAPath of [
      '3f9a0c1d2e4b5a6978879605a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5',
      'run/mcp/launch-1.cred',
      ''
    ]) {
      expect(() =>
        relayEntry({
          command: '/opt/dwarfai/dwarfai',
          args: [],
          credentialFilePath: notAPath,
          platform: 'linux'
        })
      ).toThrow(HostInvariantError)
    }
    expect(
      relayEntry({
        command: 'C:\\DwarfAI\\versions\\1.0.0\\DwarfAI.exe',
        args: [],
        credentialFilePath: 'C:\\Users\\person\\AppData\\Roaming\\DwarfAI\\run\\mcp\\launch-1.cred',
        platform: 'win32'
      }).env.DWARFAI_MCP_CREDENTIAL_FILE
    ).toBe('C:\\Users\\person\\AppData\\Roaming\\DwarfAI\\run\\mcp\\launch-1.cred')
  })

  it('[C-23] on Windows SystemRoot, ComSpec and PATHEXT are kept and a variable not on the list is dropped', () => {
    const windowsLogin: LoginEnvironment = {
      Path: 'C:\\Windows\\system32;C:\\Program Files\\nodejs',
      USERPROFILE: 'C:\\Users\\person',
      APPDATA: 'C:\\Users\\person\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local',
      TEMP: 'C:\\Users\\person\\AppData\\Local\\Temp',
      TMP: 'C:\\Users\\person\\AppData\\Local\\Temp',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.BAT;.CMD'
    }

    const env = build(
      {
        ...windowsLogin,
        USERNAME: 'person',
        COMPUTERNAME: 'DESK',
        ProgramFiles: 'C:\\Program Files'
      },
      { platform: 'win32' }
    )

    expect(env).toEqual({ ...windowsLogin, DWARFAI_SPAWN: SPAWN_TAG })
  })

  it('[C-23] on Windows a listed variable is matched whatever its case, and its login spelling is kept', () => {
    const env = build(
      { SYSTEMROOT: 'C:\\Windows', comspec: 'C:\\Windows\\system32\\cmd.exe' },
      { platform: 'win32' }
    )

    expect(env).toEqual({
      SYSTEMROOT: 'C:\\Windows',
      comspec: 'C:\\Windows\\system32\\cmd.exe',
      DWARFAI_SPAWN: SPAWN_TAG
    })
  })

  it('[C-23] off Windows SystemRoot, ComSpec and PATHEXT are not on the list', () => {
    const env = build({ ...POSIX_LOGIN, SystemRoot: '/x', ComSpec: '/y', PATHEXT: '.EXE' })

    expect(env).not.toHaveProperty('SystemRoot')
    expect(env).not.toHaveProperty('ComSpec')
    expect(env).not.toHaveProperty('PATHEXT')
  })

  it('[C-23] the provider’s documented variables are copied when the person set them and absent otherwise', () => {
    const env = build(
      { ...POSIX_LOGIN, PROVIDER_CONFIG_DIR: '/home/person/.provider' },
      { providerVars: ['PROVIDER_CONFIG_DIR', 'PROVIDER_LOG_LEVEL'] }
    )

    expect(env.PROVIDER_CONFIG_DIR).toBe('/home/person/.provider')
    expect(env).not.toHaveProperty('PROVIDER_LOG_LEVEL')
  })

  it('[C-23, INV-59] a provider variable list naming a Host-internal or DwarfAI variable is refused, so data never reopens the allowlist', () => {
    for (const name of [
      'ELECTRON_RUN_AS_NODE',
      'NODE_OPTIONS',
      'DWARFAI_DELEGATION_TOKEN',
      'DWARFAI_SPAWN',
      'node_options'
    ]) {
      expect(() => build(POSIX_LOGIN, { providerVars: [name] })).toThrow(HostInvariantError)
    }
  })

  it('[C-23] a spawn tag that is not v1:<installId>:<launchId>:<hostEpoch> is refused', () => {
    for (const tag of ['', 'v2:a:b:c', 'v1:a:b', 'v1:a:b:c:d']) {
      expect(() =>
        childEnv(POSIX_LOGIN, tag, { providerVars: [], loopbackRelay: false, platform: 'linux' })
      ).toThrow(HostInvariantError)
    }
  })
})
