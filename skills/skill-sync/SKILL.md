---
name: skill-sync
description: >
  Regenerating AGENTS.md's three generated regions — the skill catalogue, the auto-invoke table, and the main/ tree bullet.
  Trigger: after adding, renaming, retiring or re-scoping any skill, after adding or removing a directory under src/main, or when a generated region in AGENTS.md looks stale.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '1.0'
  scope: [root]
  auto_invoke:
    - 'finishing a change under skills/'
    - 'fixing a skill that is missing from a table in AGENTS.md'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# Keeping AGENTS.md honest

`AGENTS.md` contains three generated regions. Two are built from the frontmatter of the skills
themselves:

- the **skill catalogue** — one row per skill, from the half of `description` before `Trigger:`
- the **auto-invoke table** — one row per `metadata.auto_invoke` phrase, the imperative _"when you
  are about to do X, ALWAYS invoke Y first"_

The third is built from the filesystem:

- the **`main/` tree bullet** (`main-tree`) — the bullet under "The tree" that lists the subject
  directories actually present under `src/main`, each with a one-phrase gloss

None of them is ever edited by hand. A rule and a hand-maintained document describing that rule
will drift, and a drifted table is worse than no table: it still gets read, still gets obeyed, and
is wrong. The `main/` line proved that the hard way: five branches rewrote it in two days, and
every one of them conflicted, because adding a directory to the app meant editing a sentence here.

## The `main/` bullet, and where its glosses live

The **list** is read off `src/main` at generation time. Only the **wording** is declared, in
`MAIN_TREE_GLOSSES` in `assets/sync.mjs` — one reviewable table beside the code that renders it,
rather than a comment convention inside each directory that nothing would keep honest.

Two absences are deliberately different:

- an explicit `null` — a directory whose name says everything (`config`, `tier`). Bare, silent.
- **absent from the table** — a directory nobody has glossed yet. It still appears, as its bare
  name, and the run prints `! no gloss for src/main/<name>`. Never invisible, never invented, and
  never a build failure: only a human can write the phrase.

The bullet is greedy-wrapped at 99 columns with a two-space hanging indent, which is where the
prose around it stops today (`printWidth` is 100, and Prettier's `proseWrap` default leaves prose
line breaks alone, so nothing reflows it and nothing complains).

`AGENTS.md` also declares its own budget — "budgeted under 200 lines" — so the generator refuses
to write a result over 199 lines. A generated region grows a line at a time without anyone
deciding to; when it trips, take prose out, starting with prose another file already carries in
full.

## The rule

**After any change under `skills/`, and after adding or removing a directory under `src/main`,
run this and commit the result:**

```bash
node skills/skill-sync/assets/sync.mjs
```

```bash
node skills/skill-sync/assets/sync.mjs --check     # exit 1 if stale
node skills/skill-sync/assets/sync.mjs --dry-run   # print, change nothing
node skills/skill-sync/assets/sync.mjs --scope root
```

The generator has its own suite — `node skills/skill-sync/assets/sync.test.mjs` (23 tests,
deliberately outside vitest's include so `pnpm test` stays src-only; the file's own header
says why). Run it after changing `sync.mjs`; `pnpm test` will not.

Never edit text between a `<!-- BEGIN GENERATED: … -->` and its `<!-- END GENERATED: … -->`
marker. The next run overwrites it.

## What it refuses to do

Every one of these exits non-zero rather than warning:

- frontmatter missing, unclosed, or outside the supported YAML subset
- `name` absent, not kebab-case, or different from its directory name
- `description` with no `Trigger:` clause
- `metadata.version` unquoted — bare `1.0` is a YAML float, not a version
- `scope` empty, or naming a scope that is not in the `SCOPES` registry
- `auto_invoke` empty — a skill in no table is a skill nobody invokes
- an `AGENTS.md` a scope points at that does not exist
- an `AGENTS.md` missing its `BEGIN`/`END` markers
- `src/main` missing — the `main-tree` region is generated from it, and an empty list would read
  as a true claim that the main process has no subject directories
- a result over 199 lines, the budget `AGENTS.md` declares for itself

One thing is a **warning** instead: a directory under `src/main` with no entry in
`MAIN_TREE_GLOSSES`. The directory is already in the app and its bare name is honest, so refusing
to write the file would help nobody — only the phrase is missing, and only a human can write it.

This is deliberate, and it is the main way this implementation differs from the one it was
modelled on. There, each of those was a warning that still exited 0, and the result was skills that
existed, looked registered, and appeared in no table anywhere. **A generator that cannot fail
cannot enforce.**

## Adding an AGENTS.md level

There is one today, at the repo root, because this is one Electron app rather than a monorepo —
[`skills/README.md`](../README.md) argues that out. To add another:

1. Add a line to `SCOPES` in `assets/sync.mjs` mapping the scope name to its path.
2. Create the file, including both marker pairs.
3. Add the scope to the `metadata.scope` list of every skill that belongs there.
4. Re-run the script.

## Getting it wrong

- **Hand-editing a generated table.** The next run silently reverts it, and the effort looks like
  a bug in the script.
- **Adding a skill and not re-running.** The skill exists, is documented, and is invoked by nobody
  — the exact failure this script was written to prevent. `--check` is the guard; run it before
  opening a PR.
- **Compacting a table.** The tables are emitted Prettier-shaped, with every cell padded to the
  widest in its column, because the repo's format check covers `.md` and Prettier pads Markdown
  tables even past `printWidth`. Re-running the generator restores the padding.
- **Adding a directory under `src/main` and not re-running.** CI catches it at the
  `--check` step, but the conflict-prone hand edit it replaces is the whole reason the region
  exists. Add the gloss to `MAIN_TREE_GLOSSES` in the same commit, or accept the bare name.

## References

- [`assets/sync.mjs`](assets/sync.mjs) — the generator; its header explains the design
- [`skills/README.md`](../README.md) — the frontmatter contract and the scope registry
- [`AGENTS.md`](../../AGENTS.md) — the file it writes
