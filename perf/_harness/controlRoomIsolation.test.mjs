// layer: L7
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * L7 check that the Control-room scaling page (ISSUE-298; `perf/fixtures/controlRoom/`) stays test code: no product
 * source names it and no electron-vite build takes it as an input, so no production entry can reach it (R13). The page
 * is built only by the perf case (`perf/fixtures/controlRoom/buildPage.ts`).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURE = /perf\/fixtures|fixtures\/controlRoom/

/** Every file under `relativeDir`, as repository-relative posix paths. */
function filesUnder(relativeDir) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(relative)
      else if (entry.isFile() && /\.(?:[cm]?[jt]s|vue|html)$/.test(entry.name)) files.push(relative)
    }
  }
  walk(relativeDir)
  return files
}

describe('the Control-room scaling page is test code (R13)', () => {
  it('[S-034-1] no product source and no electron-vite build names the Control-room fixture page', () => {
    const builds = readdirSync(ROOT).filter((name) => /^electron\.vite.*\.config\.ts$/.test(name))
    const naming = [...filesUnder('src'), ...builds].filter((file) =>
      FIXTURE.test(readFileSync(path.join(ROOT, file), 'utf8'))
    )

    expect(builds.length).toBeGreaterThan(0)
    expect(naming).toEqual([])
  })
})
