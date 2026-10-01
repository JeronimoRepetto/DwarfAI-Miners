import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NATIVE_MODULES, buildSteps } from './build-win-pipe.mjs'

// L1: the commands that build the Host's owner-only pipe helper. The built binary itself is checked
// in the Windows OS lane (nativeOwnerOnlyPipe.os.test.ts: no VC++ runtime import).

const options = {
  headersDir: path.join('h', 'include'),
  defFile: path.join('h', 'def', 'node_api.def'),
  workDir: 'w',
  outFile: path.join('prebuilds', 'win32-x64', 'dwarfai_win_pipe.node')
}

describe('build-win-pipe', () => {
  it('[ADR-003] the helper links the static C runtime and no VC++ redistributable', () => {
    const [, compile] = buildSteps({ arch: 'x64', ...options })

    expect(compile?.args).toContain('/MT')
    expect(compile?.args.some((arg) => /^\/MDd?$/.test(arg))).toBe(false)
  })

  it('[ADR-003] the import library names node.exe and the link delays it, so the binary also loads in Electron', () => {
    const [lib, , link] = buildSteps({ arch: 'x64', ...options })

    expect(lib?.args).toContain(`/def:${options.defFile}`)
    expect(link?.args).toContain('/DELAYLOAD:node.exe')
    expect(link?.args).toContain('delayimp.lib')
  })

  it('[ADR-003] x64 and arm64 build for their own machine type', () => {
    const x64 = buildSteps({ arch: 'x64', ...options })
    const arm64 = buildSteps({ arch: 'arm64', ...options })

    expect(x64[0]?.args).toContain('/machine:X64')
    expect(x64[2]?.args).toContain('/MACHINE:X64')
    expect(arm64[0]?.args).toContain('/machine:ARM64')
    expect(arm64[2]?.args).toContain('/MACHINE:ARM64')
    // CET shadow stacks exist on x64 only.
    expect(x64[2]?.args).toContain('/CETCOMPAT')
    expect(arm64[2]?.args).not.toContain('/CETCOMPAT')
    expect(() => buildSteps({ arch: 'ia32', ...options })).toThrow('unsupported architecture: ia32')
  })

  // ADDED (fix: Windows Host launch timeout): the UI's launch helper is the second module the
  // script builds, from its own source in the UI tree, into its own binary, with the same runtime
  // and hardening, linking only kernel32.
  it('[ADR-002] the UI launch helper is built from its own source into its own binary, with the static C runtime and the delayed node.exe', () => {
    expect(NATIVE_MODULES.map((module) => module.binary)).toEqual([
      'dwarfai_win_pipe.node',
      'dwarfai_win_launch.node'
    ])
    const launch = NATIVE_MODULES[1]
    expect(path.relative(process.cwd(), launch.source)).toBe(
      path.join('src', 'ui-main', 'hostLauncher', 'win-launch', 'win_launch.c')
    )
    const [lib, compile, link] = buildSteps({
      arch: 'x64',
      ...options,
      outFile: path.join('prebuilds', 'win32-x64', launch.binary),
      module: launch
    })

    expect(lib?.args).toContain(`/def:${options.defFile}`)
    expect(compile?.args).toContain('/MT')
    expect(compile?.args).toContain(launch.source)
    expect(compile?.args).toContain(`/Fo${path.join('w', 'win_launch.obj')}`)
    expect(link?.args).toContain('/DELAYLOAD:node.exe')
    expect(link?.args).toContain('/GUARD:CF')
    expect(link?.args).toContain(path.join('w', 'win_launch.obj'))
    expect(link?.args).toContain('kernel32.lib')
    expect(link?.args).not.toContain('advapi32.lib')
  })
})
