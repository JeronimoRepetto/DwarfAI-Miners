#!/usr/bin/env node
/**
 * Static scanner for the pre-cut-0 registry re-inventory (ISSUE-006, `21` §2 P-3, `14` §6.5).
 *
 * It lists, from the source text alone (nothing is imported or executed):
 * - every `ipcMain.handle(` / `ipcMain.on(` registration (source `registration`, kind `invoke` / `send`);
 * - every member of the object a preload exposes with `contextBridge.exposeInMainWorld` (source
 *   `preload`, kind `invoke` / `send` / `push` from the `ipcRenderer` call it makes, `helper` when it
 *   makes none);
 * - every main → renderer `.send(` push (source `push`), outside `src/preload/` and `src/renderer/`;
 * - every key of the `IPC_CHANNELS` object (source `constant`).
 *
 * Each item carries its wire name, the constant key or member name it was found under, and its
 * file and line. The output is sorted by wire name, then file, then line.
 *
 * Usage: node scripts/checks/ipc-reinventory.mjs [--root <dir>]   (JSON on stdout)
 *
 * `readReinventoryTable` reads `docs/strangler/registry-reinventory.md` back into rows, so a later
 * registry check (ISSUE-007) takes the committed table as its source of found channels.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_FILE = /\.(?:[cm]?ts|[cm]?js)$/
const SKIPPED_FILE = /(?:\.d\.ts|\.(?:test|spec)\.[cm]?[jt]s)$/
const SKIPPED_DIR = new Set(['node_modules', '__fixtures__'])

/** Every scannable source file under `<root>/src`, as posix paths relative to `root`. */
function sourceFiles(root) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIR.has(entry.name)) walk(full)
      } else if (SOURCE_FILE.test(entry.name) && !SKIPPED_FILE.test(entry.name)) {
        files.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
  }
  walk(path.join(root, 'src'))
  return files.sort()
}

/**
 * Two same-length views of a source text: `code` has every comment blanked (strings kept), and
 * `shape` also blanks the contents of every string, so brace depth can be counted safely. Newlines
 * are kept in both, so an offset maps to the same line in the original.
 */
function views(text) {
  const code = text.split('')
  const shape = text.split('')
  const blank = (view, from, to) => {
    for (let i = from; i < to; i++) if (view[i] !== '\n' && view[i] !== '\r') view[i] = ' '
  }
  let i = 0
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? text.length : end
      blank(code, i, stop)
      blank(shape, i, stop)
      i = stop
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      blank(code, i, stop)
      blank(shape, i, stop)
      i = stop
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') j++
        else if (c !== '`' && text[j] === '\n') break
        j++
      }
      blank(shape, i + 1, j)
      i = j + 1
    } else {
      i++
    }
  }
  return { code: code.join(''), shape: shape.join('') }
}

/** Plain code-unit order, the order `Array.prototype.sort` gives strings, independent of locale. */
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function lineAt(text, offset) {
  let line = 1
  for (let i = 0; i < offset; i++) if (text[i] === '\n') line++
  return line
}

/** The offset just past the brace that closes the one at `open`, counted on `shape`. */
function closingBrace(shape, open) {
  let depth = 0
  for (let i = open; i < shape.length; i++) {
    if (shape[i] === '{' || shape[i] === '(' || shape[i] === '[') depth++
    else if (shape[i] === '}' || shape[i] === ')' || shape[i] === ']') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return shape.length
}

/**
 * The top-level members of the object literal whose `{` is at `open`: each with its key, the
 * offset of the key and the member's own source slice (from `code`).
 */
function objectMembers(code, shape, open) {
  const close = closingBrace(shape, open) - 1
  const members = []
  let depth = 0
  let start = open + 1
  const flush = (end) => {
    const slice = code.slice(start, end)
    const key = /^\s*(?:async\s+)?(?:(\w+)|'([^']+)'|"([^"]+)")/.exec(slice)
    const lead = slice.length - slice.trimStart().length
    if (key) {
      members.push({ key: key[1] ?? key[2] ?? key[3], offset: start + lead, body: slice })
    }
    start = end + 1
  }
  for (let i = open + 1; i < close; i++) {
    const c = shape[i]
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) flush(i)
  }
  flush(close)
  return members
}

const CHANNEL_ARG = String.raw`\s*(?:IPC_CHANNELS\.(\w+)|(['"\x60])([^'"\x60]+)\2)`

function scanFile(file, text) {
  const { code, shape } = views(text)
  const constants = []
  const uses = []
  const add = (list, item, offset) => list.push({ ...item, file, line: lineAt(text, offset) })

  for (const match of code.matchAll(/\bIPC_CHANNELS\s*=\s*\{/g)) {
    const open = match.index + match[0].length - 1
    for (const member of objectMembers(code, shape, open)) {
      const value = /:\s*(['"\x60])([^'"\x60]+)\1/.exec(member.body)
      if (value) add(constants, { name: member.key, wire: value[2] }, member.offset)
    }
  }

  const registration = new RegExp(
    String.raw`\bipcMain\.(handle|handleOnce|on|once)\(` + CHANNEL_ARG,
    'g'
  )
  for (const match of code.matchAll(registration)) {
    const kind = match[1].startsWith('handle') ? 'invoke' : 'send'
    add(
      uses,
      {
        source: 'registration',
        kind,
        name: match[2] ?? null,
        constant: match[2],
        literal: match[4]
      },
      match.index
    )
  }

  const mainSide = !file.startsWith('src/preload/') && !file.startsWith('src/renderer/')
  if (mainSide) {
    const push = /(?<!ipcRenderer)\.send\(\s*(?:IPC_CHANNELS\.(\w+)|(['"])([\w-]+(?::[\w-]+)+)\2)/g
    for (const match of code.matchAll(push)) {
      add(
        uses,
        {
          source: 'push',
          kind: 'push',
          name: match[1] ?? null,
          constant: match[1],
          literal: match[3]
        },
        match.index
      )
    }
  }

  for (const match of code.matchAll(
    /\bcontextBridge\.exposeInMainWorld\(\s*(['"])\w+\1\s*,\s*(\w+|\{)/g
  )) {
    let open = match[2] === '{' ? match.index + match[0].length - 1 : -1
    if (open === -1) {
      const declaration = new RegExp(
        String.raw`\b(?:const|let|var)\s+${match[2]}\b[^=]*=\s*\{`
      ).exec(code)
      if (!declaration) continue
      open = declaration.index + declaration[0].length - 1
    }
    for (const member of objectMembers(code, shape, open)) {
      const call = new RegExp(
        String.raw`\bipcRenderer\.(invoke|send|on|once)\(` + CHANNEL_ARG
      ).exec(member.body)
      const kind = call
        ? { invoke: 'invoke', send: 'send', on: 'push', once: 'push' }[call[1]]
        : 'helper'
      add(
        uses,
        {
          source: 'preload',
          kind,
          name: member.key,
          constant: call?.[2],
          literal: call?.[4]
        },
        member.offset
      )
    }
  }
  return { constants, uses }
}

/**
 * Every registration, preload member, push and `IPC_CHANNELS` key under `<root>/src`.
 *
 * @param {string} root
 * @returns {Array<{ wire: string | null, source: 'registration' | 'preload' | 'push' | 'constant', kind: 'invoke' | 'send' | 'push' | 'helper' | null, name: string | null, file: string, line: number }>}
 */
export function scanIpc(root) {
  const scans = sourceFiles(root).map((file) =>
    scanFile(file, readFileSync(path.join(root, file), 'utf8'))
  )
  const constants = scans.flatMap((scan) => scan.constants)
  const wireOf = new Map(constants.map((constant) => [constant.name, constant.wire]))

  const items = constants.map(({ name, wire, file, line }) => ({
    wire,
    source: 'constant',
    kind: null,
    name,
    file,
    line
  }))
  for (const use of scans.flatMap((scan) => scan.uses)) {
    items.push({
      wire: use.literal ?? wireOf.get(use.constant) ?? null,
      source: use.source,
      kind: use.kind,
      name: use.name,
      file: use.file,
      line: use.line
    })
  }

  return items.sort(
    (a, b) => compare(a.wire ?? '', b.wire ?? '') || compare(a.file, b.file) || a.line - b.line
  )
}

const TABLE_START = '<!-- reinventory-table:start -->'
const TABLE_END = '<!-- reinventory-table:end -->'

/** A cell's text without its code quotes; `—` (no value) becomes null. */
const cellValue = (cell) => {
  const text = cell.trim().replace(/^`(.*)`$/, '$1')
  return text === '—' || text === '' ? null : text
}

/**
 * The rows of `docs/strangler/registry-reinventory.md`: every table row between the
 * `reinventory-table` markers, header and separator rows skipped. Columns: wire name, member, kind,
 * found at, `14` id, status, amendment request, notes.
 *
 * @param {string} markdown
 * @returns {Array<{ wire: string | null, member: string | null, kind: string | null, files: string[], id: string | null, status: string | null, request: string | null }>}
 */
export function readReinventoryTable(markdown) {
  const start = markdown.indexOf(TABLE_START)
  const end = markdown.indexOf(TABLE_END)
  if (start === -1 || end < start) return []
  return markdown
    .slice(start + TABLE_START.length, end)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('|') && !/^\|\s*(?:-+\s*\|\s*)+$/.test(line))
    .map((line) =>
      line.slice(1, line.trimEnd().endsWith('|') ? line.trimEnd().length - 1 : undefined)
    )
    .map((line) => line.split('|'))
    .filter((cells) => cells[0].trim() !== 'Wire name')
    .map(([wire, member, kind, foundAt, id, status, request]) => ({
      wire: cellValue(wire),
      member: cellValue(member),
      kind: cellValue(kind),
      files: [...new Set([...foundAt.matchAll(/([\w./-]+):\d+/g)].map((match) => match[1]))].sort(),
      id: cellValue(id),
      status: cellValue(status),
      request: cellValue(request)
    }))
}

function main(argv) {
  const rootFlag = argv.indexOf('--root')
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root =
    rootFlag === -1 ? path.resolve(here, '..', '..') : path.resolve(argv[rootFlag + 1] ?? '.')
  process.stdout.write(`${JSON.stringify(scanIpc(root), null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
