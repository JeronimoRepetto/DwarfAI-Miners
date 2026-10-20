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

| Document                                         | What it answers                                                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`privacy.md`](privacy.md)                       | The data boundary: every file the app reads, everything it stores and where, what it transmits (nothing), and what reaches your screen unredacted. Each claim names the source behind it.               |
| [`signing.md`](signing.md)                       | What is code-signed and what is not, per platform; the macOS Developer ID and notarization config that is wired in, where its credentials live, and the checklist the first release after it must pass. |
| [`simulated-provider.md`](simulated-provider.md) | The development-only simulated valley (`DWARFAI_SIMULATE=1`): seeing the panel under load without launching a single real agent, and the two locks that keep it out of a packaged build.                |
| [`map-coordinates.md`](map-coordinates.md)       | How the map's 74 spawn points and the mine interiors' work points were extracted from the design exports, and the coordinate spaces involved. The data itself is in the three JSON files listed below.  |

## Provider formats

The bar a new provider has to clear is evidence about its on-disk format. These are that evidence,
per provider, with `[V]` for what was verified on a real machine and `[I]` for what was inferred.

| Document                                     | What it covers                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [`provider-formats.md`](provider-formats.md) | The primary survey: Claude Code, Codex, Antigravity, and why the local `.gemini` data is deliberately not parsed as Gemini CLI.           |
| [`codex-v2-format.md`](codex-v2-format.md)   | The deeper Codex investigation — two different Codex products, the `state_5.sqlite` registry, `logs_2.sqlite`, and rollout storage.       |
| [`opencode-format.md`](opencode-format.md)   | OpenCode's on-disk store: the `opencode.db` WAL SQLite schema, the tables the provider reads, and the version floor a build is pinned to. |

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
