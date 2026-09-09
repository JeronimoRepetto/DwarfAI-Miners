#!/usr/bin/env node
/**
 * electron-builder afterPack hook: strip every @anthropic-ai/claude-agent-sdk-*
 * platform runtime except the one matching the artifact actually being built.
 *
 * Why this exists (#349). @anthropic-ai/claude-agent-sdk ships its runtime as one
 * optional package per platform+arch (darwin-arm64, darwin-x64, linux-x64,
 * win32-x64, plus musl/arm64 variants this project never builds). pnpm only
 * installs the host's own match by default; `supportedArchitectures` in
 * `pnpm-workspace.yaml` widens that so a single macOS host — which builds BOTH
 * arm64 and x64 dmg/zip targets from one `pnpm install` — has both darwin
 * runtimes available. But that widening is a cross product, not a set of pairs
 * (see the comment in pnpm-workspace.yaml), so on any host it also pulls in
 * whichever other platforms' variants happen to be reachable.
 *
 * electron-builder is supposed to prune node_modules to the target arch/os on
 * its own — but only from v27 (see "node_modules are now arch/os-filtered on
 * every build" in its v27 migration notes). This project pins 26.15.3
 * (docs/signing.md explains why: v27 also restructures the mac signing config
 * this project already has wired in), which has no such filter. Verified by
 * hand: without this hook, a `--win --x64 --dir` build shipped all eight
 * platform packages into app.asar.unpacked — each one is a ~200MB standalone
 * binary, so that is a ~1.4GB regression per installer, not a rounding error.
 *
 * This hook is the v26 stand-in for that v27 behavior, scoped to exactly the
 * one dependency this project actually declares per-platform builds for.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

const SCOPE = '@anthropic-ai/'
// Directory entries inside a `node_modules/@anthropic-ai/` folder are already
// unscoped (`claude-agent-sdk-win32-x64`, not `@anthropic-ai/claude-agent-sdk-win32-x64`).
export const RUNTIME_DIR_PREFIX = 'claude-agent-sdk-'

// electron-builder's Arch enum (packages/builder-util/src/arch.ts): index -> name.
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

/**
 * Which single runtime package belongs in an artifact for this platform+arch,
 * as a fully scoped package name (matching the `optionalDependencies` keys in
 * package.json), or null when the combination isn't one this project's
 * node_modules could ever satisfy exactly (a universal build, or an arch this
 * app doesn't package) — in which case pruning is skipped rather than
 * guessing wrong.
 */
export function wantedRuntimePackage(electronPlatformName, archIndex) {
  const archName = ARCH_NAMES[archIndex]
  if (archName !== 'x64' && archName !== 'arm64') return null
  return `${SCOPE}${RUNTIME_DIR_PREFIX}${electronPlatformName}-${archName}`
}

/** Depth-bounded search for every `node_modules/@anthropic-ai` directory under `root`. */
async function findAnthropicAiDirs(root, depth = 8) {
  const found = []
  async function walk(dir, remaining) {
    if (remaining <= 0) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = path.join(dir, entry.name)
      if (entry.name === '@anthropic-ai') {
        found.push(full)
        continue // nothing relevant nests inside a scope directory itself
      }
      await walk(full, remaining - 1)
    }
  }
  await walk(root, depth)
  return found
}

/**
 * Deletes every `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` directory
 * under `root` except `wantedPackage` (accepted scoped or unscoped). Returns
 * the removed (unscoped) directory names.
 */
export async function pruneRuntimeDirs(root, wantedPackage) {
  const wantedDirName = wantedPackage.startsWith(SCOPE)
    ? wantedPackage.slice(SCOPE.length)
    : wantedPackage
  const removed = []
  for (const scopeDir of await findAnthropicAiDirs(root)) {
    let entries
    try {
      entries = await readdir(scopeDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith(RUNTIME_DIR_PREFIX)) continue
      if (entry.name === wantedDirName) continue
      await rm(path.join(scopeDir, entry.name), { recursive: true, force: true })
      removed.push(entry.name)
    }
  }
  return removed
}

/** electron-builder's afterPack hook. */
export default async function afterPack(context) {
  const { appOutDir, electronPlatformName, arch } = context
  const wantedPackage = wantedRuntimePackage(electronPlatformName, arch)
  if (wantedPackage == null) return

  if ((await stat(appOutDir).catch(() => null)) == null) return
  const removed = await pruneRuntimeDirs(appOutDir, wantedPackage)
  if (removed.length > 0) {
    console.log(`[pruneSdkRuntimes] kept ${wantedPackage}, removed: ${removed.sort().join(', ')}`)
  }
}
