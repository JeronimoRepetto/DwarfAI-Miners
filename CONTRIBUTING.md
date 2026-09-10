# Contributing to DwarfAI-Miners

Thanks for considering it. This is a small, honest project — a floating desktop panel that
turns AI coding sessions into a mining colony — and the most valuable contributions right now
are real-world validation on macOS and Linux, regression-tested bug fixes, and artwork. This
guide covers how to set up, what the project expects from code, and where each kind of
contribution should go.

## Development setup

You need Node and [pnpm](https://pnpm.io/):

```bash
pnpm install
pnpm dev
```

The panel starts hidden — press **Ctrl+Alt+Shift+P** or click the tray icon to show it.
pnpm 11 build scripts are allowed through `allowBuilds` in `pnpm-workspace.yaml`; if the
Electron binary is missing after an interrupted install, run `pnpm rebuild electron`.

Configuration in a checkout is env-based: copy `.env.example` to `.env` if you want to override
defaults. Every key is optional and invalid values fail fast at startup
(`src/main/config/config.ts`). One thing to know before adding a setting: **an installed app never
sees `.env`**, because `dotenv` resolves it against the working directory. It reads a
`config-v1.json` under Electron's `userData` instead, layered underneath the real environment. So a
new setting that is only reachable from `.env` is unreachable from the product — see
[`skills/config-layering/SKILL.md`](skills/config-layering/SKILL.md) and the README's
[Configuration](README.md#configuration) section. Preferences somebody sets _in the app_ (a volume,
the panel's side) are the other kind, and belong in their own `userData` document rather than in the
config layers at all.

## Packaging dependencies

`@anthropic-ai/claude-agent-sdk` ships its native runtime as one optional package per target
platform and architecture. `package.json` declares the four this app actually builds for —
`claude-agent-sdk-darwin-arm64`, `-darwin-x64`, `-linux-x64` and `-win32-x64` — in
`optionalDependencies`, pinned to the exact version already in `dependencies`. **Bump both
together**: a mismatch is exactly the drift `scripts/sdkRuntimeVersions.test.mjs` exists to catch.
Without this, pnpm installs only the runtime matching the machine that ran `pnpm install`, so an
installer built on the "wrong" architecture for its own target — the x64 macOS build made on an
Apple Silicon Mac, notably — would ship without the runtime a held Claude session needs.

electron-builder does not prune the other three runtimes out of an artifact on its own (that is a
v27 feature; this project pins 26.x — see [`docs/signing.md`](docs/signing.md) for why). The
`build.afterPack` hook `scripts/pruneSdkRuntimes.mjs` removes every `claude-agent-sdk-*` folder
except the one matching the artifact actually being packaged, before code signing runs.

`package.json` also declares a `homepage`, which electron-builder's `.deb` (fpm) target refuses to
build without.

## Verification

Before opening a pull request, run the same checks CI runs, in the same order
(`.github/workflows/ci.yml` runs all seven on every push to `main` and every PR):

1. **The privacy guard**, which runs **first** — every check below it can pass on a change
   that still goes red. It is a `git grep` over tracked files for machine-specific
   identifiers. The patterns are the `PRIVACY_GUARD_PATTERN` repository secret, never a
   tracked file: quoting them anywhere in the tree is itself what the guard exists to catch.
   The maintainer keeps the same value in a shell variable and runs
   `! git grep -n -I -E "$PRIVACY_GUARD_PATTERN" -- .` before pushing; a contributor without
   it relies on the placeholders table in
   [`skills/privacy-guard/SKILL.md`](skills/privacy-guard/SKILL.md) and on CI, which runs the
   guard on every push to `main` and every same-repository pull request. That skill also
   says what the guard does not cover — screenshots above all.
2. Then, in CI's order:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
node skills/skill-sync/assets/sync.mjs --check   # AGENTS.md tables vs skill frontmatter
pnpm test
pnpm build
```

The whole test suite is platform-independent and must stay that way: it runs and passes on
any host OS, because per-OS behavior is tested through pure builders (see below), never by
executing platform commands.

## Testing philosophy

- **Tests come with the change.** New behavior arrives with the test that pins it — write the
  test first when you can. A pull request that changes behavior without touching tests will
  be asked to.
- **Every real-world bug becomes a regression test.** If you fix something that broke on a
  real machine, the fix includes a test that fails without it.
- **Deterministic fakes, no network, no credentials.** Unit tests use in-memory fakes —
  `FakeFs` (`src/main/adapters/fakeFs.ts`), `FakeHookFs` (`src/main/hooks/fakeHookFs.ts`),
  an in-memory SQLite (`src/main/adapters/memorySqlite.ts`) — never the real home directory,
  a live CLI, or the network.
- **Per-platform code is pure builders plus a thin runner.** Everything OS-specific produces
  a testable value (a command's argv, a plist's exact bytes) and is selected in one place,
  `src/main/platform/platformAdapters.ts`. Tests pass the platform explicitly, which is how
  macOS and Linux assertions run on a Windows host and vice versa.

## Commit conventions

- [Conventional commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
  `test:`, `ci:`, `refactor:`, `chore:`, with an optional scope — e.g.
  `fix(focus): resolve console windows pid-exact via AttachConsole`.
- Imperative mood in the subject ("add", not "added" or "adds"), lowercase after the colon.
- No AI attribution trailers — no `Co-Authored-By:` bots, no "Generated with" footers.
  Recent `git log` is the style reference.

## Issues and pull requests

- **Search first**, then open an issue. A useful bug report names your platform, the app
  version, and reproduction steps; the support matrix in the README tells you whether your
  platform row is verified or only expected, which is often the explanation.
- **Keep PRs small and focused** — one concern per PR, linked to its issue. CI must pass,
  behavior changes need tests, and user-facing changes update the docs in the same PR.
- **Security reports never go in public issues.** Use the private reporting flow in
  [`SECURITY.md`](SECURITY.md).

## Platform validation — help wanted

Windows is the platform that has been run end to end. macOS and Linux have been run on real
hardware, but with far less mileage, and the README's
[support matrix](README.md#platform-support) still marks most of their rows as expected rather
than verified. Walking those rows is the single most useful contribution a Mac or Linux user can
make:

1. `pnpm install && pnpm dev` (or a packaged build) on your machine, with real Claude Code
   or Codex sessions running.
2. Walk the matrix rows: session detection, click-to-focus, the transcript viewer, message
   delivery (the relay on your platform; the console-paste path is Windows-only today), autostart,
   tray behavior, packaging.
3. File an issue per broken row — with your OS version, desktop environment (for Linux:
   X11 or Wayland matters), and what actually happened.

"It all worked" is also a report worth filing — it is what moves a row from
"expected" to "verified".

## Artwork

The in-app art is AI-generated, then processed. The shipped, processed art is committed under
`src/renderer/src/assets/art/` so a clone builds without the originals; `pnpm art:build`
regenerates it from source images kept outside the repository (default
`<home>/Downloads/DwarfAI-Miners`, overridable with `--src <dir>` or
`DWARFAI_MINERS_ART_SRC`). The pipeline chroma-keys each image off its flat backdrop —
sampling the key color from the image's own four corners — and crops all dwarf poses to one
shared canvas so animation frames never jitter (`scripts/build-art.mjs`).

That means contributed art must sit on a **flat, uniform backdrop** (any color that appears
in all four corners), and dwarf animations come as pose pairs (two working swings, two
resting poses, two walking poses). Open an issue with a sample before producing a full set,
so style fit gets settled cheaply.

**Audio is not processed by that pipeline.** The six music tracks, the two mine ambience beds and
the three dwarf voices are committed exactly as delivered — the music as `.ogg` under
`src/renderer/src/assets/audio/music/` because Electron's bundled Chromium decodes it natively, and
the beds and voices as `.mp3` filed beside the art they belong to. Every one is imported explicitly
in `src/renderer/src/lib/audio/audioAssets.ts` rather than globbed, so a renamed or missing file
fails the build instead of quietly shortening the playlist or silencing a rank. Add a file there
when you add a sound.

**Inbound terms.** Artwork is not an open contribution surface by default. Please discuss an art
contribution with the maintainer before opening a pull request. Any accepted artwork must have
separate written terms confirming that it is yours to give, free of third-party claims, and
specifying the permission granted to this project. It is not automatically covered by the MIT
license for the code, and submitting a pull request does not by itself grant permission to reuse
the project's existing artwork.

## Scope and non-goals

So that nobody invests work the project will decline:

- **A useful visual monitor first, a game second.** The panel's job is telling you the truth
  about your sessions at a glance; game mechanics that make it less trustworthy or heavier as
  a monitor are out.
- **No game-engine migration.** The renderer stays a Vue-driven sprite panel. Porting it to a
  game engine is explicitly not on the roadmap.
- **The cosmetics/token-burn economy is deferred.** It was researched
  ([`docs/ecosystem-research.md`](docs/ecosystem-research.md)) and is intentionally not
  scheduled.
- **New providers need verifiable session artifacts.** Gemini CLI stays "planned" until its
  session files can be verified on a real machine — the same bar Claude Code and Codex met
  (see [`docs/provider-formats.md`](docs/provider-formats.md)). The Add Panel's **Other** chip
  is not a way round that bar and does not lower it: it starts a command of your own as a
  process the panel HOLDS, so the panel is its stdio rather than a reader of its store, and its
  dwarf can say nothing a transcript would have said. A CLI that wants a chip, a tier, ore, or
  a session it can be reconnected to still needs its own provider and still needs the evidence
  (see [`docs/custom-launch-command.md`](docs/custom-launch-command.md)).

## Routing

- Bugs, features, roadmap discussion → [GitHub issues](https://github.com/JeronimoRepetto/DwarfAI-Miners/issues)
- Vulnerabilities → [`SECURITY.md`](SECURITY.md), privately
- Data-boundary questions → [`docs/privacy.md`](docs/privacy.md)
- "Why is it built this way?" → [`docs/README.md`](docs/README.md) indexes every research note,
  evaluation and format survey in the repository, and says which of them are dated rather than
  maintained
- Rules an agent working here keeps getting wrong → [`AGENTS.md`](AGENTS.md) and the skills under
  [`skills/`](skills/README.md)
- Supporting the project financially → [Ko-fi](https://ko-fi.com/jeronimorepetto)
