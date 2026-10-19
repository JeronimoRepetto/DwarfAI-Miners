import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Test helper for `depcruise-rules.test.mjs` (05 §5.2, 17 §1.7).
 *
 * Writes a minimal source tree into a fresh `mkdtemp` directory and runs the pinned
 * dependency-cruiser CLI on it with the repository's `.dependency-cruiser.cjs`, exactly as
 * `pnpm depcruise` does (`depcruise src --config .dependency-cruiser.cjs`), with JSON output.
 * The rule paths of the config are relative to the working directory, so the CLI runs with the
 * temp directory as its cwd.
 *
 * Next to the given files the tree holds what the resolver needs and nothing more: a
 * `package.json` that declares the stub packages, one stub package per declared name, and the
 * `tsconfig.node.json` the config names. Stub packages are laid out the way pnpm installs this
 * repository: `node_modules/<name>` links to `node_modules/.pnpm/<name>@<version>/node_modules/<name>`,
 * so a package import resolves to the same kind of path it resolves to in the real tree.
 */

const execFileAsync = promisify(execFile)

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

export const DEFAULT_CONFIG_PATH = path.join(repoRoot, '.dependency-cruiser.cjs')
const CLI_PATH = path.join(
  repoRoot,
  'node_modules',
  'dependency-cruiser',
  'bin',
  'dependency-cruiser.mjs'
)

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2023',
    module: 'ESNext',
    moduleResolution: 'bundler',
    strict: true,
    noEmit: true
  },
  include: ['src/**/*.ts']
}

function write(root, relativePath, content) {
  const full = path.join(root, ...relativePath.split('/'))
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
}

const STUB_VERSION = '1.0.0'

/** pnpm's store folder name for a package: `@scope/name` becomes `@scope+name`. */
function storeFolder(name) {
  return `${name.replace('/', '+')}@${STUB_VERSION}`
}

function stubPackageFolder(name) {
  return `node_modules/.pnpm/${storeFolder(name)}/node_modules/${name}`
}

/**
 * The path dependency-cruiser reports for an import of the stub package `name`: the link path,
 * because the config keeps symlinks (`preserveSymlinks: true`).
 */
export function stubPackageEntry(name) {
  return `node_modules/${name}/index.js`
}

function writeStubPackage(root, name) {
  const real = stubPackageFolder(name)
  write(
    root,
    `${real}/package.json`,
    JSON.stringify({ name, version: STUB_VERSION, main: 'index.js' })
  )
  write(root, `${real}/index.js`, 'module.exports = {}\n')
  const link = path.join(root, 'node_modules', ...name.split('/'))
  mkdirSync(path.dirname(link), { recursive: true })
  // A junction needs no privilege on Windows; elsewhere the type is ignored and a symlink is made.
  symlinkSync(path.join(root, ...real.split('/')), link, 'junction')
}

/**
 * Writes the tree and cruises it.
 *
 * @param {object} tree
 * @param {Record<string, string>} tree.files posix path (relative to the tree root) → content
 * @param {string[]} [tree.dependencies] stub packages declared under `dependencies`
 * @param {string[]} [tree.devDependencies] stub packages declared under `devDependencies`
 * @param {string} [tree.configPath] the dependency-cruiser config to use
 * @returns {Promise<{ root: string, violations: { rule: string, from: string, to: string }[], ruleNames: string[] }>}
 */
export async function cruiseTree({
  files,
  dependencies = [],
  devDependencies = [],
  configPath = DEFAULT_CONFIG_PATH
}) {
  const root = mkdtempSync(path.join(tmpdir(), 'depcruise-rules-'))
  const asMap = (names) => Object.fromEntries(names.map((name) => [name, STUB_VERSION]))
  write(
    root,
    'package.json',
    JSON.stringify({
      name: 'depcruise-fixture',
      private: true,
      dependencies: asMap(dependencies),
      devDependencies: asMap(devDependencies)
    })
  )
  write(root, 'tsconfig.node.json', JSON.stringify(TSCONFIG))
  for (const name of [...dependencies, ...devDependencies]) writeStubPackage(root, name)
  for (const [relativePath, content] of Object.entries(files)) write(root, relativePath, content)

  const args = [CLI_PATH, 'src', '--config', configPath, '--output-type', 'json']
  let stdout
  try {
    ;({ stdout } = await execFileAsync(process.execPath, args, { cwd: root, maxBuffer: 1 << 26 }))
  } catch (error) {
    // The CLI exits non-zero when it reports error-severity violations; the JSON is still on stdout.
    if (typeof error.stdout !== 'string' || error.stdout.trim() === '') throw error
    stdout = error.stdout
  }
  const result = JSON.parse(stdout)
  const violations = result.summary.violations.map((violation) => ({
    rule: violation.rule.name,
    from: violation.from,
    to: violation.to
  }))
  const ruleNames = [...new Set(violations.map((violation) => violation.rule))].sort()
  return { root, violations, ruleNames }
}
