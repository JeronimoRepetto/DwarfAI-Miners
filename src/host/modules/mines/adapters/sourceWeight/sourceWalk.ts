// The source-weight walk of FsSourceWeightScanner (16 §4.1), transplanted from
// src/main/tier/tierService.ts `sumSourceBytes` at `0bfd108` (05 §6 row "Tier/weight", T): the
// same measured skip list, source-ish extensions, file cap, bundle ceiling, generated-name
// suffixes and duplicate fingerprint (#37, #39). What changed for the Host: the abort is checked
// before each directory (ADR-030, S3.15), a root that cannot be listed is `{ unenterable }` with
// the io's error instead of weighing 0 (S3.11), and the walk runs in a worker (HR O2).
//
// `sumSourceWeight` is SELF-CONTAINED: it reads only its parameters and language globals, never a
// module binding, because the adapter builds its worker from the function's source text. The
// rules travel as data (`workerData`) and the file system as `io`. Keep it that way: a reference
// to anything outside the function body would throw inside the worker (`sourceWalk.test.ts`
// rebuilds it from its text to prove it).

/** The walk's rules, plain data so they can be posted to the worker. */
export interface SourceWalkRules {
  /** Directories that never count toward the weight, matched by exact name. */
  readonly skipDirs: readonly string[]
  /** Source-ish extensions, without the dot, matched without case. */
  readonly sourceExtensions: readonly string[]
  /** The walk stops once this many source-ish files have been visited (counted or skipped). */
  readonly fileCap: number
  /** A source-ish file over this many bytes is a bundle or generated data, never counted. */
  readonly bundleCeilingBytes: number
  /** Name suffixes of generated output, matched without case, never counted. */
  readonly generatedNameSuffixes: readonly string[]
  /** Bytes from the start of a file that, with its size, identify a byte-identical copy. */
  readonly duplicateSampleBytes: number
}

export interface SourceWalkEntry {
  readonly name: string
  readonly isDirectory: boolean
}

/** What the walk needs of a file system; the worker's is node:fs, the tests' a FakeFs. */
export interface SourceWalkIo {
  /** A directory's entries, or the reason it cannot be listed (`not-found`, `access-denied`, …). */
  list(path: string): Promise<{ ok: true; value: SourceWalkEntry[] } | { ok: false; error: string }>
  /** A file's size in bytes, or null when it cannot be read. */
  size(path: string): Promise<number | null>
  /** A key equal for byte-identical files: the size and a hash of the first `sampleBytes`. */
  fingerprint(path: string, size: number, sampleBytes: number): Promise<string>
  /** `dir` and `name` joined by the separator of the walked folder's own platform. */
  join(dir: string, name: string): string
}

/** The weight, or why there is none: the root's io error, or `aborted`. */
export type SourceWalkOutcome = { bytes: number } | { unenterable: string }

/**
 * Per-file byte ceiling above which a "source" file is treated as a bundle, minified artifact or
 * generated data rather than something a person typed (#39): comfortably above a long
 * hand-written file, about 8x smaller than the 2.3 MB vendored script that first inflated a
 * gold-sized project to a uranium-sized one by itself.
 */
export const BUNDLE_SIZE_CEILING_BYTES = 300 * 1024

/** The measured rules (`tierService.ts` at `0bfd108`). */
export const SOURCE_WALK_RULES: SourceWalkRules = {
  // `release` and `build` were added after measuring a packaged project: `release/` alone held
  // 836 MB of a 1 536 MB checkout, none of it hand-written source (#37).
  skipDirs: ['node_modules', '.git', 'dist', 'out', '.venv', 'target', 'release', 'build'],
  sourceExtensions: [
    'adb',
    'ads',
    'astro',
    'c',
    'cbl',
    'cc',
    'clj',
    'cljs',
    'cob',
    'cpp',
    'cr',
    'cs',
    'css',
    'd',
    'dart',
    'elm',
    'erl',
    'ex',
    'exs',
    'f90',
    'f95',
    'fs',
    'fsx',
    'go',
    'groovy',
    'gvy',
    'h',
    'hcl',
    'hpp',
    'hrl',
    'hs',
    'html',
    'java',
    'jl',
    'js',
    'jsx',
    'kt',
    'kts',
    'less',
    'lisp',
    'lsp',
    'lua',
    'm',
    'ml',
    'mli',
    'mm',
    'mjs',
    'nim',
    'nix',
    'php',
    'pl',
    'pm',
    'ps1',
    'py',
    'r',
    'R',
    'rb',
    'rs',
    'rkt',
    'scala',
    'scm',
    'scss',
    'sh',
    'sol',
    'sql',
    'ss',
    'svelte',
    'swift',
    't',
    'tf',
    'tfvars',
    'ts',
    'tsx',
    'v',
    'vue',
    'zig'
  ],
  fileCap: 3000,
  bundleCeilingBytes: BUNDLE_SIZE_CEILING_BYTES,
  // `.map` is forward-looking: no extension above ends in "map", so a source map is already not
  // source-ish (#39).
  generatedNameSuffixes: ['.min.js', '.min.css', '.bundle.js', '-bundle.js', '.map'],
  // A fixed, small prefix keeps the duplicate check affordable: two distinct files sharing both
  // size and their first 4 KB would be taken as copies, a known, accepted risk (#39).
  duplicateSampleBytes: 4096
}

/**
 * Bounded breadth-first walk summing the byte size of source-ish files under `root`. Before each
 * directory it asks `isAborted` and stops with `{ unenterable: 'aborted' }`. The root's listing
 * error is the outcome's reason; a subfolder that cannot be listed or a file that cannot be read
 * is skipped. Three exclusions run before a file's bytes reach the sum (#39): a generated-output
 * name, a size over the bundle ceiling, and a byte-identical copy of a file already counted (scoped
 * to this walk). Each exclusion still spends one file-cap slot: the cap bounds files visited.
 */
export async function sumSourceWeight(
  root: string,
  rules: SourceWalkRules,
  io: SourceWalkIo,
  isAborted: () => boolean
): Promise<SourceWalkOutcome> {
  const skipDirs = new Set(rules.skipDirs)
  const extensions = new Set(rules.sourceExtensions.map((extension) => extension.toLowerCase()))
  const suffixes = rules.generatedNameSuffixes.map((suffix) => suffix.toLowerCase())
  const seen = new Set<string>()
  let bytes = 0
  let filesSeen = 0
  const queue: string[] = [root]
  while (queue.length > 0 && filesSeen < rules.fileCap) {
    if (isAborted()) return { unenterable: 'aborted' }
    const dir = queue.shift() as string
    const listed = await io.list(dir)
    if (!listed.ok) {
      if (dir === root) return { unenterable: listed.error }
      continue
    }
    for (const entry of listed.value) {
      const path = io.join(dir, entry.name)
      if (entry.isDirectory) {
        if (!skipDirs.has(entry.name)) queue.push(path)
        continue
      }
      const dotAt = entry.name.lastIndexOf('.')
      if (dotAt <= 0 || !extensions.has(entry.name.slice(dotAt + 1).toLowerCase())) continue
      filesSeen++
      const lower = entry.name.toLowerCase()
      if (!suffixes.some((suffix) => lower.endsWith(suffix))) {
        const size = (await io.size(path)) ?? 0
        if (size <= rules.bundleCeilingBytes) {
          const key = await io.fingerprint(path, size, rules.duplicateSampleBytes)
          if (!seen.has(key)) {
            seen.add(key)
            bytes += size
          }
        }
      }
      if (filesSeen >= rules.fileCap) return { bytes }
    }
  }
  return { bytes }
}
