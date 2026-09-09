# Background music

The eight tracks in this directory are the **maintainer's own**, produced for DwarfAI-Miners
(#174, with two more added on #323).
They are committed so a clone builds and plays without any extra download, exactly as the processed
art under `../../art/` is.

**They are not covered by the repository's MIT license and they are not licensed for reuse.** The
inbound-artwork terms in [`CONTRIBUTING.md`](../../../../../CONTRIBUTING.md#artwork) apply to audio
as well: submitting a pull request does not grant permission to reuse what is already here, and any
audio contributed to the project needs separate written terms.

## What plays them

`lib/audio/audioAssets.ts` imports each file explicitly and `lib/audio/engine.ts` schedules them —
a random order with no repeat until all eight have played, then a fresh order, forever. Nothing globs
this directory: a renamed or missing file has to fail the build rather than shorten the playlist
silently.

## Adding a track

1. Drop the `.ogg` in here with a short, stable name derived from its style — no session ids, no
   generator suffixes, nothing that names a machine (see the `privacy-guard` skill).
2. Add one `import` and one entry to `MUSIC_TRACK_SRC` in `lib/audio/audioAssets.ts`.
3. Update the count `audioAssets.test.ts` asserts, and say in the commit body what the track is.

`.ogg` is what Electron's bundled Chromium decodes natively, so nothing here is transcoded at build
time. Each file costs its own size in the installer; the eight together are about 22.5 MB — the six the
maintainer accepted on #174 plus 4.9 MB of the two that followed (#323).
