# The simulated provider

A development-only provider that invents a valley — twenty mines, crowded
crews, dwarfs arriving and leaving — so the panel can be seen under load
**without launching a single real agent** (issue #42).

Running twenty real sessions to answer a visual question costs a serious amount
of the owner's token quota. This exists so nobody has to pay that again.

## Switching it on

```bash
DWARFAI_SIMULATE=1 pnpm dev
```

That is the whole switch. It is a real environment variable, set for one run,
exactly like `DWARFAI_PERF`.

## Why a packaged build cannot turn it on

A user must never see mines that do not exist. There are two independent locks,
and each is enough on its own.

**Lock 1 — the switch is not a setting.** `DWARFAI_SIMULATE` is read by
`loadSimulationConfig` straight from the process environment. It is deliberately
_not_ part of `AppConfig`, because `AppConfig` is fed by
`withConfigFileFallback`, which layers in the userData config file that #38 gave
every installed app. Anything reachable from `loadConfig` is reachable from that
file, and therefore reachable on a stranger's machine. The simulation is not
reachable from it: `config.test.ts` asserts that `loadConfig` returns the plain
defaults even when every simulation key is set.

**Lock 2 — the build refuses.** `createSimulation` returns `null` whenever
`isPackaged` is true, whatever the environment says, and logs that it did.
`isPackaged` is Electron's own `app.isPackaged`, which Electron derives from the
running executable; a packaged build cannot make it false through its
environment, its config file or its command line. `runtime.ts` passes the same
flag it already receives from `index.ts`.

Lock 1 keeps the switch tidy. Lock 2 is the one a user is actually protected by.

## Why phantom ore never reaches the real vault

While simulating, the persisted `MaterialLedger` that `index.ts` hands the
runtime is dropped on the floor — never observed, never saved, never opened. In
its place the runtime builds a full `MaterialLedger` over `nullLedgerStore()`.

So accrual is **not** bypassed. The real ledger code runs, on real deltas, and
the panel gets a vault that fills fast enough to overflow the 21-nugget pile cap
within a minute. Only the one wire to disk is cut. Bypassing accrual would have
been simpler and would have left #22's overflow exactly as unobserved as it was
before.

`runtime.test.ts` proves it: the injected store's `save` is never called, even
across `stop()`, and the injected ledger's totals stay empty while the panel's
totals grow.

## Settings

Every key below is ignored unless `DWARFAI_SIMULATE` is on. Invalid values fail
fast at startup with a `[config]` message rather than being silently corrected.

| Variable                   | Default   | Meaning                                                                    |
| -------------------------- | --------- | -------------------------------------------------------------------------- |
| `DWARFAI_SIMULATE`         | _(off)_   | The master switch. `1` or `true`; anything else is off.                    |
| `DWARFAI_SIMULATE_SEED`    | `dwarfai` | Seeds every choice. The same seed replays the same valley.                 |
| `DWARFAI_SIMULATE_MINES`   | `20`      | How many mines to invent (max 60). Above 13 the map's sites start sharing. |
| `DWARFAI_SIMULATE_CREW`    | `12`      | Largest crew a mine may hold, foreman included (max 40).                   |
| `DWARFAI_SIMULATE_TIERS`   | all five  | Comma-separated tiers to spread the mines across.                          |
| `DWARFAI_SIMULATE_STEP_MS` | `4000`    | How long one simulated tick lasts (250–600000).                            |
| `DWARFAI_SIMULATE_ANIMATE` | `true`    | Whether the crew churns. Off freezes the layout for a screenshot.          |
| `DWARFAI_SIMULATE_TOKENS`  | `75000`   | Tokens each dwarf burns per tick. `0` mines nothing.                       |

## Reproducing a bug found in a simulation

A seed and a tick number are the entire bug report. `world.ts` is pure — a
function from `(config, tick)` to exactly the snapshots a real provider would
have returned — so the same seed replays the same valley on any machine at any
hour. `simulatedProvider.ts` is the thin runner that owns the clock and turns it
into a tick.

```bash
DWARFAI_SIMULATE=1 DWARFAI_SIMULATE_SEED=the-seed-from-the-report pnpm dev
```

## Guaranteed crowding, not lucky crowding

Most of the world is hash-derived and varies by seed. Two things deliberately
are not, because a simulation whose overcrowding depends on a lucky seed proves
nothing on the unlucky ones:

- **Tier spread is round-robin.** With five tiers over twenty mines, a hash
  would often leave one tier unrepresented, and a spread nobody can see is a
  spread that tests nothing.
- **Mine 0 is a showcase mine.** It always holds the full crew, and its worker
  statuses come from a fixed cycle whose length is the default worker count — so
  rotating it by the tick is a _permutation_. Individual dwarfs change status
  every tick, exercising walk transitions and the grace window, while the counts
  stay exactly 6 working, 3 waiting and 2 leaving. Against 4 veins, 2 rest spots
  and 1 foreman post, every anchor pool is oversubscribed at every tick, at
  every seed.

Ordinary mines churn instead: each worker runs a deterministic shift and simply
stops being reported when it ends, which is how the lifecycle grace window gets
exercised for real. Faking a `leaving` status would skip the very code the
simulation exists to drive.

## What it deliberately does not do

- **No pid.** A pid is the one field the panel acts on — click-to-focus calls
  `focusPid` with it — and a made-up number pointing at some unrelated process
  is the one way this could do real damage.
- **No delivery channel.** `textDelivery` always answers `null`, so Send and
  Kick render disabled with a reason. Inventing a channel would mean inventing a
  session for the delivery tier to act on.
- **No transcript path**, so nothing tries to tail a file that does not exist.
  The in-panel feed still serves deterministic fake messages.

## Limits it was built to reach

Measured end to end through the real renderer placement code at the default
settings (20 mines, 181 dwarfs):

| Limit                       | Observed                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------- |
| 13 authored map sites (#20) | all 13 occupied, 5 shared, one holding 4 mines                                         |
| Cave anchor sharing (#19)   | up to 5 dwarfs on one anchor (3 on a vein, 5 at the exit)                              |
| Bubble staggering (#43)     | 5 bubble rows stacked, 144px of offset                                                 |
| 21-nugget pile cap (#22)    | 20 piles overflowing, one at 2610 units — drawn as 21 nuggets at the 1.6 scale ceiling |
| Poll budgets (#25)          | main-process poll: median 0.55ms, p95 1.05ms, max 2.07ms                               |
