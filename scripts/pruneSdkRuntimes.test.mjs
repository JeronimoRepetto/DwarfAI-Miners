import { mkdtemp, mkdir, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pruneRuntimeDirs, wantedRuntimePackage } from './pruneSdkRuntimes.mjs'

/**
 * Real filesystem, on purpose: this hook's whole job is deleting directories
 * electron-builder already wrote to disk (see the comment in
 * pruneSdkRuntimes.mjs), so a fake fs would only prove the mock behaves —
 * the same exception CONTRIBUTING.md carves out for adapter tests.
 */

let tmpDirs = []

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tmpDirs = []
})

async function makeTempRoot() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sdk-runtime-prune-'))
  tmpDirs.push(dir)
  return dir
}

/** Builds `<root>/<...segments>/node_modules/@anthropic-ai/<name>/marker.txt` for each name. */
async function seedRuntimePackages(root, nodeModulesRelPath, names) {
  const scopeDir = path.join(root, nodeModulesRelPath, '@anthropic-ai')
  for (const name of names) {
    const pkgDir = path.join(scopeDir, name)
    await mkdir(pkgDir, { recursive: true })
    await writeFile(path.join(pkgDir, 'marker.txt'), name)
  }
  return scopeDir
}

describe('wantedRuntimePackage', () => {
  it('names the exact runtime for a win32 x64 build', () => {
    expect(wantedRuntimePackage('win32', 1)).toBe('@anthropic-ai/claude-agent-sdk-win32-x64')
  })

  it('names the exact runtime for a darwin arm64 build', () => {
    expect(wantedRuntimePackage('darwin', 3)).toBe('@anthropic-ai/claude-agent-sdk-darwin-arm64')
  })

  it('names the exact runtime for a darwin x64 build', () => {
    expect(wantedRuntimePackage('darwin', 1)).toBe('@anthropic-ai/claude-agent-sdk-darwin-x64')
  })

  it('names the exact runtime for a linux x64 build', () => {
    expect(wantedRuntimePackage('linux', 1)).toBe('@anthropic-ai/claude-agent-sdk-linux-x64')
  })

  it('refuses to guess for an arch this project never builds (ia32)', () => {
    expect(wantedRuntimePackage('win32', 0)).toBeNull()
  })

  it('refuses to guess for a universal build', () => {
    expect(wantedRuntimePackage('darwin', 4)).toBeNull()
  })
})

describe('pruneRuntimeDirs', () => {
  it('keeps only the wanted platform runtime and removes the rest', async () => {
    const root = await makeTempRoot()
    const scopeDir = await seedRuntimePackages(root, 'resources/app.asar.unpacked/node_modules', [
      'claude-agent-sdk-darwin-arm64',
      'claude-agent-sdk-darwin-x64',
      'claude-agent-sdk-linux-x64',
      'claude-agent-sdk-win32-x64'
    ])

    const removed = await pruneRuntimeDirs(root, '@anthropic-ai/claude-agent-sdk-win32-x64')

    const remaining = (await readdir(scopeDir)).sort()
    expect(remaining).toEqual(['claude-agent-sdk-win32-x64'])
    expect(removed.sort()).toEqual([
      'claude-agent-sdk-darwin-arm64',
      'claude-agent-sdk-darwin-x64',
      'claude-agent-sdk-linux-x64'
    ])
  })

  it('never touches a directory that is not one of the per-platform runtimes', async () => {
    const root = await makeTempRoot()
    const scopeDir = path.join(root, 'resources/app.asar.unpacked/node_modules', '@anthropic-ai')
    await mkdir(path.join(scopeDir, 'claude-agent-sdk'), { recursive: true }) // the platform-agnostic wrapper
    await mkdir(path.join(scopeDir, 'sdk'), { recursive: true }) // unrelated @anthropic-ai/sdk
    await mkdir(path.join(scopeDir, 'claude-agent-sdk-win32-x64'), { recursive: true })

    await pruneRuntimeDirs(root, '@anthropic-ai/claude-agent-sdk-win32-x64')

    expect((await readdir(scopeDir)).sort()).toEqual([
      'claude-agent-sdk',
      'claude-agent-sdk-win32-x64',
      'sdk'
    ])
  })

  it('prunes every node_modules/@anthropic-ai it finds, not just the first', async () => {
    // A defensive case: if a target ever nests a second copy (e.g. a helper
    // app's own node_modules), both copies get pruned to the same runtime.
    const root = await makeTempRoot()
    const scopeA = await seedRuntimePackages(root, 'resources/app.asar.unpacked/node_modules', [
      'claude-agent-sdk-darwin-arm64',
      'claude-agent-sdk-win32-x64'
    ])
    const scopeB = await seedRuntimePackages(
      root,
      'resources/app.asar.unpacked/node_modules/some-nested-app/node_modules',
      ['claude-agent-sdk-darwin-arm64', 'claude-agent-sdk-win32-x64']
    )

    await pruneRuntimeDirs(root, '@anthropic-ai/claude-agent-sdk-win32-x64')

    expect(await readdir(scopeA)).toEqual(['claude-agent-sdk-win32-x64'])
    expect(await readdir(scopeB)).toEqual(['claude-agent-sdk-win32-x64'])
  })

  it('is a no-op when the wanted runtime is the only one present', async () => {
    const root = await makeTempRoot()
    const scopeDir = await seedRuntimePackages(root, 'resources/app.asar.unpacked/node_modules', [
      'claude-agent-sdk-win32-x64'
    ])

    const removed = await pruneRuntimeDirs(root, '@anthropic-ai/claude-agent-sdk-win32-x64')

    expect(removed).toEqual([])
    expect(await readdir(scopeDir)).toEqual(['claude-agent-sdk-win32-x64'])
  })
})
