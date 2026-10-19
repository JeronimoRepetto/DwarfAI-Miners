// Lays a `ResolverMachine` out for the real `CliInstallResolver`: files in a FakeFs, links in a
// realpath table, the Host's environment, and a StubCliProcessControl whose scripted programs
// answer `--version`, the login shell's PATH read and macOS `xattr`. The OS is an explicit
// `Platform`, so every OS's table runs on every host (skills/platform-ports).
import { posix, win32 } from 'node:path'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeFs } from '../../../kernel/fakes/FakeFs'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { CliInstallResolver, LOGIN_SHELL_PATH_MARK } from '../adapters/install/CliInstallResolver'
import type {
  MachineInstall,
  Platform,
  ResolverMachine,
  ResolverUnderTest
} from './installResolver.contract'
import {
  FIXTURE_AGY_OVERRIDE,
  FIXTURE_HOME,
  FIXTURE_LOGIN_SHELL_DIR,
  FIXTURE_PATH
} from './installResolver.fixtures'
import { StubCliProcessControl } from './StubCliProcessControl'

export const FIXTURE_SHELL = '/bin/zsh'
export const FIXTURE_NODE = 'C:\\Program Files\\nodejs\\node.exe'

export interface LaidMachine extends ResolverUnderTest {
  fs: FakeFs
  clock: FakeClock
  control: StubCliProcessControl
  links: Map<string, string>
  env: Record<string, string>
  home: string
}

/** An npm cmd-shim: runs the `.js` entry with the node.exe beside it, else `node` from PATH. */
function npmShim(entryFromShimDir: string): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entryFromShimDir}" %*`
  ].join('\r\n')
}

/** A pnpm cmd-shim: the same two branches, `%~dp0` spelled its own way. */
function pnpmShim(entryFromShimDir: string): string {
  return [
    '@SETLOCAL',
    '@IF NOT DEFINED NODE_PATH (',
    '  @SET "NODE_PATH=%~dp0\\global\\5\\node_modules"',
    ')',
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${entryFromShimDir}" %*`,
    ') ELSE (',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    `  node  "%~dp0\\${entryFromShimDir}" %*`,
    ')'
  ].join('\r\n')
}

/** A batch file that starts a program next to it. */
function batShim(programFromShimDir: string): string {
  return `@echo off\r\n"%~dp0\\${programFromShimDir}" %*\r\n`
}

export function layMachine(machine: ResolverMachine): LaidMachine {
  const { platform } = machine
  const win = platform === 'win32'
  const path = win ? win32 : posix
  const home = FIXTURE_HOME[platform]
  const fs = new FakeFs()
  const links = new Map<string, string>()
  const control = new StubCliProcessControl()
  const appData = `${home}\\AppData\\Roaming`
  const localAppData = `${home}\\AppData\\Local`
  const env: Record<string, string> = win
    ? {
        Path: FIXTURE_PATH.win32,
        PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS',
        USERPROFILE: home,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        SystemRoot: 'C:\\Windows',
        SECRET_TOKEN: 'never-forwarded'
      }
    : {
        PATH: FIXTURE_PATH[platform],
        HOME: home,
        SHELL: FIXTURE_SHELL,
        SECRET_TOKEN: 'never-forwarded'
      }
  if (win) fs.addFile(FIXTURE_NODE, 'node', 1)

  const file = (at: string): void => fs.addFile(at, 'program', 1)
  const link = (from: string, to: string): void => {
    fs.addFile(from, 'link', 1)
    links.set(from, to)
  }
  const shimIn = (dir: string, name: string, text: string): void => {
    fs.addFile(path.join(dir, name), text, 1)
  }
  const rel = (fromDir: string, to: string): string => win32.relative(fromDir, to)

  for (const install of machine.installs) {
    const { binary, target } = install
    const exe = win ? `${binary}.exe` : binary
    switch (install.layout) {
      case 'path':
      case 'local-bin':
      case 'login-shell':
      case 'override':
        file(target)
        break
      case 'path-link':
        file(target)
        link(path.join('/opt/tools/bin', binary), target)
        break
      case 'path-cmd':
        file(target)
        shimIn('C:\\Tools\\bin', `${binary}.cmd`, npmShim(rel('C:\\Tools\\bin', target)))
        break
      case 'path-bat':
        file(target)
        shimIn('C:\\Tools\\bin', `${binary}.bat`, batShim(rel('C:\\Tools\\bin', target)))
        break
      case 'npm': {
        file(target)
        if (win) {
          const dir = `${appData}\\npm`
          shimIn(dir, `${binary}.cmd`, npmShim(rel(dir, target)))
        } else link(path.join(home, '.npm-global', 'bin', binary), target)
        break
      }
      case 'pnpm': {
        file(target)
        if (win) {
          const dir = `${localAppData}\\pnpm`
          shimIn(dir, `${binary}.cmd`, pnpmShim(rel(dir, target)))
        }
        break
      }
      case 'volta':
        if (win) file(target)
        else {
          file(path.join(home, '.volta', 'bin', 'volta-shim'))
          link(target, path.join(home, '.volta', 'bin', 'volta-shim'))
        }
        break
      case 'bun':
        file(target)
        if (!win) link(path.join(home, '.bun', 'bin', binary), target)
        break
      case 'homebrew':
        file(target)
        link(path.join('/opt/homebrew/bin', binary), target)
        break
      case 'scoop': {
        file(target)
        const shims = `${home}\\scoop\\shims`
        file(path.join(shims, exe))
        shimIn(shims, `${binary}.shim`, `path = "${target}"\r\nargs = \r\n`)
        break
      }
      case 'winget':
        file(target)
        link(`${localAppData}\\Microsoft\\WinGet\\Links\\${exe}`, target)
        break
    }
  }
  if (machine.installs.some((install) => install.layout === 'override')) {
    env['DWARFAI_AGY_PATH'] = FIXTURE_AGY_OVERRIDE[platform]
  } else if (machine.overrideMissing === true) {
    env['DWARFAI_AGY_PATH'] = win ? 'D:\\Gone\\agy.exe' : '/opt/gone/agy'
  }

  const byProgram = new Map<string, MachineInstall>()
  for (const install of machine.installs) byProgram.set(install.target, install)
  const quarantined = machine.installs.filter((install) => install.quarantined === true)

  // `--version` of each install: the program run, or the `.js` entry node runs.
  control.script((spec) => {
    if (spec.args.at(-1) !== '--version') return undefined
    const program = spec.args.length === 2 ? spec.args[0] : spec.executable
    const install = program === undefined ? undefined : byProgram.get(program)
    return install === undefined ? undefined : { stdout: `${install.version}\n` }
  })
  // The login shell prints its PATH between marks, after whatever its profile printed.
  control.script((spec) => {
    if (spec.executable !== FIXTURE_SHELL) return undefined
    const loginDir = platform === 'win32' ? '' : FIXTURE_LOGIN_SHELL_DIR[platform]
    const value = `${FIXTURE_PATH[platform]}:${loginDir}`
    return { stdout: `Welcome!\n${LOGIN_SHELL_PATH_MARK}${value}${LOGIN_SHELL_PATH_MARK}\n` }
  })
  // macOS `xattr -p com.apple.quarantine <file>`: exit 0 and the value when the file carries it.
  control.script((spec) => {
    if (spec.executable !== '/usr/bin/xattr') return undefined
    const file = spec.args.at(-1)
    return quarantined.some((install) => install.target === file)
      ? { stdout: '0083;00000000;Safari;\n', code: 0 }
      : { stdout: '', code: 1 }
  })

  const clock = new FakeClock()
  const resolver = new CliInstallResolver({
    platform,
    env,
    home,
    fs,
    realpath: (at) => Promise.resolve(realpathIn(fs, links, at)),
    processControl: control,
    scheduler: new FakeScheduler(clock)
  })

  return {
    resolver,
    fs,
    clock,
    control,
    links,
    env,
    home,
    spawned: () =>
      control.spawns.map((spawn) => ({
        executable: spawn.executable,
        args: spawn.args,
        env: spawn.env
      })),
    loginShellReads: () =>
      control.spawns.filter((spawn) => spawn.executable === FIXTURE_SHELL).length
  }
}

/** Follows the link table to the end, the way the OS realpath would; null when nothing is there. */
function realpathIn(fs: FakeFs, links: ReadonlyMap<string, string>, at: string): string | null {
  let current = at
  for (let hops = 0; hops < 40; hops += 1) {
    const next = links.get(current)
    if (next === undefined) break
    current = next
  }
  return fs.headNow(current, 1) !== null ? current : null
}

/** The platforms every table covers. */
export const PLATFORMS: readonly Platform[] = ['win32', 'darwin', 'linux']
