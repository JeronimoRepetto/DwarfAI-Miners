---
name: privacy-guard
description: >
  Keeping machine-specific identifiers out of tracked files, and the CI step that fails the build when one gets in.
  Trigger: before committing any fixture, test, default, screenshot or document, and whenever writing a path, hostname or home directory into a tracked file.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '1.0'
  scope: [root]
  auto_invoke:
    - 'writing a path, hostname or username into a tracked file'
    - 'adding or editing a test fixture'
    - 'committing a screenshot or a captured terminal transcript'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# Nothing from this machine goes in the repo

An agent working on the maintainer's own machine is by far the likeliest source of a real username
in a fixture, a real home path in a document, or a real hostname in a captured transcript. CI has a
step that fails the build when one appears.

This matters more for an agent than for a human: you have the real paths in front of you, and
pasting a captured value is the path of least resistance.

## The rule

**Use the project's placeholders, never a real value from this machine.** Verified in the fixtures:

| Instead of                             | Use                |
| -------------------------------------- | ------------------ |
| the real account name in a path        | `j`                |
| the real machine hostname              | `placeholder-host` |
| the maintainer's secondary Claude root | `~/.claude-work`   |

Check before you commit by running the guard the way CI runs it — read the step out of
`.github/workflows/ci.yml` and run it, rather than retyping the patterns from memory:

```bash
sed -n '/Privacy guard/,/^$/p' .github/workflows/ci.yml
```

## What the guard actually does

Be precise about this; it is narrower than it sounds.

- It greps for **four hardcoded literals**, not for usernames in general. Two of them only match
  after a `Users` or `home` path separator, so the project's intentional public identity — the
  GitHub handle, the Ko-fi link, the bundle id, the name in `LICENSE` — never trips it. The other
  two match anywhere.
- It covers **tracked files only**. An untracked or ignored file is invisible to it.
- It skips **binary files**. A path baked into PNG metadata, or a project name legible in a
  committed screenshot, cannot be caught — issue #18 was a screenshot leak, and human review caught
  it, not CI.
- It excludes exactly one file: the workflow itself, because that file necessarily spells the
  patterns it searches for.

So a green build is not proof of privacy. It is proof that four specific strings are absent from
the text of tracked files.

## The trap that has actually bitten

**Do not quote the guard's patterns in a tracked file.** There is one exemption and it is for the
workflow only. Writing the literal strings anywhere else — in agent instructions, in a document
explaining the guard, in a code block, in a commit body — trips the guard against the file that was
trying to be helpful about it.

This is not hypothetical. It has happened three times:

1. An exemption for `.env.example` was removed one commit before the file was actually clean.
2. A performance document pasted real Claude root paths into a fenced code block. `main` stayed red
   for **twelve** consecutive pushes before anyone read the failing step name.
3. An agent instructions file spelled out all four patterns in prose in order to document them, and
   held `main` red until the file was restructured.

Describe the patterns; never reproduce them. That is why this page names none of them.

## Getting it wrong

- **Assuming the guard fired.** It only started covering every tracked file partway through the
  project's history; leaks removed before that were found by a manual audit, not by CI. Do not
  credit CI for a catch without checking the run.
- **Reading only the last line of a red build.** The guard runs as the **first** step of the checks
  job, before typecheck, lint, format and test. If it fails, nothing else runs, and the release job
  is skipped entirely because it depends on that job — see [`release`](../release/SKILL.md).
- **Trusting the five local checks.** `CONTRIBUTING.md` lists five commands to run before a PR. The
  guard is a sixth thing CI does that is not in that list, so all five can pass locally on a change
  that goes red.

## References

- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — the step and the reasoning above it
- [`docs/privacy-audit.md`](../../docs/privacy-audit.md) — the audit that produced the placeholders
- [`SECURITY.md`](../../SECURITY.md) — where an actual disclosure goes
