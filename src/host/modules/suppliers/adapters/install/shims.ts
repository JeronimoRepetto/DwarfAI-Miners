// Reading a Windows shim for what it runs (ADR-029 row 8: a `.cmd` / `.bat` shim is resolved to its
// target, never run through `cmd.exe`; 16 §4.4: Scoop shims too). Pure: text in, target out. The
// reading rules are the found tree's (`src/main/platform/cliDetection.ts` `resolveShimTarget` at
// 0bfd108, #193, #502, #544), rewritten here because the rebuild never imports legacy code (R16).
import { win32 } from 'node:path'

/** What a shim runs: a `.js` entry for node, or a program in its own right. */
export type ShimTarget = { kind: 'script'; entry: string } | { kind: 'program'; program: string }

/**
 * The target of an npm / pnpm `.cmd` shim or a `.bat` that starts a program. The first quoted
 * `.js` wins (every node shim also quotes `node.exe`, the program it runs the entry with); else
 * the first quoted `.exe` / `.com` (a compiled CLI published through npm). `%~dp0` and `%dp0%`, the
 * shim's own directory, are the only variables expanded; anything still holding a `%` would need
 * cmd.exe, so the shim is not read (null), and neither is a shim that names neither.
 */
export function batchShimTarget(shimPath: string, text: string): ShimTarget | null {
  const shimDir = win32.dirname(shimPath)
  const expand = (quoted: string): string | null => {
    const expanded = quoted.replace(/%~dp0\\?|%dp0%\\?/gi, `${shimDir}\\`)
    return expanded.includes('%') ? null : win32.normalize(expanded)
  }
  for (const quoted of quotedTokens(text)) {
    if (!/\.js$/i.test(quoted)) continue
    const entry = expand(quoted)
    return entry === null ? null : { kind: 'script', entry }
  }
  for (const quoted of quotedTokens(text)) {
    if (!/\.(exe|com)$/i.test(quoted) || /(^|[\\/])node\.exe$/i.test(quoted)) continue
    const program = expand(quoted)
    return program === null ? null : { kind: 'program', program }
  }
  return null
}

/** The program a Scoop `.shim` file names in its `path = "..."` line. */
export function scoopShimTarget(text: string): string | null {
  const line = /^\s*path\s*=\s*"?([^"\r\n]+?)"?\s*$/im.exec(text)
  return line?.[1] === undefined ? null : win32.normalize(line[1])
}

function quotedTokens(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '')
}
