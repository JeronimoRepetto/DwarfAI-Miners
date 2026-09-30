// Transplanted unchanged from src/main/adapters/fsAdapter.test.ts (the NodeFs half); only the
// imports differ (ISSUE-017, 16 §3 row FileSystem, 17 §2.5).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NodeFs } from './NodeFs'

describe('NodeFs', () => {
  let dir: string
  const nodeFs = new NodeFs()

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-name-fs-'))
    await writeFile(join(dir, 'sample.txt'), 'abcdefghij')
    await writeFile(join(dir, 'data.json'), '{"ok":true}')
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('readTextTail() reads only the last maxBytes', async () => {
    expect(await nodeFs.readTextTail(join(dir, 'sample.txt'), 4)).toBe('ghij')
    expect(await nodeFs.readTextTail(join(dir, 'sample.txt'), 100)).toBe('abcdefghij')
  })

  it('readTextHead() reads only the first maxBytes', async () => {
    expect(await nodeFs.readTextHead(join(dir, 'sample.txt'), 3)).toBe('abc')
  })

  it('readJson() parses a real file', async () => {
    expect(await nodeFs.readJson(join(dir, 'data.json'))).toEqual({ ok: true })
  })

  it('listDir(), stat() and exists() agree with the real filesystem', async () => {
    const entries = await nodeFs.listDir(dir)
    expect(entries.map((e) => e.name).sort()).toEqual(['data.json', 'sample.txt'])
    expect(entries.every((e) => !e.isDirectory)).toBe(true)
    expect(await nodeFs.listDir(join(dir, 'missing'))).toEqual([])
    expect((await nodeFs.stat(join(dir, 'sample.txt')))?.size).toBe(10)
    expect(await nodeFs.stat(join(dir, 'missing'))).toBeNull()
    expect(await nodeFs.exists(dir)).toBe(true)
    expect(await nodeFs.exists(join(dir, 'missing'))).toBe(false)
  })
})
