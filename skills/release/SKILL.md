---
name: release
description: >
  How an installer release is actually cut — pushing a v-prefixed tag — and the traps in the workflow that do the building.
  Trigger: when asked to cut a release, publish installers, or change anything about packaging or the release workflow.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '1.0'
  scope: [root]
  auto_invoke:
    - 'cutting a release or publishing installers'
    - 'changing packaging or the release workflow'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# Releases are cut by pushing a tag

**Pushing a tag matching `v*` builds and publishes installers for all three platforms.** That is
the whole process. There is no release script to run and no manual promote step.

This is written down here because it is written down nowhere else. `CONTRIBUTING.md` and
`README.md` document the three local packaging commands, but neither says how a real release
happens — so an agent that does not know either invents a process or asks.

## What the tag triggers

One job per platform, each producing real installers:

| Runner  | Produces                                           |
| ------- | -------------------------------------------------- |
| Windows | an NSIS setup executable and a portable executable |
| macOS   | a `.dmg` and a `.zip`                              |
| Linux   | an `AppImage` and a `.deb`                         |

Each leg must run on its own OS; that is why it is a matrix and not one job.

## The traps

Verified against the workflow. Every one of these is a way to get a release that silently does not
happen, or a build that fails late.

1. **The release job depends on the checks job.** If checks are red, the tag builds **nothing** —
   the release job is skipped, not failed, so it is easy to miss. The first step of that job is the
   privacy guard, so a leak in a tracked file blocks every release until it is fixed. See
   [`privacy-guard`](../privacy-guard/SKILL.md).
2. **The trigger is a glob, not semver.** Anything starting with `v` fires it. Nothing validates
   the tag against the version in `package.json` — check that yourself before pushing.
3. **Permissions are split on purpose.** The workflow grants read at the top level and the release
   job overrides it with write. Copying only the top-level block gets a 403 on publish.
4. **It publishes immediately.** Not a draft. There is no review step between the tag and a public
   release.
5. **Release notes are generated on exactly one leg.** GitHub regenerates notes on every update, so
   enabling that on all three legs duplicates them. The single-leg setting is deliberate; the
   comment above it explains why.
6. **A renamed artifact fails the release loudly**, by design — the upload is configured to fail on
   unmatched files. If you change an artifact name, change the matching glob in the same commit.
   The macOS filename template carries no platform suffix, which is why its globs look broader than
   the others.
7. **Packaging never self-publishes.** All three package scripts pass a never-publish flag, and the
   workflow's own release step owns publishing. Tag builds once tried to publish on their own and
   failed on a missing token. The Linux target also requires an author email to be set.

## Before pushing a tag

```bash
gh run list --limit 5          # is main green? a red checks job means no release
git describe --tags            # what the last tag was
```

Confirm the version in `package.json` matches the tag you are about to push, and that `main` is
green. Then push the tag.

## Getting it wrong

- **Pushing the tag while `main` is red.** Nothing builds and nothing tells you loudly; the job
  shows as skipped.
- **Assuming a failed release means a packaging bug.** Check whether the checks job ran at all
  first.
- **Editing a package script's targets without the workflow.** The two are coupled through the
  artifact globs.

## References

- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — the release job, its matrix, and
  the comments explaining each setting
- [`README.md`](../../README.md) — the local packaging commands and why each needs its own OS
