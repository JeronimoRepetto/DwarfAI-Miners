---
name: test-safety
description: >
  Preserving tests that already exist — a test file you did not create is append-and-amend only, and every removal is stated out loud.
  Trigger: before writing to, overwriting or deleting any existing *.test.ts file, and before reporting that a change is done.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '1.0'
  scope: [root]
  auto_invoke:
    - 'changing an existing test file'
    - 'deleting or replacing a test'
    - 'reporting that a change with tests is finished'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# Never lose a test silently

An agent once used `Write` on two existing test files and destroyed **40 committed tests**
belonging to three different issues. The suite went green: it had added more tests than it deleted,
so the total rose and the loss was invisible. A rising total hides a loss. Only a per-file
comparison against the committed version finds it.

## The rule

**A test file you did not create in this session is append-and-amend only.** Use `Edit`. Never
`Write` over an existing test file, and never `Write` a path without checking whether it already
exists.

Removing a test is still allowed. **Silent** removal is what is banned.

## Prove it before you report

Run this before saying a change is done, and paste the output:

```bash
node skills/test-safety/assets/test-census.mjs           # changed files vs HEAD
node skills/test-safety/assets/test-census.mjs --all     # every tracked test file
node skills/test-safety/assets/test-census.mjs --base <ref>
```

Exit code 1 means at least one file lost test statements. That is not proof of a mistake —
deleting a genuinely obsolete test is legitimate — it means the loss has to be **stated and
justified out loud** rather than passing unseen.

The census counts `it(`, `it.each(`, `test(` and friends **as written**, which is deliberately not
the number vitest reports: one `it.each` expands into many runtime cases. The question it answers
is _"did a block of tests stop existing"_, not _"how many assertions ran"_, and only the delta is
ever read.

## When a test genuinely goes

Say so where it stood. When a test goes because its subject went, leave the note in the file it
left, naming the issue that removed the function and the file where the coverage now lives.
`economy.test.ts` in the renderer keeps two worked examples of this.

## Why this is a skill and not a path-scoped rule

A rule in `.claude/rules/` with a `paths:` glob fires when a matching file is **read**. This
failure mode is a `Write` to a file the agent never opened, so a path rule cannot reach it — by the
time the rule would load, the tests are already gone. It has to be in context from the start, which
means it has to be a skill and it has to be in the auto-invoke table.

## Getting it wrong

- **Trusting the total.** `vitest run` passing and the count going up proves nothing. Both were
  true during the incident that produced this file.
- **`Write` on a path you assumed was new.** Check first. `Edit` fails loudly on a file that does
  not exist, which is the safer direction to be wrong in.
- **Reporting "all tests pass" without the census.** The suite cannot tell you what is no longer in
  it.

## References

- [`assets/test-census.mjs`](assets/test-census.mjs) — the enforcement; its header explains the
  counting rules
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — testing philosophy and the named deterministic fakes
