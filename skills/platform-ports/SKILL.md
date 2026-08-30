---
name: platform-ports
description: >
  How per-OS behaviour is isolated behind ports so that macOS and Linux assertions run on a Windows host.
  Trigger: before adding or changing anything that behaves differently per operating system, or before reading process.platform anywhere.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '1.0'
  scope: [root]
  auto_invoke:
    - 'adding behaviour that differs per operating system'
    - 'reading process.platform or shelling out to an OS command'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# Per-OS behaviour goes behind a port

Windows is the only platform verified end to end here, and the whole suite has to keep running on
it. That is only possible because almost nothing asks the OS what it is — it takes a `Platform` as
a parameter instead, so a test can pass `'darwin'` on a Windows host and assert real behaviour.

## The rule

**Take a `Platform` parameter; do not read the running OS.** Most functions default it to
`currentPlatform()`, so callers stay clean and tests pass the OS in explicitly.

The running OS is read in **three call sites (four occurrences)** across production code — inside
`currentPlatform()`, and twice in the main entry point (shortcut key names, and the platform handed
to the hook channel). Adding a fourth call site needs a reason. Tests read it **zero** times, and
that number should stay zero.

## Composition

`platformAdapters.ts` is the single per-OS composition point. It exposes two entry points, and the
split is deliberate:

- `createPlatformAdapters()` composes the runtime ports — focus, the terminal transcript viewer,
  text delivery (which composes console input in turn), and process probing.
- `createAutostartPort()` is **separate**, because autostart is owned by the tray and the startup
  path rather than by the runtime. Its own comment says so.

Everything downstream depends on those ports, never on the OS.

## Pure builders, thin runners

Anything OS-specific produces a **testable value** — a command's argv, a file's exact bytes — and a
thin runner executes it. That is what makes per-OS behaviour assertable without the OS.

The text-delivery port is the exemplar. It is a types-only module, and its `supportsConsoleInput`
capability flag lets a caller ask _"can you?"_ instead of _"which OS?"_. Its single production
consumer uses it to downgrade a terminal delivery target to a relay when console input is
unavailable — a decision expressed entirely in capability terms.

Prefer a capability flag to a platform check whenever you can name the capability.

## One comment not to repeat

The `AgentRuntime` constructor carries a comment saying it is _"the one place the running operating
system is consulted"_. That is true **within that module** and false for the app, which has three
more sites elsewhere. Do not quote it as an app-wide claim; it was already restated inaccurately
once.

## Getting it wrong

- **Branching on the OS deep in a call chain.** It makes the behaviour unreachable from a test on
  any other host. Push the decision up to composition, or express it as a capability.
- **Adding a fourth read of the running OS** because it was convenient. Take the parameter.
- **Hardcoding a path to these modules.** The tree is being regrouped; find them by basename.

## References

- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — the platform-validation ask, and why the suite must
  stay platform-independent
- [`tdd`](../tdd/SKILL.md) — passing the OS in explicitly is a house idiom
