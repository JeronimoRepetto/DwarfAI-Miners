import { describe, expect, it } from 'vitest'
import { isOpenablePath } from './openablePath'

/**
 * Which activity lines name a FILE this panel may offer to open (#279): only
 * `edit` and `read` targets are paths — `run` and `search` stay plain text,
 * exactly as `screens/mine.md`'s amendment says.
 */
describe('isOpenablePath', () => {
  it('opens an edit target', () => {
    expect(isOpenablePath({ kind: 'edit', target: 'src/main/index.ts' })).toBe(true)
  })

  it('opens a read target', () => {
    expect(isOpenablePath({ kind: 'read', target: 'src/main/index.ts' })).toBe(true)
  })

  it('leaves a run target as plain text', () => {
    expect(isOpenablePath({ kind: 'run', target: 'pnpm test' })).toBe(false)
  })

  it('leaves a search target as plain text', () => {
    expect(isOpenablePath({ kind: 'search', target: '**/*.ts' })).toBe(false)
  })

  it('is false for a row with no activity at all', () => {
    expect(isOpenablePath(undefined)).toBe(false)
  })
})
