// layer: L7
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The one reviewed electron-builder configuration (`20` §3.2, ADR-027 items 1–2; ISSUE-268). It is the `build` key
 * of package.json, which `pnpm package` runs on each OS's own runner: electron-builder cannot cross-build a dmg or a
 * deb, so every OS builds exactly the targets of its own key and nothing is named on the command line.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const config = pkg.build

/** The targets of one OS key as `{ target, arch }` pairs, the shapes electron-builder accepts. */
function targetsOf(os) {
  return [config[os].target]
    .flat()
    .map((entry) =>
      typeof entry === 'string'
        ? { target: entry, arch: undefined }
        : { target: entry.target, arch: entry.arch === undefined ? undefined : [entry.arch].flat() }
    )
}

/** The artifact name template a target uses: its own key's, else its OS key's, else the top-level one. */
function artifactNameOf(os, target) {
  return config[target]?.artifactName ?? config[os].artifactName ?? config.artifactName
}

/** A template expanded the way electron-builder 26 expands it (`${arch}` per builder-util getArtifactArchName). */
function expand(template, { arch, ext }) {
  const archName =
    arch === 'x64' && ext === 'AppImage'
      ? 'x86_64'
      : arch === 'x64' && ext === 'deb'
        ? 'amd64'
        : arch
  // No template at any level leaves electron-builder's own default, which no 20 §3.2 name uses.
  return (template ?? '<electron-builder default>')
    .replaceAll('${productName}', config.productName)
    .replaceAll('${version}', '0.20.0')
    .replaceAll('${arch}', archName)
    .replaceAll('${ext}', ext)
}

describe('electron-builder configuration (20 §3.2)', () => {
  it('[ADR-027] Windows builds exactly a zip and a per-user nsis installer, never portable, with no elevation', () => {
    expect(targetsOf('win')).toEqual([
      { target: 'zip', arch: ['x64'] },
      { target: 'nsis', arch: ['x64'] }
    ])
    expect(config.portable, 'no portable configuration is left behind').toBeUndefined()
    expect(config.nsis.oneClick, 'the one-click installer installs for the current user').not.toBe(
      false
    )
    expect(config.nsis.perMachine).toBe(false)
    expect(config.nsis.allowElevation).toBe(false)
    expect(config.nsis.packElevateHelper, 'no elevate.exe ships beside the app').toBe(false)
  })

  it('[ADR-027] macOS builds dmg and zip for arm64 and x64 with the hardened runtime; Linux builds AppImage and deb for x64', () => {
    expect(targetsOf('mac')).toEqual([
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] }
    ])
    expect(config.mac.hardenedRuntime).toBe(true)
    expect(targetsOf('linux')).toEqual([
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] }
    ])
  })

  it('[ADR-027] every artifact name template matches 20 §3.2 and productName is DwarfAI-Miners', () => {
    expect(config.productName).toBe('DwarfAI-Miners')
    expect(pkg.productName).toBe('DwarfAI-Miners')
    const names = {
      win: [
        expand(artifactNameOf('win', 'zip'), { arch: 'x64', ext: 'zip' }),
        expand(artifactNameOf('win', 'nsis'), { arch: 'x64', ext: 'exe' })
      ],
      mac: ['arm64', 'x64'].flatMap((arch) => [
        expand(artifactNameOf('mac', 'dmg'), { arch, ext: 'dmg' }),
        expand(artifactNameOf('mac', 'zip'), { arch, ext: 'zip' })
      ]),
      linux: [
        expand(artifactNameOf('linux', 'AppImage'), { arch: 'x64', ext: 'AppImage' }),
        expand(artifactNameOf('linux', 'deb'), { arch: 'x64', ext: 'deb' })
      ]
    }
    expect(names).toEqual({
      win: ['DwarfAI-Miners-0.20.0-win-x64.zip', 'DwarfAI-Miners-Setup-0.20.0-x64.exe'],
      mac: [
        'DwarfAI-Miners-0.20.0-arm64.dmg',
        'DwarfAI-Miners-0.20.0-arm64.zip',
        'DwarfAI-Miners-0.20.0-x64.dmg',
        'DwarfAI-Miners-0.20.0-x64.zip'
      ],
      // `20` §3.2: the names follow the `0bfd108` templates where they exist, and the Linux one is
      // `${productName}-${version}-${arch}.${ext}` (the deb's x64 arch name is `amd64`).
      linux: ['DwarfAI-Miners-0.20.0-x86_64.AppImage', 'DwarfAI-Miners-0.20.0-amd64.deb']
    })
  })

  it('[ADR-019] the packaged files include the Host entry and exclude tests, fixtures, lint canaries and spike records', () => {
    const included = config.files.filter((pattern) => !pattern.startsWith('!'))
    const excluded = config.files.filter((pattern) => pattern.startsWith('!'))
    // The Host entry `pnpm build` writes (electron.vite.host.config.ts outDir `out/host`, input `main`).
    expect(included).toContain('out/**/*')
    expect(readFileSync(path.join(repoRoot, 'electron.vite.host.config.ts'), 'utf8')).toMatch(
      /outDir: 'out\/host'/
    )
    // Only build output, the native prebuilds and the manifest itself ship: no source tree is listed.
    expect(included).toEqual(['out/**/*', 'prebuilds/**/*', 'package.json'])
    for (const dir of [
      'src',
      'fixtures',
      'lint-canaries',
      'spikes',
      'spike-results',
      'e2e',
      'scripts',
      'docs'
    ]) {
      expect(
        included.some((pattern) => pattern.startsWith(`${dir}/`)),
        `${dir}/ is not packaged`
      ).toBe(false)
    }
    // Build output never carries a test file into the app.
    expect(excluded).toEqual(['!**/*.test.*'])
  })

  it('[ADR-027] the configuration never publishes: no publish provider and `pnpm package` passes --publish never', () => {
    expect(config.publish).toBeNull()
    expect(pkg.scripts.package).toBe('electron-builder --publish never')
    expect(pkg.scripts['test:packaged']).toBe('node scripts/release/packaged/run.mjs')
  })
})
