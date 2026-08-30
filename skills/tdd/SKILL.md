---
name: tdd
description: >
  The test-first workflow this repo holds agents to, and the house idioms for writing a test that belongs here.
  Trigger: before implementing any behaviour change, fixing any bug, or making a failing test pass.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '1.0'
  scope: [root]
  auto_invoke:
    - 'implementing a behaviour change'
    - 'fixing a bug'
    - 'making a failing test pass'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# Failing test first

[`CONTRIBUTING.md`](../../CONTRIBUTING.md) asks contributors to write the test first _"when you
can"_. For an agent that is not a preference, it is the rule — because the thing an agent does
wrong that a human does not is quietly adjust the expectation until the bar clears.

## The rule

1. Write the test first.
2. **Watch it fail**, and check it fails for the reason you expect. A test that passes before the
   fix is testing nothing.
3. Make it pass.
4. **Never weaken an expectation to make it pass.** When a test resists, the test is usually right
   — several bugs here were found by agents that refused to relax one.

Loosening an assertion, widening a tolerance, deleting a case, or adding a conditional skip in
order to go green are all the same move, and all of them are the failure this rule exists to stop.

## Prove a decision that carries weight

When a choice is load-bearing, break it deliberately and confirm the **specific** test that should
fail does fail. Two designs that looked fine were caught this way. Undo the break immediately.

## House idioms

Copy these rather than inventing a style — verified against the suite:

- **Hand-written fakes, not `vi.mock`.** The named ones are `fakeFs.ts`, `fakeHookFs.ts` and
  `memorySqlite.ts`; `CONTRIBUTING.md` gives their paths. `vi.mock` appears in only 2 test files
  (5 occurrences) in the whole suite, so reaching for it means you are probably going against the
  grain.
- **Injected clocks.** Where a module takes a `now`, pass a mutable `{ now }` object and advance it
  by hand (`clock.now += 601_000`). Where the module owns its own timers, use `vi.useFakeTimers` —
  10 test files do.
- **Vitest globals are off.** Import `describe` / `it` / `expect` explicitly.
- **jsdom is opt-in per file** via a `// @vitest-environment jsdom` docblock; the default
  environment is `node`. 14 files opt in.
- **Pass the OS in explicitly.** Take a `Platform` parameter so macOS and Linux assertions run on a
  Windows host — see [`platform-ports`](../platform-ports/SKILL.md).
- **No network, ever.** The one honest exception to "no real disk" is the adapter tests that exist
  to prove the real adapter works, which use a temp dir. Everywhere else a real path or a real
  timer in a unit test is a bug.

## Getting it wrong

- **Writing the test after the code.** It will pass on the first run and you will have learned
  nothing about whether it can fail.
- **Editing the assertion instead of the code.** If you changed a test and the production code in
  the same breath to make something pass, stop and say so.
- **Losing tests while adding them.** Different failure, same file: see
  [`test-safety`](../test-safety/SKILL.md), and run the census before reporting.

## References

- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — testing philosophy, the named fakes, the seven
  checks CI runs
- [`test-safety`](../test-safety/SKILL.md) — not losing tests that already exist
