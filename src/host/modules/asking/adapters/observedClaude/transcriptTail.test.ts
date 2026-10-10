// layer: L4
// L4 (17 §1.4): the observed-Claude transcript tail the keystroke channel re-reads just before
// pressing (ADR-012 item 3), over the synthetic fixtures of `fixtures/claude/hook-keystroke/2.1.x/`
// (their meta.json says how they were written). Each `*.expected.json` was written by hand from the
// rule; the CRLF and `-with-extra` variants must read exactly like their plain twin.
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FakeFs } from '../../../../kernel/fakes/FakeFs'
import { FsTranscriptTail, readTail, TRANSCRIPT_TAIL_BYTES } from './transcriptTail'

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../../fixtures/claude/hook-keystroke/2.1.x'
)

const fixture = (name: string): Promise<string> => readFile(join(FIXTURES, name), 'utf8')
const expectedOf = async (name: string): Promise<unknown> =>
  JSON.parse(await fixture(`${name}.expected.json`)) as unknown

describe('observed-Claude transcript tail (ADR-012 item 3)', () => {
  it('[ADR-012] the one unresolved main-session tool call is the open call, in every line-ending and extra-field variant', async () => {
    const expected = await expectedOf('pending-permission')
    for (const name of [
      'pending-permission.jsonl',
      'pending-permission-crlf.jsonl',
      'pending-permission-with-extra.jsonl'
    ]) {
      expect(readTail(await fixture(name)), name).toEqual(expected)
    }
  })

  it('[ADR-012] every case reads exactly like its expected file in its CRLF and with-extra variants', async () => {
    for (const name of [
      'pending-permission',
      'resolved-permission',
      'two-pending-same-tool',
      'pending-question',
      'sidechain-pending'
    ]) {
      const expected = await expectedOf(name)
      for (const variant of [`${name}.jsonl`, `${name}-crlf.jsonl`, `${name}-with-extra.jsonl`]) {
        expect(readTail(await fixture(variant)), variant).toEqual(expected)
      }
    }
  })

  it('[FM-082, ADR-012] a call with its tool_result is no longer open', async () => {
    expect(readTail(await fixture('resolved-permission.jsonl'))).toEqual(
      await expectedOf('resolved-permission')
    )
  })

  it('[FM-082, ADR-012] two unresolved calls of the hook tool are ambiguous and match nothing', async () => {
    const text = await fixture('two-pending-same-tool.jsonl')
    expect(readTail(text)).toEqual(await expectedOf('two-pending-same-tool'))
    expect(readTail(text, 'Bash')).toEqual(await expectedOf('two-pending-same-tool'))
    // Another tool's name matches neither.
    expect(readTail(text, 'Write').pending).toBeNull()
  })

  it('[ADR-012] an AskUserQuestion call is a question, never a permission', async () => {
    expect(readTail(await fixture('pending-question.jsonl'))).toEqual(
      await expectedOf('pending-question')
    )
  })

  it('[ADR-012] a subagent (sidechain) call is never matched', async () => {
    expect(readTail(await fixture('sidechain-pending.jsonl'))).toEqual(
      await expectedOf('sidechain-pending')
    )
  })

  it('[ADR-012] a cut first line, malformed lines and an empty tail read as nothing open', async () => {
    const text = await fixture('pending-permission.jsonl')
    // A bounded tail can start mid-record: that line is skipped, the rest still reads.
    expect(readTail(text.slice(40)).pending?.id).toBe('toolu_01KeystrokeBash')
    expect(readTail('{not json\n[]\n"x"\n')).toEqual({
      version: null,
      ambiguous: false,
      pending: null
    })
    expect(readTail('')).toEqual({ version: null, ambiguous: false, pending: null })
  })

  // Its secrets are redacted by the registry's injected `redact`, bound to the one redaction rule by
  // the wiring (05 R9): proven in wiring/routes/observedClaudeAsks.test.ts.
  it('[ADR-012] the request text is the call subject, capped at 240 characters', () => {
    const line = (input: Record<string, unknown>): string | undefined =>
      readTail(
        JSON.stringify({
          type: 'assistant',
          isSidechain: false,
          message: { content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input }] }
        })
      ).pending?.requestText
    expect(line({ command: 'pnpm test', description: 'run' })).toBe('pnpm test')
    expect(line({ path: 'src', pattern: 'FeedMessage' })).toBe('FeedMessage')
    expect(line({ server: 'atlas', ref: 42 })).toBe('{"server":"atlas","ref":42}')
    expect(line({ command: 'x'.repeat(5_000) })?.length).toBe(240)
  })

  it('[ADR-012] the real tail reads a bounded tail of the file and answers null when it cannot', async () => {
    const fs = new FakeFs()
    const text = await fixture('pending-permission.jsonl')
    fs.addFile('/t/session.jsonl', text)
    const tail = new FsTranscriptTail(fs)
    expect(await tail.read('/t/session.jsonl')).toBe(text)
    expect(await tail.read('/t/missing.jsonl')).toBeNull()
    expect(TRANSCRIPT_TAIL_BYTES).toBe(262_144)
  })
})
