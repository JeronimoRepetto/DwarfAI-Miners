#!/usr/bin/env node
/**
 * Builds the app's Windows native modules, NATIVE_MODULES, for one Windows architecture:
 * `pnpm build:native [--arch x64|arm64]`.
 *
 * - The Host's owner-only pipe helper (ADR-003 item 2; src/host/platform/endpoint/win-pipe/
 *   win_pipe.c) → `dwarfai_win_pipe.node`, loaded by the Host.
 * - The UI's launch helper (ADR-002 D6 item 1; src/ui-main/hostLauncher/win-launch/win_launch.c)
 *   → `dwarfai_win_launch.node`, loaded by UI main to start the Host with job breakaway.
 *
 * Each tree builds from and loads its own binary (R10: the UI and the Host share no code). Output:
 * `prebuilds/win32-<arch>/<binary>`, which the app ships asar-unpacked (package.json `build`). They
 * are built by CI on Windows and never on a person's machine.
 *
 * - Compiler: MSVC from the newest Visual Studio found by vswhere (it ships with every Visual
 *   Studio installer at a fixed path). An arm64 binary from an x64 machine needs the "MSVC ARM64
 *   build tools" component and is cross-compiled (`vcvarsall x64_arm64`).
 * - Node-API: the C headers and the import-library definition of `node-api-headers` (`--headers`,
 *   `--def` override them). The import library names node.exe; the module answers the delayed load
 *   of node.exe with the running executable, so the same binary loads in node.exe and in Electron.
 * - Static C runtime (`/MT`): the binary imports only Windows system DLLs, never a VC++
 *   redistributable (proved on the built files by nativeOwnerOnlyPipe.os.test.ts and
 *   build-win-pipe.os.test.mjs).
 * - Hardening: `/GS`, Control Flow Guard, ASLR, DEP, and CET shadow stacks on x64.
 *
 * The commands themselves are `buildSteps()`, a pure function with its own test
 * (build-win-pipe.test.mjs).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const SOURCE = path.join(
  repoRoot,
  'src',
  'host',
  'platform',
  'endpoint',
  'win-pipe',
  'win_pipe.c'
)
export const BINARY = 'dwarfai_win_pipe.node'
export const LAUNCH_SOURCE = path.join(
  repoRoot,
  'src',
  'ui-main',
  'hostLauncher',
  'win-launch',
  'win_launch.c'
)

/**
 * Every native module the app ships: its source, its binary, and the Windows import libraries it
 * links, which are exactly the system DLLs the built binary may import (build-win-pipe.os.test.mjs).
 *
 * @type {ReadonlyArray<{ source: string, binary: string, libs: string[] }>}
 */
export const NATIVE_MODULES = [
  { source: SOURCE, binary: BINARY, libs: ['advapi32.lib', 'kernel32.lib'] },
  {
    source: LAUNCH_SOURCE,
    binary: 'dwarfai_win_launch.node',
    libs: ['kernel32.lib', 'ole32.lib', 'oleaut32.lib']
  }
]
/** The Node-API version the module is written against (thread-safe functions need 4). */
export const NAPI_VERSION = 8

/** `vcvarsall.bat` argument and linker machine per target, for an x64 or arm64 build machine. */
const TARGETS = {
  x64: { machine: 'X64', vcvars: { x64: 'x64', arm64: 'arm64_x64' } },
  arm64: { machine: 'ARM64', vcvars: { x64: 'x64_arm64', arm64: 'arm64' } }
}

/**
 * The commands that build the module, in order, for `cmd.exe` after vcvarsall.
 *
 * @param {{ arch: 'x64' | 'arm64', headersDir: string, defFile: string, workDir: string, outFile: string, module?: { source: string, libs: string[] } }} options
 * @returns {{ file: string, args: string[] }[]}
 */
export function buildSteps({
  arch,
  headersDir,
  defFile,
  workDir,
  outFile,
  module = NATIVE_MODULES[0]
}) {
  const target = TARGETS[arch]
  if (target === undefined) throw new Error(`unsupported architecture: ${arch}`)
  const importLib = path.join(workDir, 'node_api.lib')
  const source = module.source
  const object = path.join(workDir, `${path.basename(source, '.c')}.obj`)
  return [
    {
      file: 'lib',
      args: ['/nologo', `/def:${defFile}`, `/machine:${target.machine}`, `/out:${importLib}`]
    },
    {
      file: 'cl',
      args: [
        '/nologo',
        '/c',
        '/O2',
        '/MT',
        '/W4',
        '/WX',
        '/GS',
        '/guard:cf',
        '/utf-8',
        `/DNAPI_VERSION=${NAPI_VERSION}`,
        `/I${headersDir}`,
        `/Fo${object}`,
        source
      ]
    },
    {
      file: 'link',
      args: [
        '/nologo',
        '/DLL',
        // The module exports nothing another binary links against: no import library or .exp.
        '/NOIMPLIB',
        '/NOEXP',
        `/OUT:${outFile}`,
        `/MACHINE:${target.machine}`,
        '/DYNAMICBASE',
        '/NXCOMPAT',
        '/GUARD:CF',
        ...(arch === 'x64' ? ['/CETCOMPAT'] : []),
        '/DELAYLOAD:node.exe',
        object,
        importLib,
        'delayimp.lib',
        ...module.libs
      ]
    }
  ]
}

/** vswhere ships with every Visual Studio installer at this fixed path. */
function vswherePath() {
  const programFiles = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  return path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
}

/** The newest Visual Studio installation with the C++ tools for `arch`, or null. */
function findVcvarsall(arch) {
  const vswhere = vswherePath()
  if (!existsSync(vswhere)) return null
  const component =
    arch === 'arm64'
      ? 'Microsoft.VisualStudio.Component.VC.Tools.ARM64'
      : 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
  const found = spawnSync(
    vswhere,
    ['-latest', '-products', '*', '-requires', component, '-property', 'installationPath'],
    { encoding: 'utf8' }
  )
  const installation = found.stdout?.trim().split(/\r?\n/)[0]
  if (!installation) return null
  const vcvarsall = path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat')
  return existsSync(vcvarsall) ? vcvarsall : null
}

const quote = (value) => (/[\s&()^]/.test(value) ? `"${value}"` : value)

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!['--arch', '--headers', '--def', '--out'].includes(key) || value === undefined) {
      throw new Error(
        `usage: build-win-pipe.mjs [--arch x64|arm64] [--headers <dir>] [--def <file>] [--out <dir>]`
      )
    }
    options[key.slice(2)] = value
    index += 1
  }
  return options
}

function main() {
  if (process.platform !== 'win32') {
    console.log('build-win-pipe: the native modules are Windows only; nothing to build here.')
    return 0
  }
  const options = parseArgs(process.argv.slice(2))
  const arch = options.arch ?? process.arch
  const headersPackage = path.join(repoRoot, 'node_modules', 'node-api-headers')
  const headersDir = path.resolve(options.headers ?? path.join(headersPackage, 'include'))
  const defFile = path.resolve(options.def ?? path.join(headersPackage, 'def', 'node_api.def'))
  const outDir = path.resolve(options.out ?? path.join(repoRoot, 'prebuilds'), `win32-${arch}`)
  for (const [what, where] of [
    ['Node-API headers', path.join(headersDir, 'node_api.h')],
    ['Node-API import definition', defFile]
  ]) {
    if (!existsSync(where)) {
      console.error(`build-win-pipe: ${what} not found at ${where}`)
      return 1
    }
  }
  const host = process.arch === 'arm64' ? 'arm64' : 'x64'
  const vcvarsArg = TARGETS[arch]?.vcvars[host]
  if (vcvarsArg === undefined) {
    console.error(`build-win-pipe: unsupported architecture ${arch}`)
    return 1
  }
  const vcvarsall = findVcvarsall(arch)
  if (vcvarsall === null) {
    console.error(`build-win-pipe: no Visual Studio with the MSVC ${arch} build tools was found`)
    return 1
  }
  mkdirSync(outDir, { recursive: true })
  const workDir = mkdtempSync(path.join(tmpdir(), 'dwarfai-win-pipe-'))
  try {
    const outFiles = NATIVE_MODULES.map((module) => path.join(outDir, module.binary))
    const steps = NATIVE_MODULES.flatMap((module, index) =>
      buildSteps({ arch, headersDir, defFile, workDir, outFile: outFiles[index], module })
    )
    const script = [
      `call ${quote(vcvarsall)} ${vcvarsArg} >nul`,
      ...steps.map(({ file, args }) => [file, ...args.map(quote)].join(' '))
    ].join(' && ')
    // cmd.exe runs vcvarsall and the tools in one environment; no shell option is used.
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${script}"`], {
      stdio: 'inherit',
      windowsVerbatimArguments: true,
      // vcvarsall looks for vswhere on PATH as well.
      env: { ...process.env, PATH: `${path.dirname(vswherePath())};${process.env.PATH ?? ''}` }
    })
    if (result.status !== 0) {
      console.error(`build-win-pipe: the build failed (exit ${result.status})`)
      return 1
    }
    for (const outFile of outFiles) {
      console.log(`build-win-pipe: ${path.relative(repoRoot, outFile)}`)
    }
    return 0
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
