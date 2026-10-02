// `runInstallResolverContract` (16 §2.8, §4.4): what every `InstallResolver` — the
// `CliInstallResolver` adapter over FakeFs and the `FakeInstallResolver` double — must answer for
// the same machines: the shim resolution table of each OS with an explicit `Platform` (PATH ×
// PATHEXT, npm, pnpm, Volta, bun, Scoop shims, WinGet links, `.cmd` / `.bat` shims to their target),
// a quarantined binary answered as quarantined and never spawned, the login-shell retry only on a miss, the
// AMENDMENT-13 order for `agy`, and nothing ever run through a shell (ADR-009 D5, ADR-029 row 8).
//
// A machine names, for every install, the target the resolver must answer: the fixtures say what
// is true of the machine, each subject lays it out its own way (TC-146-01).
import { describe, expect, it } from 'vitest'
import type { InstallResolver } from '../ports/installResolver'

export type Platform = 'win32' | 'darwin' | 'linux'

/** How a CLI was installed: where its entry point sits and what kind of entry it is. */
export type InstallLayout =
  | 'path' // a program in a PATH directory
  | 'path-link' // POSIX: a PATH entry that links to the program elsewhere
  | 'path-cmd' // Windows: an npm-style `.cmd` shim in a PATH directory, naming a `.js` entry
  | 'path-bat' // Windows: a `.bat` shim in a PATH directory, naming a program
  | 'npm' // the npm global bin
  | 'pnpm' // the pnpm global bin
  | 'volta' // a Volta shim (a program that dispatches on its own name)
  | 'bun' // the bun global bin
  | 'homebrew' // macOS: Homebrew's bin, linking into its Cellar
  | 'scoop' // Windows: a Scoop shim with its `.shim` file
  | 'winget' // Windows: a WinGet link
  | 'local-bin' // `~/.local/bin`
  | 'login-shell' // POSIX: a directory only the login shell's PATH has
  | 'override' // the file the binary's override variable names (`DWARFAI_AGY_PATH`)

export interface MachineInstall {
  binary: string
  layout: InstallLayout
  /** The absolute path the resolver must answer: the shim's target, never the shim. */
  target: string
  /** The first line the CLI prints for `--version`. */
  version: string
  /** The OS quarantined the file (macOS `com.apple.quarantine`). */
  quarantined?: boolean
}

export interface ResolverMachine {
  platform: Platform
  installs: readonly MachineInstall[]
  /** `DWARFAI_AGY_PATH` is set, to a file that does not exist. */
  overrideMissing?: boolean
}

/** One process the subject started, as the recording double saw it. */
export interface SpawnSeen {
  executable: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
}

export interface ResolverUnderTest {
  resolver: InstallResolver
  spawned(): readonly SpawnSeen[]
  loginShellReads(): number
}

export type MakeInstallResolver = (machine: ResolverMachine) => ResolverUnderTest

/** How the resolver found an install (15 §1.2 `resolvedVia`); the override file counts as `path`. */
export function viaOf(layout: InstallLayout): 'path' | 'package-manager-dir' | 'login-shell-path' {
  switch (layout) {
    case 'override':
    case 'path':
    case 'path-link':
    case 'path-cmd':
    case 'path-bat':
      return 'path'
    case 'login-shell':
      return 'login-shell-path'
    default:
      return 'package-manager-dir'
  }
}

/** The answer the resolver owes for an install. */
function answerOf(install: MachineInstall) {
  return { path: install.target, version: install.version, resolvedVia: viaOf(install.layout) }
}

const SHELLISH = /(^|[\\/])(cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe)$/i
const BATCH = /\.(cmd|bat)$/i

/** Nothing a resolver runs to read a CLI goes through cmd.exe or a batch file (ADR-029 row 8). */
function expectNoShellSpawn(spawns: readonly SpawnSeen[]): void {
  for (const spawn of spawns) {
    expect(spawn.executable).not.toMatch(SHELLISH)
    expect(spawn.executable).not.toMatch(BATCH)
    for (const arg of spawn.args) expect(arg).not.toMatch(BATCH)
  }
}

export function runInstallResolverContract(
  name: string,
  make: MakeInstallResolver,
  table: Readonly<Record<Platform, readonly MachineInstall[]>>,
  agy: Readonly<Record<Platform, AgyPlaces>>
): void {
  describe(`InstallResolver contract: ${name}`, () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      describe(platform, () => {
        it('[ADR-009] resolves PATH x PATHEXT, npm, pnpm, Volta, bun, Scoop shims and WinGet links', async () => {
          const installs = table[platform].filter((install) => install.layout !== 'login-shell')
          const subject = make({ platform, installs })
          for (const install of installs) {
            expect(await subject.resolver.resolve([install.binary])).toEqual(answerOf(install))
          }
          expect(await subject.resolver.resolve(['never-installed'])).toBeNull()
          expectNoShellSpawn(subject.spawned())
        })

        it('[ADR-009] agy resolves from DWARFAI_AGY_PATH when set and present, else from the resolver, else from the local bin directory', async () => {
          const places = agy[platform]
          const everywhere = make({
            platform,
            installs: [places.override, places.onPath, places.localBin]
          })
          expect(await everywhere.resolver.resolve(['agy'])).toEqual(answerOf(places.override))

          const missingOverride = make({
            platform,
            installs: [places.onPath, places.localBin],
            overrideMissing: true
          })
          expect(await missingOverride.resolver.resolve(['agy'])).toEqual(answerOf(places.onPath))

          const localOnly = make({ platform, installs: [places.localBin], overrideMissing: true })
          expect(await localOnly.resolver.resolve(['agy'])).toEqual(answerOf(places.localBin))
          // The override variable never reaches a child (15 §4 `childEnv`).
          for (const subject of [everywhere, missingOverride, localOnly]) {
            for (const spawn of subject.spawned()) {
              expect(Object.keys(spawn.env).map((key) => key.toUpperCase())).not.toContain(
                'DWARFAI_AGY_PATH'
              )
            }
          }
        })
      })
    }

    it('[ADR-009] a .cmd or .bat shim resolves to its target and nothing is run through a shell', async () => {
      const shims = table.win32.filter((install) => /cmd|bat|npm|pnpm/.test(install.layout))
      expect(shims.length).toBeGreaterThan(0)
      const subject = make({ platform: 'win32', installs: shims })
      for (const install of shims) {
        const resolved = await subject.resolver.resolve([install.binary])
        expect(resolved?.path).toBe(install.target)
        expect(resolved?.path).not.toMatch(BATCH)
      }
      expectNoShellSpawn(subject.spawned())
    })

    it('[ADR-009] a quarantined binary is reported quarantined and never spawned', async () => {
      const quarantined: MachineInstall = {
        binary: 'mike',
        layout: 'path',
        target: '/opt/tools/bin/mike',
        version: 'mike 1.0.0',
        quarantined: true
      }
      const subject = make({ platform: 'darwin', installs: [quarantined] })

      // Answered as quarantined (16 §4.4 as amended, ISSUE-146); detection treats it as not installed.
      expect(await subject.resolver.resolve(['mike'])).toEqual({
        path: quarantined.target,
        quarantined: true
      })
      // Reading its attributes is allowed; running it, directly or as a script's entry, is not.
      for (const spawn of subject.spawned()) {
        expect(spawn.executable).not.toBe(quarantined.target)
        expect(spawn.args[0]).not.toBe(quarantined.target)
      }
    })

    it('[ADR-009] the login-shell retry runs only when nothing was found', async () => {
      for (const platform of ['darwin', 'linux'] as const) {
        const onPath = table[platform].find((install) => install.layout === 'path')
        const viaShell = table[platform].find((install) => install.layout === 'login-shell')
        if (onPath === undefined || viaShell === undefined) {
          throw new Error(`the ${platform} table needs a path and a login-shell install`)
        }

        const found = make({ platform, installs: [onPath, viaShell] })
        expect(await found.resolver.resolve([onPath.binary])).toEqual(answerOf(onPath))
        expect(found.loginShellReads()).toBe(0)

        expect(await found.resolver.resolve([viaShell.binary])).toEqual(answerOf(viaShell))
        expect(found.loginShellReads()).toBe(1)
      }
    })
  })
}

/** The three places `agy` can be, per OS, for the AMENDMENT-13 order. */
export interface AgyPlaces {
  override: MachineInstall
  onPath: MachineInstall
  localBin: MachineInstall
}
