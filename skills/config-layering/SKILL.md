---
name: config-layering
description: >
  The three configuration layers, why a packaged app never sees .env, and the deliberate split between a bad shape and a bad value.
  Trigger: before adding a setting, changing how configuration is read, or documenting a configuration option.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '1.0'
  scope: [root]
  auto_invoke:
    - 'adding or changing a configuration setting'
    - 'documenting a configuration option'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# Three layers, most specific first

Configuration resolves **environment, then a JSON file under Electron's `userData`, then
defaults**. The file layer is stored _underneath_ a real environment, so `pnpm dev` with a repo
`.env` behaves exactly as it always did — dotenv has already populated the environment by the time
the file layer is consulted.

Two details worth copying rather than reinventing: a **blank** environment variable counts as
"unset at that layer" and falls through to the file rather than past it, and the layering is built
with prototype chaining rather than a spread, deliberately.

## The trap that produced this

`dotenv` resolves `.env` relative to the **working directory**, and an installed app never runs
from the repository. So every documented setting was unreachable once packaged, and the app
silently ran on defaults — the entire Configuration section of the README applied only to a dev
checkout. That was issue #38, and the `userData` JSON file is the transport that fixed it.

**When you add a setting, ask where it can be set from an installed app.** If the answer is only
`.env`, you have rebuilt the bug.

## Bad shape degrades, bad value fails fast

This asymmetry is the one thing worth reading twice, and both halves are implemented.

| Kind            | Example                                                                     | Behaviour                                               | Why                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Shape** error | unparseable JSON, a non-object document, a value that is an array or `null` | degrades to "no entries", startup continues on defaults | It is corruption, indistinguishable from a file that was never written. Refusing to start would leave a packaged app with no way back in. |
| **Value** error | a port of `70000`                                                           | throws, fails fast                                      | It is not corruption; it is a legible instruction that cannot be carried out. Silently ignoring it recreates the original bug.            |

Degrading is **not** silent: the loader warns by name when it discards a file, because starting on
defaults quietly would look exactly like the bug this was added to fix. And the writer refuses to
persist anything the next startup would reject, so the one writer under our control cannot produce
a file that fails to load.

## The rule

1. New setting → make sure it is reachable from a packaged app, not just from `.env`.
2. Malformed **document** → fall back to defaults, and warn by name.
3. Malformed **value** → throw, with a message naming the key and what was received.
4. Add the case to the precedence tests. There is a test named after the precedence rule
   (`resolves all three layers at once, most specific first`) plus siblings covering environment
   over file, blank-does-not-mask, fall-through to defaults, fail-fast on a bad file value, and the
   environment rescuing a value the file gets wrong. Put your case next to them.

## One setting that is deliberately not a setting

The simulated valley's switch is read straight from the environment and **never enters the
resolved config object**, so the `userData` file cannot carry it. A tripwire test asserts exactly
that. If you are tempted to route a development-only switch through the normal config path, read
[`simulated-valley`](../simulated-valley/SKILL.md) first — that omission is the point.

## References

- [`README.md`](../../README.md) — the user-facing Configuration section, including the
  dev-versus-installed distinction
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — `.env` setup and the fail-fast-at-startup contract
