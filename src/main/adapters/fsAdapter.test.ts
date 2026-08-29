import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeFs } from './fakeFs'
import { NodeFs } from './fsLike'

describe('FakeFs', () => {
  function makeFake(): FakeFs {
    const fake = new FakeFs()
    fake.addFile('C:\\Users\\jeron\\.claude\\sessions\\100.json', '{"pid":100}', 1_000)
    fake.addFile(
      'C:\\Users\\jeron\\.claude\\projects\\enc\\s1.jsonl',
      'line1\nline2\nline3\n',
      2_000
    )
    return fake
  }

  it('exists() is true for files and their parent directories', async () => {
    const fake = makeFake()
    expect(await fake.exists('C:\\Users\\jeron\\.claude\\sessions\\100.json')).toBe(true)
    expect(await fake.exists('C:\\Users\\jeron\\.claude\\sessions')).toBe(true)
    expect(await fake.exists('C:\\Users\\jeron\\.claude')).toBe(true)
    expect(await fake.exists('C:\\Users\\jeron\\.claude-multitec')).toBe(false)
  })

  it('normalizes forward and backward slashes to the same file', async () => {
    const fake = makeFake()
    expect(await fake.exists('C:/Users/jeron/.claude/sessions/100.json')).toBe(true)
  })

  it('listDir() returns files and directories with the isDirectory flag', async () => {
    const fake = makeFake()
    const entries = await fake.listDir('C:\\Users\\jeron\\.claude')
    expect(entries).toContainEqual({ name: 'sessions', isDirectory: true })
    expect(entries).toContainEqual({ name: 'projects', isDirectory: true })
    const files = await fake.listDir('C:\\Users\\jeron\\.claude\\sessions')
    expect(files).toEqual([{ name: '100.json', isDirectory: false }])
  })

  it('listDir() returns [] for a missing directory', async () => {
    expect(await makeFake().listDir('C:\\nope')).toEqual([])
  })

  it('readJson() parses file content', async () => {
    const fake = makeFake()
    expect(await fake.readJson('C:\\Users\\jeron\\.claude\\sessions\\100.json')).toEqual({
      pid: 100
    })
  })

  it('readJson() rejects for a missing file', async () => {
    await expect(makeFake().readJson('C:\\nope.json')).rejects.toThrow()
  })

  it('readTextTail() returns the whole file when maxBytes is large enough', async () => {
    const fake = makeFake()
    const text = await fake.readTextTail('C:\\Users\\jeron\\.claude\\projects\\enc\\s1.jsonl', 4096)
    expect(text).toBe('line1\nline2\nline3\n')
  })

  it('readTextTail() returns only the last maxBytes', async () => {
    const fake = makeFake()
    const text = await fake.readTextTail('C:\\Users\\jeron\\.claude\\projects\\enc\\s1.jsonl', 8)
    expect(text).toBe('2\nline3\n')
  })

  it('readTextHead() returns only the first maxBytes', async () => {
    const fake = makeFake()
    const text = await fake.readTextHead('C:\\Users\\jeron\\.claude\\projects\\enc\\s1.jsonl', 6)
    expect(text).toBe('line1\n')
  })

  it('stat() reports mtime and size, and null for missing paths', async () => {
    const fake = makeFake()
    const stat = await fake.stat('C:\\Users\\jeron\\.claude\\sessions\\100.json')
    expect(stat).toEqual({ mtimeMs: 1_000, size: 11, isDirectory: false })
    expect(await fake.stat('C:\\nope')).toBeNull()
    const dirStat = await fake.stat('C:\\Users\\jeron\\.claude\\sessions')
    expect(dirStat?.isDirectory).toBe(true)
  })
})

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
