/**
 * The sounds, resolved to bundled URLs (#174, #173).
 *
 * Beside `lib/art.ts` rather than inside it, and the split is on purpose: that
 * file's whole contract is "every file here is produced by `pnpm art:build`",
 * and none of these are — they are the maintainer's own recordings, committed
 * as delivered. The shell's two music ICONS are art and do live over there.
 *
 * Imports are explicit rather than an `import.meta.glob`, for the reason art.ts
 * gives: a missing or renamed file has to fail the build instead of shortening
 * the playlist or silencing a rank at runtime, where nobody would notice.
 */
import type { DwarfRole } from '../../types'
import type { CrewCue } from '../sprite/crewSound'
import type { AmbienceBed } from './ambience'
import type { UiSfx } from './volume'

import trackAmbientSynthFuture from '../../assets/audio/music/ambient-synth-future.ogg'
import trackCinematicOrchestralAdventure from '../../assets/audio/music/cinematic-orchestral-adventure.ogg'
import trackAtmosphericMonastic from '../../assets/audio/music/atmospheric-monastic.ogg'
import trackAtmosphericSciFi from '../../assets/audio/music/atmospheric-sci-fi.ogg'
import trackHopefulAcousticCinematic from '../../assets/audio/music/hopeful-acoustic-cinematic.ogg'
import trackWhimsicalChamberOrchestra from '../../assets/audio/music/whimsical-chamber-orchestra.ogg'
import trackWhimsicalMedievalFolk from '../../assets/audio/music/whimsical-medieval-folk.ogg'
import trackWhimsicalTheatricalCircus from '../../assets/audio/music/whimsical-theatrical-circus.ogg'

import sfxClick from '../../assets/audio/sfx/button_sound.mp3'
import sfxPanel from '../../assets/audio/sfx/open_sound.mp3'

import sfxPickaxe from '../../assets/audio/sfx/pickaxe-sfx.mp3'
import sfxHands from '../../assets/audio/sfx/hands-sfx.mp3'
import sfxSteps from '../../assets/audio/sfx/steps-sfx.mp3'
import sfxSteps2 from '../../assets/audio/sfx/steps2-sfx.mp3'

import bedSilence from '../../assets/art/inside-mines/sfx/mine-inside-silence.mp3'

import foremanVoice from '../../assets/art/dwarf-foreman/voce/dwarf-foreman-voice.mp3'
import workerVoice from '../../assets/art/dwarf-worker/voice/dwarf-worker-voice.mp3'
import worker2Voice from '../../assets/art/dwarf-worker/voice/dwarf-worker2-voice.mp3'

/**
 * The eight background tracks, in the order they are declared and in no other
 * sense ordered: the playlist shuffles them (see playlist.ts), so this list's
 * sequence is never what anybody hears.
 *
 * `.ogg` because Electron's bundled Chromium decodes it natively — nothing
 * here is transcoded at build time. Roughly 22.5 MB across the eight: 17.6 MB
 * of it the six the maintainer accepted on #174, and 4.9 MB the two added
 * after the first live listen (#323).
 */
export const MUSIC_TRACK_SRC: readonly string[] = [
  trackAmbientSynthFuture,
  trackAtmosphericMonastic,
  trackAtmosphericSciFi,
  trackCinematicOrchestralAdventure,
  trackHopefulAcousticCinematic,
  trackWhimsicalMedievalFolk,
  trackWhimsicalChamberOrchestra,
  trackWhimsicalTheatricalCircus
]

/**
 * The mine's room tone (#173). It lives under the ART tree, in
 * `inside-mines/sfx/`, because that is where the maintainer filed it beside
 * the five interior paintings it belongs to — the path is the artist's
 * filing, exactly as `worker2`'s sheets sitting in the worker's directory is.
 *
 * There were two. `mine-inside-working.mp3` was one recording of "a mine being
 * worked", the same whether one worker or nine were at the rock, and #330
 * retires it in favour of the crew's own clips below. IT IS STILL ON DISK AND
 * DELIBERATELY NOT IMPORTED HERE — the maintainer's to delete or keep, and a
 * renamed or removed file must not break a build that no longer plays it.
 */
export const AMBIENCE_SRC = {
  silence: bedSilence
} satisfies Record<AmbienceBed, string>

/**
 * One voice per rank (#173), which is the same inventory shape the sprite
 * sheets use (see lib/sprite/dwarfSheets.ts) with one difference worth naming:
 * there is NO FALLBACK here. A rank with no sheet for a state falls back to
 * its idle drawing, because a dwarf has to be drawn as something; a rank with
 * no voice would simply be silent, and borrowing another rank's bark would
 * make the crew sound like one dwarf. All three are recorded, so the record is
 * total and `satisfies` holds it that way.
 */
export const DWARF_VOICE_SRC = {
  foreman: foremanVoice,
  worker: workerVoice,
  worker2: worker2Voice
} satisfies Record<DwarfRole, string>

/**
 * The two interface sounds (#323), under `assets/audio/sfx/` beside the music
 * rather than under the art tree the mine beds live in: these answer a press on
 * the shell's own chrome, and nothing about them belongs to a mine.
 *
 * `.mp3`, as delivered — the same container the beds and the voices already
 * use, decoded natively by Electron's Chromium, so nothing is transcoded here
 * either. They are kilobytes rather than megabytes: a press has to sound the
 * moment it is pressed, and a long recording could not.
 */
export const UI_SFX_SRC = {
  click: sfxClick,
  panel: sfxPanel
} satisfies Record<UiSfx, string>

/**
 * The two footstep recordings (#330), which every rank shares.
 *
 * A PAIR because a crew walking in on one recording is nine copies of the same
 * gait; each dwarf wears one of the two for its whole life, picked from its own
 * id (see `crewVariantIndex`). Far longer than any walk in the panel — 17.96 s
 * and 13.06 s against a crossing measured in seconds — so they play from their
 * start and are never looped: a walk that outlasted one would simply go quiet,
 * which is the right failure.
 */
const CREW_WALK_SRC: readonly string[] = [sfxSteps, sfxSteps2]

/**
 * What each rank sounds like, cue by cue (#330), under `assets/audio/sfx/`
 * beside the interface sounds rather than under the art tree the room tone
 * lives in: these are the maintainer's own recordings of a crew, not an
 * interior's furniture.
 *
 * WHEN each of these plays is not here — it is declared on the rank's sheets
 * (`DWARF_CREW` in lib/sprite/dwarfSheets.ts), because a cue is a claim about
 * FRAMES. This is only what it plays with, and `audioAssets.test.ts` holds the
 * two tables against each other: a cue declared with no recording fires into
 * silence nobody notices, and a recording for a cue no rank declares never
 * plays at all.
 *
 * A LIST PER CUE, even where there is one recording, so that every cue is
 * picked the same way — `crewVariantIndex` answers 0 for a single-element list
 * without anything special being written for it.
 *
 * `.mp3`, as delivered, decoded natively by Electron's Chromium exactly as the
 * beds and the voices already are.
 */
export const CREW_SFX_SRC = {
  worker: { strike: [sfxPickaxe], walk: CREW_WALK_SRC },
  worker2: { shift: [sfxHands], walk: CREW_WALK_SRC },
  // No strike and no shift: a foreman's `working` is a session producing
  // tokens rather than a pick on a rock (#173's own example), and he has no
  // working art for a frame cue to be read off. He walks, so he has boots.
  foreman: { walk: CREW_WALK_SRC }
} satisfies Record<DwarfRole, Partial<Record<CrewCue, readonly string[]>>>
