#!/usr/bin/env node
// The SHA256SUMS file of an internal cut build (20 §3.2 lists `SHA256SUMS` among every OS's artifacts).
//
//   node scripts/ci/sha256sums.mjs <dir> <suffix>...   writes <dir>/SHA256SUMS for the top-level files of <dir> whose
//                                                      names end in one of the suffixes, e.g. `release .dmg .zip`
//
// The text format is GNU coreutils' `sha256sum` (`<hex>  <name>`, or `<hex> *<name>` in binary mode), so the owner can
// also check a download by hand with `sha256sum -c SHA256SUMS`. .github/workflows/internal-build.yml writes it on each
// packaging leg; scripts/ci/fetch-internal-build.mjs verifies each downloaded artifact against it.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SUMS_FILE = 'SHA256SUMS'

const LINE = /^([0-9a-f]{64}) [ *](.+)$/

/** The SHA-256 of one file, as lowercase hex. */
function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** `<hash>  <name>` lines, sorted by name, each ending in a newline. */
export function formatSha256Sums(entries) {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, hash }) => `${hash}  ${name}\n`)
    .join('')
}

/** The entries of a SHA256SUMS text, and a problem per line that is neither one nor blank. */
export function parseSha256Sums(text) {
  const entries = []
  const problems = []
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return
    const match = LINE.exec(line)
    if (match) entries.push({ name: match[2], hash: match[1] })
    else problems.push(`line ${i + 1} is not "<sha256>  <file name>"`)
  })
  return { entries, problems }
}

/** Writes `<dir>/SHA256SUMS` for the top-level files ending in one of `suffixes`; answers what it listed. */
export function writeSha256Sums(dir, suffixes) {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== SUMS_FILE)
    .filter((entry) => suffixes.some((suffix) => entry.name.endsWith(suffix)))
    .map((entry) => ({ name: entry.name, hash: hashFile(path.join(dir, entry.name)) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (entries.length === 0) {
    throw new Error(`${dir} holds no file ending in ${suffixes.join(', ')}`)
  }
  writeFileSync(path.join(dir, SUMS_FILE), formatSha256Sums(entries))
  return entries
}

/**
 * Checks every file of `dir` against `dir/SHA256SUMS`: each listed file exists and matches, the list is not empty,
 * and no other file is in the folder. `verified` holds the names that matched, and only when the whole folder did.
 */
export function verifySha256Sums(dir) {
  const sumsPath = path.join(dir, SUMS_FILE)
  if (!existsSync(sumsPath))
    return { ok: false, verified: [], problems: [`${SUMS_FILE} is missing`] }
  const { entries, problems } = parseSha256Sums(readFileSync(sumsPath, 'utf8'))
  if (entries.length === 0) problems.push(`${SUMS_FILE} lists no file`)
  const listed = new Set()
  const matched = []
  for (const { name, hash } of entries) {
    if (path.basename(name) !== name || name === '.' || name === '..') {
      problems.push(`${name}: not a plain file name`)
      continue
    }
    listed.add(name)
    const file = path.join(dir, name)
    if (!existsSync(file)) problems.push(`${name}: listed but missing`)
    else if (hashFile(file) !== hash) problems.push(`${name}: checksum mismatch`)
    else matched.push(name)
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === SUMS_FILE || listed.has(entry.name)) continue
    problems.push(`${entry.name}: not listed in ${SUMS_FILE}`)
  }
  const ok = problems.length === 0
  return { ok, verified: ok ? matched : [], problems }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, ...suffixes] = process.argv.slice(2)
  if (!dir || suffixes.length === 0) {
    console.error('usage: node scripts/ci/sha256sums.mjs <dir> <suffix>...')
    process.exit(2)
  }
  try {
    for (const { name, hash } of writeSha256Sums(dir, suffixes)) console.log(`${hash}  ${name}`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
