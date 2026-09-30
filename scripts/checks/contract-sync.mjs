#!/usr/bin/env node
/**
 * docs-contract-sync (testing strategy `17` §1.7, §5.2; `15` §12; `16` §12; `25` §9).
 *
 * The architecture package copies some contract blocks next to the prose that uses them. The
 * owner is normative: a copy that differs from it is a defect. This check reads the package in
 * place (nothing of it is ever copied into a tracked path), finds every marked copy, extracts
 * the owner block the `15` §12 and `16` §12 method names, and compares the two line by line after
 * line-end normalisation (`05` and `14` are stored with CRLF, the rest with LF), so any other
 * difference, down to one byte, fails and names the block. The copies:
 *
 * - `15-provider-driver.md`: `<!-- BEGIN VERBATIM ADR-nnn <Dn>[-SUFFIX] -->` … `<!-- END … -->`.
 *   Owner: section `### <Dn>.` of the ADR; a fenced copy equals the section's first code fence,
 *   a table copy (ADR-009 D2-MERGE) equals the section's first table.
 * - `16-internal-ports.md`: `<!-- verbatim: <file> L<a>-L<b> -->` before a code fence. Owner:
 *   lines a to b of that package file.
 * - `05-modules-and-ports.md`: the paragraph `**Verbatim copy of ADR-nnn D2/D3 …` followed by
 *   one code fence per named section (§3.4), and the `// ---- verbatim copy of ADR-nnn item N`
 *   … `// ---- end of copy ----` runs (§3.7, §3.12). Owner: the first code fence of the section,
 *   or of item N of the ADR's `## Decision` list.
 *
 * A file that holds no copy at all fails too, so a lost marker cannot make the check pass empty.
 *
 * Package location (OQ-83): `new-architecture/DwarfAI-Miners-Architecture/` at the repository
 * root, or the path given with `--from`. The package exists only on the owner's machine, so where
 * the default location is absent (remote CI) the check prints the notice "architecture package
 * not present: contract sync skipped" and exits 0; a `--from` path that does not exist fails.
 *
 * Usage: node scripts/checks/contract-sync.mjs [--from <package dir>] [--root <repository root>]
 * Exit code 0 when every copy equals its owner (or the package is absent), 1 with one line per
 * differing block on stderr.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE_PATH } from '../traceability/build-catalogs.mjs'

export const SKIP_NOTICE = 'architecture package not present: contract sync skipped'

/** The package files that hold copies; each must hold at least one. */
export const COPY_FILES = [
  '05-modules-and-ports.md',
  '15-provider-driver.md',
  '16-internal-ports.md'
]

const BEGIN_VERBATIM = /^<!-- BEGIN VERBATIM (ADR-\d{3}) (\S+) -->$/
const LINE_RANGE_VERBATIM = /^<!-- verbatim: (\S+) L(\d+)-L(\d+) -->$/
const SECTION_COPY_PARAGRAPH = /^\*\*Verbatim copy of (ADR-\d{3}) (D\d+(?:\/D\d+)*)\b/
const ITEM_COPY_START = /^\s*\/\/ ---- verbatim copy of (ADR-\d{3}) item (\d+)\b/
const ITEM_COPY_END = /^\s*\/\/ ---- end of copy ----\s*$/
const FENCE = /^\s*```/
const TABLE_ROW = /^\s*\|/
const HEADING = /^(#{1,6}) /
const LIST_ITEM = /^(\d+)\. /

class ContractSyncError extends Error {}

/** The lines of a text file with line endings normalised. */
function readLines(file) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** The lines strictly inside the code fence that opens at `start`, and the index of its closing line. */
function fenceAt(lines, start) {
  if (!FENCE.test(lines[start] ?? '')) return null
  for (let end = start + 1; end < lines.length; end += 1) {
    if (FENCE.test(lines[end])) return { body: lines.slice(start + 1, end), open: start, end }
  }
  return null
}

/** The first code fence at or after `from` and before `until`. */
function firstFence(lines, from, until = lines.length) {
  for (let index = from; index < until; index += 1) {
    if (FENCE.test(lines[index])) return fenceAt(lines, index)
  }
  return null
}

/** The first run of Markdown table rows at or after `from` and before `until`. */
function firstTable(lines, from, until = lines.length) {
  for (let index = from; index < until; index += 1) {
    if (!TABLE_ROW.test(lines[index])) continue
    let end = index
    while (end < until && TABLE_ROW.test(lines[end])) end += 1
    return { body: lines.slice(index, end), open: index }
  }
  return null
}

/** The package file of an ADR id (`03-adr/ADR-nnn-*.md`), as a package-relative posix path. */
function adrFile(packageDir, adr) {
  const dir = path.join(packageDir, '03-adr')
  const names = existsSync(dir) ? readdirSync(dir) : []
  const name = names.find((each) => each.startsWith(`${adr}-`) && each.endsWith('.md'))
  if (!name) throw new ContractSyncError(`owner not found: no 03-adr/${adr}-*.md`)
  return `03-adr/${name}`
}

/** The line range `[start, end)` of the section whose heading starts with `<section>.`. */
function sectionRange(lines, section, ownerFile) {
  const start = lines.findIndex((line) => {
    const heading = HEADING.exec(line)
    return heading && line.slice(heading[0].length).startsWith(`${section}.`)
  })
  if (start === -1)
    throw new ContractSyncError(`owner section ${section} not found in ${ownerFile}`)
  const level = HEADING.exec(lines[start])[1].length
  let end = start + 1
  while (end < lines.length) {
    const heading = HEADING.exec(lines[end])
    if (heading && heading[1].length <= level) break
    end += 1
  }
  return [start, end]
}

/** The owner block of a copy taken from a section of an ADR: its first fence, or first table. */
function sectionOwner(packageDir, adr, section, shape) {
  const ownerFile = adrFile(packageDir, adr)
  const lines = readLines(path.join(packageDir, ownerFile))
  const [start, end] = sectionRange(lines, section, ownerFile)
  const block = shape === 'table' ? firstTable(lines, start, end) : firstFence(lines, start, end)
  if (!block)
    throw new ContractSyncError(`owner ${adr} ${section} holds no ${shape} in ${ownerFile}`)
  return { ownerFile, ownerLine: block.open + 1, owner: block.body }
}

/** The owner block of item N of an ADR's `## Decision` list: the item's first code fence. */
function itemOwner(packageDir, adr, item) {
  const ownerFile = adrFile(packageDir, adr)
  const lines = readLines(path.join(packageDir, ownerFile))
  const decision = lines.findIndex((line) => /^## Decision\b/.test(line))
  if (decision === -1) throw new ContractSyncError(`no "## Decision" section in ${ownerFile}`)
  const start = lines.findIndex(
    (line, index) => index > decision && LIST_ITEM.exec(line)?.[1] === item
  )
  if (start === -1)
    throw new ContractSyncError(`owner ${adr} item ${item} not found in ${ownerFile}`)
  let end = start + 1
  while (end < lines.length && !LIST_ITEM.test(lines[end]) && !HEADING.test(lines[end])) end += 1
  const block = firstFence(lines, start + 1, end)
  if (!block)
    throw new ContractSyncError(`owner ${adr} item ${item} holds no code fence in ${ownerFile}`)
  return { ownerFile, ownerLine: block.open + 1, owner: block.body }
}

/** The owner block of a line-range marker: lines a to b of the named package file. */
function rangeOwner(packageDir, file, first, last) {
  const full = path.join(packageDir, file)
  if (!existsSync(full)) throw new ContractSyncError(`owner file not found: ${file}`)
  const lines = readLines(full)
  if (first < 1 || last < first || last > lines.length) {
    throw new ContractSyncError(
      `owner range L${first}-L${last} is outside ${file} (${lines.length} lines)`
    )
  }
  return { ownerFile: file, ownerLine: first, owner: lines.slice(first - 1, last) }
}

/** The copies of `15`: BEGIN/END VERBATIM blocks. */
function copiesIn15(lines) {
  const copies = []
  lines.forEach((line, index) => {
    const begin = BEGIN_VERBATIM.exec(line)
    if (!begin) return
    const [, adr, name] = begin
    const endMarker = `<!-- END VERBATIM ${adr} ${name} -->`
    const end = lines.indexOf(endMarker, index + 1)
    if (end === -1) {
      copies.push({ name: `${adr} ${name}`, line: index + 1, error: `no "${endMarker}"` })
      return
    }
    const inner = lines.slice(index + 1, end)
    const fenced = inner.length > 0 && FENCE.test(inner[0])
    const body = fenced ? (fenceAt(inner, 0)?.body ?? inner) : inner
    const shape = fenced ? 'fence' : 'table'
    const section = name.split('-')[0]
    copies.push({
      name: `${adr} ${name}`,
      line: index + 2,
      body,
      owner: (packageDir) => sectionOwner(packageDir, adr, section, shape)
    })
  })
  return copies
}

/** The copies of `16`: line-range markers, each followed by a code fence. */
function copiesIn16(lines) {
  const copies = []
  lines.forEach((line, index) => {
    const marker = LINE_RANGE_VERBATIM.exec(line)
    if (!marker) return
    const [, file, first, last] = marker
    const name = `${file} L${first}-L${last}`
    const block = fenceAt(lines, index + 1)
    if (!block) {
      copies.push({ name, line: index + 1, error: 'no code fence follows the marker' })
      return
    }
    copies.push({
      name,
      line: index + 3,
      body: block.body,
      owner: (packageDir) => rangeOwner(packageDir, file, Number(first), Number(last))
    })
  })
  return copies
}

/** The copies of `05`: section-copy paragraphs (§3.4) and item-copy runs (§3.7, §3.12). */
function copiesIn05(lines) {
  const copies = []
  lines.forEach((line, index) => {
    const paragraph = SECTION_COPY_PARAGRAPH.exec(line)
    if (paragraph) {
      const [, adr, sectionList] = paragraph
      let from = index + 1
      for (const section of sectionList.split('/')) {
        const block = firstFence(lines, from)
        if (!block) {
          copies.push({
            name: `${adr} ${section}`,
            line: index + 1,
            error: 'no code fence for this section'
          })
          break
        }
        copies.push({
          name: `${adr} ${section}`,
          line: block.open + 2,
          body: block.body,
          owner: (packageDir) => sectionOwner(packageDir, adr, section, 'fence')
        })
        from = block.end + 1
      }
      return
    }
    const start = ITEM_COPY_START.exec(line)
    if (!start) return
    const [, adr, item] = start
    const name = `${adr} item ${item}`
    const end = lines.findIndex((each, at) => at > index && ITEM_COPY_END.test(each))
    if (end === -1) {
      copies.push({ name, line: index + 1, error: 'no "// ---- end of copy ----" line' })
      return
    }
    copies.push({
      name,
      line: index + 2,
      body: lines.slice(index + 1, end),
      owner: (packageDir) => itemOwner(packageDir, adr, item)
    })
  })
  return copies
}

const COPY_FINDERS = {
  '05-modules-and-ports.md': copiesIn05,
  '15-provider-driver.md': copiesIn15,
  '16-internal-ports.md': copiesIn16
}

/** Why `copy` differs from `owner`, or null when they are equal line by line. */
function difference(copy, owner) {
  const length = Math.max(copy.length, owner.length)
  for (let index = 0; index < length; index += 1) {
    if (copy[index] === owner[index]) continue
    if (index >= copy.length)
      return `the copy ends after ${copy.length} line(s); the owner has ${owner.length}`
    if (index >= owner.length)
      return `the copy has ${copy.length} line(s); the owner has ${owner.length}`
    return `first difference at line ${index + 1} of the block: copy ${JSON.stringify(copy[index])}, owner ${JSON.stringify(owner[index])}`
  }
  return null
}

/**
 * Compares every copy of the package in `packageDir` with its owner.
 * Returns the number of blocks compared and one printable line per failure.
 */
export function checkContractSync(packageDir) {
  const failures = []
  let checked = 0
  for (const file of COPY_FILES) {
    const full = path.join(packageDir, file)
    if (!existsSync(full)) {
      failures.push(`${file}: file not found in the package`)
      continue
    }
    const copies = COPY_FINDERS[file](readLines(full))
    if (copies.length === 0) {
      failures.push(`${file}: no verbatim copy found; a lost marker must not pass the check`)
      continue
    }
    for (const copy of copies) {
      const where = `${file}:${copy.line} ${copy.name}`
      if (copy.error) {
        failures.push(`${where}: ${copy.error}`)
        continue
      }
      checked += 1
      try {
        const { ownerFile, ownerLine, owner } = copy.owner(packageDir)
        const why = difference(copy.body, owner)
        if (why) failures.push(`${where}: differs from its owner ${ownerFile}:${ownerLine}: ${why}`)
      } catch (error) {
        if (!(error instanceof ContractSyncError)) throw error
        failures.push(`${where}: ${error.message}`)
      }
    }
  }
  return { checked, failures }
}

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--'))
    throw new ContractSyncError(`${name} needs a value`)
  return value
}

/** Runs the check as the command line does; returns the exit code. */
export function runContractSync(argv, io) {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const root = path.resolve(optionValue(argv, '--root') ?? path.join(here, '..', '..'))
    const from = optionValue(argv, '--from')
    if (from !== undefined && !existsSync(from)) {
      throw new ContractSyncError(`--from path does not exist: ${from}`)
    }
    const packageDir = path.resolve(from ?? path.join(root, ...PACKAGE_PATH))
    if (!existsSync(packageDir)) {
      io.out(SKIP_NOTICE)
      return 0
    }
    const { checked, failures } = checkContractSync(packageDir)
    for (const failure of failures) io.err(failure)
    if (failures.length > 0) {
      io.err(`contract sync: ${failures.length} failure(s); the owner wins, re-copy the block`)
      return 1
    }
    io.out(`contract sync: ${checked} verbatim block(s) identical to their owners (${packageDir})`)
    return 0
  } catch (error) {
    if (!(error instanceof ContractSyncError)) throw error
    io.err(`contract sync: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runContractSync(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`)
  })
}
