import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ordinary from '../../vitest.config.ts'
import golden from '../../vitest.golden.config.ts'

/*
 * The golden suite (#634) needs the private design repository and a real browser, so it must
 * never run inside `pnpm test`, which CI runs on three OSes; and `pnpm test:golden` must run only
 * it, one file at a time, because every file drives the same browser build.
 */

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (file) => readFileSync(path.join(rootDir, file), 'utf8')

describe('golden suite wiring', () => {
  it('keeps golden tests out of the ordinary suite', () => {
    expect(ordinary.test.exclude).toContain('**/*.golden.test.*')
  })

  it('runs only golden tests, serially, with room for a browser', () => {
    expect(golden.test.include).toEqual(['**/*.golden.test.mjs'])
    expect(golden.test.exclude).toContain('.design/**')
    expect(golden.test.fileParallelism).toBe(false)
    expect(golden.test.environment).toBe('node')
    expect(golden.test.testTimeout).toBeGreaterThanOrEqual(60_000)
  })

  it('exposes the golden run and the design copy as package scripts', () => {
    const { scripts } = JSON.parse(read('package.json'))
    expect(scripts['test:golden']).toBe('node scripts/golden/run.mjs')
    expect(scripts['golden:design']).toBe('node scripts/golden/design-copy.mjs')
  })

  it('never tracks the design copy', () => {
    expect(read('.gitignore').split(/\r?\n/)).toContain('/.design/')
  })
})
