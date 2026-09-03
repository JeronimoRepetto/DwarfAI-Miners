# The custom launch command, and why the panel refuses to run one

The Add Panel's chip row ends with **Other**, and Other opens a box you can type a command
into. Issue #168 asked for a ruling on what happens when you press Enter on it: build a real
invocation path with its security posture thought through, or refuse the feature outright and
say so. Leaving it inert was not one of the options.

**The ruling is refusal.** The panel will not start a command of your own. This document is
the reason, so that the next person to look at that chip finds an answer rather than a gap.

## The short version

A launched custom command produces **no dwarf** — not "not yet", but structurally, for as long
as the panel observes sessions the way it does. Running one would start a real process in one
of your folders and then show you nothing, forever. That is worse than the refusal it
replaces.

## The long version

### What the panel actually is

This app does not run agents. It **observes** them: every dwarf on the board comes from a
provider reading a store that some agent CLI wrote — Claude's transcripts, Codex's rollout
files and thread registry. `DwarfProvider` is the list of stores that can be read, and it has
two entries.

A launch does not change that. `AgentLaunchResult` says so at length, and means it: `launched`
means a process was started, never that anything is on the board. The dwarf turns up later,
when the ordinary poll finds the session in the provider's own storage. There is exactly one
observation path and the launch is not it.

### Why a custom command has no dwarf

Give the panel `my-agent --do-the-thing` and it can start it perfectly well. Nothing then
writes a Claude transcript, and nothing appends to a Codex rollout, because those files are
written by those CLIs. No provider has a store to read. The poll finds nothing, and the Add
Panel sits in its spawning state waiting for an arrival that cannot happen.

`launchState.ts` reached the same conclusion from the other direction long before this
document, in the comment on the constant itself: `OTHER_CHOICE` is deliberately kept out of
`DwarfProvider`, because that union "is who OBSERVED a dwarf, and no observation ever comes
back saying 'other'". A thing that is never observed cannot be drawn.

### What building it anyway would cost

To make a custom command visible you would need a third way of noticing a session — scanning
the process table for children the panel started, say, and drawing a dwarf from the fact that
a PID exists. That is precisely the second observation path #86 refuses, and it would be a
worse one than either provider has: no model, no tokens, no status beyond "still running", no
transcript to read, no message to deliver, nothing to kick. A dwarf that is only a rectangle.

`docs/question-capture-evaluation.md` states the discipline this falls under — for rows with
no evidence behind them, "there is no comparable evidence, and none should be invented" — and
`docs/console-hosting.md` puts it shorter: **absent beats guessed**.

### Security was not the deciding argument, but it is not nothing

Had the feature been worth having, it would still have had to be arbitrary program execution
driven by a text box in an always-on-top panel, running in a folder the app chose rather than
one you were standing in. A safe version is buildable — no shell anywhere, the command
resolved as a program name plus an argv array, anything carrying shell metacharacters refused
— and that is roughly what the launcher already does for the two known CLIs.

None of that changes the paragraph above. It is a cost with no benefit on the other side of
it, which is why the refusal is stated on the observation ground and not this one.

## What the panel does instead

The chip stays where the design puts it, and the box it opens still works, because hiding it
would be answering a product question by deletion. Enter says why, in one line, and starts
nothing:

> A launch command of your own would start a process no dwarf could ever be drawn from — the
> panel observes agents through their own session files.

Two things follow that are worth stating plainly:

- **This is not a limit of the wire.** `AgentLaunchRequest` could carry a command string
  tomorrow. It does not carry one because there is nothing good to do with it.
- **This is not "not built yet".** The old copy said that, and it was true when both launch
  channels resolved their own CLI and there was nowhere for a command to go. Since #168 there
  is somewhere for it to go, and the answer is still no.

## What would change the ruling

One thing: a custom command that leaves a **readable session store behind it**. If a third
agent CLI arrives that writes transcripts this app can read, the honest way to support it is
to add it to `DWARF_PROVIDERS` with a provider that reads its store — which is the path
`CONTRIBUTING.md` already describes, and which gives it a chip of its own rather than a
generic box.

That is the difference the chip row draws. A named provider is one the panel can watch. Other
is not.

## Where this is enforced

- `src/renderer/src/lib/launch/providerChips.ts` — the refusal and its copy.
- `src/renderer/src/composables/useAgentLaunch.ts` — refused before it reaches the bridge, so
  no launch is ever sent for a choice with no engine behind it.
- `src/shared/contracts.ts` — `AgentLaunchRequest.provider` is a `DwarfProvider`, and a custom
  command is deliberately not a value it can take.
