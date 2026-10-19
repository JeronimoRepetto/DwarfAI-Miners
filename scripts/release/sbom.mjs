#!/usr/bin/env node
// One SBOM per artifact (20 §2.4 "SBOM", §3.2 `sbom-<os>.json`; 18 C-36; ISSUE-272).
//
//   pnpm sbom --sbom-format cyclonedx --prod --sbom-type application > <file>
//   node scripts/release/sbom.mjs --input <file> [--root <dir>] [--out <dir>]
//
// The generator is pnpm's own `pnpm sbom` (CycloneDX 1.7; OI-20-3): it reads the lockfile and the installed packages,
// adds no dependency and fetches nothing. CI's `pnpm/setup` asks for `version: 11`, so the minor version floats (11.28.6
// on the main line on 2026-10-16, 11.1.1 on the maintainer's machine), and the two differ on optional peers.
//
// This script checks the document against the lockfile's production packages, then writes <out>/sbom-<os>.json
// (default release/licenses/) for each artifact OS with only the components that OS's artifact installs, by the `os`,
// `cpu` and `libc` fields the lockfile records. Two differences are legitimate and are printed, never hidden:
// - a production package missing from the document that no artifact ships: an optional platform binary pnpm did not
//   install on this runner (a musl binary on a glibc runner), the same rule the licence report applies;
// - a package in the document that is only an optional peer of a production package (vue's `typescript`, resolved only
//   because the root has it as a dev dependency): no artifact ships it, so no OS SBOM keeps it.
// Any other difference fails, and so does a missing package an artifact ships. Exits 1 on a failure.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ARTIFACT_OSES,
  ARTIFACT_PLATFORMS,
  DEFAULT_OUT,
  installsOn,
  parseArgs,
  parseLockfile,
  productionPackages,
  shippedByAnArtifact
} from './licenses.mjs'

// The artifact platforms live with the licence report, which needs them too; they are re-exported here.
export { ARTIFACT_OSES, ARTIFACT_PLATFORMS, installsOn }

const fullName = (component) =>
  component.group ? `${component.group}/${component.name}` : component.name

/** The SBOM of one artifact OS: a copy of the whole document with the components that OS does not install removed. */
export function sbomForArtifact(bom, lock, os) {
  const platform = ARTIFACT_PLATFORMS[os]
  if (!platform) throw new Error(`unknown artifact OS "${os}"`)
  const production = new Set(productionPackages(lock).map((p) => `${p.name}@${p.version}`))
  const components = bom.components.filter((c) => {
    const key = `${fullName(c)}@${c.version}`
    return production.has(key) && installsOn(lock.packages[key], platform)
  })
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

/** The document compared with the lockfile: `problems` fail the job, `differences` are legitimate and printed. */
function compare(bom, lock) {
  if (bom?.bomFormat !== 'CycloneDX' || !Array.isArray(bom.components)) {
    return { problems: ['the SBOM is not a CycloneDX document with components'], differences: [] }
  }
  const listed = new Set(bom.components.map((c) => `${fullName(c)}@${c.version}`))
  const expected = new Set(productionPackages(lock).map((p) => `${p.name}@${p.version}`))
  const withPeers = new Set(
    productionPackages(lock, { optionalPeers: true }).map((p) => `${p.name}@${p.version}`)
  )
  const problems = []
  const differences = []
  for (const key of [...expected].filter((k) => !listed.has(k))) {
    if (shippedByAnArtifact(lock.packages[key])) {
      problems.push(`the SBOM is missing ${key}, a production package of the lockfile`)
    } else {
      differences.push(
        `${key}: not in the SBOM and not shipped by any artifact (not installed on this runner)`
      )
    }
  }
  for (const key of [...listed].filter((k) => !expected.has(k))) {
    if (withPeers.has(key)) {
      differences.push(
        `${key}: in the SBOM, but only an optional peer of a production package, so no artifact ships it`
      )
    } else {
      problems.push(`the SBOM lists ${key}, which is not a production package of the lockfile`)
    }
  }
  return { problems, differences }
}

/** The problems that make an SBOM unusable: not CycloneDX, or not the lockfile's production packages. */
export function checkSbomMatchesLockfile(bom, lock) {
  return compare(bom, lock).problems
}

/** The legitimate differences between the document and the lockfile's production packages, one line each. */
export function sbomDifferences(bom, lock) {
  return compare(bom, lock).differences
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.input)
    throw new Error('usage: sbom.mjs --input <pnpm sbom output> [--root <dir>] [--out <dir>]')
  const rootDir = path.resolve(args.root ?? '.')
  const out = path.resolve(rootDir, args.out ?? DEFAULT_OUT)
  const bom = JSON.parse(readFileSync(path.resolve(args.input), 'utf8'))
  const lock = parseLockfile(readFileSync(path.join(rootDir, 'pnpm-lock.yaml'), 'utf8'))
  const { problems, differences } = compare(bom, lock)
  for (const difference of differences) console.log(`listed: ${difference}`)
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
