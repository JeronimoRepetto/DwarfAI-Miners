// Transplanted unchanged from src/main/adapters/fsAdapter.test.ts (the FakeFs half); only the
// imports differ (ISSUE-017, 16 §3 row FileSystem, 17 §2.5).
import { describe, expect, it } from 'vitest'
import { FakeFs } from './FakeFs'

describe('FakeFs', () => {
  function makeFake(): FakeFs {
    const fake = new FakeFs()
    fake.addFile('C:\\Users\\j\\.claude\\sessions\\100.json', '{"pid":100}', 1_000)
    fake.addFile('C:\\Users\\j\\.claude\\projects\\enc\\s1.jsonl', 'line1\nline2\nline3\n', 2_000)
    return fake
  }

  it('exists() is true for files and their parent directories', async () => {
    const fake = makeFake()
    expect(await fake.exists('C:\\Users\\j\\.claude\\sessions\\100.json')).toBe(true)
    expect(await fake.exists('C:\\Users\\j\\.claude\\sessions')).toBe(true)
    expect(await fake.exists('C:\\Users\\j\\.claude')).toBe(true)
    expect(await fake.exists('C:\\Users\\j\\.claude-work')).toBe(false)
  })

  it('normalizes forward and backward slashes to the same file', async () => {
    const fake = makeFake()
    expect(await fake.exists('C:/Users/j/.claude/sessions/100.json')).toBe(true)
  })

  it('resolves a POSIX-registered tree through POSIX or Windows separators', async () => {
    // The single normalization point: fixtures written with `/` (or `\`) are
    // found by providers that build their paths with node:path.join, whichever
    // host the suite runs on. That is what lets one set of fixtures prove
    // path portability without being rewritten per platform.
    const fake = new FakeFs()
    fake.addFile('/home/j/.claude/sessions/100.json', '{"pid":100}')
    expect(await fake.exists('/home/j/.claude/sessions/100.json')).toBe(true)
    expect(await fake.exists('\\home\\j\\.claude\\sessions\\100.json')).toBe(true)
    expect(await fake.listDir('/home/j/.claude')).toEqual([{ name: 'sessions', isDirectory: true }])
    expect(await fake.readJson('\\home\\j\\.claude\\sessions\\100.json')).toEqual({ pid: 100 })
  })

  it('listDir() returns files and directories with the isDirectory flag', async () => {
    const fake = makeFake()
    const entries = await fake.listDir('C:\\Users\\j\\.claude')
    expect(entries).toContainEqual({ name: 'sessions', isDirectory: true })
    expect(entries).toContainEqual({ name: 'projects', isDirectory: true })
    const files = await fake.listDir('C:\\Users\\j\\.claude\\sessions')
    expect(files).toEqual([{ name: '100.json', isDirectory: false }])
  })

  it('listDir() returns [] for a missing directory', async () => {
    expect(await makeFake().listDir('C:\\nope')).toEqual([])
  })

  it('readJson() parses file content', async () => {
    const fake = makeFake()
    expect(await fake.readJson('C:\\Users\\j\\.claude\\sessions\\100.json')).toEqual({
      pid: 100
    })
  })

  /*
   * #555. A Claude session entry or a ledger document saved by a Windows
   * editor opens with EF BB BF, and `JSON.parse` throws on it. Asserted on the
   * FAKE here because the fake is what every other test reads through: if the
   * two disagree about the same bytes, a green suite says nothing about the
   * real adapter. See adapters/jsonText.ts.
   */
  it('readJson() parses a file a Windows editor marked with a BOM', async () => {
    const fake = new FakeFs()
    fake.addFile('C:\\Users\\j\\.claude\\sessions\\100.json', '\uFEFF{"pid":100}')
    await expect(fake.readJson('C:\\Users\\j\\.claude\\sessions\\100.json')).resolves.toEqual({
      pid: 100
    })
  })

  it('readJson() still rejects text that is not JSON at all', async () => {
    const fake = new FakeFs()
    fake.addFile('C:\\broken.json', '\uFEFFnot json')
    await expect(fake.readJson('C:\\broken.json')).rejects.toThrow()
  })

  it('readJson() rejects for a missing file', async () => {
    await expect(makeFake().readJson('C:\\nope.json')).rejects.toThrow()
  })

  it('readTextTail() returns the whole file when maxBytes is large enough', async () => {
    const fake = makeFake()
    const text = await fake.readTextTail('C:\\Users\\j\\.claude\\projects\\enc\\s1.jsonl', 4096)
    expect(text).toBe('line1\nline2\nline3\n')
  })

  it('readTextTail() returns only the last maxBytes', async () => {
    const fake = makeFake()
    const text = await fake.readTextTail('C:\\Users\\j\\.claude\\projects\\enc\\s1.jsonl', 8)
    expect(text).toBe('2\nline3\n')
  })

  it('readTextHead() returns only the first maxBytes', async () => {
    const fake = makeFake()
    const text = await fake.readTextHead('C:\\Users\\j\\.claude\\projects\\enc\\s1.jsonl', 6)
    expect(text).toBe('line1\n')
  })

  it('stat() reports mtime and size, and null for missing paths', async () => {
    const fake = makeFake()
    const stat = await fake.stat('C:\\Users\\j\\.claude\\sessions\\100.json')
    expect(stat).toEqual({ mtimeMs: 1_000, size: 11, isDirectory: false })
    expect(await fake.stat('C:\\nope')).toBeNull()
    const dirStat = await fake.stat('C:\\Users\\j\\.claude\\sessions')
    expect(dirStat?.isDirectory).toBe(true)
  })
})
