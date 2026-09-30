import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SKIP_NOTICE, checkContractSync, runContractSync } from './contract-sync.mjs'

/**
 * L7 check of `docs-contract-sync` (testing strategy `17` §1.7, §5.2; `15` §12; `16` §12).
 *
 * The architecture package copies some contract blocks next to the prose that uses them; the
 * owner wins and a copy that differs is a defect. The check reads the package in place and
 * compares every marked copy with its owner block, line by line with line endings normalised:
 * the `BEGIN/END VERBATIM` blocks of `15`, the `<!-- verbatim: <file> L<a>-L<b> -->` blocks of
 * `16`, and the `05` §3.4, §3.7 and §3.12 copies. The fixture below is a miniature package with
 * one copy of each kind; `05` is stored with CRLF, as in the real package, the rest with LF.
 */

const D1 = [
  'export type ProviderId = string',
  "export type SessionOwnership = 'owned' | 'observed'"
]
const D2 = ['export interface ProviderCapabilities {', '  launch: boolean', '}']
const D2_TABLE = [
  '  | Field kind | Fields | Effective value |',
  '  |---|---|---|',
  '  | boolean | `launch` | ceiling AND negotiated |'
]
const D3 = ['export interface ProviderDriver {', '  readonly transport: DriverTransport', '}']
const ASK_ITEM_5 = [
  "   export type AskKind = 'question' | 'permission'",
  '   export interface AskBroker {}'
]
const SECRET_ITEM_1 = [
  "   export type SecretName = 'jev-key'",
  '   export interface SecretStore {}'
]
const KERNEL = ['interface Clock { now(): Instant }', 'interface Scheduler {}']

const fence = (lines, indent = '') => [`${indent}\`\`\`ts`, ...lines, `${indent}\`\`\``]

const ADR_009 = [
  '# ADR-009: One ProviderDriver',
  '',
  '## Decision',
  '',
  '### D1. Two layers',
  '',
  ...fence(D1),
  '',
  '### D2. Capabilities',
  '',
  ...fence(D2),
  '- The merge table:',
  '',
  ...D2_TABLE,
  '',
  '### D3. The driver contract',
  '',
  ...fence(D3),
  '',
  '## Consequences'
]

const ADR_010 = [
  '# ADR-010: Single ask broker',
  '',
  '## Decision',
  '',
  '1. **One broker.** Prose.',
  '5. **Typed outcomes.**',
  ...fence(ASK_ITEM_5, '   '),
  '6. **Events.** Prose.'
]

const ADR_017 = [
  '# ADR-017: Secrets at rest',
  '',
  '## Decision',
  '',
  '1. **Port.**',
  ...fence(SECRET_ITEM_1, '   '),
  '2. **Adapter.** Prose.'
]

const DOC_05 = [
  '# 05 Modules and ports',
  '',
  '```ts',
  ...KERNEL,
  '```',
  '',
  '**Verbatim copy of ADR-009 D2/D3 (re-synced).** ADR-009 wins on any difference.',
  '',
  ...fence(D2),
  '',
  ...fence(D3),
  '',
  '```ts',
  '// ---- verbatim copy of ADR-010 item 5 (as revised) ----',
  ...ASK_ITEM_5,
  '// ---- end of copy ----',
  'export type AskCommands = AskBroker',
  '// ---- verbatim copy of ADR-017 item 1 (AMENDMENT-2); ADR-017 wins on any difference ----',
  ...SECRET_ITEM_1,
  '// ---- end of copy ----',
  '```'
]

const DOC_15 = [
  '# 15 Provider driver',
  '',
  '<!-- BEGIN VERBATIM ADR-009 D1 -->',
  ...fence(D1),
  '<!-- END VERBATIM ADR-009 D1 -->',
  '',
  '<!-- BEGIN VERBATIM ADR-009 D2 -->',
  ...fence(D2),
  '<!-- END VERBATIM ADR-009 D2 -->',
  '',
  '<!-- BEGIN VERBATIM ADR-009 D2-MERGE -->',
  ...D2_TABLE,
  '<!-- END VERBATIM ADR-009 D2-MERGE -->',
  '',
  '<!-- BEGIN VERBATIM ADR-009 D3 -->',
  ...fence(D3),
  '<!-- END VERBATIM ADR-009 D3 -->'
]

/** `16` copies lines 4-5 of `05` (the kernel block) and lines 7-8 of ADR-017 (item 1's fence). */
const DOC_16 = [
  '# 16 Internal ports',
  '',
  '<!-- verbatim: 05-modules-and-ports.md L4-L5 -->',
  ...fence(KERNEL),
  '',
  '<!-- verbatim: 03-adr/ADR-017-secrets.md L7-L8 -->',
  ...fence(SECRET_ITEM_1)
]

const FILES = {
  '03-adr/ADR-009-one-providerdriver.md': { lines: ADR_009, eol: '\n' },
  '03-adr/ADR-010-single-ask-broker.md': { lines: ADR_010, eol: '\n' },
  '03-adr/ADR-017-secrets.md': { lines: ADR_017, eol: '\n' },
  '05-modules-and-ports.md': { lines: DOC_05, eol: '\r\n' },
  '15-provider-driver.md': { lines: DOC_15, eol: '\n' },
  '16-internal-ports.md': { lines: DOC_16, eol: '\n' }
}

/** One single-byte edit per copy kind: [file, the copy line to edit, the block name it must name]. */
const ONE_BYTE_EDITS = [
  ['15-provider-driver.md', D1[0], 'ADR-009 D1'],
  ['15-provider-driver.md', D2[0], 'ADR-009 D2'],
  ['15-provider-driver.md', D2_TABLE[2], 'ADR-009 D2-MERGE'],
  ['15-provider-driver.md', D3[1], 'ADR-009 D3'],
  ['16-internal-ports.md', KERNEL[1], '05-modules-and-ports.md L4-L5'],
  ['16-internal-ports.md', SECRET_ITEM_1[1], '03-adr/ADR-017-secrets.md L7-L8'],
  ['05-modules-and-ports.md', D2[1], 'ADR-009 D2'],
  ['05-modules-and-ports.md', D3[0], 'ADR-009 D3'],
  ['05-modules-and-ports.md', ASK_ITEM_5[0], 'ADR-010 item 5'],
  ['05-modules-and-ports.md', SECRET_ITEM_1[0], 'ADR-017 item 1']
]

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'contract-sync-'))
  tempRoots.push(dir)
  return dir
}

/** Writes the miniature package into `dir` and returns `dir`. */
function writePackage(dir) {
  for (const [file, { lines, eol }] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), lines.join(eol) + eol)
  }
  return dir
}

/** Replaces the last character of the first occurrence of `line` in `file` (one byte, ASCII). */
function editOneByte(dir, file, line) {
  const full = path.join(dir, file)
  const text = readFileSync(full, 'utf8')
  const at = text.indexOf(line)
  expect(at, `${file} holds the copy line`).toBeGreaterThanOrEqual(0)
  const last = at + line.length - 1
  const replacement = text[last] === 'x' ? 'y' : 'x'
  writeFileSync(full, text.slice(0, last) + replacement + text.slice(last + 1))
}

function collectingIo() {
  const lines = { out: [], err: [] }
  return {
    lines,
    io: { out: (line) => lines.out.push(line), err: (line) => lines.err.push(line) }
  }
}

describe('docs-contract-sync (15 §12, 16 §12)', () => {
  it('[ADR-009] a verbatim block that differs from its owner by one byte fails; identical blocks pass; CRLF and LF compare equal; an absent package folder skips with a notice', () => {
    const packageDir = writePackage(tempDir())
    const identical = checkContractSync(packageDir)
    expect(identical.failures).toEqual([])
    expect(identical.checked, 'every copy of the fixture was compared').toBe(ONE_BYTE_EDITS.length)

    for (const [file, line, blockName] of ONE_BYTE_EDITS) {
      const edited = writePackage(tempDir())
      editOneByte(edited, file, line)
      const { failures } = checkContractSync(edited)
      expect(failures.length, `one failure after editing ${blockName} in ${file}`).toBe(1)
      expect(failures[0]).toContain(file)
      expect(failures[0]).toContain(blockName)
    }

    const repoWithoutPackage = tempDir()
    const skipped = collectingIo()
    expect(runContractSync(['--root', repoWithoutPackage], skipped.io)).toBe(0)
    expect(skipped.lines.out).toEqual([SKIP_NOTICE])
    expect(SKIP_NOTICE).toBe('architecture package not present: contract sync skipped')
  })

  it('[ADR-009] a --from path that does not exist fails, and --from reads the package in place', () => {
    const root = tempDir()
    const missing = collectingIo()
    expect(runContractSync(['--root', root, '--from', path.join(root, 'absent')], missing.io)).toBe(
      1
    )
    expect(missing.lines.err.join('\n')).toMatch(/--from path does not exist/)

    const packageDir = writePackage(tempDir())
    const passing = collectingIo()
    expect(runContractSync(['--root', root, '--from', packageDir], passing.io)).toBe(0)
    expect(passing.lines.out.join('\n')).toMatch(/10 verbatim block\(s\) identical/)

    editOneByte(packageDir, '15-provider-driver.md', D3[1])
    const failing = collectingIo()
    expect(runContractSync(['--root', root, '--from', packageDir], failing.io)).toBe(1)
    expect(failing.lines.err.join('\n')).toContain('ADR-009 D3')
  })

  it('[ADR-009] a package file that lost every copy marker fails instead of passing silently', () => {
    const packageDir = writePackage(tempDir())
    writeFileSync(path.join(packageDir, '16-internal-ports.md'), '# 16 Internal ports\n')
    const { failures } = checkContractSync(packageDir)
    expect(failures.join('\n')).toMatch(/16-internal-ports\.md: no verbatim copy found/)
  })
})
