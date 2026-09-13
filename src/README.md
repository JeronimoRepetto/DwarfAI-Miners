# The shape of `src/`

This file exists to answer one question: **where does the file I am about to add go?**

It does not repeat the project's rules. [`AGENTS.md`](../AGENTS.md) carries the boundaries that
must survive (`shared/contracts.ts` as the single wire-type declaration point above all), and
[`CONTRIBUTING.md`](../CONTRIBUTING.md) is the contributor guide — including the per-platform
rule: pure builders plus a thin runner, selected once in `platform/platformAdapters.ts`.
Read those for _why_; this one is only _where_.

## The rule

**A directory is a subject, not a layer.** It is named for the thing it is about — the map, the
cave scene, the vault, a delivery to a session — and it holds every module about that thing,
whatever kind of module it is.

Four consequences, in the order you will need them:

1. **Put a new module in the directory named for what it is about**, not for what it is. A
   constant table, a geometry function and a wording helper that are all about the cave are all
   `lib/scene/`.
2. **Never create a directory for a _kind_ of module** — no `utils/`, `helpers/`, `common/`,
   `misc/`, `types/`. A name that admits anything ends up holding everything, which is exactly
   how `lib/` reached twenty flat modules (issue #49).
3. **A module whose subject is the panel as a whole has no family**, and stays at the top of its
   directory rather than being forced into the nearest group. `lib/art.ts` (every image),
   `lib/presentation.ts` (every word) and `lib/placement.ts` (deterministic slot assignment,
   which the map, the scene _and_ the vault each use) are the three that earned it. Being
   imported from two places is not the test — the test is whether you can name its subject and
   find that subject in the tree.
4. **A real subject with one module in it is fine.** `lib/map/` holds one file today. That is
   not a group waiting to be justified; it is the second map module already having an obvious
   home.

Two conventions that keep the rule enforceable:

- **A test sits beside its subject.** `foo.ts` and `foo.test.ts`, always in the same directory,
  and a move takes both.
- **No per-group barrel.** Groups have no `index.ts`; imports name the module they want
  (`../lib/scene/sceneSizing`). A barrel would hide which group a file actually came from, and
  the import path is what makes a wrong home visible in review. The only barrels in the project
  are the two deliberate ones — `main/domain/types.ts` and `renderer/src/types.ts` — through
  which each process reads `shared/contracts.ts`.

## The tree

```
src/
├── shared/          the wire boundary: contracts.ts, plus accelerator, truncate and externalLink
├── preload/         the API surface exposed to the renderer
├── main/
│   ├── index.ts     composition root — the only file that owns Electron's ipcMain and globalShortcut
│   ├── adapters/    injectable seams for fs and sqlite, with their fakes
│   ├── appDatabase/ the one file the app writes: its schema version, and the migrations between versions
│   ├── config/      typed settings, and the userData document layered under the environment
│   ├── domain/      this process's type barrel, and the pure domain rules (materials, ledger, lifecycle)
│   ├── history/     what a mine's transcripts on disk remember: every dwarf that spoke there, read on request
│   ├── hooks/       the opt-in Claude hooks push channel
│   ├── ledger/      what has been mined, persisted, plus the coal backfill and its migration
│   ├── platform/    everything that knows an operating system, and platformAdapters.ts that composes it
│   ├── projects/    every project the app has been shown, persisted: name, dates, provenance
│   ├── providers/   reading each agent CLI's own on-disk session state, registry.ts that composes it, and feedWindow.ts that bounds a feed read by messages rather than bytes
│   ├── runtime/     the poll loop: AgentRuntime, the poller, the publish gate, the profiler
│   ├── sessionLaunch/ starting a session, and holding one open so its questions reach the panel
│   ├── shell/       the app as a desktop citizen: window, tray, autostart, shortcut, persisted preferences
│   ├── textDelivery/ getting text into a running session, and knowing which channel can
│   └── tier/        measuring a project to a tier
└── renderer/src/
    ├── App.vue      the SHELL window's root; types.ts beside it is this process's type barrel
    ├── MessagePanelWindow.vue  the message panel's own window (#162) — the second root, one entry
    ├── assets/      processed art and css
    ├── components/  shell/ · map/ · scene/ · dwarf/ · message/ · history/ · launch/ · vault/ · panel/ — thin, and decide nothing
    ├── composables/ the Vue-bound state (`use*`), one per concern
    ├── lib/         framework-agnostic logic, unit-tested without a component:
    │                  shell/     the frame every screen sits in: the areas the rail opens onto, how its ground folds into the rail, and the one bounded runner every panel's motion goes through
    │                  map/       the authored dig sites of the valley and the trails between them
    │                  scene/     the cave: anchors, geometry, who stands where, motion, sizing
    │                  vault/     ore: tokens into units of a material, and how a heap of it is drawn
    │                  message/   what a dwarf's panel may honestly show, how far back it pages, how tall it opens, and what its Markdown means
    │                  history/   the mine-wide history: tab order, the 50-message cap, the timestamp's spelling
    │                  launch/    starting an agent: the gates, the chips, and whose dwarf arrived
    │                  delivery/  reaching a session: the four actions, and whether it provably worked
    │                  overlay/   the boxes that float over a sprite: speech bubbles and the tooltip
    │                  sprite/    the dwarf drawing: packed sheets, which frame shows, which loop plays
    │                  art.ts · presentation.ts · placement.ts — see rule 3
    └── testing/     factories for tests
```

`components/` and `lib/` share the family names `shell`, `map`, `scene`, `message`, `history`,
`launch` and `vault` on purpose: a component may read from several `lib/` families, but when a name exists in
both, it means the same thing in both.
