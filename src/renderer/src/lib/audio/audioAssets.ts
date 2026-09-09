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
import type { AmbienceBed } from './ambience'

import trackAmbientSynthFuture from '../../assets/audio/music/ambient-synth-future.ogg'
import trackAtmosphericMonastic from '../../assets/audio/music/atmospheric-monastic.ogg'
import trackAtmosphericSciFi from '../../assets/audio/music/atmospheric-sci-fi.ogg'
import trackWhimsicalChamberOrchestra from '../../assets/audio/music/whimsical-chamber-orchestra.ogg'
import trackWhimsicalMedievalFolk from '../../assets/audio/music/whimsical-medieval-folk.ogg'
import trackWhimsicalTheatricalCircus from '../../assets/audio/music/whimsical-theatrical-circus.ogg'

import bedSilence from '../../assets/art/inside-mines/sfx/mine-inside-silence.mp3'
import bedWorking from '../../assets/art/inside-mines/sfx/mine-inside-working.mp3'

import foremanVoice from '../../assets/art/dwarf-foreman/voce/dwarf-foreman-voice.mp3'
import workerVoice from '../../assets/art/dwarf-worker/voice/dwarf-worker-voice.mp3'
import worker2Voice from '../../assets/art/dwarf-worker/voice/dwarf-worker2-voice.mp3'

/**
 * The six background tracks, in the order they are declared and in no other
 * sense ordered: the playlist shuffles them (see playlist.ts), so this list's
 * sequence is never what anybody hears.
 *
 * `.ogg` because Electron's bundled Chromium decodes it natively — nothing
 * here is transcoded at build time. Roughly 17.6 MB across the six, which the
 * maintainer accepted on #174.
 */
export const MUSIC_TRACK_SRC: readonly string[] = [
  trackAmbientSynthFuture,
  trackAtmosphericMonastic,
  trackAtmosphericSciFi,
  trackWhimsicalMedievalFolk,
  trackWhimsicalChamberOrchestra,
  trackWhimsicalTheatricalCircus
]

/**
 * The two mine beds (#173). They live under the ART tree, in
 * `inside-mines/sfx/`, because that is where the maintainer filed them beside
 * the five interior paintings they belong to — the path is the artist's
 * filing, exactly as `worker2`'s sheets sitting in the worker's directory is.
 */
export const AMBIENCE_SRC = {
  working: bedWorking,
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
