#!/usr/bin/env node
/**
 * Tests for sync.mjs, run directly:
 *
 *   node skills/skill-sync/assets/sync.test.mjs
 *
 * Deliberately standalone rather than a vitest suite. `vitest.config.ts`
 * includes `src/**` and `scripts/**` only, so a test here would not be picked
 * up, and widening that config to reach the harness would put the app's suite
 * and its own tooling in the same run for no benefit.
 *
 * Most of what is asserted below is REFUSAL. The generator's whole claim is
 * that it fails loudly where the implementation it was modelled on warned and
 * exited 0, so the failure paths are the ones worth pinning.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

const SYNC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sync.mjs')

const AGENTS_TEMPLATE = `# Test

## Skills

<!-- BEGIN GENERATED: skill-catalogue -->
<!-- END GENERATED: skill-catalogue -->

### Auto-invoke Skills

<!-- BEGIN GENERATED: auto-invoke -->
<!-- END GENERATED: auto-invoke -->

## The tree

<!-- BEGIN GENERATED: main-tree -->
<!-- END GENERATED: main-tree -->

## Tail

Content after the regions must survive.
`

/** Enough real subject directories that the rendered bullet has to wrap. */
const MANY_MAIN_DIRS = [
  'adapters',
  'appDatabase',
  'config',
  'domain',
  'hooks',
  'ledger',
  'platform',
  'projects',
  'providers',
  'runtime',
  'sessionLaunch',
  'shell',
  'textDelivery',
  'tier'
]

const skill = (over = {}) => ({
  name: 'alpha',
  description: 'What alpha covers.\n  Trigger: when alpha applies.',
  license: 'MIT',
  author: 'JeronimoRepetto',
  version: "'1.0'",
  scope: '[root]',
  autoInvoke: ["'doing an alpha thing'"],
  ...over
})

function frontmatter(s) {
  return `---
name: ${s.name}
description: >
  ${s.description}
license: ${s.license}
metadata:
  author: ${s.author}
  version: ${s.version}
  scope: ${s.scope}
  auto_invoke:
${s.autoInvoke.map((a) => `    - ${a}`).join('\n')}
allowed-tools: Read, Edit
---

# ${s.name}

Body.
`
}

/** Builds a throwaway repo and returns its root. */
function makeRepo({
  skills = [skill()],
  agents = AGENTS_TEMPLATE,
  dirNames = null,
  mainDirs = ['adapters', 'runtime']
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'skill-sync-test-'))
  // The main-tree region is generated from whatever is under `src/main`, so a
  // throwaway repo needs one. `mainDirs: null` leaves it out entirely, which is
  // a refusal rather than an empty list.
  for (const dir of mainDirs ?? []) {
    mkdirSync(path.join(root, 'src', 'main', dir), { recursive: true })
  }
  mkdirSync(path.join(root, 'skills'), { recursive: true })
  skills.forEach((s, i) => {
    const dir = dirNames ? dirNames[i] : s.name
    mkdirSync(path.join(root, 'skills', dir), { recursive: true })
    writeFileSync(path.join(root, 'skills', dir, 'SKILL.md'), frontmatter(s))
  })
  if (agents !== null) writeFileSync(path.join(root, 'AGENTS.md'), agents)
  return root
}

function run(root, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [SYNC, '--repo-root', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { code: 0, out: stdout }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const agentsOf = (root) => readFileSync(path.join(root, 'AGENTS.md'), 'utf8')

// ── harness ────────────────────────────────────────────────────────────────

let passed = 0
const failures = []
const cleanup = []

function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`${name}\n    ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Asserts the run failed AND that the message names the real reason. */
function refuses(result, needle) {
  assert(result.code === 1, `expected exit 1, got ${result.code}. Output:\n${result.out}`)
  assert(
    result.out.includes(needle),
    `expected the failure to mention "${needle}". Output:\n${result.out}`
  )
}

function withRepo(options, fn) {
  const root = makeRepo(options)
  cleanup.push(root)
  return fn(root)
}

// ── the happy path ─────────────────────────────────────────────────────────

test('generates both tables and preserves surrounding content', () => {
  withRepo({}, (root) => {
    const result = run(root)
    assert(result.code === 0, `expected success, got:\n${result.out}`)
    const out = agentsOf(root)
    assert(out.includes('[`alpha`](skills/alpha/SKILL.md)'), 'catalogue row missing')
    assert(out.includes('doing an alpha thing'), 'auto-invoke row missing')
    assert(out.includes('What alpha covers'), 'catalogue should use the pre-Trigger half')
    assert(!out.includes('Trigger: when alpha applies'), 'the Trigger half must not leak in')
    assert(out.startsWith('# Test'), 'content before the region must survive')
    assert(out.includes('Content after the regions must survive.'), 'tail must survive')
  })
})

test('a folded description keeps a Trigger: clause on its continuation line', () => {
  // Regression: an earlier parser treated `Trigger:` as a new YAML key because
  // it looks like `key: value`, and every skill failed validation.
  withRepo({}, (root) => {
    assert(run(root).code === 0, 'folded block with Trigger: should parse')
  })
})

test('is idempotent — a second run changes nothing', () => {
  withRepo({}, (root) => {
    run(root)
    const first = agentsOf(root)
    run(root)
    assert(agentsOf(root) === first, 'second run produced different bytes')
    assert(run(root, ['--check']).code === 0, '--check should pass right after a write')
  })
})

test('emits Prettier-shaped tables — every row padded to one width', () => {
  withRepo({ skills: [skill(), skill({ name: 'beta-much-longer-name' })] }, (root) => {
    run(root)
    const rows = agentsOf(root)
      .split('\n')
      .filter((l) => l.startsWith('|'))
    const widths = new Set(rows.map((r) => r.length))
    // Two tables, so at most two distinct widths; never one width per row.
    assert(widths.size <= 2, `expected padded columns, got ${widths.size} distinct row widths`)
  })
})

test('sorts rows so output is stable regardless of directory order', () => {
  withRepo({ skills: [skill({ name: 'zulu' }), skill({ name: 'alpha' })] }, (root) => {
    run(root)
    const out = agentsOf(root)
    assert(out.indexOf('`alpha`') < out.indexOf('`zulu`'), 'rows should be sorted')
  })
})

// ── the refusals ───────────────────────────────────────────────────────────

test('refuses a name that does not match its directory', () => {
  withRepo({ skills: [skill({ name: 'alpha' })], dirNames: ['not-alpha'] }, (root) => {
    refuses(run(root), 'must match its directory name')
  })
})

test('refuses a description with no Trigger: clause', () => {
  withRepo({ skills: [skill({ description: 'No trigger here at all.' })] }, (root) => {
    refuses(run(root), 'Trigger:')
  })
})

test('refuses an unquoted version, which YAML would read as a float', () => {
  withRepo({ skills: [skill({ version: '1.0' })] }, (root) => {
    refuses(run(root), 'quoted string')
  })
})

test('refuses an unknown scope instead of registering the skill nowhere', () => {
  withRepo({ skills: [skill({ scope: '[renderer]' })] }, (root) => {
    refuses(run(root), 'unknown `metadata.scope`')
  })
})

test('refuses a skill with no auto_invoke', () => {
  withRepo({ skills: [skill({ autoInvoke: [] })] }, (root) => {
    refuses(run(root), 'auto_invoke')
  })
})

test('refuses an AGENTS.md that is missing its markers', () => {
  withRepo({ agents: '# Test\n\nNo markers anywhere.\n' }, (root) => {
    refuses(run(root), 'missing the generated region')
  })
})

test('refuses when the AGENTS.md a scope points at does not exist', () => {
  withRepo({ agents: null }, (root) => {
    refuses(run(root), 'does not exist')
  })
})

test('refuses an unknown flag and an unknown --scope value', () => {
  withRepo({}, (root) => {
    refuses(run(root, ['--nope']), 'Unknown option')
    refuses(run(root, ['--scope', 'renderer']), 'Unknown scope')
  })
})

// ── modes ──────────────────────────────────────────────────────────────────

test('--check reports staleness without writing', () => {
  withRepo({}, (root) => {
    const before = agentsOf(root)
    const result = run(root, ['--check'])
    assert(result.code === 1, 'stale file should exit 1')
    assert(agentsOf(root) === before, '--check must not write')
  })
})

test('--dry-run prints the tables and changes nothing', () => {
  withRepo({}, (root) => {
    const before = agentsOf(root)
    const result = run(root, ['--dry-run'])
    assert(result.code === 0, `--dry-run should succeed, got:\n${result.out}`)
    assert(result.out.includes('doing an alpha thing'), 'should print the table')
    assert(agentsOf(root) === before, '--dry-run must not write')
  })
})

test('normalises a CRLF AGENTS.md to LF, as .gitattributes requires', () => {
  withRepo({ agents: AGENTS_TEMPLATE.replace(/\n/g, '\r\n') }, (root) => {
    run(root)
    assert(!agentsOf(root).includes('\r\n'), 'output should contain no CRLF')
    assert(run(root, ['--check']).code === 0, 'should be up to date after normalising')
  })
})

// ── the main/ tree region ──────────────────────────────────────────────────

/**
 * The generated lines between the main-tree markers, without the blank line
 * Prettier requires each side of a marker.
 */
const mainTreeRegion = (root) =>
  agentsOf(root)
    .split('<!-- BEGIN GENERATED: main-tree -->')[1]
    .split('<!-- END GENERATED: main-tree -->')[0]
    .trim()
    .split('\n')

/**
 * The region as one sentence again. The bullet is wrapped, so a gloss can
 * straddle a line break — unwrap before asserting on wording, and leave the
 * wrapping to the test that is about wrapping.
 */
const mainTreeSentence = (root) =>
  mainTreeRegion(root)
    .map((l) => l.trim())
    .join(' ')

test('lists the directories that are actually under src/main, with their glosses', () => {
  withRepo({ mainDirs: ['runtime', 'adapters', 'tier'] }, (root) => {
    const result = run(root)
    assert(result.code === 0, `expected success, got:\n${result.out}`)
    const sentence = mainTreeSentence(root)
    assert(sentence.includes('`adapters` (fs and sqlite seams with their fakes)'), 'gloss missing')
    assert(sentence.includes('`runtime` (the poll loop)'), 'gloss missing')
    // `tier` is in the gloss table with no phrase — bare on purpose, no parens.
    assert(sentence.endsWith('`tier`.'), 'a deliberately bare directory renders as a bare name')
    assert(
      sentence.indexOf('`adapters`') < sentence.indexOf('`runtime`'),
      'the list should be sorted'
    )
  })
})

test('a directory with no gloss appears as its bare name, and the run says so', () => {
  withRepo({ mainDirs: ['adapters', 'telemetry'] }, (root) => {
    const result = run(root)
    assert(result.code === 0, `a missing gloss must not fail the build, got:\n${result.out}`)
    const sentence = mainTreeSentence(root)
    assert(sentence.includes('`telemetry`'), 'a new directory must appear, not be skipped')
    assert(!sentence.includes('`telemetry` ('), 'a gloss must never be invented')
    assert(result.out.includes('telemetry'), 'the run should name the unglossed directory')
    assert(/no gloss/i.test(result.out), `expected a gloss warning, got:\n${result.out}`)
    assert(run(root, ['--check']).code === 0, '--check must pass, warning and all')
  })
})

test('a directory that goes away disappears from the bullet', () => {
  withRepo({ mainDirs: ['adapters', 'runtime'] }, (root) => {
    run(root)
    assert(agentsOf(root).includes('`runtime`'), 'precondition: runtime was listed')
    rmSync(path.join(root, 'src', 'main', 'runtime'), { recursive: true, force: true })
    assert(run(root).code === 0, 'should regenerate after a removal')
    assert(!agentsOf(root).includes('`runtime`'), 'a removed directory must not survive')
  })
})

test('wraps the bullet inside the column limit, with a two-space hanging indent', () => {
  withRepo({ mainDirs: MANY_MAIN_DIRS }, (root) => {
    run(root)
    const lines = mainTreeRegion(root)
    assert(lines.length > 1, 'a list this long has to wrap')
    const tooWide = lines.filter((l) => l.length > 100)
    assert(tooWide.length === 0, `lines over 100 columns: ${tooWide.map((l) => l.length)}`)
    assert(lines[0].startsWith('- **`main/`**'), `first line was: ${lines[0]}`)
    for (const line of lines.slice(1)) {
      assert(line.startsWith('  ') && line.trim() !== '', `bad continuation line: ${line}`)
    }
  })
})

test('--check catches a directory added without regenerating', () => {
  withRepo({ mainDirs: ['adapters'] }, (root) => {
    run(root)
    assert(run(root, ['--check']).code === 0, 'precondition: up to date after a write')
    mkdirSync(path.join(root, 'src', 'main', 'projects'), { recursive: true })
    const before = agentsOf(root)
    const result = run(root, ['--check'])
    assert(result.code === 1, 'a directory added by hand should read as stale')
    assert(result.out.includes('out of date'), `expected a staleness report, got:\n${result.out}`)
    assert(agentsOf(root) === before, '--check must not write')
  })
})

test('refuses to exceed the line budget AGENTS.md declares for itself', () => {
  const padding = Array.from({ length: 200 }, (_, i) => `Filler line ${i}.`).join('\n\n')
  withRepo({ agents: `${AGENTS_TEMPLATE}\n${padding}\n` }, (root) => {
    const before = agentsOf(root)
    refuses(run(root, ['--check']), 'budget')
    refuses(run(root), 'budget')
    assert(agentsOf(root) === before, 'an over-budget file must not be written')
  })
})

test('refuses when src/main does not exist', () => {
  withRepo({ mainDirs: null }, (root) => {
    refuses(run(root), 'src/main')
  })
})

// ── report ─────────────────────────────────────────────────────────────────

for (const root of cleanup) rmSync(root, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} failing:\n`)
  for (const f of failures) console.error(`  ✗ ${f}\n`)
  process.exit(1)
}
console.log(`${passed} passing.`)
