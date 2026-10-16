#!/usr/bin/env node
// One SBOM per artifact (20 §2.4 "SBOM", §3.2 `sbom-<os>.json`; 18 C-36; ISSUE-272).
//
//   pnpm sbom --sbom-format cyclonedx --prod --sbom-type application > <file>
//   node scripts/release/sbom.mjs --input <file> [--root <dir>] [--out <dir>]
//
// The generator is the pinned pnpm's own `pnpm sbom` (pnpm 11.1.1, CycloneDX 1.7; OI-20-3): it reads the lockfile and
// the installed packages, adds no dependency and fetches nothing. Its document covers every production package of the
// lockfile, for every platform the workspace installs (pnpm-workspace.yaml `supportedArchitectures`). This script
// checks that it lists exactly the lockfile's production packages, then writes <out>/sbom-<os>.json (default
// release/licenses/) for each artifact OS with only the components that OS's artifact installs, by the `os`, `cpu` and
// `libc` fields the lockfile records for each package. Exits 1 on a mismatch.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_OUT, parseArgs, parseLockfile, productionPackages } from './licenses.mjs'

/** The artifact OSes (`20` §3.2) and what each one's packages install on: Windows x64, macOS arm64 and x64, Linux x64. */
export const ARTIFACT_PLATFORMS = {
  windows: { os: 'win32', cpu: ['x64'], libc: null },
  macos: { os: 'darwin', cpu: ['arm64', 'x64'], libc: null },
  linux: { os: 'linux', cpu: ['x64'], libc: 'glibc' }
}
export const ARTIFACT_OSES = Object.keys(ARTIFACT_PLATFORMS)

/** Whether a lockfile constraint list (`[x64]`, `['!win32']`) admits a value; no list admits everything. */
function admits(list, value) {
  if (!Array.isArray(list) || list.length === 0 || value === null) return true
  const negated = list.filter((v) => v.startsWith('!')).map((v) => v.slice(1))
  const positive = list.filter((v) => !v.startsWith('!'))
  return !negated.includes(value) && (positive.length === 0 || positive.includes(value))
}

/** Whether a package's lockfile entry installs on one artifact platform. */
export function installsOn(entry, platform) {
  return (
    admits(entry?.os, platform.os) &&
    platform.cpu.some((cpu) => admits(entry?.cpu, cpu)) &&
    admits(entry?.libc, platform.libc)
  )
}

const fullName = (component) =>
  component.group ? `${component.group}/${component.name}` : component.name

/** The SBOM of one artifact OS: a copy of the whole document with the components that OS does not install removed. */
export function sbomForArtifact(bom, lock, os) {
  const platform = ARTIFACT_PLATFORMS[os]
  if (!platform) throw new Error(`unknown artifact OS "${os}"`)
  const components = bom.components.filter((c) =>
    installsOn(lock.packages[`${fullName(c)}@${c.version}`], platform)
  )
  const kept = new Set([
    bom.metadata?.component?.['bom-ref'],
    ...components.map((c) => c['bom-ref'])
  ])
  return {
    ...bom,
    metadata: {
      ...bom.metadata,
      properties: [...(bom.metadata?.properties ?? []), { name: 'dwarfai:artifact-os', value: os }]
    },
    components,
    dependencies: (bom.dependencies ?? [])
      .filter((d) => kept.has(d.ref))
      .map((d) => ({ ...d, dependsOn: (d.dependsOn ?? []).filter((r) => kept.has(r)) }))
  }
}

/** The problems that make an SBOM unusable: not CycloneDX, or not exactly the lockfile's production packages. */
export function checkSbomMatchesLockfile(bom, lock) {
  if (bom?.bomFormat !== 'CycloneDX' || !Array.isArray(bom.components)) {
    return ['the SBOM is not a CycloneDX document with components']
  }
  const listed = new Set(bom.components.map((c) => `${fullName(c)}@${c.version}`))
  const expected = new Set(productionPackages(lock).map((p) => `${p.name}@${p.version}`))
  return [
    ...[...expected]
      .filter((key) => !listed.has(key))
      .map((key) => `the SBOM is missing ${key}, a production package of the lockfile`),
    ...[...listed]
      .filter((key) => !expected.has(key))
      .map((key) => `the SBOM lists ${key}, which is not a production package of the lockfile`)
  ]
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.input)
    throw new Error('usage: sbom.mjs --input <pnpm sbom output> [--root <dir>] [--out <dir>]')
  const rootDir = path.resolve(args.root ?? '.')
  const out = path.resolve(rootDir, args.out ?? DEFAULT_OUT)
  const bom = JSON.parse(readFileSync(path.resolve(args.input), 'utf8'))
  const lock = parseLockfile(readFileSync(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8'))
  const problems = checkSbomMatchesLockfile(bom, lock)
  for (const problem of problems) console.error(`FAIL ${problem}`)
  if (problems.length > 0) {
    process.exitCode = 1
    return
  }
  mkdirSync(out, { recursive: true })
  for (const os of ARTIFACT_OSES) {
    const file = path.join(out, `sbom-${os}.json`)
    const artifact = sbomForArtifact(bom, lock, os)
    writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`)
    console.log(
      `wrote ${file}: ${artifact.components.length} of ${bom.components.length} components`
    )
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
