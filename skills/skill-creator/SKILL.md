---
name: skill-creator
description: >
  How to add, change or retire a skill in this repository, and how to decide whether one is warranted at all.
  Trigger: when adding a skill, editing skill frontmatter, or noticing a lesson that keeps being re-explained by hand.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '1.0'
  scope: [root]
  auto_invoke:
    - 'adding or changing a skill under skills/'
    - 'writing down a rule an agent keeps getting wrong'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# Writing a skill

A skill teaches an agent one thing this project learned the expensive way. The library is small on
purpose: a skill nobody invokes teaches readers to skim the whole library, so the bar for adding
one is that something went wrong without it.

Read [`skills/README.md`](../README.md) for the spec — layout, the full frontmatter contract, and
why the auto-invoke table is generated. This file is the procedure.

## When a skill is warranted

All four must hold:

1. **An agent gets it wrong that a competent contributor would not.** This is the whole filter. If
   a careful human would do it right unprompted, it is contributor documentation, and it belongs in
   [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
2. **You can name the incident, the enforcement, or the invariant.** "Best practice" is not a
   justification. "An agent did X and it cost Y" is.
3. **It is not already documented somewhere that an agent will actually read** — a comment at the
   definition, a regression test, or `CONTRIBUTING.md`.
4. **There is a moment it applies to.** You must be able to finish the sentence _"when you are
   about to ______, invoke this first."_ If you cannot, the knowledge is real but it is not a
   skill.

## When it is not

- **One invariant with a comment at its definition and a test pinning it.** That is already in the
  two places an agent will hit it. Index it under "Domain invariants" in
  [`AGENTS.md`](../../AGENTS.md) and stop. This is why there is no `vault-materials` skill: the
  no-cross-material-summing rule is stated at `MATERIAL_TOKENS_PER_UNIT` in
  `src/shared/contracts.ts` and enforced by three named tests.
- **A rule that only applies inside specific files.** Use a path-scoped rule in `.claude/rules/`
  with a `paths:` glob. See the decision rule below.
- **A procedure only the maintainer can run.** This is why there is no `art-pipeline` skill: it
  needs source paintings that live outside the repository, it is in neither CI nor `pnpm build`,
  and the operator-facing part is one command already documented in `CONTRIBUTING.md`.
- **Anything you have not verified.** See "Verify first".

## Skill or path-scoped rule?

This distinction is load-bearing and easy to get backwards.

|                          | Skill                                     | Path-scoped rule (`.claude/rules/*.md`) |
| ------------------------ | ----------------------------------------- | --------------------------------------- |
| Fires when               | the agent is about to take a named action | a matching file is **read**             |
| Protects a blind `Write` | yes — it is in context from the start     | **no**                                  |
| Best for                 | a procedure, a workflow, a checklist      | a fact about specific files             |

**A path rule fires on read, not on write.** An agent that creates or overwrites a file it never
opened never sees the rule. So: if the failure mode is _"clobbered a file without reading it"_, it
must be a skill. If the failure mode is _"read the file and still misunderstood it"_, a path rule
is the lighter and better fit.

Worked example — the two coordinate spaces (`mapSites.ts` authors in box percent, `sceneLayout.ts`
in image percent) stay a path rule, because you cannot add a point to either without opening the
file first. The test-preservation rule is a skill, because its entire failure mode is a `Write` to
a file the agent never read.

## Naming

- kebab-case, and the directory name must equal the `name` in frontmatter — `sync.mjs` fails if
  they differ.
- Name the **subject**, not the action: `platform-ports`, not `use-platform-ports`.
- Two words where possible. The name appears in every generated table.

## `assets/` or `references/`

| You need                                          | Put it in     |
| ------------------------------------------------- | ------------- |
| a template, schema or config to copy from         | `assets/`     |
| a script the skill tells you to run               | `assets/`     |
| a pointer to a doc or module already in this repo | `references/` |

**`references/` point at local files, never web URLs.** A skill links the canonical document
rather than restating it, so the two cannot disagree. A URL changes under you and cannot be
grepped. Most skills need neither directory.

## The procedure

1. **Verify first** (see below). Do not write a claim you have not checked.
2. `cp skills/skill-creator/assets/SKILL-TEMPLATE.md skills/{name}/SKILL.md` and fill it in.
3. Write `auto_invoke` as the action the agent is **about to take** — `changing a test file` fires,
   `testing` does not. One phrase per moment; a list is fine.
4. Regenerate, do not hand-edit, the tables in `AGENTS.md`:

   ```bash
   node skills/skill-sync/assets/sync.mjs
   ```

5. Confirm your skill appears in both generated tables, and that `pnpm format:check` is clean —
   the repo's format check covers `.md`.

## Verify first

The most valuable thing the last pass over this repository produced was a correction. Three claims
in the brief for this harness were wrong when checked against the code, including one that had
already been copied from an inaccurate source comment into a rule file, where it was being read as
fact. Restating an unverified claim is how that spreads.

So: open the file, run the search, count the occurrences. Prefer "three call sites (four
occurrences)" to "about three". If you cannot verify a claim, either leave it out or mark it as
unverified and say why — the README's support matrix and the "Verified versus assumed" convention
in [`AGENTS.md`](../../AGENTS.md) are the house style for that, and they are worth matching.

## Getting it wrong

The two failure modes actually seen here:

- **A library that grows faster than it is invoked.** Every thin skill costs attention from the
  ones that matter. Retiring a skill is a normal act: delete the directory and re-run `sync.mjs`.
- **A second home for an idea.** If a rule now lives in a skill, it must stop living anywhere else,
  or the two copies will disagree and the older one will be believed. Search before you write.
