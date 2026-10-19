// L7 static check (17 §1.7; 18 §4.5 T-34): the mines module reads `.git` files and folders only.
// Running `git` in a person's repository would run its `core.fsmonitor`, hooks and filters, so no
// file of the module may import a process API (R17 also holds for the whole Host through
// dependency-cruiser) or name the git executable as a program to start.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url))
const THIS_FILE = fileURLToPath(import.meta.url)

/** The process API: `child_process`, with or without `node:`, imported or required. */
const PROCESS_IMPORT =
  /\bfrom\s+['"](node:)?child_process['"]|require\(\s*['"](node:)?child_process['"]\s*\)/

/** The git executable named as a program: `'git'`, `"git.exe"`, `` `git` `` and the like. */
const GIT_EXECUTABLE = /(['"`])git(\.exe|\.cmd)?\1/i

/** The code of a file without its comments, where prose may name `git` freely. */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|mts|cts|js|mjs)$/.test(entry.name) && path !== THIS_FILE ? [path] : []
  })
}

describe('mines module: no git binary', () => {
  it('[R17] the mines module never imports node:child_process and never names the git executable', () => {
    const files = sourceFiles(MODULE_DIR)
    // The scan sees the module, the inspector among it.
    expect(files.map((file) => relative(MODULE_DIR, file).replace(/\\/g, '/'))).toContain(
      'adapters/FsGitRepoInspector.ts'
    )

    const offenders = files.flatMap((file) => {
      const text = codeOf(readFileSync(file, 'utf8'))
      const found: string[] = []
      if (PROCESS_IMPORT.test(text)) found.push('imports child_process')
      if (GIT_EXECUTABLE.test(text)) found.push('names the git executable')
      return found.map((what) => `${relative(MODULE_DIR, file)}: ${what}`)
    })
    expect(offenders).toEqual([])
  })
})
