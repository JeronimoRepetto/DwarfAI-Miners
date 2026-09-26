# Sound effects

The interface sounds and the crew's sounds. They are committed so a clone builds and plays without
any extra download, exactly as the background music under `../music/` and the processed art under
`../../art/` are.

**Every file here is released under CC0 1.0**, either as original work made for DwarfAI-Miners or
as a derivative of CC0 recordings. Who made each one and from what is in
[`AUDIO-CREDITS.md`](../../../../../../AUDIO-CREDITS.md), together with the mine's room tone that
lives under `../../art/inside-mines/sfx/`. A new file here needs a row there, with its source and
licence, before it is committed.

## What plays them

`lib/audio/audioAssets.ts` imports each file explicitly — the interface sounds into `UI_SFX_SRC`
(a click on the shell's own navigation buttons, a sound when the side panel opens and closes) and
the crew's into `CREW_SFX_SRC` (the pick, the worker2's grind, the footsteps). Nothing globs this
directory: a renamed or missing file has to fail the build rather than leave an action silent at
runtime, where nobody would notice. `lib/audio/bundledAudio.test.ts` holds the other direction: a
file on disk that nothing imports fails the suite, and so does any file carrying a copyright frame.

`.mp3` is the container the voices already use, decoded natively by Electron's bundled Chromium —
nothing here is transcoded at build time.

## Levels

The six CC0 replacements of #637 arrive mastered at their design levels, which are far quieter than
the files they replaced. The app's own gains (`STRIKE_GAIN`, `WALK_GAIN` in
`lib/sprite/dwarfSheets.ts`, the channel volumes in `lib/audio/volume.ts`) were set by ear against
the old files, so each replacement was re-levelled to the old file's loudness instead, and no gain
in code moved: each role measures as loud as it did. Nobody has listened to the result in the app
yet, so this is a measured match, not an ear's ruling.

Loudness is ffmpeg's `ebur128` integrated loudness, measured with 0.5 s of silence appended so that
clips shorter than one 400 ms gating block are measurable at all; for the long files the padding
changes nothing. The walk had two old files, so its target is their mean.

| File                        | Replaced                          | Old (LUFS)      | Master (LUFS) | Gain applied | Result (LUFS) | True peak (dBTP) |
| --------------------------- | --------------------------------- | --------------- | ------------- | ------------ | ------------- | ---------------- |
| `ui-click.mp3`              | `button_sound.mp3`                | -26.3           | -35.6         | +9.3 dB      | -26.3         | -2.1             |
| `panel-open-close.mp3`      | `open_sound.mp3`                  | -28.6           | -30.1         | +1.5 dB      | -28.6         | -10.3            |
| `pickaxe-strike.mp3`        | `pickaxe-sfx.mp3`                 | -20.2           | -26.5         | +6.3 dB      | -20.2         | -2.3             |
| `worker2-grind.mp3`         | `hands-sfx.mp3`                   | -27.3           | -35.0         | +7.7 dB      | -27.3         | -17.3            |
| `walk-loop.mp3`             | `steps-sfx.mp3`, `steps2-sfx.mp3` | -41.2 and -33.5 | -49.4         | +12.0 dB     | -37.4         | -20.4            |
| `mine-inside-room-tone.mp3` | `mine-inside-silence.mp3`         | -26.8           | -42.0         | +15.2 dB     | -26.8         | -9.5             |

`mine-inside-working.mp3`, unplayed since #330, was deleted with no replacement.

Each was encoded from the WAV master with ffmpeg's `libmp3lame` at 320 kb/s CBR, 48 kHz stereo, with
`-map_metadata -1`, no ID3v2 tag and no ID3v1 tag, so the only header is the encoder's own gapless
information:

```sh
ffmpeg -i <master>.wav -af "volume=<gain>dB" -map_metadata -1 -map_chapters -1 \
  -fflags +bitexact -flags:a +bitexact -id3v2_version 0 -write_id3v1 0 \
  -c:a libmp3lame -b:a 320k <name>.mp3
```

## Adding a sound

1. Drop the `.mp3` in here with a short, stable name derived from what it plays — no session ids,
   no generator suffixes, nothing that names a machine (see the `privacy-guard` skill) — and with
   its metadata stripped as above.
2. Add one `import` and one entry to `UI_SFX_SRC` or `CREW_SFX_SRC` in `lib/audio/audioAssets.ts`.
3. Add its row to `AUDIO-CREDITS.md`, and say in the commit body what the sound is and which action
   plays it.
