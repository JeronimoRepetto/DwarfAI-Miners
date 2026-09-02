# The skills library

A skill is a short document that teaches an agent one thing this project learned the expensive
way. This file is the spec for the system itself: the layout, the frontmatter contract, what is
generated from what, and which parts of the surveyed pattern were deliberately left out.

If you are here to write a skill, read [`skill-creator`](skill-creator/SKILL.md) instead — it is
the procedure. This file is the reference behind it.

## The central insight

A `Trigger:` clause in a skill's frontmatter is **advisory**, and advisory text loses to an
agent's default approach. Agents read "use this when…" as background colour and carry on.

What actually gets obeyed is an **imperative table in `AGENTS.md`**: _when you are about to do X,
ALWAYS invoke skill Y first._ So the harness keeps both, and the redundancy is the point.

The table is **generated from the skills' own frontmatter**, never typed by hand. A rule and a
separate document describing that rule will drift, and a drifted table is worse than no table at
all — it still gets read, still gets obeyed, and is wrong. Generating it means the instruction and
the metadata cannot disagree, because there is only one of them.

## Layout

```
AGENTS.md                     # committed single source of truth; carries the generated tables
CLAUDE.md                     # three lines, committed: `@AGENTS.md` (see "Entry points")
skills/
├── README.md                 # this file — the spec
├── skill-creator/            # the meta-skill: how to write a skill
│   ├── SKILL.md
│   └── assets/SKILL-TEMPLATE.md
├── skill-sync/               # regenerates the tables in AGENTS.md
│   ├── SKILL.md
│   └── assets/sync.mjs
└── {skill-name}/
    ├── SKILL.md              # required: frontmatter + body
    ├── assets/               # optional: templates, schemas, scripts
    └── references/           # optional: pointers to LOCAL files, never web URLs
```

One skill per directory, and `{skill-name}` must equal the `name` in its frontmatter — `sync.mjs`
fails if they differ, because a mismatch means the table links somewhere that does not exist.

## Frontmatter contract

```yaml
---
name: scene-coordinates
description: >
  What the skill is, in one clause.
  Trigger: when an agent should reach for it.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '1.0'
  scope: [root]
  auto_invoke:
    - 'moving or adding a point on the map or in a cave'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---
```

| Field                  | Required | Notes                                                                              |
| ---------------------- | -------- | ---------------------------------------------------------------------------------- |
| `name`                 | yes      | kebab-case, identical to the directory name                                        |
| `description`          | yes      | one `>` folded block; must contain a `Trigger:` clause                             |
| `license`              | yes      | `MIT` — this repo's LICENSE                                                        |
| `metadata.author`      | yes      | `JeronimoRepetto`                                                                  |
| `metadata.version`     | yes      | **quoted** string like `'1.0'`; unquoted `1.0` is a YAML float                     |
| `metadata.scope`       | yes      | which `AGENTS.md` files register it; every value must be a known scope             |
| `metadata.auto_invoke` | yes      | the verbatim action phrase(s) that become the left column of the auto-invoke table |
| `allowed-tools`        | no       | advisory; recorded for tools that honour it                                        |

`description` is split on `Trigger:`. The half before it becomes the catalogue row; `auto_invoke`
becomes the auto-invoke row. Write the first half as a noun phrase — it is read as _"this skill
covers …"_.

Write `auto_invoke` as the action the agent is **about to take**, not as a topic. `changing a
test file` fires; `testing` does not.

### `assets/` versus `references/`

| You need                                       | Put it in     |
| ---------------------------------------------- | ------------- |
| a template, schema, or config to copy from     | `assets/`     |
| a script the skill tells you to run            | `assets/`     |
| a pointer to a doc that already exists in-repo | `references/` |

**`references/` point at local files, never web URLs.** A skill references the canonical document
rather than restating it, so the two cannot disagree; a URL can change under you and cannot be
grepped. If the content lives in `CONTRIBUTING.md`, link to `CONTRIBUTING.md`.

## How many `AGENTS.md`: one

The surveyed implementation has five, because it is a monorepo — four independently deployed
components with different languages, toolchains and test runners, so a rule that is true in the
Django API is meaningless in the Next.js UI.

This project is **one Electron app**: one `package.json`, one `tsconfig` set, one `vitest.config.ts`,
one lint config, one build. `src/main/` and `src/renderer/` are process boundaries, not component
boundaries — they share `src/shared/contracts.ts` as a contract and ship as a single artifact. A
second level would carry the same toolchain twice and earn nothing.

Two further reasons this is a decision rather than laziness:

- **Per-process rules are already better served elsewhere.** A rule that only matters in one file
  belongs in `.claude/rules/` with a `paths:` glob; a rule that only matters to one subsystem
  belongs in that subsystem's skill. A nested `AGENTS.md` would duplicate both.
- **A nested `AGENTS.md` would have hardcoded paths that moved.** Issue #49 regrouped the whole
  of `src/` into subject directories in one pass (`ae9890c`); a directory-scoped instruction
  file living through that reorg would have needed migrating right alongside every file it
  named.

Adding a level later is one line in `SCOPES` in `sync.mjs` plus the file itself. It is cheap on
purpose, so that it can be earned rather than pre-built.

## Regenerating

```bash
node skills/skill-sync/assets/sync.mjs             # rewrite the generated regions
node skills/skill-sync/assets/sync.mjs --check     # exit 1 if stale — for CI
node skills/skill-sync/assets/sync.mjs --dry-run   # print, change nothing
```

Everything below is a **hard failure**, not a warning:

- frontmatter missing, unclosed, or outside the supported YAML subset
- `name` absent, not kebab-case, or different from the directory name
- `description` without a `Trigger:` clause
- `metadata.version` unquoted or not `'X.Y'`
- `scope` empty or naming a scope that is not in the registry
- `auto_invoke` empty — a skill in no table is a skill nobody invokes
- an `AGENTS.md` that a scope points at but that does not exist
- an `AGENTS.md` missing its `<!-- BEGIN GENERATED: … -->` / `<!-- END GENERATED: … -->` markers
- `src/main` missing, which the `main-tree` region is generated from
- a result over the 199 lines `AGENTS.md` budgets for itself

That list is deliberate. In the surveyed implementation each of those was a warning that let the
run exit 0, and the observed result was skills that existed, looked registered, and appeared in no
table anywhere. A generator that cannot fail cannot enforce.

The generated regions are delimited by explicit HTML comment markers rather than by "start at a
heading, stop at the next heading". That heuristic breaks the moment someone writes `##` where the
generator emitted `###` — which is exactly what happened upstream, silently, leaving four files
hand-maintained while the script still reported success.

The tables are emitted **Prettier-shaped** (every cell padded to the widest in its column). This
repo's format check covers `.md`, and Prettier pads Markdown tables even past `printWidth`, so a
compact table would make `format:check` fail on a file the generator had just written.

## Entry points, and what does not work on Windows

Windows is the primary development platform here, and the surveyed implementation's `setup.sh`
symlinks `CLAUDE.md → AGENTS.md`. That approach was tested on this machine rather than assumed.
What was found:

| Thing                                          | Result here                                         |
| ---------------------------------------------- | --------------------------------------------------- |
| `ln -s` in Git Bash                            | **exits 0 and silently creates a copy**, not a link |
| `MSYS=winsymlinks:nativestrict ln -s`          | creates a real symlink (Developer Mode is on)       |
| `fs.symlinkSync(target, link, 'file')` in Node | creates a real symlink                              |
| `git config core.symlinks` in this repo        | **`false`**                                         |

The last row settles it. Even a correctly created symlink is committed as an ordinary file whose
contents are the target path, and checks out on Windows as a text file containing the literal
string `AGENTS.md`. Symlinks are not viable here, and the default `ln -s` failure is the worst
kind: silent, exit 0, and it produces a **copy** — the duplicated-by-hand file this whole pattern
exists to prevent.

So there is **no `setup.sh`**, and nothing is generated or gitignored. Two facts make it
unnecessary:

- **Claude Code does not read `AGENTS.md`.** It reads `CLAUDE.md`, which supports `@path` imports
  that load the target's full content. So `CLAUDE.md` is three committed lines containing
  `@AGENTS.md`. It holds no rules, so there is nothing in it that can drift.
- **Every other tool reads `AGENTS.md` natively** — Cursor, Copilot, Windsurf, Cline and Gemini all
  resolve it without help. There is no third entry point to generate.

A generator that creates one static three-line file is a moving part that buys nothing.

## Writing style

- **Only what an agent gets wrong.** If a competent contributor would do it right unprompted, it
  does not belong in a skill.
- **Name the incident.** Every rule here should be traceable to something that actually happened.
  A rule with a scar behind it gets followed; an invented best practice gets skimmed.
- **Point, do not restate.** `CONTRIBUTING.md` is the human-facing guide. Link to it.
- **Verify before writing.** Claims in these files are checked against the code. Three claims in
  the brief for this harness turned out to be wrong, one of them outright false — including one
  that had already been copied from an inaccurate source comment into a rule file. Restating an
  unverified claim is how that spreads.
- Keep a `SKILL.md` under ~150 lines. Adherence drops as length grows.
