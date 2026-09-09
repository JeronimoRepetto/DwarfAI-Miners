import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * @anthropic-ai/claude-agent-sdk ships its runtime as one optional package per
 * platform+arch (`claude-agent-sdk-darwin-arm64`, `-darwin-x64`, `-linux-x64`,
 * `-win32-x64`) rather than bundling every platform in the main package. pnpm
 * only auto-installs the one matching the machine running `pnpm install`, so
 * these four are pinned in `optionalDependencies` and widened into
 * `node_modules` on every host via `supportedArchitectures` in
 * `pnpm-workspace.yaml` — see the comment there and issue #349.
 *
 * They are a SEPARATE set of npm packages with their own version numbers, not
 * derived from the SDK's version automatically, so bumping `dependencies`
 * without bumping every runtime pin the same amount silently ships a stale
 * (or, worse, ahead) native binary next to a newer/older SDK. This test is
 * the guard: it fails the moment any one of the four drifts from the exact
 * version pinned for `@anthropic-ai/claude-agent-sdk` itself. Renovate/a
 * manual bump must move all five together.
 */

const packageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'package.json'
)

function readPackageJson() {
  return JSON.parse(readFileSync(packageJsonPath, 'utf8'))
}

describe('claude-agent-sdk runtime version pins', () => {
  it('pins every per-platform runtime to the exact @anthropic-ai/claude-agent-sdk version', () => {
    const pkg = readPackageJson()
    const sdkVersion = pkg.dependencies['@anthropic-ai/claude-agent-sdk']
    expect(sdkVersion).toBeTruthy()

    const runtimeEntries = Object.entries(pkg.optionalDependencies ?? {}).filter(([name]) =>
      name.startsWith('@anthropic-ai/claude-agent-sdk-')
    )

    // Catches the whole block being deleted by accident, not just one entry drifting.
    expect(runtimeEntries.length).toBeGreaterThan(0)

    for (const [name, version] of runtimeEntries) {
      expect(version, `${name} must match @anthropic-ai/claude-agent-sdk@${sdkVersion}`).toBe(
        sdkVersion
      )
    }
  })

  it('declares exactly the four runtimes this app builds for, and none of the musl/foreign-arch variants', () => {
    const pkg = readPackageJson()
    const runtimeNames = Object.keys(pkg.optionalDependencies ?? {})
      .filter((name) => name.startsWith('@anthropic-ai/claude-agent-sdk-'))
      .sort()

    // darwin-arm64/darwin-x64: the mac build produces both arches from one host.
    // linux-x64/win32-x64: the only arch either platform is built for.
    // The SDK itself also ships linux-arm64, the two -musl variants and
    // win32-arm64 — none built by this project, so none belong here (#349).
    expect(runtimeNames).toEqual([
      '@anthropic-ai/claude-agent-sdk-darwin-arm64',
      '@anthropic-ai/claude-agent-sdk-darwin-x64',
      '@anthropic-ai/claude-agent-sdk-linux-x64',
      '@anthropic-ai/claude-agent-sdk-win32-x64'
    ])
  })
})
