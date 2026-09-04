# The custom launch command: what Other starts, and what it does not promise

The Add Panel's chip row ends with **Other**, and Other opens a box you can type a command
into. Press Enter on a prompt and the panel **starts that command as a process it holds**, sends
the prompt down its stdin, shows its output as plain text, and draws a dwarf for it in the mine.

This document had the opposite ruling for its whole previous life. That ruling is
[reversed](#the-ruling-that-was-reversed-and-why), by the maintainer, on 2026-09-04, and the
reversal is kept in full below rather than deleted — the argument it made is still the clearest
statement of what a hosted dwarf **cannot** say about itself.

## The short version

The panel observes terminals **and is a terminal itself**. A process the panel holds needs no
session file to be observed, because the panel is its stdio. So there is still exactly one
observation path per dwarf, and for these dwarfs the observer is the panel — `PANEL_OBSERVER`
on the wire, never a provider.

Everything a transcript would have told you is therefore missing, and missing permanently.

## What Other actually does

1. The command is parsed into a **program name plus an argv array**. No shell, ever.
2. That program is started in the mine's folder, not detached, with all three streams piped.
3. The prompt goes down **stdin**, never in argv.
4. stdout and stderr are captured, folded into one stream, and shown as the dwarf's conversation.
5. The dwarf appears on the next ordinary poll and reports the panel as its observer.
6. The composer stays live: a later message goes onto the same stdin.
7. Kick **ends the process tree**. There is no interrupt.
8. Quitting the panel ends it. This process is its stdio; nothing else could read it.

## What it does not promise

This is the honest half, and it is longer than the feature.

**No transcript-derived fact, at all.** Not "not yet" — there is nothing that could ever report
one. A hosted dwarf carries no `model`, `effort`, `tokensUsed`, `tokensObserved`, `silentForMs`,
`transcriptUpdatedAt`, `attendance`, `waitingReason`, `pendingQuestion`, `mcpServers` or
`totalCostUsd`. It contributes no ore to the vault, and its mine's tier is the provisional one
any unwalked mine gets. Absence is what this app reads as unknown everywhere, and this is the
largest instance of it in the tree.

**No subagents.** Nothing observes children for a process nobody reads a store for, so a hosted
dwarf never has a crew and no worker ever relays through it.

**No reactions.** A message onto its stdin is `delivered` — bytes went into a pipe. Whether the
program read them is unobservable here, so the marker never promotes to ✓✓. That is the
`delivered` versus `reacted` rule (`reaction.ts`) applied to the one channel that can never
supply the second half.

**No interrupt.** Kick ends the process. This app knows nothing about what somebody else's
program treats as an interrupt, and a byte it happened to accept as one would be the panel
guessing at another program's key bindings. The panel says which act it performed, exactly as it
does for a launched session (#217).

**`working` means one thing.** It means the panel is holding a process that has not exited.
Splitting it into busy and idle would mean reading meaning out of rendered bytes — the heuristic
#60 refused, and the reason [`console-hosting.md`](console-hosting.md) turned a pty down.

**No shell, so no shell syntax.** Pipes, redirects, chains, background operators, command
substitution and variable expansion (`$HOME`, `%USERPROFILE%`) are **refused by name**, because
with `shell: false` they would not be interpreted — they would reach the program as literal
arguments and quietly do something other than what was typed. Single quotes are refused too:
POSIX groups with them and cmd.exe does not, so the panel declines to pick. Double quotes group
one argument and are removed; that is grouping, not a shell, and there are no escapes and no
nesting.

**No `.cmd` or `.bat`.** `spawn` of a shim without a shell throws `EINVAL` (verified on Node
v24.11.1 for #193), so it is refused by name. #193 taught the _detected-CLI_ launcher to read a
shim for the program it points at instead; that reading starts from a path detection produced,
and this starts from a name somebody typed, which may not be a path at all.

**No pty.** This is slice 1, and the maintainer's decision splits it deliberately: pipes now, a
real pty as its own later issue. A program that only draws a TUI produces escape sequences here
rather than a screen. A pty would be this project's first native module and a per-platform build
matrix in the release workflow, so it gets its own decision when demand shows up.

**No path with spaces, unquoted.** Quote it. There is no other spelling.

## Why hosting needs no console-hosting intermediary

Worth stating, because the detached launcher pays for one and this does not.

`buildLaunchSpawn` wraps a launch in a `node -e` intermediary, at the cost of one resident node
process per session, for a measured Win32 reason: libuv turns `detached` into DETACHED_PROCESS,
Win32 documents CREATE_NO_WINDOW as **ignored** alongside it, so a detached child gets no console
— and Windows then hands a console-subsystem grandchild whose parent has no console a fresh
**visible** one. That was #208's black window.

A hosted process is **not detached**. With DETACHED_PROCESS gone, `windowsHide` is honoured, the
child gets an invisible console of its own, and anything it starts inherits it. Which is exactly
the second hop the intermediary was invented to arrange — so a hosted process needs no host: it
already _is_ the non-detached, window-hidden hop.

Not detaching is also not a concession. libuv gives every non-detached child a
KILL_ON_JOB_CLOSE job, so a hosted process dies with the panel — which is the lifetime it must
have.

## Security, which was never the deciding argument and is not nothing

The old ruling described the safe version and then never built it:

> A safe version is buildable — no shell anywhere, the command resolved as a program name plus an
> argv array, anything carrying shell metacharacters refused.

That is what shipped, in `hostedCommand.ts`, as a pure function so the whole posture is asserted
by unit tests rather than inferred from a spawn no test may perform. Two further guards come from
the launch channels that already existed: the request names a **mine and never a directory**, so
this channel cannot be talked into starting a process somewhere the panel is not showing; and the
prompt travels on **stdin and never argv**, because argv is readable by any other process on this
machine (`docs/privacy.md`, #59).

None of that makes arbitrary program execution from a text box in an always-on-top panel free.
It is a cost the maintainer has now decided there is a benefit on the other side of.

## The ruling that was reversed, and why

Kept because this repository's history is its documentation, and a silent reversal is worse than
none. The previous ruling was **refusal**, from #168 (commit 3cd59e2), and it argued:

> A launched custom command produces **no dwarf** — not "not yet", but structurally, for as long
> as the panel observes sessions the way it does. Running one would start a real process in one of
> your folders and then show you nothing, forever. That is worse than the refusal it replaces.

Its reasoning, in its own terms:

- **What the panel is.** "This app does not run agents. It **observes** them: every dwarf on the
  board comes from a provider reading a store that some agent CLI wrote."
- **Why a custom command has no dwarf.** "Give the panel `my-agent --do-the-thing` and it can
  start it perfectly well. Nothing then writes a Claude transcript, and nothing appends to a Codex
  rollout, because those files are written by those CLIs. No provider has a store to read."
- **What building it anyway would cost.** "To make a custom command visible you would need a third
  way of noticing a session — scanning the process table for children the panel started, say, and
  drawing a dwarf from the fact that a PID exists. That is precisely the second observation path
  #86 refuses… A dwarf that is only a rectangle."
- **What would change the ruling.** "One thing: a custom command that leaves a **readable session
  store behind it**."

**Every factual claim in that argument is still true.** Nothing writes a transcript. No provider
has a store to read. A dwarf drawn from a scan of the process table would be a rectangle.

What was wrong was the step from those facts to the conclusion, in two places.

**First, the last bullet named the wrong sufficient condition.** It asked for a readable session
_store_. What a dwarf actually needs is an _observer_ — and the panel can be one. Not by scanning
the process table for a PID, which really would be a second observation path and really would
produce a rectangle, but by **holding the process**: this app started it, owns its stdin, and
reads its stdout. That is first-hand evidence of the strongest kind the app has, better than the
bounded transcript tail it reads for an observed session, and it arrives live. The dwarf is not
drawn from "a PID exists". It is drawn from "this process is holding that pipe".

**Second, "a dwarf that is only a rectangle" was an argument about facts, and it settled a
question about hosting.** The facts really are absent — the whole [What it does not
promise](#what-it-does-not-promise) section above is that bullet, kept and made specific. But a
dwarf you can type into, watch reply, and end is not a rectangle. `console-hosting.md` put the
same distinction better than either document managed at the time: **owning the bytes is not
understanding them**. It is not, and this feature does not claim to understand them. It claims to
own them, which is a smaller and completely different claim — and the one the product direction
needs, because the goal is to open the panel, open a project, launch agents and guide them from
there without opening a terminal.

The old ruling's final line was "A named provider is one the panel can watch. Other is not." The
correction is one word: a named provider is one the panel can **read**. Other is one it can
**hold**.

## Where this is enforced

- `src/main/sessionLaunch/hostedCommand.ts` — the parse, and the whole no-shell posture.
- `src/main/sessionLaunch/hostedProcesses.ts` — the register that holds them, and what one may
  honestly say about itself.
- `src/main/sessionLaunch/nodeHostedProcess.ts` — the spawn, and why it needs no intermediary.
- `src/main/sessionLaunch/hostedBoard.ts` — the stamp that draws them, and the mine it may create.
- `src/shared/contracts.ts` — `DwarfObserver`, `PANEL_OBSERVER`, the `hosted-stdin` channel, and
  `HostedLaunchRequest`. `DwarfProvider` is deliberately unchanged: it is the list of stores that
  can be read, and a hosted process is not one.
- `src/renderer/src/lib/launch/providerChips.ts` — where `OTHER_NOT_LAUNCHABLE` used to be.
- `src/renderer/src/lib/launch/launchState.ts` — `OTHER_CHOICE` is still not a `DwarfProvider`,
  and the reason is untouched by any of this: no observation ever comes back saying 'other'. It
  comes back saying 'panel'.
