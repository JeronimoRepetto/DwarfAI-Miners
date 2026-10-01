import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildManifest, parseManifest } from '../../src/ui-main/hostLauncher/hostManifest.ts'

/**
 * scripts/build/write-host-manifest.mjs (ADR-002 D5; lead decision 2026-09-30 in ISSUE-031): after
 * `electron-vite build`, development and test builds get the `host-manifest.json` the Host's
 * versioned copy is checked against, written by the same buildManifest the launcher verifies with.
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const script = path.join(rootDir, 'scripts', 'build', 'write-host-manifest.mjs')
const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('write-host-manifest.mjs', () => {
  it('[ADR-002] writes the manifest of the given source directory to the given file, readable by the launcher', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'dwarfai-031-script-'))
    dirs.push(base)
    const source = path.join(base, 'runtime')
    mkdirSync(path.join(source, 'resources'), { recursive: true })
    writeFileSync(path.join(source, 'electron.exe'), 'runtime bytes')
    writeFileSync(path.join(source, 'resources', 'default_app.asar'), 'asar bytes')
    const out = path.join(base, 'out', 'host-manifest.json')

    execFileSync(process.execPath, [script, '--source', source, '--out', out], {
      cwd: rootDir,
      stdio: 'pipe'
    })

    const parsed = parseManifest(readFileSync(out, 'utf8'))
    expect(parsed).toEqual({ ok: true, value: await buildManifest(source) })
    expect(parsed.value.entries).toHaveLength(2)
  })

  it('[ADR-002] the build script runs it after electron-vite build', () => {
    const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
    expect(pkg.scripts.build).toMatch(
      /^electron-vite build && node scripts\/build\/write-host-manifest\.mjs && /
    )
  })
})
