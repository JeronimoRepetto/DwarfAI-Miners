# Documentation index

Two kinds of document live in this folder, and it is worth knowing which you are reading before you
trust it.

**Reference** describes the app as it is. It is kept current, and a claim in it that the code
contradicts is a bug in the document.

**Research and evaluation notes** are dated investigations. Each one records what was measured, on
which machine, on which day, and what was decided as a result — including the things that were
decided _against_. They are not maintained as the app moves, so several carry a `Status:` banner
saying what has since shipped. Read them for the reasoning, and check the code for the behaviour.

## Reference

| Document                                               | What it answers                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`guide.md`](guide.md)                                 | Every screen and control of the app in depth — the README's long form: the panel's areas, the message panel and delivery marks, sound, settings, tray behaviour, the Claude hooks channel, provider limits, and the full configuration reference.                |
| [`architecture.md`](architecture.md)                   | How the pieces fit: providers → poller → runtime → IPC → the two renderer windows, the platform ports, security posture, the art and icon pipelines, and per-platform packaging.                                                                                 |
| [`privacy.md`](privacy.md)                             | The data boundary: every file the app reads, everything it stores and where, what it transmits (nothing), and what reaches your screen unredacted. Each claim names the source behind it.                                                                        |
| [`signing.md`](signing.md)                             | What is code-signed and what is not, per platform; the macOS Developer ID and notarization config that is wired in, where its credentials live, and the checklist the first release after it must pass.                                                          |
| [`console-hosting.md`](console-hosting.md)             | Whether the panel can be the console. The four paths that were considered, what shipped from the one that won, and — in §4b — the delivery-channel matrix: which tier a message and an interrupt each take, and why the paste-versus-relay order reversed twice. |
| [`custom-launch-command.md`](custom-launch-command.md) | What the Add panel's **Other** chip actually starts, the long list of things a held process cannot tell you about itself, and the refusal that was reversed to get there.                                                                                        |
| [`simulated-provider.md`](simulated-provider.md)       | The development-only simulated valley (`DWARFAI_SIMULATE=1`): seeing the panel under load without launching a single real agent, and the two locks that keep it out of a packaged build.                                                                         |
| [`map-coordinates.md`](map-coordinates.md)             | How the map's 74 spawn points and the mine interiors' work points were extracted from the design exports, and the coordinate spaces involved. The data itself is in the three JSON files listed below.                                                           |

## Provider formats

The bar a new provider has to clear is evidence about its on-disk format. These are that evidence,
per provider, with `[V]` for what was verified on a real machine and `[I]` for what was inferred.

| Document                                                         | What it covers                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`provider-formats.md`](provider-formats.md)                     | The primary survey: Claude Code, Codex, Antigravity, and why the local `.gemini` data is deliberately not parsed as Gemini CLI.                  |
| [`codex-v2-format.md`](codex-v2-format.md)                       | The deeper Codex investigation — two different Codex products, the `state_5.sqlite` registry, `logs_2.sqlite`, and rollout storage.              |
| [`session-topology-and-roles.md`](session-topology-and-roles.md) | What `foreman` and `worker` mean, why the two shipped backends derive them differently, and the normalized model a third backend should inherit. |

## Evaluations and decisions

| Document                                                           | The question it was opened to answer                                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| [`hook-detection-evaluation.md`](hook-detection-evaluation.md)     | Whether a push channel could replace the poll. Became the opt-in "Instant updates (Claude hooks)" feature.           |
| [`question-capture-evaluation.md`](question-capture-evaluation.md) | Whether an agent's question can be captured and answered from the panel, and for which session types.                |
| [`command-surface-evaluation.md`](command-surface-evaluation.md)   | How much of a CLI's own command surface a held session exposes — which is what the session strip can offer.          |
| [`animation-loops.md`](animation-loops.md)                         | Whether two-frame dwarf animations are the reason the motion reads thin, and whether a larger set is worth its cost. |
| [`ecosystem-research.md`](ecosystem-research.md)                   | The prior-art survey that shaped the whole design: what already existed, what was reusable, what was not.            |

## Audits and measurements

| Document                               | What it records                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [`performance.md`](performance.md)     | What the app actually costs as a permanent tray resident, the budgets set from those measurements, and which fixes the numbers justified.   |
| [`privacy-audit.md`](privacy-audit.md) | The pre-publication sweep of every tracked file, image and commit for machine-specific identifiers — and the placeholder table it produced. |

## Data and assets in this folder

These are not documents; they are inputs the build reads or the README displays.

| Path                                                       | What it is                                                                                                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `map-spawn-points.json`                                    | The 74 measured world-map spawn locations. `node scripts/build-map-sites.mjs` turns it into `src/renderer/src/lib/map/spawnPoints.generated.ts`; edit the JSON, never the generated file. |
| `mine-interior-features.json`, `mine-interior-facing.json` | The mine interiors' extracted work points and which way each faces, read by `node scripts/build-interior-map.mjs`.                                                                        |
| `assets/`, `media/`                                        | The logo, the feature-tour captures and the hero animations the top-level README embeds.                                                                                                  |

## Not in this repository

The interface design source (`docs/dwarfai-miners-design/`) is maintainer-only and git-ignored, so
the screen specifications several code comments cite are not part of a clone. Where a decision came
from that source, the code comment beside it states what the source said — which is the part that
matters for changing the code.
