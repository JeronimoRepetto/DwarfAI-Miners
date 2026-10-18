#!/usr/bin/env node
// Extracts every release artifact of a folder with the OS's own tools, so the spike harnesses read and run what each
// artifact ships, not only electron-builder's unpacked folders (packaging spike lane, ISSUE-328).
//
//   node spikes/_packaged/extract.mjs <artifact dir> <out dir> [--evidence <dir>]
//
// Windows: the zip with `tar` (bsdtar), the nsis installer with 7-Zip (its `$PLUGINSDIR/app-64.7z` payload). macOS:
// the zip with `ditto`, the dmg mounted read-only with `hdiutil`. Linux: the AppImage with `--appimage-extract`, the
// deb with `dpkg-deb -x`. Each artifact lands in `<out>/<artifact file name>/`. Nothing is installed or run except
// the AppImage's own extractor.
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { environmentFacts, options, PLATFORM, writeEvidence } from './kit.mjs'

const run = (file, args, cwd) =>
  execFileSync(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return full
    if (entry.isDirectory()) {
      const found = findFile(full, name)
      if (found) return found
    }
  }
  return null
}

function extractOne(artifact, target) {
  const name = path.basename(artifact)
  mkdirSync(target, { recursive: true })
  if (name.endsWith('.zip')) {
    if (PLATFORM === 'darwin') run('ditto', ['-x', '-k', artifact, target])
    else run('tar', ['-xf', artifact, '-C', target])
    return 'zip'
  }
  if (name.endsWith('.exe') && PLATFORM === 'win32') {
    const outer = mkdtempSync(path.join(tmpdir(), 'dwarfai-nsis-'))
    try {
      run('7z', ['x', '-y', `-o${outer}`, artifact])
      const payload = findFile(outer, 'app-64.7z')
      if (!payload) throw new Error('no app-64.7z payload in the installer')
      run('7z', ['x', '-y', `-o${target}`, payload])
    } finally {
      rmSync(outer, { recursive: true, force: true })
    }
    return 'nsis'
  }
  if (name.endsWith('.dmg') && PLATFORM === 'darwin') {
    const mount = mkdtempSync(path.join(tmpdir(), 'dwarfai-dmg-'))
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, artifact])
    try {
      for (const entry of readdirSync(mount)) {
        if (entry.endsWith('.app')) {
          cpSync(path.join(mount, entry), path.join(target, entry), {
            recursive: true,
            verbatimSymlinks: true
          })
        }
      }
    } finally {
      run('hdiutil', ['detach', mount, '-force'])
    }
    return 'dmg'
  }
  if (name.endsWith('.AppImage') && PLATFORM === 'linux') {
    chmodSync(artifact, 0o755)
    run(path.resolve(artifact), ['--appimage-extract'], target)
    return 'AppImage'
  }
  if (name.endsWith('.deb') && PLATFORM === 'linux') {
    run('dpkg-deb', ['-x', artifact, target])
    return 'deb'
  }
  return null
}

function main() {
  const args = options(process.argv.slice(2))
  const [artifactDir, outDir] = args._
  if (!artifactDir || !outDir) {
    console.error('usage: extract.mjs <artifact dir> <out dir> [--evidence <dir>]')
    return 2
  }
  const results = []
  for (const entry of readdirSync(artifactDir).sort()) {
    const artifact = path.resolve(artifactDir, entry)
    const target = path.resolve(outDir, entry)
    if (!/\.(zip|exe|dmg|AppImage|deb)$/.test(entry) || /^Uninstall/i.test(entry)) continue
    try {
      const kind = extractOne(artifact, target)
      if (kind === null) continue
      results.push({ artifact: entry, kind, ok: existsSync(target) })
      console.log(`extracted ${entry} (${kind})`)
    } catch (error) {
      results.push({ artifact: entry, ok: false, error: String(error?.stderr ?? error?.message) })
      console.error(`could not extract ${entry}: ${error?.message}`)
    }
  }
  if (args.evidence) {
    writeEvidence(args.evidence, 'extract', { environment: environmentFacts(), results })
  }
  return results.length > 0 && results.every((result) => result.ok) ? 0 : 1
}

process.exitCode = main()
