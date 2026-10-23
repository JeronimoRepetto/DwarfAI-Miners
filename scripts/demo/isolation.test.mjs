import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CATALOG_PROVIDER_CLIS,
  DEMO_PROFILE_PREFIX,
  PROVIDER_CLIS,
  isolatedVariables,
  isolationProblems,
  mineFolderOf,
  pathProblems,
  resolutionProblems,
  resolveCommand
} from './isolation.mjs'
import { CATALOG_PROVIDER_IDS } from '../../src/contracts/catalog/ids.mjs'
import { launchParamsOf, PROVIDER_IDS } from './app.mjs'

const win = path.win32
const root = win.join(
  'C:\\',
  'Users',
  'j',
  'AppData',
  'Local',
  'Temp',
  `${DEMO_PROFILE_PREFIX}a1b2c3`
)
const profile = { root, dataRoot: win.join(root, 'data') }
const realHome = win.join('C:\\', 'Users', 'j')

/** The environment `launchApp` hands the app for this profile (`e2e/_harness/launchApp.ts` appEnv). */
const isolatedEnv = () => ({
  HOME: win.join(root, 'home'),
  USERPROFILE: win.join(root, 'home'),
  APPDATA: win.join(root, 'home', 'AppData', 'Roaming'),
  LOCALAPPDATA: profile.dataRoot,
  XDG_CONFIG_HOME: win.join(root, 'home', '.config'),
  XDG_STATE_HOME: win.join(root, 'home', '.local', 'state'),
  CLAUDE_CONFIG_DIR: win.join(root, 'claude'),
  CODEX_HOME: win.join(root, 'codex'),
  PATH: 'whatever'
})

const options = { platform: 'win32', realHomes: [realHome], pathApi: win }

describe('the demo profile’s isolation', () => {
  it('names every per-user and provider folder the app could read, per OS', () => {
    expect(isolatedVariables('win32')).toEqual([
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'XDG_CONFIG_HOME',
      'XDG_STATE_HOME',
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'LOCALAPPDATA'
    ])
    expect(isolatedVariables('linux')).toContain('XDG_DATA_HOME')
    expect(isolatedVariables('darwin')).not.toContain('LOCALAPPDATA')
  })

  it('accepts an environment whose every per-user and provider folder lies inside the profile', () => {
    expect(isolationProblems(isolatedEnv(), profile, options)).toEqual([])
  })

  it('refuses the real home, a provider folder outside the profile, or a variable left unset, naming each', () => {
    const env = isolatedEnv()
    env.USERPROFILE = realHome
    env.CODEX_HOME = win.join(realHome, '.codex')
    delete env.CLAUDE_CONFIG_DIR
    expect(isolationProblems(env, profile, options)).toEqual([
      `USERPROFILE is ${realHome}, outside the demo profile`,
      `CLAUDE_CONFIG_DIR is not set`,
      `CODEX_HOME is ${win.join(realHome, '.codex')}, outside the demo profile`
    ])
  })

  it('refuses a profile that is not a fresh demo folder, or that holds a real home', () => {
    expect(isolationProblems(isolatedEnv(), { ...profile, root: realHome }, options)).toContain(
      `the profile ${realHome} is not a ${DEMO_PROFILE_PREFIX}* folder`
    )
    const inside = { root: win.join(root), dataRoot: profile.dataRoot }
    expect(
      isolationProblems(isolatedEnv(), inside, { ...options, realHomes: [win.join(root, 'home')] })
    ).toContain(`the profile ${root} holds the real home ${win.join(root, 'home')}`)
  })

  it('refuses a PATH folder outside the profile that holds a provider CLI, and accepts one that holds none', () => {
    const stubs = win.join(root, 'stubs', 'claude')
    const node = win.join('C:\\', 'Program Files', 'nodejs')
    const present = new Set([win.join(node, 'codex-acp.cmd'), win.join(stubs, 'claude.cmd')])
    const exists = (file) => present.has(file)
    const pathValue = [stubs, node].join(';')
    expect(pathProblems(pathValue, profile, { ...options, exists, pathExt: '.EXE;.CMD' })).toEqual([
      `PATH folder ${node} holds a provider CLI (codex-acp.cmd): the demo would find it`
    ])
    present.delete(win.join(node, 'codex-acp.cmd'))
    expect(pathProblems(pathValue, profile, { ...options, exists, pathExt: '.EXE;.CMD' })).toEqual(
      []
    )
  })

  it('puts each mine folder inside the profile, themed names included, and refuses a name that could leave it', () => {
    expect(mineFolderOf(profile, 'ore-ledger', win)).toBe(win.join(root, 'mines', 'ore-ledger'))
    expect(mineFolderOf(profile, 'Heigh-Ho Mine', win)).toBe(
      win.join(root, 'mines', 'Heigh-Ho Mine')
    )
    for (const name of [
      '..',
      '../outside',
      'a/b',
      'a\\b',
      'C:\\x',
      '',
      ' Moria',
      'Moria.',
      'Mo:ria'
    ]) {
      expect(() => mineFolderOf(profile, name, win)).toThrow(`not a demo mine name: ${name}`)
    }
  })
})

describe('the hard guard: every provider CLI the app can find is a demo stub', () => {
  const stubs = win.join(root, 'stubs')
  const realBin = win.join('C:\\', 'Users', 'j', '.local', 'bin')
  const realCodex = win.join('C:\\', 'Users', 'j', 'AppData', 'Local', 'OpenAI', 'Codex', 'bin')
  const node = win.join('C:\\', 'Program Files', 'nodejs')
  const guard = (pathValue, present) =>
    resolutionProblems(pathValue, profile, {
      ...options,
      pathExt: '.EXE;.CMD',
      exists: (file) => present.has(file)
    })
  const stubFiles = [win.join(stubs, 'claude', 'claude.cmd'), win.join(stubs, 'codex', 'codex.cmd')]

  it('resolves a command the way the platform does: the first PATH folder that holds it, by PATHEXT order', () => {
    const present = new Set([win.join(realBin, 'claude.exe'), ...stubFiles])
    const resolve = (pathValue) =>
      resolveCommand('claude', pathValue, {
        ...options,
        pathExt: '.EXE;.CMD',
        exists: (file) => present.has(file)
      })
    expect(resolve([realBin, win.join(stubs, 'claude')].join(';'))).toBe(
      win.join(realBin, 'claude.exe')
    )
    expect(resolve([win.join(stubs, 'claude'), realBin].join(';'))).toBe(
      win.join(stubs, 'claude', 'claude.cmd')
    )
    expect(resolve(node)).toBeNull()
  })

  it('starts when claude and codex resolve to the demo stubs and no other provider CLI resolves', () => {
    const pathValue = [win.join(stubs, 'claude'), win.join(stubs, 'codex'), node].join(';')
    expect(guard(pathValue, new Set(stubFiles))).toEqual([])
  })

  it('refuses a real-looking claude or codex that resolves before the stubs, naming where it resolves', () => {
    const present = new Set([
      win.join(realBin, 'claude.exe'),
      win.join(realCodex, 'codex.exe'),
      ...stubFiles
    ])
    const pathValue = [
      realBin,
      realCodex,
      win.join(stubs, 'claude'),
      win.join(stubs, 'codex')
    ].join(';')
    expect(guard(pathValue, present)).toEqual([
      `claude resolves to ${win.join(realBin, 'claude.exe')}, not to a demo stub`,
      `codex resolves to ${win.join(realCodex, 'codex.exe')}, not to a demo stub`
    ])
  })

  it('refuses any other provider CLI or ACP adapter the app could detect, and a stub that is missing', () => {
    const present = new Set([
      win.join(node, 'opencode.cmd'),
      win.join(node, 'claude-agent-acp.cmd'),
      stubFiles[0]
    ])
    const pathValue = [win.join(stubs, 'claude'), node].join(';')
    expect(guard(pathValue, present)).toEqual([
      `claude-agent-acp resolves to ${win.join(node, 'claude-agent-acp.cmd')}, not to a demo stub`,
      'codex does not resolve to the demo stub',
      `opencode resolves to ${win.join(node, 'opencode.cmd')}, not to a demo stub`
    ])
  })
})

describe('the hard guard covers every worker, delegated or spawned', () => {
  it('names a guarded CLI for every catalog provider a worker or a delegation could run on', () => {
    for (const id of CATALOG_PROVIDER_IDS.filter((p) => p !== 'simulated')) {
      expect(CATALOG_PROVIDER_CLIS[id], id).toBeDefined()
      for (const name of CATALOG_PROVIDER_CLIS[id])
        expect(PROVIDER_CLIS, `${id}: ${name}`).toContain(name)
    }
  })

  it('resolves a worker the Host starts on the same guarded PATH: a real CLI after the stubs is still refused', () => {
    const stubs = win.join(root, 'stubs')
    const realOpencode = win.join('C:\\', 'Users', 'j', 'AppData', 'Roaming', 'npm')
    const present = new Set([
      win.join(stubs, 'claude', 'claude.cmd'),
      win.join(stubs, 'codex', 'codex.cmd'),
      win.join(realOpencode, 'opencode.cmd')
    ])
    const pathValue = [win.join(stubs, 'claude'), win.join(stubs, 'codex'), realOpencode].join(';')
    expect(
      resolutionProblems(pathValue, profile, {
        ...options,
        pathExt: '.EXE;.CMD',
        exists: (file) => present.has(file)
      })
    ).toEqual([
      `opencode resolves to ${win.join(realOpencode, 'opencode.cmd')}, not to a demo stub`
    ])
  })

  it('launches every foreman without "Let Jev choose", so no delegation gate opens and no TypeSafe call is made', () => {
    for (const provider of ['claude', 'codex']) {
      expect(launchParamsOf('mine-1', provider, 'Dig.', 'request-1')).toEqual({
        mineId: 'mine-1',
        way: { kind: 'supplier', providerId: PROVIDER_IDS[provider] },
        prompt: 'Dig.',
        jevOn: false,
        jevAutoAccept: false,
        requestId: 'request-1'
      })
    }
  })
})
