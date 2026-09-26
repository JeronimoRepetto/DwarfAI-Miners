# Audio credits

Where every sound the app bundles comes from, and under what licence. The files themselves are
imported one by one in `src/renderer/src/lib/audio/audioAssets.ts`; a sound on disk that is not
listed here should not be there.

## The maintainer's own

The eight background tracks under `src/renderer/src/assets/audio/music/` and the three dwarf voices
under `src/renderer/src/assets/art/` are the maintainer's own, covered by
[`ARTWORK-LICENSE.md`](ARTWORK-LICENSE.md) and not licensed for reuse.

## Sound effects released as CC0

The six effects below replaced eight files that carried a third-party copyright tag (#637). Each is
either original work made for DwarfAI-Miners, synthesised from oscillators and seeded noise with no
recorded audio sampled, or built from recordings their authors released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). All six are released under CC0 1.0
as well, and are therefore outside [`ARTWORK-LICENSE.md`](ARTWORK-LICENSE.md). CC0 asks for no
attribution; the authors are recorded here so every source can be traced.

Each file was re-levelled for the app and encoded as MP3 with all metadata stripped; see
[the level table](src/renderer/src/assets/audio/sfx/README.md#levels).

| File                                                    | Plays                                          | Made of                                                                                                                                                                                                                                                                                                                                                                                                             | Licence                                   |
| ------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `assets/audio/sfx/ui-click.mp3`                         | A press on a navigation button                 | `sfx100v2_metal_hit_02.ogg` by rubberduck, from OpenGameArt, <https://opengameart.org/content/100-cc0-sfx-2>; silence trimmed, levelled.                                                                                                                                                                                                                                                                            | CC0 1.0 (rubberduck)                      |
| `assets/audio/sfx/panel-open-close.mp3`                 | The side panel opening and closing             | `5 Menu Screen Slide SFX 02.wav` by CleytonKauffman, from OpenGameArt, <https://opengameart.org/content/sfx-5-menu-screen-slides>, layered with `bookOpen.ogg` 4 dB under it, by Kenney, from the RPG Audio pack, <https://kenney.nl/assets/rpg-audio>.                                                                                                                                                             | CC0 1.0 (CleytonKauffman; Kenney)         |
| `assets/audio/sfx/pickaxe-strike.mp3`                   | A worker's pick landing                        | Original synthesis: pick-head metal modes, a stone click and crack, a body thump and debris ticks.                                                                                                                                                                                                                                                                                                                  | Original work for DwarfAI-Miners, CC0 1.0 |
| `assets/audio/sfx/worker2-grind.mp3`                    | A worker2's shift, the whole 8.53 s movement   | Original synthesis: spin-up, stone contact and spin-down; an FM sawtooth whine over a motor hum, band-passed noise for the stone.                                                                                                                                                                                                                                                                                   | Original work for DwarfAI-Miners, CC0 1.0 |
| `assets/audio/sfx/walk-loop.mp3`                        | Footsteps, looped for as long as a dwarf walks | Original synthesis: twelve footsteps in a seamless 6.7 s loop.                                                                                                                                                                                                                                                                                                                                                      | Original work for DwarfAI-Miners, CC0 1.0 |
| `assets/art/inside-mines/sfx/mine-inside-room-tone.mp3` | The mine's room tone, a 90 s loop              | `dungeon_ambient_1.ogg` by JaggedStone, <https://opengameart.org/content/loopable-dungeon-ambience>; `atmosbasement.flac` by Independent.nu (submitted by qubodup), <https://opengameart.org/content/dripping-water-loop>; and `dungeon002.ogg` by yd, <https://opengameart.org/content/dungeon-ambience> — all on OpenGameArt, mixed, filtered and compressed, with an original synthesised sub rumble and reverb. | CC0 1.0 (JaggedStone, Independent.nu, yd) |

Paths are relative to `src/renderer/src/`. Each OpenGameArt item's licence was verified on the
item's own page when the sound was chosen, since that site hosts CC0, CC-BY, CC-BY-SA and GPL work
side by side; the Kenney pack states CC0 in its own `License.txt`.
