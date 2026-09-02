---
name: skill-sync
description: >
  Regenerating the skill catalogue and the imperative auto-invoke table in AGENTS.md from skill frontmatter.
  Trigger: after adding, renaming, retiring or re-scoping any skill, or when a skill is missing from a table in AGENTS.md.
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

`AGENTS.md` contains two generated regions, both built from the frontmatter of the skills
themselves:

- the **skill catalogue** — one row per skill, from the half of `description` before `Trigger:`
- the **auto-invoke table** — one row per `metadata.auto_invoke` phrase, the imperative _"when you
  are about to do X, ALWAYS invoke Y first"_

Neither is ever edited by hand. A rule and a hand-maintained document describing that rule will
drift, and a drifted table is worse than no table: it still gets read, still gets obeyed, and is
wrong.

## The rule

**After any change under `skills/`, run this and commit the result:**

```bash
node skills/skill-sync/assets/sync.mjs
```

```bash
node skills/skill-sync/assets/sync.mjs --check     # exit 1 if stale
node skills/skill-sync/assets/sync.mjs --dry-run   # print, change nothing
node skills/skill-sync/assets/sync.mjs --scope root
```

The generator has its own suite — `node skills/skill-sync/assets/sync.test.mjs` (19 tests,
deliberately outside vitest's include so `pnpm test` stays src-only; the file's own header
says why). Run it after changing `sync.mjs`.

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

## References

- [`assets/sync.mjs`](assets/sync.mjs) — the generator; its header explains the design
- [`skills/README.md`](../README.md) — the frontmatter contract and the scope registry
- [`AGENTS.md`](../../AGENTS.md) — the file it writes
