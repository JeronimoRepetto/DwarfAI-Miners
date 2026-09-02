#!/usr/bin/env node
/**
 * Regenerates every AGENTS.md's three generated regions: the skill catalogue and
 * the "Auto-invoke Skills" table, from the frontmatter of the skills themselves,
 * and the `main/` bullet in "The tree", from the directories under `src/main`.
 *
 * Why this exists. A `Trigger:` clause in a skill's frontmatter is advisory, and
 * advisory text loses to an agent's default approach. What actually gets obeyed
 * is an imperative table in AGENTS.md — "when about to do X, invoke Y first".
 * That table is therefore generated from the frontmatter rather than typed
 * alongside it, because a rule and its documentation that are maintained by hand
 * drift, and a table that has drifted is worse than no table: it is read, obeyed,
 * and wrong.
 *
 * Node rather than bash, deliberately. This repo runs Node everywhere and
 * `.claude/scripts/test-census.mjs` set the precedent. The stronger reason is
 * that the primary development platform is Windows, where `ln -s` and several
 * other bash idioms fail *silently* — see the Windows section of
 * skills/README.md. A generator that quietly does the wrong thing is the exact
 * failure this script exists to prevent.
 *
 * Usage:
 *   node skills/skill-sync/assets/sync.mjs              # rewrite the targets
 *   node skills/skill-sync/assets/sync.mjs --check      # exit 1 if stale (CI)
 *   node skills/skill-sync/assets/sync.mjs --dry-run    # print, touch nothing
 *   node skills/skill-sync/assets/sync.mjs --scope root
 *
 * Exit codes: 0 ok / 1 stale under --check, or a validation failure.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Which AGENTS.md each `metadata.scope` value writes to, relative to the repo
 * root. One entry today because this is one Electron app, not a monorepo — see
 * "How many AGENTS.md" in skills/README.md for why that is a decision and not an
 * omission. Adding a level is adding a line here plus the file itself; an
 * unknown scope is a hard error rather than a warning, so a typo in frontmatter
 * cannot quietly register a skill nowhere.
 */
const SCOPES = {
  root: 'AGENTS.md'
}

const MARKERS = {
  catalogue: 'skill-catalogue',
  autoInvoke: 'auto-invoke',
  mainTree: 'main-tree'
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

// ── frontmatter ────────────────────────────────────────────────────────────

/**
 * Parses the deliberately small YAML subset a SKILL.md is allowed to use:
 * scalars, `>` folded blocks, one level of nesting under `metadata:`, and lists
 * written either inline (`[a, b]`) or as `- item` blocks.
 *
 * Hand-rolled rather than a YAML dependency because the surface is this small
 * and the harness should not add a package to the app's dependency tree to
 * lint its own documentation. The cost is that anything outside the subset is
 * rejected loudly instead of being silently half-understood, which is the
 * trade this file wants: `validate()` below turns every gap into an error.
 */
function parseFrontmatter(source, file) {
  const lines = source.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    throw new SkillError(file, 'must start with a `---` frontmatter delimiter on line 1')
  }
  const end = lines.indexOf('---', 1)
  if (end === -1) throw new SkillError(file, 'frontmatter is never closed by a second `---`')

  const body = lines.slice(1, end)
  const out = {}
  const unquote = (v) => v.replace(/^['"]|['"]$/g, '')

  // The key a folded block or a block list is still filling. Continuation is
  // decided by INDENTATION, never by whether the line looks like `key: value` —
  // a folded `description` legitimately contains `Trigger: …`, which is prose.
  let pending = null

  for (const raw of body) {
    if (!raw.trim()) continue
    const text = raw.trim()
    if (text.startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length

    if (pending?.kind === 'fold' && indent > pending.indent) {
      const held = pending.container[pending.key]
      pending.container[pending.key] = held ? `${held} ${text}` : text
      continue
    }
    if (pending?.kind === 'list' && text.startsWith('- ')) {
      pending.container[pending.key].push(unquote(text.slice(2).trim()))
      continue
    }
    pending = null

    const match = raw.match(/^(\s*)([\w-]+):\s*(.*)$/)
    if (!match) throw new SkillError(file, `frontmatter line is not \`key: value\`: ${text}`)

    const [, , key, rest] = match
    const value = rest.trim()

    if (key === 'metadata' && indent === 0) {
      out.metadata ??= {}
      continue
    }
    // Exactly one level of nesting is supported, and only under `metadata:`.
    const container = indent > 0 ? (out.metadata ??= {}) : out

    if (value === '>' || value === '>-' || value === '|') {
      container[key] = ''
      pending = { key, container, indent, kind: 'fold' }
    } else if (value === '') {
      container[key] = []
      pending = { key, container, indent, kind: 'list' }
    } else if (value.startsWith('[') && value.endsWith(']')) {
      container[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean)
    } else {
      container[key] = unquote(value)
    }
  }
  return out
}

class SkillError extends Error {
  constructor(file, message) {
    super(`${file}: ${message}`)
    this.file = file
  }
}

// ── validation ─────────────────────────────────────────────────────────────

/**
 * Every rule here failed loudly by choice. The reference implementation this
 * pattern came from warned and continued on a missing scope, an unmapped scope
 * name and a missing insert anchor — and in all three cases the result was a
 * skill that existed, looked registered, and was in no table anywhere.
 */
function validate(skill, dirName, file, source) {
  const errs = []
  const meta = skill.metadata ?? {}

  if (!skill.name) errs.push('missing `name`')
  else if (skill.name !== dirName)
    errs.push(`\`name: ${skill.name}\` must match its directory name \`${dirName}\``)
  else if (!NAME_RE.test(skill.name)) errs.push(`\`name: ${skill.name}\` must be kebab-case`)

  if (!skill.description) errs.push('missing `description`')
  else if (!/\bTrigger:/.test(skill.description))
    errs.push('`description` must contain a `Trigger:` clause saying when to reach for the skill')

  if (!skill.license) errs.push('missing `license` (this repo is MIT)')
  if (!meta.author) errs.push('missing `metadata.author`')
  // The quoting has to be checked against the SOURCE, not the parsed value.
  // This parser strips quotes, so `1.0` and `'1.0'` are indistinguishable by
  // the time they reach here — but they are not equivalent to a real YAML
  // parser, which other agent tools use to read this same frontmatter: bare
  // 1.0 is a float, and bare 1.10 silently becomes 1.1.
  const versionLine = source.match(/^[ \t]+version:[ \t]*(.*)$/m)
  if (!meta.version || !versionLine) errs.push('missing `metadata.version`')
  else if (!/^['"]/.test(versionLine[1].trim()))
    errs.push(
      "`metadata.version` must be a quoted string like '1.0' (bare 1.0 is a YAML float, and bare 1.10 becomes 1.1)"
    )
  else if (!/^\d+\.\d+$/.test(meta.version))
    errs.push(`\`metadata.version\` should look like '1.0', got '${meta.version}'`)

  const scope = toList(meta.scope)
  if (scope.length === 0) errs.push('missing `metadata.scope`')
  for (const s of scope) {
    if (!SCOPES[s])
      errs.push(
        `unknown \`metadata.scope\` value \`${s}\` (known: ${Object.keys(SCOPES).join(', ')})`
      )
  }

  if (toList(meta.auto_invoke).length === 0)
    errs.push(
      'missing `metadata.auto_invoke` — a skill in no auto-invoke table is a skill nobody invokes'
    )

  if (errs.length) throw new SkillError(file, `\n    - ${errs.join('\n    - ')}`)
}

const toList = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [String(v)] : [])

// ── table rendering ────────────────────────────────────────────────────────

/**
 * Renders a Prettier-shaped Markdown table.
 *
 * The repo's format check covers `.md`, and Prettier pads every cell to the
 * widest in its column and fills the separator row to the same width — it does
 * this even when the row runs past `printWidth`, which was verified against this
 * repo's own .prettierrc.json rather than assumed. Emitting a compact table here
 * would make `format:check` fail on a file this script had just written, so the
 * padding is reproduced instead.
 *
 * Padding is by `String.length`. That equals Prettier's display width only for
 * single-width characters, so keep table cells ASCII.
 */
function renderTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`
  return [
    line(headers),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...rows.map(line)
  ].join('\n')
}

/** The half of `description` before `Trigger:` — what the skill is. */
const whatItIs = (description) =>
  description
    .split(/\bTrigger:/)[0]
    .trim()
    .replace(/\.$/, '')

function catalogueTable(skills) {
  const rows = skills
    .map((s) => [`[\`${s.name}\`](skills/${s.name}/SKILL.md)`, whatItIs(s.description)])
    .sort((a, b) => a[0].localeCompare(b[0]))
  return renderTable(['Skill', 'What it covers'], rows)
}

function autoInvokeTable(skills) {
  const rows = []
  for (const skill of skills) {
    for (const action of toList(skill.metadata.auto_invoke)) {
      rows.push([action, `[\`${skill.name}\`](skills/${skill.name}/SKILL.md)`])
    }
  }
  // Sorted by action, then skill, so the file is stable across runs regardless
  // of directory order — a generator whose output reorders on every run
  // produces noise diffs and teaches reviewers to stop reading them.
  rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  return renderTable(['When you are about to…', 'ALWAYS invoke this skill first'], rows)
}

// ── the main/ tree bullet ──────────────────────────────────────────────────

/**
 * One phrase per subject directory under `src/main/`.
 *
 * The LIST is what drifts, not the wording: three branches rewrote this bullet
 * on 2026-09-02 alone (`d4cba91`, `5dbccce`, `46a8899`), two of them in commits
 * whose entire content was re-typing this sentence, and a fourth edit is open in
 * #113 — because adding a directory to the app means editing a wrapped paragraph
 * in AGENTS.md, where two branches collide on lines neither meant to touch. So
 * the list is read off the filesystem and only the phrasing lives here (#118).
 *
 * Here rather than in each directory. A convention like "the first comment in
 * the directory's most central file is its gloss" has to decide which file is
 * central, and nothing stops that file being renamed or its comment rewritten
 * for a different reason — the gloss would rot invisibly. This table is one
 * reviewable place, in the generator whose output it feeds.
 *
 * Two absences, deliberately distinguished. An explicit `null` is a directory
 * whose name already says everything, rendered bare and silently. A directory
 * absent from this table altogether is NEW: it renders as its bare name too —
 * never invisible, and never with an invented gloss — and the run reports it so
 * the phrase gets written by a human rather than guessed by a script.
 */
const MAIN_TREE_GLOSSES = {
  adapters: 'fs and sqlite seams with their fakes',
  appDatabase: 'the one SQLite file',
  config: null,
  domain: 'pure rules and the type barrel',
  hooks: 'the opt-in Claude push channel',
  ledger: 'mined, persisted',
  platform: 'composed once in `platformAdapters.ts`',
  projects: null,
  providers: 'one per agent CLI plus the simulated one',
  runtime: 'the poll loop',
  sessionLaunch: 'starting a session',
  shell: 'window, tray, autostart, shortcuts',
  textDelivery: null,
  tier: null
}

/**
 * The half of the bullet that is a claim about the code rather than a list of
 * it. It is generated with the list because the two are one sentence, and a
 * marker cannot sit in the middle of a Markdown paragraph.
 */
const MAIN_TREE_LEAD =
  "- **`main/`** — `index.ts` is the composition root, and the only file that owns Electron's " +
  '`ipcMain` and `globalShortcut`. Beside it, one directory per subject:'

/**
 * `.prettierrc.json` sets `printWidth: 100`, and Prettier's `proseWrap` default
 * leaves prose line breaks alone — so nothing reflows this bullet for us and
 * nothing complains either. 99 is where every hand-wrapped prose line in
 * AGENTS.md stops today, and generated text that wraps like its neighbours is
 * the whole point.
 */
const WRAP_COLUMNS = 99
const HANGING_INDENT = '  '

/**
 * AGENTS.md's own second bullet: "It is budgeted under 200 lines, because
 * adherence drops as it grows." A generated region is exactly the kind of thing
 * that grows a line at a time without anyone deciding to, so the generator
 * refuses to be the one that breaks the budget.
 */
const AGENTS_MAX_LINES = 199

/** Greedy wrap with a hanging indent — the shape the bullet already has. */
function wrapBullet(text) {
  const lines = []
  let current = ''
  for (const word of text.split(' ')) {
    const indent = lines.length === 0 ? '' : HANGING_INDENT
    const candidate = current ? `${current} ${word}` : word
    if (current && (indent + candidate).length > WRAP_COLUMNS) {
      lines.push(indent + current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) lines.push((lines.length === 0 ? '' : HANGING_INDENT) + current)
  return lines.join('\n')
}

function mainTreeDirs(repoRoot) {
  const rel = 'src/main'
  const abs = path.join(repoRoot, 'src', 'main')
  if (!existsSync(abs)) {
    throw new SkillError(rel, 'must exist — the `main-tree` region is generated from it')
  }
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

function mainTreeBullet(dirs) {
  const parts = dirs.map((name) => {
    const gloss = MAIN_TREE_GLOSSES[name]
    return gloss ? `\`${name}\` (${gloss})` : `\`${name}\``
  })
  return wrapBullet(`${MAIN_TREE_LEAD} ${parts.join(', ')}.`)
}

/** Directories this table has never heard of — reported, never invented for. */
const unglossed = (dirs) => dirs.filter((name) => !(name in MAIN_TREE_GLOSSES))

// ── splicing ───────────────────────────────────────────────────────────────

/**
 * Replaces the text between the BEGIN/END markers for `id`.
 *
 * Explicit markers, rather than the surveyed implementation's "start at a
 * heading, stop at the next heading or rule". That heuristic broke the moment
 * someone wrote `##` where the generator emitted `###`: the section stopped
 * being found, the file silently fell through to an insert path that also did
 * nothing, and the script still exited 0. Markers are unambiguous, and a
 * missing marker is an error here rather than a no-op.
 *
 * The blank line each side of the content is not decoration: Prettier separates
 * an HTML comment from whatever block sits next to it, so a marker written flush
 * against its content fails `format:check` on a file this script just wrote.
 * That is what the `main/` bullet costs: six lines of the file's budget — two
 * markers, the two blanks Prettier wants inside them, and two more separating
 * them from the list items each side. Paying for it meant taking prose out.
 */
function splice(content, id, replacement, file) {
  const begin = `<!-- BEGIN GENERATED: ${id} -->`
  const end = `<!-- END GENERATED: ${id} -->`
  const start = content.indexOf(begin)
  const stop = content.indexOf(end)
  if (start === -1 || stop === -1 || stop < start) {
    throw new SkillError(
      file,
      `is missing the generated region for \`${id}\`. Add these two lines where the table belongs:\n    ${begin}\n    ${end}`
    )
  }
  return `${content.slice(0, start + begin.length)}\n\n${replacement}\n\n${content.slice(stop)}`
}

// ── main ───────────────────────────────────────────────────────────────────

function loadSkills(skillsDir) {
  const dirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  const skills = []
  for (const dirName of dirs) {
    const file = path.join('skills', dirName, 'SKILL.md')
    const abs = path.join(skillsDir, dirName, 'SKILL.md')
    if (!existsSync(abs)) {
      throw new SkillError(file, 'every directory under skills/ must contain a SKILL.md')
    }
    const source = readFileSync(abs, 'utf8')
    const skill = parseFrontmatter(source, file)
    validate(skill, dirName, file, source)
    skills.push(skill)
  }
  if (skills.length === 0) throw new Error('No skills found under skills/.')
  return skills
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'Regenerate the three generated regions in AGENTS.md — the two skill tables from',
        "skills/*/SKILL.md frontmatter, and the main/ tree bullet from src/main's directories.",
        '',
        '  --check          exit 1 if any AGENTS.md is out of date (for CI)',
        '  --dry-run        print what would be written, change nothing',
        '  --scope <name>   limit to one scope',
        `  known scopes:    ${Object.keys(SCOPES).join(', ')}`
      ].join('\n')
    )
    return 0
  }

  const check = argv.includes('--check')
  const dryRun = argv.includes('--dry-run')
  const scopeIndex = argv.indexOf('--scope')
  const onlyScope = scopeIndex === -1 ? null : argv[scopeIndex + 1]
  // `--repo-root` exists so the test suite can point the generator at a
  // throwaway tree instead of this repository.
  const rootIndex = argv.indexOf('--repo-root')
  const rootArg = rootIndex === -1 ? null : argv[rootIndex + 1]

  const known = new Set(
    ['--check', '--dry-run', '--scope', '--repo-root', '--help', '-h', onlyScope, rootArg].filter(
      (v) => v !== null
    )
  )
  const unknown = argv.find((a) => !known.has(a))
  if (unknown) {
    console.error(`Unknown option: ${unknown}`)
    return 1
  }
  if (onlyScope && !SCOPES[onlyScope]) {
    console.error(`Unknown scope: ${onlyScope} (known: ${Object.keys(SCOPES).join(', ')})`)
    return 1
  }

  const here = path.dirname(fileURLToPath(import.meta.url))
  const repoRoot = rootArg === null ? path.resolve(here, '..', '..', '..') : path.resolve(rootArg)
  const skillsDir = path.join(repoRoot, 'skills')

  const skills = loadSkills(skillsDir)

  const mainDirs = mainTreeDirs(repoRoot)
  const bare = unglossed(mainDirs)
  if (bare.length > 0) {
    // A warning, not a refusal: the directory is already in the app, and a bare
    // name in the tree is honest. Only the phrase is missing, and only a human
    // can write it.
    console.log(
      `  ! no gloss for ${bare.map((n) => `src/main/${n}`).join(', ')} — listed by bare name.` +
        ' Add a phrase to `MAIN_TREE_GLOSSES` in this script, or an explicit `null` if the' +
        ' name says everything.'
    )
  }

  const targets = Object.entries(SCOPES).filter(([scope]) => !onlyScope || scope === onlyScope)
  let stale = 0

  for (const [scope, relPath] of targets) {
    const registered = skills.filter((s) => toList(s.metadata.scope).includes(scope))
    const abs = path.join(repoRoot, relPath)
    if (!existsSync(abs)) {
      throw new SkillError(relPath, `scope \`${scope}\` maps to this file, but it does not exist`)
    }

    // `.gitattributes` forces LF and Prettier enforces it, so the generator
    // normalises rather than inheriting whatever the file happens to have.
    // Comparing the result against the RAW original (not the normalised one)
    // means a CRLF file is reported stale and rewritten, instead of being
    // called up to date while still failing `format:check`.
    const raw = readFileSync(abs, 'utf8')
    const before = raw.replace(/\r\n/g, '\n')
    let after = splice(before, MARKERS.catalogue, catalogueTable(registered), relPath)
    after = splice(after, MARKERS.autoInvoke, autoInvokeTable(registered), relPath)
    after = splice(after, MARKERS.mainTree, mainTreeBullet(mainDirs), relPath)

    // Counted on the RESULT, so the budget is checked against what would be
    // written rather than against what is there — and checked before the write,
    // so an over-budget file is refused rather than produced and then reported.
    const lineCount = after.replace(/\n$/, '').split('\n').length
    if (lineCount > AGENTS_MAX_LINES) {
      throw new SkillError(
        relPath,
        `would be ${lineCount} lines, over the ${AGENTS_MAX_LINES}-line budget the file declares` +
          " for itself. Take prose out — the file's own rule is that prose another file already" +
          ' carries in full goes first.'
      )
    }

    if (dryRun) {
      console.log(`--- ${relPath} (dry run, ${registered.length} skill(s)) ---`)
      console.log(catalogueTable(registered))
      console.log()
      console.log(autoInvokeTable(registered))
      console.log()
      console.log(mainTreeBullet(mainDirs))
      continue
    }
    if (after === raw) {
      console.log(`  = ${relPath} already up to date (${registered.length} skill(s))`)
      continue
    }
    if (check) {
      console.error(`  ✗ ${relPath} is out of date`)
      stale += 1
      continue
    }
    writeFileSync(abs, after)
    console.log(`  ✓ ${relPath} regenerated (${registered.length} skill(s))`)
  }

  if (stale > 0) {
    console.error(`\n${stale} file(s) stale. Run: node skills/skill-sync/assets/sync.mjs`)
    return 1
  }
  return 0
}

try {
  process.exit(main(process.argv.slice(2)))
} catch (error) {
  console.error(`\nskill-sync failed.\n  ${error.message}\n`)
  process.exit(1)
}
