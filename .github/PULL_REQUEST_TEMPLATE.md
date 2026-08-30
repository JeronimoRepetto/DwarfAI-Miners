## What this changes

Closes #

<!-- One or two sentences on what the change achieves, in plain language. -->

## Tests

<!--
Name the test that fails without this change, or say why none was warranted. The standard is
CONTRIBUTING.md's testing philosophy, and it is not repeated here.
-->

## Checklist

- [ ] The checks under [Verification](https://github.com/JeronimoRepetto/DwarfAI-Miners/blob/main/CONTRIBUTING.md#verification) pass locally
- [ ] Nothing machine-specific added — a path, a hostname, a username, or a screenshot showing one
- [ ] Ran `node skills/skill-sync/assets/sync.mjs` if anything under `skills/` changed
- [ ] Any test removed or rewritten in a file you did not create is named below, with why

<!--
None of the last three is in CONTRIBUTING.md's five commands. The first two are CI steps that
fail the build — and the privacy guard runs before any of the five, so all five can pass
locally on a pull request that still goes red.

The third is not a gate; nothing enforces it. The census reports per file what a passing suite
cannot, because a rising total hides a loss:

    node skills/test-safety/assets/test-census.mjs
-->
