// layer: L7
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * trace:check (17 §3.2) and the id catalogs it compares with.
 *
 * Each case assembles a repository root in its own `mkdtemp` directory: the `traceability.json`
 * the extractor writes for one of the `__fixtures__/` trees, `scripts/traceability/closed.json`,
 * `scripts/traceability/mapped.baseline.json` and, when the case needs them, the synthetic
 * catalogs of `__fixtures__/catalogs/` or a small synthetic architecture package under git. The
 * real scripts run as child processes, so the exit code and the printed lines are what is proven.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const fixtures = path.join(here, '__fixtures__')
const extractorPath = path.join(here, 'extract.mjs')
const checkPath = path.join(here, 'check.mjs')
const builderPath = path.join(here, 'build-catalogs.mjs')

const SKIP_NOTICE = 'architecture package not present: catalog check skipped'
const CATALOG_FILES = [
  'acs.json',
  'adrs.json',
  'brs.json',
  'chs.json',
  'conformance.json',
  'fms.json',
  'invs.json',
  'manual.json',
  'nfrs.json',
  'rules.json',
  'spikes.json',
  'transitions.json'
]

let tempRoots = []

afterEach(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true })
  tempRoots = []
})

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function writeFile(file, content) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function node(script, args) {
  const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

/**
 * A repository root holding the traceability of `testTree` (a repository-shaped tree), the given
 * `closed` and `baseline` lists and, when `catalogs` is a directory, a copy of its catalogs.
 */
function makeRoot({ testTree, closed = [], baseline = [], catalogs = null }) {
  const root = tempDir('trace-check-')
  const extracted = node(extractorPath, [
    '--root',
    testTree,
    '--out',
    path.join(root, 'traceability.json')
  ])
  expect(extracted.status, extracted.stderr).toBe(0)
  writeFile(path.join(root, 'scripts/traceability/closed.json'), `${JSON.stringify(closed)}\n`)
  writeFile(
    path.join(root, 'scripts/traceability/mapped.baseline.json'),
    `${JSON.stringify(baseline)}\n`
  )
  if (catalogs)
    cpSync(catalogs, path.join(root, 'scripts/traceability/catalogs'), { recursive: true })
  return root
}

const check = (root, args = []) => node(checkPath, ['--root', root, ...args])

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * A small synthetic architecture package, committed in its own git repository as the real one
 * is. Each document holds only the lines its catalog is read from, plus lines that look alike but
 * sit outside the owning section, so the section scoping is proven too.
 */
const PACKAGE_FILES = {
  '02-requirements.md': [
    '# 02 — Requirements',
    '',
    'Prose that names NFR-TIM-99 and BR-99 is not a definition.',
    '',
    '## 4. Non-functional requirements',
    '',
    '### 4.1 TIM — timings',
    '',
    '| ID | Statement | Rationale | Source | Verify |',
    '|---|---|---|---|---|',
    '| NFR-TIM-05 | Synthetic timing. | x | x | unit |',
    '| NFR-A11Y-06 | Synthetic keyboard map. | x | x | unit |',
    '',
    '## 5. Cross-cutting business rules',
    '',
    '| ID | Rule | Source |',
    '|---|---|---|',
    '| BR-17 | Synthetic rule. | x |',
    '',
    '<!-- CATALOG -->',
    '',
    '## Story catalog (generated)',
    '',
    '| ID | Title | Modes | Status | ACs |',
    '|---|---|---|---|---|',
    '| US-MSG-001 | Synthetic story | Panel | Draft | 2 |',
    '',
    '### US-MSG-001 — Synthetic story',
    '',
    '- **US-MSG-001.AC03** `happy` **Given** a **when** b **then** c.',
    '- **US-MSG-001.AC04** `edge` **Given** a **when** b **then** c.',
    '- **US-OBS-001.AC01** `error` **Given** a **when** b **then** c.',
    ''
  ],
  '05-modules-and-ports.md': [
    '# 05',
    '',
    '### 5.1 Rule set',
    '',
    '| ID | Rule | ADR-004 | Tool |',
    '|---|---|---|---|',
    '| R1 | Synthetic rule. | P1 | lint |',
    '| R19 | Synthetic rule. | — | lint |',
    '',
    '### 5.2 Other',
    '',
    '| R42 | Not in the rule set. | — | — |',
    ''
  ],
  '06-domain-model.md': [
    '# 06',
    '',
    '- **INV-01** Synthetic invariant.',
    '  - **INV-122** Synthetic nested invariant.',
    '',
    'Prose that cites INV-50 is not a definition.',
    ''
  ],
  '07-state-machines.md': [
    '# 07',
    '',
    '| Id | From → To | Trigger | Guard | Actions |',
    '|---|---|---|---|---|',
    '| S1.01 | a → b | x | — | x |',
    '| S5.08a | a → b | x | — | x |',
    '| S12.B09 | a → b | x | — | x |',
    '| S12.C01 | a → b | x | — | x |',
    '',
    '## 21. Cross-machine table',
    '',
    '| S1.01–S1.05 | a range is a citation, not a transition |',
    ''
  ],
  '13-failure-matrix.md': [
    '# 13',
    '',
    '| Id | Failure | Cause |',
    '|---|---|---|',
    '| FM-001 | Synthetic failure. | x |',
    '| FM-150 | Synthetic failure. | x |',
    ''
  ],
  '15-provider-driver.md': [
    '# 15',
    '',
    '## 6. Conformance suite (input to `17-testing-strategy.md`)',
    '',
    '| Case | Input | Expected |',
    '|---|---|---|',
    '| C-01 launch → handshake | x | x |',
    '| C-25b multi-source merge | x | x |',
    '',
    '## 7. Adding a new provider',
    '',
    '| C-99 outside the suite | x | x |',
    ''
  ],
  '17-testing-strategy.md': [
    '# 17',
    '',
    '### 1.10 L10 — Chaos and fault injection',
    '',
    '| Id | Fault | Fake injector (L2/L3) | Real injector (L8/L9) | Proven by (examples) |',
    '|---|---|---|---|---|',
    '| CH-01 | Synthetic fault. | x | x | x |',
    '| CH-11 | Synthetic fault. | x | x | x |',
    '',
    '### 1.11 L11 — Performance budgets',
    '',
    '| CH-12 | Not an injector row. | x | x | x |',
    ''
  ],
  '20-build-release.md': [
    '# 20',
    '',
    '## 8. Release checklist',
    '',
    '| ID | Item | Blocks release | Source |',
    '|---|---|---|---|',
    '| R-01 | Synthetic item. | yes | x |',
    '',
    '### 8.1 Manual check ids',
    '',
    '| Check id | AC / NFR / verification bullet | Scripted step | OS | Run at |',
    '|---|---|---|---|---|',
    '| `MAN-<area>-<nn>` | the id it verifies | steps | Windows | every release |',
    '| `MAN-VETA-03` | US-VETA-001.AC01 | steps | Windows | every release |',
    '',
    '## 9. Owner decisions needed',
    ''
  ],
  '03-adr/README.md': ['# ADRs', ''],
  '03-adr/ADR-001-synthetic-first-decision.md': ['# ADR-001', ''],
  '03-adr/ADR-034-synthetic-last-decision.md': ['# ADR-034', ''],
  '03-adr/spike-register.md': [
    '# Spike register',
    '',
    '| Id | Question | ADR | What it gates | Lane |',
    '|---|---|---|---|---|',
    '| SP-02 | Synthetic question. | ADR-002 | x | x |',
    '| SP-15 (alias: S-030-2) | Synthetic question. | ADR-030 | x | x |',
    '| S-008-1 | Synthetic question. | ADR-008 | x | x |',
    ''
  ]
}

/** The catalogs PACKAGE_FILES must yield, written by hand from the owner documents' id forms. */
const PACKAGE_CATALOG_IDS = {
  acs: {
    'US-MSG-001.AC03': { story: 'US-MSG-001', tag: 'happy' },
    'US-MSG-001.AC04': { story: 'US-MSG-001', tag: 'edge' },
    'US-OBS-001.AC01': { story: 'US-OBS-001', tag: 'error' }
  },
  adrs: ['ADR-001', 'ADR-034'],
  brs: ['BR-17'],
  chs: ['CH-01', 'CH-11'],
  conformance: ['C-01', 'C-25b'],
  fms: ['FM-001', 'FM-150'],
  invs: ['INV-01', 'INV-122'],
  manual: ['MAN-VETA-03'],
  nfrs: ['NFR-A11Y-06', 'NFR-TIM-05'],
  rules: ['R1', 'R19'],
  spikes: ['S-008-1', 'S-030-2', 'SP-02', 'SP-15'],
  transitions: ['S1.01', 'S12.B09', 'S12.C01', 'S5.08a']
}

/** Writes PACKAGE_FILES under `dir`, commits them in a new git repository and returns HEAD. */
function makePackage(dir) {
  for (const [file, lines] of Object.entries(PACKAGE_FILES)) {
    writeFile(path.join(dir, ...file.split('/')), lines.join('\n'))
  }
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  git(dir, ['config', 'core.autocrlf', 'false'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'synthetic package'])
  return git(dir, ['rev-parse', 'HEAD']).trim()
}

/** Every file under `dir`, as sorted posix paths relative to it. */
function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
    )
    .sort()
}

describe('trace:check (17 §3.2)', () => {
  it('[ADR-001] an id cited by a test that no catalog holds fails the check naming the file and title', () => {
    const root = makeRoot({
      testTree: path.join(fixtures, 'typo'),
      catalogs: path.join(fixtures, 'catalogs')
    })

    const run = check(root)

    expect(run.status).toBe(1)
    const title =
      '[US-MSG-001.AC99, US-MSG-001.AC03] marks the message delivered when the channel accepts it'
    expect(run.stderr).toContain(
      `src/host/modules/conversation/application/send.test.ts › ${title}: unknown id US-MSG-001.AC99`
    )
    expect(run.stderr).not.toContain('unknown id US-MSG-001.AC03')
  })

  it('[ADR-001] an AC of closed.json with no test fails the check', () => {
    const catalogs = path.join(fixtures, 'catalogs')
    const testTree = path.join(fixtures, 'mapped')

    const mapped = check(makeRoot({ testTree, catalogs, closed: ['US-MSG-001.AC03'] }))
    const unmapped = check(
      makeRoot({ testTree, catalogs, closed: ['US-MSG-001.AC03', 'US-MSG-001.AC04'] })
    )

    expect(mapped.status, mapped.stderr).toBe(0)
    expect(unmapped.status).toBe(1)
    expect(unmapped.stderr).toContain('closed.json: US-MSG-001.AC04 has no test')
    expect(unmapped.stderr).not.toContain('US-MSG-001.AC03')
  })

  it('[ADR-001] an id in mapped.baseline.json that no test cites any more fails the check', () => {
    const catalogs = path.join(fixtures, 'catalogs')
    const testTree = path.join(fixtures, 'mapped')

    const kept = check(makeRoot({ testTree, catalogs, baseline: ['INV-01', 'NFR-TIM-05'] }))
    const lost = check(
      makeRoot({ testTree, catalogs, baseline: ['BR-17', 'INV-01', 'NFR-TIM-05'] })
    )

    expect(kept.status, kept.stderr).toBe(0)
    expect(lost.status).toBe(1)
    expect(lost.stderr).toContain('mapped.baseline.json: BR-17 lost its last test')
    expect(lost.stderr).not.toContain('INV-01')
  })

  it('[ADR-001] MAN-<area>-<nn> ids are accepted only when manual.json lists them', () => {
    const testTree = path.join(fixtures, 'manual')
    const withoutManual = tempDir('trace-catalogs-')
    cpSync(path.join(fixtures, 'catalogs'), withoutManual, { recursive: true })
    const manualPath = path.join(withoutManual, 'manual.json')
    writeFileSync(
      manualPath,
      `${JSON.stringify({ ...JSON.parse(readFileSync(manualPath, 'utf8')), ids: [] }, null, 2)}\n`
    )
    const file = 'src/renderer/src/lib/veta.test.ts'
    const listed = `${file} › [MAN-VETA-03] follows the scripted release check: unknown id MAN-VETA-03`
    const unlisted = `${file} › [MAN-VETA-04] names a check that the release checklist does not list: unknown id MAN-VETA-04`

    const listedRun = check(makeRoot({ testTree, catalogs: path.join(fixtures, 'catalogs') }))
    const emptyManualRun = check(makeRoot({ testTree, catalogs: withoutManual }))

    expect(listedRun.status).toBe(1)
    expect(listedRun.stderr).toContain(unlisted)
    expect(listedRun.stderr).not.toContain(listed)
    expect(emptyManualRun.status).toBe(1)
    expect(emptyManualRun.stderr).toContain(listed)
  })

  it('[ADR-001] the real repository passes trace:check; without the catalogs the typo check is skipped with a notice and the other checks still run', () => {
    const realClosed = JSON.parse(readFileSync(path.join(here, 'closed.json'), 'utf8'))
    const realBaseline = JSON.parse(readFileSync(path.join(here, 'mapped.baseline.json'), 'utf8'))

    const real = check(makeRoot({ testTree: repoRoot, closed: realClosed, baseline: realBaseline }))
    const closedStillChecked = check(
      makeRoot({ testTree: repoRoot, closed: [...realClosed, 'US-MSG-001.AC04'] })
    )
    const ratchetStillChecked = check(
      makeRoot({ testTree: repoRoot, baseline: [...realBaseline, 'BR-17'] })
    )

    expect(real.status, real.stderr).toBe(0)
    expect(real.stdout).toContain(SKIP_NOTICE)
    expect(closedStillChecked.status).toBe(1)
    expect(closedStillChecked.stdout).toContain(SKIP_NOTICE)
    expect(closedStillChecked.stderr).toContain('closed.json: US-MSG-001.AC04 has no test')
    expect(ratchetStillChecked.status).toBe(1)
    expect(ratchetStillChecked.stdout).toContain(SKIP_NOTICE)
    expect(ratchetStillChecked.stderr).toContain('mapped.baseline.json: BR-17 lost its last test')
  })

  it('[ADR-001] build-catalogs reads each id catalog from its owner document', () => {
    const packageDir = tempDir('trace-package-')
    const revision = makePackage(packageDir)
    const out = tempDir('trace-catalogs-')

    const run = node(builderPath, ['--from', packageDir, '--out', out])

    expect(run.status, run.stderr).toBe(0)
    const catalogs = Object.fromEntries(
      CATALOG_FILES.map((file) => [
        path.basename(file, '.json'),
        JSON.parse(readFileSync(path.join(out, file), 'utf8'))
      ])
    )
    expect(Object.fromEntries(Object.entries(catalogs).map(([name, c]) => [name, c.ids]))).toEqual(
      PACKAGE_CATALOG_IDS
    )
    for (const [name, catalog] of Object.entries(catalogs)) {
      expect(catalog.catalog).toBe(name)
      expect(catalog.revision).toBe(revision)
    }
  })

  it('[ADR-001] build-catalogs run twice on one package revision writes identical catalogs that name it, only under its catalogs folder', () => {
    const packageDir = tempDir('trace-package-')
    const revision = makePackage(packageDir)
    const out = tempDir('trace-catalogs-')
    const read = () => CATALOG_FILES.map((file) => readFileSync(path.join(out, file), 'utf8'))

    const first = node(builderPath, ['--from', packageDir, '--out', out])
    const firstBytes = read()
    const second = node(builderPath, ['--from', packageDir, '--out', out])

    expect(first.status, first.stderr).toBe(0)
    expect(second.status, second.stderr).toBe(0)
    expect(read()).toEqual(firstBytes)
    expect(filesUnder(out)).toEqual(CATALOG_FILES)
    for (const text of firstBytes) expect(JSON.parse(text).revision).toBe(revision)
    expect(git(packageDir, ['status', '--porcelain', '--untracked-files=all'])).toBe('')
    // The default output folder and the extractor's output are git-ignored in this repository.
    const ignored = ['scripts/traceability/catalogs/acs.json', 'traceability.json'].filter(
      (file) => spawnSync('git', ['check-ignore', '-q', file], { cwd: repoRoot }).status === 0
    )
    expect(ignored).toEqual(['scripts/traceability/catalogs/acs.json', 'traceability.json'])
  })

  it('[ADR-001] build-catalogs refuses a package that is not the root of its own git repository', () => {
    const packageDir = tempDir('trace-package-')
    for (const [file, lines] of Object.entries(PACKAGE_FILES)) {
      writeFile(path.join(packageDir, ...file.split('/')), lines.join('\n'))
    }
    const out = tempDir('trace-catalogs-')

    const run = node(builderPath, ['--from', packageDir, '--out', out])

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('not the root of its own git repository')
    expect(filesUnder(out)).toEqual([])
  })

  it('[ADR-001] with the package present trace:check builds the catalogs from it and runs the catalog check', () => {
    const root = makeRoot({ testTree: path.join(fixtures, 'typo') })
    const packageDir = path.join(root, 'new-architecture', 'DwarfAI-Miners-Architecture')
    const revision = makePackage(packageDir)

    const run = check(root)

    expect(run.status).toBe(1)
    expect(run.stdout).toContain(`catalog check: package revision ${revision}`)
    expect(run.stderr).toContain('unknown id US-MSG-001.AC99')
    expect(run.stderr).not.toContain('unknown id US-MSG-001.AC03')
    expect(filesUnder(path.join(root, 'scripts/traceability/catalogs'))).toEqual(CATALOG_FILES)
  })

  it('[ADR-001] a --from path that does not exist fails trace:check', () => {
    const root = makeRoot({ testTree: path.join(fixtures, 'mapped') })
    const missing = path.join(root, 'no-such-package')

    const run = check(root, ['--from', missing])

    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`--from path does not exist: ${missing}`)
    expect(run.stdout).not.toContain(SKIP_NOTICE)
  })

  it('[ADR-001] an incomplete catalogs folder fails trace:check instead of skipping the catalog check', () => {
    const catalogs = tempDir('trace-catalogs-')
    cpSync(path.join(fixtures, 'catalogs'), catalogs, { recursive: true })
    rmSync(path.join(catalogs, 'fms.json'))

    const run = check(makeRoot({ testTree: path.join(fixtures, 'mapped'), catalogs }))

    expect(run.status).toBe(1)
    expect(run.stderr).toContain('catalogs incomplete: fms.json is missing')
    expect(run.stdout).not.toContain(SKIP_NOTICE)
  })
})
