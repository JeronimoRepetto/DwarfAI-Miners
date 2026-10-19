// layer: L7
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The step-3a deletion (ISSUE-184; 21 §2 row 3a "Legacy deleted"; ADR-001 item 7; ADR-008 item 1; 15 §2.4): no Agent
 * SDK in the tree, milestone M4a (20 R-20). Claude runs only through the person's own `claude -p` stream-json or a
 * user-installed `claude-agent-acp`. Read as text over the whole repository's source roots. `lint-canaries/` is
 * skipped on purpose: its `R11-no-claude-agent-sdk` canary plants exactly this import so the lint rule is proven to fire.
 */
const ROOT = resolve(import.meta.dirname, '..', '..')
const SOURCE_ROOTS = ['src', 'scripts', 'e2e', 'spikes']
const SOURCE_FILE = /\.(c|m)?[jt]sx?$|\.vue$/
const SDK = '@anthropic-ai/claude-agent-sdk'

/** Every file under a folder, as a path relative to the repository root with forward slashes. */
function filesUnder(folder: string): string[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return []
    const path = resolve(folder, entry.name)
    if (entry.isDirectory()) return filesUnder(path)
    return [
      path
        .slice(ROOT.length + 1)
        .split('\\')
        .join('/')
    ]
  })
}

/** A module specifier naming the SDK or one of its subpaths, in an import, an export or a require. */
const SDK_IMPORT = new RegExp(
  String.raw`(^|\n)\s*(import|export)\b[^\n;]*\bfrom\s*['"]${SDK}[^'"]*['"]` +
    String.raw`|(^|\n)\s*import\s*['"]${SDK}[^'"]*['"]` +
    String.raw`|\b(require|import)\s*\(\s*['"]${SDK}[^'"]*['"]\s*\)`
)

describe('no Agent SDK in the tree (ADR-001 item 7)', () => {
  it('[ADR-001] no file named sdkHeldSession.ts exists and no source imports @anthropic-ai/claude-agent-sdk', () => {
    const files = SOURCE_ROOTS.flatMap((root) => filesUnder(resolve(ROOT, root)))
    expect(files.filter((path) => /(^|\/)sdkHeldSession\.ts$/.test(path))).toEqual([])
    const importers = files
      .filter((path) => SOURCE_FILE.test(path))
      .filter((path) => SDK_IMPORT.test(readFileSync(resolve(ROOT, path), 'utf8')))
    expect(importers).toEqual([])
  })

  it('[ADR-008] package.json and the lockfile contain no @anthropic-ai/claude-agent-sdk package', () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >
    const declared = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
      .flatMap((field) =>
        Object.keys((manifest[field] as Record<string, string> | undefined) ?? {})
      )
      .filter((name) => name.startsWith(SDK))
    expect(declared).toEqual([])
    const lockfile = readFileSync(resolve(ROOT, 'pnpm-lock.yaml'), 'utf8')
    expect(lockfile.includes(SDK)).toBe(false)
  })
})
