import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ESLint } from 'eslint'
import { cruiseTree } from './depcruise-fixture.mjs'

/**
 * The canary job (05 §5.2 "Canary fixtures", ADR-004 item 3, 17 §1.7).
 *
 * `lint-canaries/<name>/` holds one minimal violating tree (paths as they must sit in a
 * repository, `src/…`) and a one-line `expect.json` `{ "rule": "<exact rule name>", "tool":
 * "depcruise" | "eslint" }`. `<name>` starts with the architecture rule id it proves (`R1` …
 * `R19`, optionally followed by `-<suffix>`, e.g. `R11-no-claude-agent-sdk`), or, for a static rule
 * outside 05 §5.1 that 17 §1.7 still gives a lint, with the ADR that owns it (`ADR-026-no-console`:
 * `console.*` only in the logger, ADR-026 Verification).
 *
 * For each canary the runner writes the tree into a fresh scratch directory and runs both tools
 * on it with the repository's own configs, read in place (so the scratch run can never drift from
 * the real config): dependency-cruiser through `depcruise-fixture.mjs` (the pinned CLI, the
 * repository's `.dependency-cruiser.cjs`, stub packages for every bare import), and ESLint through
 * its Node API with the repository's `eslint.config.mjs` and the scratch directory as `cwd`, which
 * is then the base path of every `files` pattern (ESLint's config loader uses `cwd` as the base
 * path whenever the config file is given explicitly).
 *
 * "Exactly its rule" (05 §5.2): every violation either tool reports must belong to the canary's
 * architecture rule (a dependency-cruiser rule named `R<n>-…`, or an ESLint message tagged
 * `R<n> (…)`), and the exact rule named in `expect.json` must be among the violations of its tool.
 * The same rule's mirror in the other tool (R1, R7, R8 and R16 live in both, 05 §5.1) is the same
 * rule, not another one. Zero violations, another architecture rule, or any ESLint rule outside
 * R1–R19 fails the canary. The job exits 1 when any canary fails or none is found.
 *
 * Usage: `node scripts/checks/run-canaries.mjs [--canaries <dir>]` (`pnpm test:canaries`).
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

export const CANARIES_DIR = path.join(repoRoot, 'lint-canaries')
const ESLINT_CONFIG_PATH = path.join(repoRoot, 'eslint.config.mjs')
const SCRATCH_MODULE = 'src/scratch.ts'

/** ESLint rules of 05 §5.3 whose message carries no rule tag, and the rule each one enforces. */
const UNTAGGED_ESLINT_RULES = {
  'vue/no-v-html': ['R19'],
  '@typescript-eslint/consistent-type-imports': ['R2'],
  'no-console': ['ADR-026']
}

const RULE_ID = /^(?:R(?:[1-9]|1[0-9])|ADR-\d{3})(?=$|-)/
const MESSAGE_TAG = /\b(R\d{1,2}(?:\/R\d{1,2})*) \(/

/** Node core modules and the packages dependency-cruiser treats as built-ins (`electron`). */
const BUILT_INS = new Set([...builtinModules, 'electron'])

function listFiles(dir, prefix = '') {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...listFiles(path.join(dir, entry.name), relative))
    else files.push(relative)
  }
  return files
}

/**
 * Reads every canary directory.
 *
 * @param {string} [dir]
 * @returns {{ name: string, ruleId: string, rule: string, tool: 'depcruise' | 'eslint', files: Record<string, string> }[]}
 */
export function loadCanaries(dir = CANARIES_DIR) {
  const canaries = []
  for (const name of readdirSync(dir).sort()) {
    const canaryDir = path.join(dir, name)
    if (!statSync(canaryDir).isDirectory()) continue
    const ruleId = RULE_ID.exec(name)?.[0]
    if (ruleId === undefined) {
      throw new Error(`${name}: a canary directory starts with R1…R19 or ADR-<nnn>`)
    }
    const { rule, tool } = JSON.parse(readFileSync(path.join(canaryDir, 'expect.json'), 'utf8'))
    if (tool !== 'depcruise' && tool !== 'eslint') {
      throw new Error(`${name}: expect.json tool must be "depcruise" or "eslint"`)
    }
    const files = {}
    for (const file of listFiles(canaryDir)) {
      if (file === 'expect.json') continue
      files[file] = readFileSync(path.join(canaryDir, ...file.split('/')), 'utf8')
    }
    canaries.push({ name, ruleId, rule, tool, files })
  }
  return canaries
}

/** The bare package names a tree imports (stub packages for dependency-cruiser to resolve). */
function importedPackages(files) {
  const packages = new Set()
  const specifiers = /(?:from|import)\s*\(?\s*'([^']+)'/g
  for (const content of Object.values(files)) {
    for (const [, specifier] of content.matchAll(specifiers)) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
      const parts = specifier.split('/')
      const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
      if (!BUILT_INS.has(name)) packages.add(name)
    }
  }
  return [...packages].sort()
}

/** The architecture rule ids an ESLint message belongs to. */
function eslintRuleIds(message) {
  const tag = MESSAGE_TAG.exec(message.message)
  if (tag) return tag[1].split('/')
  return UNTAGGED_ESLINT_RULES[message.ruleId] ?? []
}

async function lintTree(root) {
  const eslint = new ESLint({ cwd: root, overrideConfigFile: ESLINT_CONFIG_PATH })
  const results = await eslint.lintFiles(['src'])
  return results.flatMap((result) =>
    result.messages
      .filter((message) => message.severity === 2)
      .map((message) => ({
        tool: 'eslint',
        rule: message.ruleId ?? 'fatal-parse-error',
        ruleIds: eslintRuleIds(message),
        file: path.relative(root, result.filePath).split(path.sep).join('/'),
        message: message.message
      }))
  )
}

/**
 * Decides whether a canary's violations are exactly its rule.
 *
 * @param {{ ruleId: string, rule: string, tool: string }} canary
 * @param {{ tool: string, rule: string, ruleIds: string[] }[]} violations
 * @returns {{ ok: boolean, reason: string }}
 */
export function judgeCanary(canary, violations) {
  if (violations.length === 0) return { ok: false, reason: 'no violation reported' }
  const foreign = violations.filter((violation) => !violation.ruleIds.includes(canary.ruleId))
  if (foreign.length > 0) {
    const names = foreign.map((violation) => `${violation.tool} ${violation.rule}`)
    return { ok: false, reason: `other rules reported: ${[...new Set(names)].join(', ')}` }
  }
  const named = violations.some(
    (violation) => violation.tool === canary.tool && violation.rule === canary.rule
  )
  if (!named) return { ok: false, reason: `${canary.tool} did not report ${canary.rule}` }
  return { ok: true, reason: `${canary.tool} reported ${canary.rule}` }
}

/**
 * Writes the canary into a scratch tree, runs both tools, and judges the result.
 *
 * @param {{ name: string, ruleId: string, rule: string, tool: string, files: Record<string, string> }} canary
 */
export async function runCanary(canary) {
  // The scratch tsconfig includes `src/**/*.ts`; TypeScript refuses an include that matches nothing,
  // so a tree of `.vue` files only gets one inert module beside it.
  const hasTs = Object.keys(canary.files).some((file) => file.endsWith('.ts'))
  const files = hasTs ? canary.files : { ...canary.files, [SCRATCH_MODULE]: 'export {}\n' }
  let cruised
  try {
    cruised = await cruiseTree({ files, dependencies: importedPackages(files) })
  } catch (error) {
    return { ok: false, reason: `dependency-cruiser failed: ${error.message}`, violations: [] }
  }
  try {
    const violations = [
      ...cruised.violations.map((violation) => ({
        tool: 'depcruise',
        rule: violation.rule,
        ruleIds: [RULE_ID.exec(violation.rule)?.[0]].filter(Boolean),
        file: violation.from,
        message: `${violation.from} -> ${violation.to}`
      })),
      ...(await lintTree(cruised.root))
    ]
    return { ...judgeCanary(canary, violations), violations }
  } finally {
    rmSync(cruised.root, { recursive: true, force: true })
  }
}

async function main(argv) {
  const flag = argv.indexOf('--canaries')
  const dir = flag === -1 ? CANARIES_DIR : path.resolve(argv[flag + 1])
  const canaries = loadCanaries(dir)
  if (canaries.length === 0) {
    console.error(`no canary found in ${dir}`)
    return 1
  }
  let failed = 0
  // One canary at a time: each run spawns dependency-cruiser and TypeScript.
  for (const canary of canaries) {
    const result = await runCanary(canary)
    if (result.ok) {
      console.log(`ok    ${canary.name}: ${result.reason}`)
      continue
    }
    failed += 1
    console.error(`FAIL  ${canary.name}: ${result.reason}`)
    for (const violation of result.violations) {
      console.error(`        ${violation.tool} ${violation.rule} ${violation.message}`)
    }
  }
  console.log(`${canaries.length - failed}/${canaries.length} canaries report exactly their rule`)
  return failed === 0 ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2))
}
