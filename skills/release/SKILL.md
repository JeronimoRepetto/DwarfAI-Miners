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

| Runner  | Job           | Produces                                           |
| ------- | ------------- | -------------------------------------------------- |
| Windows | `release`     | an NSIS setup executable and a portable executable |
| Linux   | `release`     | an `AppImage` and a `.deb`                         |
| macOS   | `release-mac` | a `.dmg` and a `.zip`                              |

Each leg must run on its own OS. Windows and Linux stay a matrix inside one `release` job; macOS
is its own separate job, `release-mac`, so it alone can carry the GitHub `release` Environment and
its five signing/notarization secrets without exposing them to the other two — see
[`docs/signing.md`](../../docs/signing.md).

## The traps

Verified against the workflow. Every one of these is a way to get a release that silently does not
happen, or a build that fails late.

1. **Both release jobs depend on the checks job.** If checks are red, the tag builds **nothing** —
   `release` and `release-mac` are both skipped, not failed, so it is easy to miss. The first step
   of `checks` is the privacy guard, so a leak in a tracked file blocks every release until it is
   fixed. See [`privacy-guard`](../privacy-guard/SKILL.md).
2. **The trigger is a glob, not semver.** Anything starting with `v` fires it. Nothing validates
   the tag against the version in `package.json` — check that yourself before pushing.
3. **Permissions are split on purpose.** The workflow grants read at the top level, and both
   `release` and `release-mac` override it with write independently. Copying only the top-level
   block — or copying `release`'s job block without its own `permissions:`, e.g. when splitting a
   leg into a new job — gets a 403 on publish.
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
   failed on a missing token. The Linux target also requires an author email AND a `homepage` in
   `package.json`: the deb (fpm) target refuses to build without either, while the AppImage builds
   fine, so a Windows-only check never sees the gap (found packaging v0.8.0 by hand, #345).
8. **The macOS leg fails alone, silently, on the other two.** `release-mac` is its own job (not a
   matrix entry, so it can carry the `release` GitHub Environment and its five secrets without
   handing them to Windows/Linux) with `needs: checks` and no dependency on the `release` job. An
   expired Developer ID certificate or app-specific password fails only `release-mac` — Windows
   and Linux still package and publish normally, so a release can go out missing only the Mac
   installers with nothing in the other two legs' logs pointing at it. Check `release-mac`
   specifically, not just whether the release has assets.
9. **The `release` environment's tag rule can refuse the leg outright.** It carries a `v*`
   deployment tag rule, so `release-mac` refuses to run for any ref that doesn't match `v*` —
   independent of, and in addition to, the job's own `if: startsWith(github.ref, 'refs/tags/v')`.
   See [`docs/signing.md`](../../docs/signing.md) for what the five secrets are and where they
   live.

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
