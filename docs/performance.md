# Performance audit and budgets

DwarfAI-Miners is a permanent tray resident: it polls every 2 seconds for as
long as the machine is on, and its window floats above everything else. Nothing
here had ever been profiled, so this document establishes what the app actually
costs, sets budgets from those measurements, and records which fixes the numbers
justified — and which popular suspicions the numbers **cleared**.

Every figure below was measured on a real machine against real sessions.
Anything that could not be measured says so instead of being estimated.

## How to reproduce

**Poll-duration logging is built in, behind a debug flag.** It is inert unless
the flag is set — no clock reads, no allocations:

```bash
DWARFAI_PERF=1 pnpm dev
```

It has to be a real environment variable. A `.env` entry will **not** work:
`perf.ts` is imported while `index.ts`'s own imports resolve, which happens
before `index.ts` calls `loadDotenv()`, so the flag would arrive too late to be
read.

**The tier walk has the same kind of switch.** `TIER_DEBUG=1` (or `true`) makes every
tier walk print one line per skipped file — reason, size, path — and a closing tally
per project (#39). Unlike `DWARFAI_PERF` it is read per walk, not at import time, so a
`.env` entry works in a dev checkout.

**The Codex liveness gate has one too**, and it answers a different question: not what a
poll cost but why a session is not on the board. `CODEX_DEBUG=1` (or `true`) makes every
scan print one line per candidate rollout it refused — the verdict (`retention-floor`,
`no-process`, `unreadable-rollout`, `artifact-cwd`, `duplicate-session`), how old the
freshest activity signal was, whether Codex's own registry had a row for it, and the
path (#264). Read at construction like `TIER_DEBUG`, so a `.env` entry works. Expect
volume: a 7-day window holds dozens of long-dead rollouts and each is refused on every
2-second tick — filtering them would hide the very line you turned this on to find.

**The two windows have one too, and it is not a performance instrument.** `SHELL_DEBUG=1`
(or `true`) makes `src/main/shell/window.ts` narrate what it does to the message panel's
own window: the rectangle a first open asked for and what became of a persisted position,
each height report with the window's visibility before and after it, the branch every
later open takes instead, the window's own `close` handler firing, and the fallback that
reveals a window no height report ever arrived for (#312). It exists
because that whole path is silent — the window is created hidden and revealed only by the
renderer's first height report, and every refusal on the way there was a bare `return`, so
a first open that produced no panel produced no line either. Read per call like
`TIER_DEBUG`, so a `.env` entry works. Low volume: nothing here fires on a poll.

Every poll then prints one line: the total, where the time went, and what it
saw.

```
[perf] poll 10.4ms | cx.q.threads 1.2 cx.q.edges 0.1 cx.q.beats 3.4 cx.registry 5.2
  cl.list 5.7 cl.entry 1.2 cl.stat 0.5 cx.candidates 1.2 cx.stat 0.4 codex 6.9
  cl.read 0.7 cl.parse 1.0 claude 10.3 aggregate 0.0 ledger 0.0 stamp 0.0
  publish 0.1 | cx.candidates.n 84 cl.bytes 522392 sessions 4 dwarfs 5 skip 1
```

Read it with two cautions:

- **Providers are scanned concurrently**, so `claude` and `codex` overlap and
  can add up to more than the poll total. The total is the honest number; the
  per-provider figures say which scan is the long pole.
- **A stage's time is wall time, not CPU time.** A stage that waits behind
  another provider's synchronous work is charged for the waiting. This turned
  out to matter a great deal — see [the `cl.list` illusion](#the-cllist-illusion).

Other instruments used for this audit, none of them left in the tree:

| What                                                  | How                                                                                                                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle / visible CPU, RSS                               | `Win32_Process` + `TotalProcessorTime` deltas over 60 s windows, split by Electron process type                                                             |
| Renderer cost                                         | Chrome DevTools Protocol `Performance.getMetrics` over 45 s windows (`--remote-debugging-port`), sampling `TaskDuration`, `LayoutCount`, `RecalcStyleCount` |
| Tier walks, probe spawns, read/parse, session scaling | A temporary harness driving the real `FsLike`, `ClaudeProvider` and `sumSourceBytes` against this machine's real filesystem, deleted after the audit        |
| SQLite query cost and plans                           | `node:sqlite` read-only against the real Codex databases, with `EXPLAIN QUERY PLAN`                                                                         |

### The measurement machine

Windows 11 Pro 26200, Node 24.11.1, Electron 44. State at measurement time:

- **4 live Claude sessions, 5 dwarfs**, across 2 configured Claude roots.
- 107 Claude transcripts on disk: 47 over 256 KiB, 15 over 4 MiB, largest 12.9 MiB.
- Codex installed and running: **84 rollouts** in the 7-day scan window,
  `state_5.sqlite` 2.5 MiB / 139 threads, `logs_2.sqlite` **83.5 MiB / 57 053
  rows**.

That last line matters more than it looks. It is the single most expensive input
the poll has.

## Headline numbers

Measured on the **shipped 0.1.0 build**, panel hidden, over 60-second windows,
as percentages of one core:

|               | main  | gpu   | renderer | utility | total     | RSS     |
| ------------- | ----- | ----- | -------- | ------- | --------- | ------- |
| Panel hidden  | 1.01% | 0.05% | 0.05%    | 0.00%   | **1.12%** | ~455 MB |
| Panel visible | 0.80% | 1.25% | 0.86%    | 0.03%   | **2.93%** | ~487 MB |

Cross-checked against the same install's **9.24-hour lifetime average**: main
1.02%, gpu 0.56%, renderer 0.28% — 1.86% of one core overall. The main process
figure is identical to the windowed sample, which is the expected result: the
poll loop runs at the same cost whether or not anyone is looking.

Per-poll main-thread cost at 4 sessions / 5 dwarfs, after this audit's fixes:

|                     | median      | p90     | max        | mean    |
| ------------------- | ----------- | ------- | ---------- | ------- |
| Steady-state poll   | **10.3 ms** | 11.3 ms | 15.7 ms    | 10.5 ms |
| First poll of a run | —           | —       | **581 ms** | —       |

## What the poll actually spends its time on

Mean milliseconds per steady-state poll, 90 consecutive samples, after fixes:

| Stage                            | Mean           | What it is                                                       |
| -------------------------------- | -------------- | ---------------------------------------------------------------- |
| `cx.q.beats`                     | **3.36 ms**    | Codex heartbeat query over the 83.5 MiB log store                |
| `cx.q.threads`                   | 1.23 ms        | Codex thread registry query                                      |
| `cx.q.edges`                     | 0.10 ms        | Codex sub-agent spawn edges                                      |
| `cx.candidates`                  | 1.20 ms        | 7 day-directory listings                                         |
| `cx.stat`                        | 0.39 ms        | 84 rollout `stat`s (was 5.10 ms — see fix 1)                     |
| `cl.list`                        | 5.68 ms        | Claude session-directory listing — **mostly waiting**, see below |
| `cl.entry`                       | 1.17 ms        | Reading 8 session registry JSON files                            |
| `cl.read`                        | 0.71 ms        | Transcript tail reads, 522 KB across 4 sessions                  |
| `cl.parse`                       | 0.95 ms        | JSONL parsing of those tails                                     |
| `cl.stat`                        | 0.52 ms        | Transcript `stat`s                                               |
| `aggregate` / `ledger` / `stamp` | 0.00 ms each   | Below the 0.05 ms rounding floor                                 |
| `publish` / `ipc`                | 0.11 / 0.00 ms | Snapshot handoff to the renderer                                 |

Two conclusions follow immediately, and neither is what the issue predicted.

**The Codex provider dominates, and it dominates while finding nothing.** There
are zero Codex sessions on this machine, yet `cx.registry` costs 5.24 ms of every
poll, of which **3.36 ms is one query** whose cost tracks the size of the Codex
log store rather than anything the app cares about.

**Transcript reading and JSONL parsing — the things the issue expected to be
expensive — cost 1.66 ms combined.** The 256 KiB tail bound is doing its job.

### The `cl.list` illusion

`cl.list` reports 5.68 ms, which looks like an expensive directory listing. It
is not. Measured in isolation on the same machine, against the same directories:

```
<primary Claude root>\sessions:    exists 0.05ms avg, listDir 0.09ms avg (8 entries)
<secondary Claude root>\sessions:  exists 0.04ms avg, listDir 0.05ms avg (0 entries)
```

The syscall costs **0.09 ms**. The other ~5.6 ms is the Claude scan _waiting for
the event loop_, because the Codex provider is running concurrently and its
SQLite work is **synchronous** (`node:sqlite`'s `DatabaseSync`) and therefore
blocks everything else in the main process while it runs.

This is the most important structural finding in the audit. The poll's real cost
is not distributed across the two providers; it is one provider's synchronous
database work, with the other provider's timings inflated by it. It also means
the same 3.36 ms blocks IPC, window events and the tray for the duration.

## The renderer: the hidden-animation suspicion is false

The issue's sharpest worry was that an always-on-top transparent window keeps
animating while hidden, burning CPU on pixels nobody sees. **Measured, it does
not.** Chrome DevTools Protocol, 45-second windows:

|                                        | Task time                      | Layouts | Style recalcs | Sprite timer ticks |
| -------------------------------------- | ------------------------------ | ------- | ------------- | ------------------ |
| Visible, mine view, 5 sprites          | 793.9 ms (**1.76%** of a core) | 928     | 2 406         | 1.8/s              |
| **Hidden** (after having been visible) | 48.5 ms (**0.11%** of a core)  | **0**   | **0**         | 1.7/s              |

Hiding the window takes rendering to **exactly zero** layouts and zero style
recalculations. Chromium's default `backgroundThrottling` is already doing the
work, and the process-level sample agrees: the renderer drops from 0.86% to
0.05% of a core and the GPU process from 1.25% to 0.05%.

The per-sprite `setInterval` timers **do** keep firing while hidden, at a
throttled 1.7 ticks/second. They cost **1.6 ms of script over 45 seconds —
0.004% of one core**. Pausing them on `document.hidden`, as the issue proposed,
would buy that 0.004% and nothing else, because the expensive half (layout,
style, paint, composite) is already not happening.

**No change was made here.** A shared ticker or a visibility-gated pause would
add code and risk to reclaim four thousandths of one percent of a core. If the
sprite count ever grows far beyond 5, re-measure with `frameTimerTicks` before
reconsidering.

Two caveats worth recording:

- Before the window has _ever_ been shown, `document.visibilityState` reports
  `visible` even though nothing is on screen, and the snapshot pushes then cost
  ~1 style recalc per second. After a real show/hide cycle it correctly reports
  `hidden`. A fix keyed on `document.hidden` would therefore have been wrong for
  the entire first hidden period of every run — another reason the measurement
  was worth taking first.
- **Not measured:** the DWM/desktop-compositor cost of hosting a transparent,
  always-on-top, drop-shadowed window. That cost lands in `dwm.exe`, not in any
  of this app's processes, and separating this window's contribution from the
  rest of the desktop was out of reach with the tools used here.

### CSS animations roughly double the visible renderer cost

Two independent A/B pairs, injecting `* { animation: none !important }` and
re-measuring:

| View                 | Task time, animations ON | Animations OFF | Style recalcs ON → OFF |
| -------------------- | ------------------------ | -------------- | ---------------------- |
| Mine view, 5 sprites | 793.9 ms                 | 285.2 ms       | 2 406 → 357            |
| Map view             | 567.8 ms                 | 273.6 ms       | 1 941 → 389            |

The always-running infinite animations (`tier-pulse` on every mound, `zzz-float`
on resting dwarfs) drive **~50 style recalculations per second** and account for
roughly half of the renderer's task time while visible.

**No change was made here either**, for a product reason rather than a technical
one: those animations are what the panel _is_, they cost nothing while hidden
(which is most of the time), and 1.76% of one core while a user is actively
looking at an animated scene is not a problem worth trading the app's character
for. It is recorded so that the number is known if the panel ever becomes a
window people leave open all day.

## Budgets

Derived from the measurements above, with headroom for machines slower than this
one. These are the numbers a future change should be held to.

| Budget                                    | Limit                       | Measured today                  |
| ----------------------------------------- | --------------------------- | ------------------------------- |
| Idle total CPU, panel hidden, ≤5 sessions | ≤ 1.5% of one core          | 1.12% ✅                        |
| Idle main-process CPU, panel hidden       | ≤ 1.2% of one core          | 1.01% ✅                        |
| Renderer CPU, panel hidden                | ≤ 0.3% of one core          | 0.11% ✅                        |
| Renderer CPU, panel visible               | ≤ 2.5% of one core          | 1.76% ✅                        |
| Steady-state poll, 5 sessions             | ≤ 15 ms median, ≤ 25 ms p90 | 10.3 / 11.3 ms ✅               |
| Steady-state poll, 20 sessions            | ≤ 40 ms median              | ~27 ms projected ⚠️ (see below) |
| Any poll as a share of the 2 s interval   | ≤ 25% (500 ms)              | 581 ms on the first poll ❌     |
| Total RSS across all processes            | ≤ 600 MB                    | ~455 MB ✅                      |
| Tier walk, one project refresh            | ≤ 200 ms, ≤ once per 600 s  | 147 ms worst case ✅            |

The 20-session figure is a projection, not a measurement of the running app:
20 live Claude sessions could not be staged on this machine. It combines a
measured synthetic scan (below) with the measured Codex cost, and is flagged as
such.

## Scaling with session count

`ClaudeProvider.scan()` against synthetic roots of 1 MiB transcripts, warm
median of 5 runs:

| Sessions | Steady-state scan | First-sight scan |
| -------- | ----------------- | ---------------- |
| 1        | 1.1 ms            | 3.6 ms           |
| 5        | 4.9 ms            | 14.8 ms          |
| 10       | 10.0 ms           | 28.7 ms          |
| 20       | 20.4 ms           | 63.0 ms          |

Cleanly linear at **~1.0 ms per session per poll** steady-state, ~3.2 ms per
session on first sight. Twenty sessions would put the Claude scan at ~20 ms and
the whole poll near 27 ms — about 1.4% of the 2-second interval. The design
holds; there is no cliff.

Transcript reads at each tail bound, against a real 12.9 MiB transcript:

| Tail bound                       | Read    | Parse   | Total       |
| -------------------------------- | ------- | ------- | ----------- |
| 256 KiB (steady state)           | 0.5 ms  | 0.4 ms  | **0.8 ms**  |
| 4 MiB (first sight, #28)         | ~3.8 ms | ~5.4 ms | **~9.8 ms** |
| 16 MiB (shortfall recovery, #36) | ~12 ms  | ~21 ms  | **~34 ms**  |

All three are affordable at their stated frequencies: the 4 MiB read happens
once per session per app run, and the 16 MiB read is rate-limited per distinct
unexplained count. **The escalated reads are not a performance problem.**

## The 581 ms first poll — and what actually causes it

Every run's first poll costs 581–605 ms, more than 50× the steady state. The
obvious suspect was the 4 MiB first-sight transcript scan (#28). **It is not.**

The instrumented first poll attributes only ~17 ms to first-sight work
(`cl.read` 4.3 ms + `cl.parse` 12.3 ms for 8.4 MB across 4 sessions), while the
`claude` stage totals 584.7 ms. The missing ~570 ms is the pid-reuse guard:
`processStartTimeMs()` spawns an external process per session, measured
directly at **120–126 ms per pid**, and the four sessions are probed
sequentially.

```
processStartTimeMs(26152) #1: 126ms   processStartTimeMs(33416) #1: 120ms
processStartTimeMs(26152) #2: 120ms   processStartTimeMs(33416) #2: 120ms
processStartTimeMs(26152) #3: 123ms   processStartTimeMs(33416) #3: 120ms
```

4 × ~120 ms ≈ 480 ms, plus Codex's 40 ms cold scan and the first-sight reads,
accounts for the whole 581 ms. The verdicts are cached per `(pid, procStart)`,
so this is paid once per session per app run — but it is also paid _again_ every
time a new Claude session appears while the app runs, as one ~120 ms poll.

This is the only budget currently breached. It is left as a recommendation
rather than a fix because the change (probing sessions concurrently) touches the
pid-reuse guard, which exists to stop a dwarf's actions landing in an unrelated
application — not something to alter inside a performance pass without its own
review. See recommendation R2.

## The Codex liveness probe

The issue asked whether the PowerShell `Win32_Process` liveness probe is spawned
per poll and whether it is cached. **Measured: it is cached, correctly.**

One spawn costs **235–261 ms**. It is memoized to at most one call per tick, and
cached across ticks for 15 seconds, and it is only consulted when a session sits
in the "past the liveness window, still inside retention" band. Across every
measurement run in this audit — several hundred polls — no poll showed the
235 ms signature, confirming it never fired.

The residual risk is worth stating in numbers: a single session parked in that
band would cost one 250 ms spawn every 15 seconds, or **~1.7% of one core**,
which would more than double the app's idle cost on its own. The 15-second cache
is what stands between the app and that, so it should be treated as load-bearing.

## Tier walks: the cap holds

`sumSourceBytes` with the 3 000-file cap, against real trees:

| Target                                      | Time         | Directories listed | Files stat'd    | Counted   |
| ------------------------------------------- | ------------ | ------------------ | --------------- | --------- |
| A small sibling repo                        | 4 ms         | 45                 | 32              | 0.1 MiB   |
| This repo                                   | 8 ms         | 36                 | 215             | 1.3 MiB   |
| Whole `Desktop` tree (stress)               | **147 ms**   | 865                | **3 000** (cap) | 63.6 MiB  |
| Whole `Desktop` tree, cap raised to 100 000 | **3 011 ms** | 20 173             | 60 835          | 576.5 MiB |

The cap holds exactly — the walk stops at 3 000 `stat`s — and it is worth **20×**
on a large tree. Combined with the 600 s TTL and the fact that `tierOf()` never
blocks the poll (it serves a cached value and refreshes in the background), the
per-`stat` cost added by #37 is comfortably inside budget.

One caveat: the cap bounds _files stat'd_, not _directories listed_. A tree with
few source files but very many directories would still be walked in full. The
stress case above listed 865 directories to hit its 3 000-file cap; a
pathological layout could list far more. Not a problem today, but the cap does
not bound it.

## Fixes applied

Ranked by measured impact. Each cites the number it moved.

### Fix 1 — Batch the Codex rollout `stat`s (largest win)

`CodexProvider.scan()` awaited a `stat` per candidate one at a time: 84
sequential round trips per poll. `stat` has no side effects and no candidate's
decision depends on the previous one's result, so the batch is fetched with
`Promise.all` and the loop consumes it. Every decision, and the loop's order,
are unchanged.

|               | Before   | After                    |
| ------------- | -------- | ------------------------ |
| `cx.stat`     | 5.10 ms  | **0.41 ms** (12× faster) |
| `codex` stage | 11.78 ms | **7.02 ms** (−40%)       |
| Poll median   | 11.6 ms  | **10.5 ms**              |
| Poll p90      | 14.2 ms  | **12.5 ms**              |
| Poll max      | 19.0 ms  | **13.7 ms**              |

Note this trades wall time, not CPU: the same syscalls run, they simply stop
queueing behind each other. That is the right trade for a stage that was holding
the poll open.

### Fix 2 — Do not wake the renderer for a snapshot that did not change

`minesUpdated` was pushed on **every** poll — 30 pushes per minute, forever,
whether or not anything moved. Each one costs a structured clone in main, a
renderer wake-up, and a Vue re-render, measured at roughly two style
recalculations per push.

A new `PublishGate` compares each published snapshot with the last one actually
sent and holds identical ones back. Suppression is safe _because_ the test is
equality: when the gate says no, the renderer already holds that exact state.
`getMines()` still answers from the runtime's current mines, so a renderer that
starts or reloads mid-quiet-spell is unaffected, and anything that moves — a
dwarf's status, a token count, a mine arriving or leaving, the vault growing —
differs and publishes immediately, so latency is unchanged.

|                                | Before  | After                                          |
| ------------------------------ | ------- | ---------------------------------------------- |
| Polls that push                | 100%    | **3.4%** (86 of 89 suppressed, 90-poll window) |
| Polls that push, busier window | 100%    | 17.4% (57 of 69 suppressed)                    |
| `ipc` stage                    | 0.10 ms | **0.00 ms**                                    |

The renderer-side saving while the panel is hidden is below the noise floor
(~0.05% of a core either way), because a hidden renderer barely reacts to a push
at all. The win is real but modest today; it matters most while the panel is
**visible**, and it grows with session count. It also removes a standing source
of wake-ups that would otherwise scale with every future field added to the
snapshot.

### Fix 3 — Drop a redundant `exists()` before every `listDir()`

`ClaudeProvider.scan()` probed each configured root with `exists()` before
listing it, but `FsLike.listDir` is documented to resolve to `[]` for a missing
directory, so the probe only ever bought a second filesystem round trip per root
per poll.

Measured cost of what was removed: **0.05 ms per root per poll**, so ~0.1 ms per
poll with two roots. That is below the poll-to-poll noise floor and did not move
the median; it is kept because it removes two syscalls per poll on the strength
of an isolated measurement and the port's own contract, not because the clock
noticed. Recorded honestly rather than claimed as a win.

## Recommendations, not applied

Ranked by measured cost. R1–R3 were not applied because each trades correctness
risk in an area that deserves its own review, and this audit's rule was that a
fix must cite a number _and_ be safe to make blind. R4 was a different kind of
finding — an outright bug rather than a trade-off — and it has since been fixed;
see its own note below.

### R1 — The Codex heartbeat query costs 3.36 ms of every poll (32%)

The single most expensive thing the app does. `EXPLAIN QUERY PLAN` on the real
83.5 MiB log store:

```
SEARCH logs USING COVERING INDEX idx_logs_thread_id_ts (thread_id>?)
→ 2.91 ms, 0 rows returned
```

Despite the `WHERE ts >= ?` filter, SQLite satisfies the `GROUP BY thread_id`
by walking the covering index across **all 57 053 rows**, then applying the time
filter — it is not the bounded range scan the comment above
`readCodexHeartbeats` in `src/main/providers/codex/state.ts` claims it is. **That
comment is now known to be wrong** and should be corrected whatever else is done.

The cost therefore grows with the user's accumulated Codex log store, not with
the 300-second heartbeat window it is supposed to reflect. On a machine with a
larger `logs_2.sqlite`, this poll stage gets worse indefinitely.

Worth trying, in order: reshape the query so the `ts` range drives the plan
(measure the resulting plan, do not assume); or skip the read entirely when the
database files have not changed. Note that a naive mtime check is **unsafe with
SQLite in WAL mode**, where committed data lands in the `-wal` file without the
main database's mtime moving — any such cache must stat the WAL sidecar too.
Caching the _connection_ is not the answer: open and close were measured at
0.32 ms and 0.28 ms, so nearly all of the cost is the query itself.

### R2 — Probe process start times concurrently (581 ms → ~150 ms first poll)

The only breached budget. Four sequential ~120 ms process spawns make the first
poll of every run 581 ms. Probing sessions concurrently would bring it to
roughly one spawn's latency. The reason to do this deliberately rather than
casually: the probe backs the pid-reuse guard, whose whole job is to stop a
recycled pid rendering as a live dwarf whose Send or Kick lands in an unrelated
application.

### R3 — Move the synchronous SQLite work off the main thread

`node:sqlite`'s `DatabaseSync` blocks the main process for the full 5.24 ms of
`cx.registry` every 2 seconds, which is also what inflates the Claude stage's
apparent cost (see [the `cl.list` illusion](#the-cllist-illusion)). Even after
R1, the remaining queries block. A worker thread would take the whole registry
read off the critical path. This is the structural version of R1 and subsumes it.

### R4 — `sumSourceBytes` built paths with a hard-coded backslash (correctness, not performance) — FIXED

Found while auditing the tier walk. `src/main/tier/tierService.ts` joined paths
with a hard-coded backslash rather than with `node:path`'s `join`. On macOS and
Linux that produced a path that resolved to nothing: `listDir` returned `[]` and
`stat` returned `null`, so `sumSourceBytes` totalled 0 bytes and **every mine on
those platforms was permanently bronze**.

This was not a performance defect and was deliberately not fixed inside this
performance change; it shipped separately as
`fix(tier): stop weighing bundles, duplicates and Windows-only paths (#39)`.
`sumSourceBytes` now joins with `node:path`'s `join`
(`src/main/tier/tierService.ts:187`), with a doc comment at `:167-170` recording
exactly this failure mode.

## What was not measured

Stated plainly rather than estimated:

- **The DWM cost of the transparent, always-on-top, drop-shadowed window.** It
  lands in the desktop compositor, not in this app's processes.
- **A real 10–20 session machine.** The scaling table uses synthetic roots with
  1 MiB transcripts; only 4 live sessions existed. The 20-session budget row is a
  projection.
- **Idle CPU before vs after this audit's fixes on the same binary.** The
  before-baseline is the packaged 0.1.0 build; the after-figures come from the
  dev build, which carries the Vite HMR client and unminified sources and is not
  comparable process-for-process (its GPU process alone idles at 0.31% against
  the packaged build's 0.05%). Per-poll wall time was measured before and after
  on the same build lineage and is comparable; end-to-end idle CPU should be
  re-measured on a packaged build carrying these fixes.
- **Codex under load.** Every measurement was taken with zero live Codex
  sessions, so the Codex numbers here are its cost to find _nothing_. Its cost
  with active sessions — rollout parsing, subagent linking — is unmeasured.
- **Cold-cache disk behaviour.** Repeated runs read a warm OS page cache. First
  reads after a reboot will be slower.
- **Memory growth over days.** RSS was sampled at one moment (9.24 h into a run)
  and looked stable, but no leak test was performed.
