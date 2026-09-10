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
capability flag lets a caller ask _"can you?"_ instead of _"which OS?"_. Its production consumer
uses it to downgrade a terminal delivery target to a relay when console input is unavailable — a
decision expressed entirely in capability terms.

Prefer a capability flag to a platform check whenever you can name the capability.

**Name the capability the ACT needs, not the one the platform is famous for.** That downgrade
applied to Kick as well until #366, and it should not have: ending a session needs a pid, where
typing needs the window server. So the same button ended the session on Windows and asked the agent
to stop by relay on macOS and Linux — two acts behind one label, from one capability doing duty for
two. The degrade now lives on the send route (`degradedForSend` in `resolve.ts`) and the kick route
keeps the console. A capability flag is only as honest as its scope.

## An absent method is a per-OS answer too

`TextDeliveryPort` has four optional methods, and each absence states something true about a
platform rather than marking a gap somebody forgot to fill. The runtime turns every one of them
into a stated refusal, never a silent no-op.

`endConsoleSession` is the one to read before adding a fifth (#329, #366). Both ports implement it
now, and the way the POSIX one arrived is the lesson. It was absent because `ProcessEndPort`'s POSIX
branch signals the process **group** (`kill -TERM -<pid>`) — correct for a process this panel
started as a group leader (#217) and wrong for a session somebody else launched, whose pid leads no
group of ours. Implementing it on that argv "for symmetry" would have been a builder producing a
command that is not true of the case: the signal would either miss or reach a group we never
created.

What #366 added instead was a **second pair of builders** for the second case — `kill -TERM <pid>`
and `kill -KILL <pid>`, the direct pid — with the group form left exactly as it was, and a comment
at both saying why one act cannot serve both. That is the shape to copy: when a platform cannot do
the same thing, give the new case its own testable argv rather than bending the existing one, and
leave a per-OS absence in place only while it states something true.

Note also which absence remains: the POSIX tier is reachable only once `Dwarf.pidStartedAt` can be
measured there, because the fail-closed pid guard refuses without it. Fail closed and say so; do
not relax a guard to make a new tier reachable.

## One port answers one question, everywhere it is asked

`ProcessProbePort.processStartTimeMs` now has two callers with opposite failure directions, and they
share the port precisely so the two answers about one pid can never come from two different probes.
The Claude provider reads it to tell a live session from a recycled pid; both ports'
`endConsoleSession` re-read it immediately before the end (#231, #366). All of them use the same
`sameProcessStart` comparison and the same `PROCESS_START_TOLERANCE_MS`, which is why that constant
lives in `processProbe.ts` rather than in any caller.

**What differs is what an unknown means, and that belongs to the caller, never to the port.** The
probe answers `null` for "could not determine" and says nothing about what to do with it. Liveness
fails open — an unreadable process list must not make a running dwarf vanish. A kill fails closed —
`taskkill /T` on a recycled pid ends a stranger's program and cannot be undone. A port that decided
this for both would have to be wrong for one of them.

## One comment not to repeat

The `AgentRuntime` constructor carries a comment saying it is _"the one place the running operating
system is consulted"_. That is true **within that module** and false for the app, which has three
more sites elsewhere. Do not quote it as an app-wide claim; it was already restated inaccurately
once.

## Getting it wrong

- **Branching on the OS deep in a call chain.** It makes the behaviour unreachable from a test on
  any other host. Push the decision up to composition, or express it as a capability.
- **Adding a fourth read of the running OS** because it was convenient. Take the parameter.
- **Hardcoding a path to these modules.** Issue #49 already regrouped the tree once
  (`ae9890c`); find current locations from `src/README.md`'s map rather than assuming a path is
  still where it was.

## References

- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — the platform-validation ask, and why the suite must
  stay platform-independent
- [`tdd`](../tdd/SKILL.md) — passing the OS in explicitly is a house idiom
