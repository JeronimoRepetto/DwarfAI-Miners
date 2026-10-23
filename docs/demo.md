# The demo showcase

`pnpm demo` starts the built app on a throwaway profile with themed mines and scripted dwarfs, so the Panel, Veta and
Valle can be recorded working together. `pnpm demo:shots` drives the same scenario and saves a PNG of each mode.
Everything in it is simulated: the mines are generated folders, every dwarf (worker or foreman) runs on a stub CLI, and
every word a dwarf says is scripted in `scripts/demo/scenarios/showcase.json`. No real provider agent ever runs, and
nothing is spent on anyone's subscription (see "The hard guard").

## Run it

```sh
pnpm install --frozen-lockfile
pnpm exec install-electron     # once per checkout
pnpm build                     # the demo runs the built app in out/; it builds nothing itself
pnpm demo                      # Ctrl+C, or Stop everything and quit in the app, ends it
```

Options (`pnpm demo --help`):

| Option                 | What it does                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `--scenario <name>`    | The scripted scenario, `scripts/demo/scenarios/<name>.json`. Only `showcase` today.                 |
| `--speed <0.25-10>`    | Divides every scripted delay. The app's own clocks do not change (see "Timing").                    |
| `--duration <seconds>` | Ends the demo by itself after that long, as Ctrl+C would.                                           |
| `--keep`               | Keeps the profile folder after the demo (its path is printed). The Host and the stubs still end.    |
| `--sound`              | Lets the app play its sound. Muted by default.                                                      |
| `--notifications`      | Lets the OS notifications show. By default they are recorded and never drawn, so no toast or chime. |

Every run starts from a fresh profile, so a new run is the reset. A demo that was killed without its cleanup can leave a
`dwarfai-demo-*` folder in the OS temp folder; delete it by hand.

## What the showcase shows

One mine per dwarf universe and one mine named like a software project, in the order Valle's Control room and Veta's
strip show them:

| Mine                | Tier    | Crew                                                                                                   |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `Moria`             | Uranium | Balin (asks a permission), Óin, Ori (asks two questions, Codex), Gimli (finishes early), Glóin, Dwalin |
| `Heigh-Ho Mine`     | Silver  | Doc, Grumpy (asks two questions, Codex), Happy, Sleepy (falls asleep), Bashful, Sneezy, Dopey          |
| `Nidavellir`        | Silver  | Brokkr, Eitri, Dvalin, hard at the forge                                                               |
| `Boatmurdered`      | Copper  | Urist McMiner, Urist McMason                                                                           |
| `Karak Eight Peaks` | Bronze  | Gotrek, Belegar                                                                                        |
| `Erebor`            | Gold    | Thorin, Fíli, Kíli, Bombur (falls asleep); Bofur starts there after 75 s ("started in Erebor")         |
| `ore-ledger`        | Copper  | one dwarf under the app's own name, fixing the ledger                                                  |

Each dwarf is launched through the app and then given its name with the app's own Rename. The asks open after the
dwarfs have worked for half a minute or so. Bombur and Sleepy finish in a few seconds and are left alone, so the Host
puts them to sleep after 60 s. After the timeline the demo holds the scene: a dwarf whose turn ended a while ago gets a
follow-up and works again, and an asking dwarf whose ask was answered asks again later, so the needs-you counter and
the queue keep coming back. The data is the app's own (the profile's database and Host), so everything carries from one
mode to the next.

### Changing names and words

`scripts/demo/scenarios/showcase.json` holds every mine name, tier, crew, dwarf name, prompt, reply, question and
timing; no code changes are needed to rename a mine or a dwarf. Set a dwarf's `name` to `null` to keep the name the app
gives it. `pnpm vitest run scripts/demo` checks the file still keeps the showcase's promises (asks in the richest mine,
sleepers, the late start off screen, crews of many sizes, exactly one mine named like a software project). A mine name
is letters, digits, spaces, hyphens and apostrophes.

### A flow to record

1. Start on the Panel's Map: the markers appear as the mines are measured, then the dwarfs arrive one by one.
2. Open Moria from the Mines page and Ori's chat: the question card. Answer it on camera.
3. Move to Veta: the strip with every crew, the same dwarfs working; raise Gimli's chat and hand it off to the Panel or
   Valle.
4. Move to Valle's Control room: every tier side by side, the needs-you counter with Balin's permission and Grumpy's
   questions. Click the counter to jump to the oldest ask and answer it.
5. Stay in Valle past 75 s: Bofur starts in Erebor (the sixth column, off screen at four columns) and the "started in"
   notice shows.
6. Dive into Moria (the Work front), split two chats, open the History drawer.
7. Back to the Panel: the answers given in Veta and Valle are there; Bombur and Sleepy are asleep.

Window sizes that read well on video: Valle at 1600 x 960 or larger, so four columns fit and Erebor is off screen; Veta
at its default height along the bottom edge; the Panel docked at its default width.

## Shots

```sh
pnpm demo:shots --out <folder>   # default: a new dwarfai-demo-shots-* folder in the OS temp folder
```

It plays the same scenario, waits until a question and a permission are open and the late dwarf started, then saves
page captures (no OS title bar, nothing behind the window):

| File                           | What it shows                                                    |
| ------------------------------ | ---------------------------------------------------------------- |
| `panel-map.png`                | The Panel's Map with every mine                                  |
| `panel-mines.png`              | The Panel's Mines page with every tier                           |
| `panel-mine-question.png`      | Moria's column with Ori's question card                          |
| `panel-settings.png`           | The Panel's Settings                                             |
| `veta-strip.png`               | Veta's strip with the crews                                      |
| `veta-risen-chat.png`          | A chat risen from Veta                                           |
| `valle-control-room.png`       | Valle's Control room: the tiers, the waiting dwarfs, the counter |
| `valle-work-front-split.png`   | Valle's Work front on Moria, two chats split                     |
| `valle-work-front-history.png` | The same, with the History drawer open                           |

A shot that cannot be reached is logged and skipped; the others are still taken. Nothing is committed: pick the images,
read each one at full size (skill `privacy-guard`), and only then add the ones you want to the README.

## Timing

`--speed` divides the scenario's own delays: launches, steps, the late start and the hold loop. Two clocks belong to
the app and do not move: a dwarf is asleep after 60 s idle, and a missing mine folder is noticed within 30 s. The first
crews are launched one after the other, each once the previous one arrived, so the 25 first launches take a minute or
two whatever the speed.

## The hard guard

The demo refuses to start, naming every reason, unless only its own stubs can be run:

- Every provider CLI the app may detect, ACP adapters included (`claude`, `claude-agent-acp`, `claude-code-acp`,
  `codex`, `codex-acp`, `opencode`, `antigravity`, `agy`, `gemini`, `kimi`), is resolved on the app's PATH the way the
  platform resolves it (each folder in order, each `PATHEXT` extension on Windows). `claude` and `codex` must resolve
  to the demo's stubs in `<profile>/stubs/`; any other must resolve there or nowhere. A real install found first, such
  as a `claude.exe` in a home `bin` folder or a `codex.exe` under the local app data folder, stops the demo before the
  app starts (`resolutionProblems` in `scripts/demo/isolation.mjs`, unit-tested).
- The app's PATH is the two stub folders, node's folder and the OS tools, nothing else: no home `bin` folder and no
  install location is on it. Node's folder is needed to run the stubs, so the demo also refuses to start if it, or any
  other folder outside the profile, holds a provider CLI at all, for example a global `claude-agent-acp` installed next
  to node.
- The Host starts from the app's environment, so every launch it makes later resolves on the same PATH: a dwarf a
  person launches from the UI, a foreman's delegated worker, a relaunch. None can reach a real CLI. The stubs run
  nothing but the DwarfAI relay the Host hands them for asks; they read no credential, open no connection and write
  only their transcripts under the profile's provider homes.

## What the demo never touches

- The profile is a fresh `dwarfai-demo-*` folder in the OS temp folder, made with the E2E harness's
  `createIsolatedProfile` (`e2e/_harness/launchApp.ts`): its own userData, home folders (HOME, USERPROFILE, APPDATA,
  the XDG homes), provider homes (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), the Host's data root and the Host endpoint keyed
  to it. Before the app starts, `scripts/demo/isolation.mjs` checks the environment it is handed and refuses to start
  if any of those folders lies outside the profile.
- The first-run step is answered with every option off, so nothing is written into any tool's config, and the
  keyring is never asked for a secret.
- On the way out the demo runs Stop everything and quit, ends anything still running from the profile, and removes it
  unless `--keep`.

## How the mines get their tiers

A tier is the Host's measurement of the mine's folder, never stored by hand: the bytes of its source files, each under
300 KB, copies counted once (`src/host/modules/mines/adapters/sourceWeight/sourceWalk.ts`), banded at 350 KB (Copper),
1 500 KB (Silver), 12 000 KB (Gold) and 100 000 KB (Uranium). `scripts/demo/tierFiles.mjs` writes generated,
fictional TypeScript into each mine folder until it weighs into the wanted band, and `tierFiles.test.mjs` runs the
Host's own walk and tier rule over the plan. The Uranium mine is therefore about 100 MB of text in the temp folder,
removed with the profile.

## How a dwarf works and earns ore

The Host marks a launched dwarf working, and credits its ore, from the transcript it observes, not from the driver
(`usagePath: 'transcript'`, `src/host/modules/crew/domain/dwarf.ts`). So each stub writes the transcript its real CLI
would: the Claude stub `<CLAUDE_CONFIG_DIR>/projects/<encoded folder>/<session>.jsonl`, the Codex stub
`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`, both inside the profile (the Host hands each child its provider
home, and the guard keeps both in the profile). The person's line keeps the uuid the driver sent, as Claude Code does,
so the Host matches the two. Each reported message carries enough tokens for at least one unit of the richest
material, so ore shows in every tier.

## Limits

- The stubs script Claude (stream-json) and Codex (app-server) only; OpenCode, Antigravity and the other providers are
  absent from the demo. Claude's stream-json driver asks no questions (`--disallowedTools AskUserQuestion`), so the
  question cards come from Codex dwarfs.
- The scripted dwarfs never delegate on their own; a delegation started from the UI during the demo launches stubs too.
- A dwarf's Stop and interrupt work, but a stopped scripted dwarf is not relaunched by the hold loop.
- About 26 stub processes run at once, each a small Node process: expect a few hundred MB of memory.
- The scenario supports a crewless mine whose folder is removed (`enterable: false`, shown unenterable); the showcase
  has none, since every mine on the owner's list has a crew.

## Files

- `scripts/demo/demo.mjs`: the command line; `args.mjs`: its options.
- `scripts/demo/run.mjs`: the profile, the guard, the launch, the timeline and the hold loop; `app.mjs`: the reads and
  actions through the app's `window.api`; `shots.mjs`: the captures.
- `scripts/demo/scenarios/showcase.json`: the mines, crews, names, prompts and scripted turns; `scenario.mjs` reads it.
- `scripts/demo/isolation.mjs`: the isolation checks and the hard guard.
- `scripts/demo/stubs/`: the Claude and Codex stub CLIs and their install into the profile.
- `scripts/demo/*.test.mjs`: the unit tests (`pnpm vitest run scripts/demo`), run by `pnpm test`.
