# Interface sound effects

Every file in this directory is the **maintainer's own** recording, produced for DwarfAI-Miners
(#323). They are committed so a clone builds and plays without any extra download, exactly as the
background music under `../music/` and the processed art under `../../art/` are.

**They are not covered by the repository's MIT license and they are not licensed for reuse.** The
inbound-artwork terms in [`CONTRIBUTING.md`](../../../../../../CONTRIBUTING.md#artwork) apply to audio
as well: submitting a pull request does not grant permission to reuse what is already here, and any
audio contributed to the project needs separate written terms.

## What plays them

`lib/audio/audioAssets.ts` imports each file explicitly into `UI_SFX_SRC`, one entry per interface
action — a click on the shell's own navigation buttons, a sound when the side panel opens and
closes. Nothing globs this directory: a renamed or missing file has to fail the build rather than
leave an action silent at runtime, where nobody would notice.

`.mp3` is the container the mine-ambience beds and the dwarf voices already use, decoded natively
by Electron's bundled Chromium — nothing here is transcoded at build time. Each file is kilobytes
rather than megabytes: a press has to sound the moment it is pressed, and a long recording could
not.

On this branch the directory holds `button_sound.mp3` and `open_sound.mp3`; more may land here
later the same way (see below) without this file needing an update to its count.

## Adding a sound

1. Drop the `.mp3` in here with a short, stable name derived from what it plays — no session ids,
   no generator suffixes, nothing that names a machine (see the `privacy-guard` skill).
2. Add one `import` and one entry to `UI_SFX_SRC` in `lib/audio/audioAssets.ts`.
3. Say in the commit body what the sound is and which action plays it.
