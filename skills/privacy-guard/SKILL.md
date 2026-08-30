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
- It does **not look for private project names**, and that was deliberate rather than forgotten.
  The sibling directories on this machine run from unmistakable to words that occur in ordinary
  prose, and a list wide enough to catch the second kind fails the build on sentences that leak
  nothing. Whether a narrow list of the unmistakable ones is worth the false positives is the
  maintainer's open call, in issue #54. **Until it is decided, assume project names are
  unchecked**: one reached `main` in a measurement table and came out by reading, not by CI.
- It skips **binary files**. A path baked into PNG metadata, or a project name legible in a
  committed screenshot, cannot be caught — see the next section.
- It excludes exactly one file: the workflow itself, because that file necessarily spells the
  patterns it searches for. Unavoidable, and stated in the step's own comment so it is not read as
  an oversight — but the consequence is that the single most identifier-dense file in the
  repository is the one file never scanned.

So a green build is not proof of privacy. It is proof that four specific strings are absent from
the text of tracked files.

## Screenshots: the guard is blind, and you are the check

Nothing in CI will ever fail for an identifier that is in pixels rather than in text. When you
commit an image, the review is a pair of eyes, and there is no second line of defence behind them.

This is the incident the rule comes from. `docs/assets/screenshot-map.png` was committed in
`c47d2f5` with **two private project names legible in the panel** — two and a half hours after
`1244510` added the guard, and after the text audit had already removed those same names from the
source. A human reading the picture caught it, and `1fe418c` replaced the file seven minutes later.
The guard was green across both commits, and the pre-scrub blob is still in history: that is why
issue #51 exists, and why replacing the file is not the same as removing what was in it.

Before staging any capture, open it at full size and read it — do not skim the thumbnail:

- **Title bars, tab strips and breadcrumbs.** An editor or terminal title is usually a full
  absolute path. This is the most common leak by a distance.
- **File trees, project pickers and recent-project lists.** Sibling project names sit one panel
  away from whatever you meant to show.
- **Shell prompts**, which tend to carry account, host and working directory on one line.
- **Anything behind the app** — notifications, tray tooltips, browser tabs.
- **In a capture of this app, a mine's label _is_ a project folder name** — `aggregate.ts` takes
  the last segment of the session's path — and a dwarf carries whatever its session was last
  saying. That is precisely what leaked above, and the panel cannot show less and still be useful.

Crop or repaint what you find; assume the reader zooms in. And say in the commit body that you
looked — an image nobody claims to have read is the state that produced the incident above.

The same applies to a captured terminal transcript pasted as text: the guard will catch the four
strings it knows and nothing else in the prompt line.

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
