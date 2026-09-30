import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Static check (17 §1.7 "Misc static"; ADR-005 item 2 and Verification): the SQLite header
// version pragma was today's #575 compatibility floor. The Host tracks versions only in
// `schema_migrations`, so the pragma's name appears nowhere under src/host, comments included.
// This file, which states the rule, is the one exception.
const FORBIDDEN = 'user_version'

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(path)
    return entry.isFile() ? [path] : []
  })
}

describe('src/host static rules', () => {
  it('[ADR-005] no user_version appears in src/host', () => {
    const self = fileURLToPath(import.meta.url)
    const root = import.meta.dirname
    const offenders = filesUnder(root)
      .filter((file) => file !== self)
      .filter((file) => readFileSync(file, 'utf8').toLowerCase().includes(FORBIDDEN))
      .map((file) => relative(root, file).split('\\').join('/'))

    expect(offenders).toEqual([])
  })
})
