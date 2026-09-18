import { describe, expect, it } from 'vitest'
import type {
  DwarfAttachment,
  DwarfAttendance,
  DwarfProvider,
  DwarfQuestion,
  DwarfRole
} from './contracts'
import {
  DEFAULT_AUDIO_PREFERENCES,
  DWARF_PROVIDERS,
  DWARF_SILENCE_WINDOW_MS,
  HELDABLE_PROVIDERS,
  MCP_CONNECTION_STATUSES,
  PANEL_OBSERVER,
  TIER_WEIGHT_THRESHOLDS_KB,
  dwarfSilenceWindowKey,
  dwarfSilenceWindowMs,
  isDwarfProvider,
  isMcpConnectionStatus,
  isMessagePanelDragPhase,
  parseAudioPreferences,
  /* --- Typography preferences (#370) — one block, appended ----------------- */
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  INTERFACE_FONTS,
  MESSAGING_FONTS,
  isInterfaceFont,
  isMessagingFont,
  parseTypographyPreferences,
  /* --- end of the #370 block ----------------------------------------------- */
  /* --- Message attachments (#408) — one block, appended -------------------- */
  ATTACHMENT_CHANNELS,
  ATTACHMENT_HELD_PROVIDERS,
  DWARF_IMAGE_EXTENSIONS,
  MAX_DWARF_ATTACHMENTS,
  MAX_DWARF_ATTACHMENT_BYTES,
  MAX_DWARF_ATTACHMENTS_TOTAL_BYTES,
  attachmentKindFor,
  channelCarriesAttachments,
  isDwarfAttachment,
  parseDwarfAttachments,
  refuseAttachment,
  /* --- end of the #408 block ----------------------------------------------- */
  /* --- Message length (#431) — one block, appended ------------------------- */
  MAX_DWARF_TEXT_CHARS,
  WINDOWS_COMMAND_LINE_LIMIT,
  maxTextCharsFor,
  messageTooLongReason,
  parseDwarfText,
  /* --- end of the #431 block ----------------------------------------------- */
  /* --- The relay's prompt on stdin (#437) — one block, appended ------------- */
  MAX_CODEX_QUEUE_TEXT_CHARS,
  /* --- end of the #437 block ----------------------------------------------- */
  /* --- The picker's Other row (#481) — one block, appended ------------------ */
  MAX_PICKER_NUMBERED_ROWS,
  askHasAReachableOtherRow
  /* --- end of the #481 block ----------------------------------------------- */
} from './contracts'

/*
 * Issue #78. Adding a provider used to mean editing the union here and then
 * finding every hand-written copy of it elsewhere. These pin the table as the
 * one declaration point: the union is derived from it, and the two mirrors
 * that used to exist (the projects store's read-back list, the CLI detector's
 * own type) now read this instead of restating it.
 */
describe('DWARF_PROVIDERS', () => {
  it('names every provider identity the wire admits, and nothing else', () => {
    // AMENDED for #444 (was: ['claude', 'codex', 'antigravity']). OpenCode
    // reads opencode.db only — no launch, no hold, no delivery channel — so
    // it joins this table alone; LAUNCHABLE_PROVIDERS and HELDABLE_PROVIDERS
    // stay exactly as they were (see launchProviders.test.ts:84).
    expect(DWARF_PROVIDERS).toEqual(['claude', 'codex', 'antigravity', 'opencode'])
  })

  /*
   * AMENDED for #237, step 5 (was: `expect(HELDABLE_PROVIDERS).not.toContain(
   * 'antigravity')`, under the heading "does not promise a held stream for a
   * provider this app only observes").
   *
   * The condition that comment set is met, and it was met by measurement
   * rather than by argument. A live two-turn round trip was HELD on this
   * machine on 2026-09-07 against Antigravity CLI 1.1.26: one process, one
   * NDJSON user event per turn on its stdin, the same `conversation_id` across
   * both, a `result` for each, and the stdout captured as
   * `main/providers/__fixtures__/antigravity/held-stream.jsonl`. That is the
   * whole of what the list promises, and the day the comment was waiting for.
   *
   * What the name still does NOT promise is everything step 7 owns: no
   * question answering, no permission answering, no turn cancellation, no
   * message addressed to a child. Those are absent from the handle rather
   * than refused at runtime — see HeldSessionHandle — so the panel's own
   * capability seams say "unsupported" with a reason instead of offering a
   * control with nothing behind it.
   */
  it('promises a held stream for every provider a live round trip has been held on', () => {
    expect(HELDABLE_PROVIDERS).toEqual(['claude', 'antigravity'])
  })

  /*
   * The other half of that, and the one that is still a capability rather than
   * a plan: Codex has no held-session engine in this app at all. #168 put the
   * refusal behind a provider name for exactly this case.
   */
  it('does not promise a held stream for a provider with no engine behind it', () => {
    expect(HELDABLE_PROVIDERS).not.toContain('codex')
  })

  it('is the type the union is derived from, so the two cannot drift apart', () => {
    // Assignable in both directions: a member added to the table becomes a
    // member of the union with no second edit, and a union member missing from
    // the table would fail to compile here rather than at a call site.
    const fromTable: DwarfProvider[] = [...DWARF_PROVIDERS]
    const fromUnion: readonly DwarfProvider[] = DWARF_PROVIDERS
    expect(fromTable).toEqual([...fromUnion])
  })
})

describe('isDwarfProvider', () => {
  it('recognises every identity in the table', () => {
    for (const provider of DWARF_PROVIDERS) {
      expect(isDwarfProvider(provider)).toBe(true)
    }
  })

  it.each(['gemini', 'Claude', 'CODEX', '', ' claude ', 42, null, undefined, {}])(
    'refuses %j, which this build has no provider for',
    (value) => {
      // Every caller is reading something it did not produce — a row off the
      // user's disk, a value off the IPC boundary — so an unrecognised one has
      // to read as "no provider" rather than being passed on as a guess.
      expect(isDwarfProvider(value)).toBe(false)
    }
  )
})

/*
 * Issue #96. The held-session loop reads `mcp_servers[].status` straight off
 * the CLI's own `init` message, which types it as a plain `string` — but the
 * live-fire spike (issue #96's comments) observed only the five values the
 * SDK's control-request surface (`mcpServerStatus()`) types as a closed enum,
 * across seven real entries including three flavours of `needs-auth`. Same
 * boundary-validation discipline `isDwarfProvider`/`isMineTier` already hold:
 * a status this build does not recognise reads as "not this enum" rather than
 * being passed on as a guess.
 */
describe('MCP_CONNECTION_STATUSES', () => {
  it('names the SDK-typed closed enum, and nothing else', () => {
    expect(MCP_CONNECTION_STATUSES).toEqual([
      'connected',
      'failed',
      'needs-auth',
      'pending',
      'disabled'
    ])
  })
})

describe('isMcpConnectionStatus', () => {
  it('recognises every status in the table', () => {
    for (const status of MCP_CONNECTION_STATUSES) {
      expect(isMcpConnectionStatus(status)).toBe(true)
    }
  })

  it.each(['Connected', 'CONNECTED', 'unknown', '', ' connected', 42, null, undefined, {}])(
    'refuses %j, which this build has no MCP status enum member for',
    (value) => {
      expect(isMcpConnectionStatus(value)).toBe(false)
    }
  )
})

/*
 * Issue #68. The long window exists because a human may be typing the next
 * prompt, and until now it was handed out on RANK — so a headless `claude -p`
 * run, which is a root and therefore a foreman, was granted the hour with
 * nobody at the keyboard. These tests pin the predicate the window actually
 * means, and the direction the unproven case falls in.
 */
describe('dwarfSilenceWindowMs', () => {
  it('keeps the two measured windows, an hour against half of one', () => {
    // Unchanged by #68: the numbers were never the defect, only what picked
    // between them. The provider's staleness rule reads the same two.
    expect(DWARF_SILENCE_WINDOW_MS.attended).toBe(60 * 60_000)
    expect(DWARF_SILENCE_WINDOW_MS.unattended).toBe(30 * 60_000)
  })

  it('gives the hour to a session a human is sitting at', () => {
    expect(dwarfSilenceWindowMs('foreman', 'attended')).toBe(DWARF_SILENCE_WINDOW_MS.attended)
  })

  it('takes the hour back from a root session nobody can type into', () => {
    // The whole of #68: `claude -p` and a Codex automation thread are roots,
    // so they were foremen, so they got an hour of patience for a keyboard
    // that does not exist.
    expect(dwarfSilenceWindowMs('foreman', 'unattended')).toBe(DWARF_SILENCE_WINDOW_MS.unattended)
  })

  it('leaves the hour standing when the provider proved nothing either way', () => {
    // The conservative direction, and the same one this codebase has taken
    // twice: absence of a pendingBackgroundAgentCount is not a count of zero,
    // and tierOf's placeholder may not seal a ledger delta. The two errors are
    // not symmetric — shortening the window on a session a human IS typing
    // into makes the panel call a live session silent, which is the false
    // departure #28 and #40 exist to prevent.
    expect(dwarfSilenceWindowMs('foreman', 'unknown')).toBe(DWARF_SILENCE_WINDOW_MS.attended)
  })

  it('treats a provider that reports no attendance at all as unproven, not as headless', () => {
    // Absent is the same reading as 'unknown' and deliberately not a third
    // one: a provider that was never taught to answer has not answered.
    expect(dwarfSilenceWindowMs('foreman')).toBe(DWARF_SILENCE_WINDOW_MS.attended)
    expect(dwarfSilenceWindowMs('foreman', undefined)).toBe(DWARF_SILENCE_WINDOW_MS.attended)
  })

  it('judges every worker on the half hour, whatever a provider claims about it', () => {
    // The one place topology still decides, because there it PROVES the thing:
    // a spawned subagent has no channel of its own, so no human can be typing
    // into it whatever the field says. Rank may shorten the window, never
    // lengthen it.
    expect(dwarfSilenceWindowMs('worker')).toBe(DWARF_SILENCE_WINDOW_MS.unattended)
    expect(dwarfSilenceWindowMs('worker', 'unknown')).toBe(DWARF_SILENCE_WINDOW_MS.unattended)
    expect(dwarfSilenceWindowMs('worker', 'attended')).toBe(DWARF_SILENCE_WINDOW_MS.unattended)
  })

  it('judges a worker2 on the same half hour a worker gets (#157)', () => {
    // The maintainer's own wire note for the new rank: a worker2 is as headless
    // as a worker. It is spawned by one, so the proof above applies to it
    // WORD FOR WORD — nothing outside its parent session can address it either,
    // and being one level deeper cannot put a keyboard in front of it.
    expect(dwarfSilenceWindowMs('worker2')).toBe(DWARF_SILENCE_WINDOW_MS.unattended)
    expect(dwarfSilenceWindowMs('worker2', 'unknown')).toBe(DWARF_SILENCE_WINDOW_MS.unattended)
    expect(dwarfSilenceWindowMs('worker2', 'attended')).toBe(DWARF_SILENCE_WINDOW_MS.unattended)
  })

  it('gives the hour to no rank but the foreman', () => {
    // The shape of the rule rather than a list of its members: a fourth rank
    // added later must state its own case here, and until it does it inherits
    // the shorter window rather than the generous one. Only a root can have a
    // human in front of it, and only a foreman is a root.
    for (const role of ['worker', 'worker2'] satisfies DwarfRole[]) {
      expect(dwarfSilenceWindowMs(role, 'attended')).toBe(DWARF_SILENCE_WINDOW_MS.unattended)
    }
  })
})

describe('dwarfSilenceWindowKey', () => {
  // Amended by #157: 'worker2' joined the union, and a list written by hand is
  // exactly the kind that silently stops covering it.
  const ROLES: DwarfRole[] = ['foreman', 'worker', 'worker2']
  const ATTENDANCE: (DwarfAttendance | undefined)[] = [
    'attended',
    'unattended',
    'unknown',
    undefined
  ]

  it('names the window dwarfSilenceWindowMs would hand back, for every input', () => {
    // The two must never part company: the key exists only so a caller with
    // its OWN pair of numbers — the Claude provider's staleness rule, whose
    // windows tests shrink to something crossable — can make the same choice
    // without restating the rule and drifting from it.
    for (const role of ROLES) {
      for (const attendance of ATTENDANCE) {
        expect(DWARF_SILENCE_WINDOW_MS[dwarfSilenceWindowKey(role, attendance)]).toBe(
          dwarfSilenceWindowMs(role, attendance)
        )
      }
    }
  })

  it('answers with one of the two window names and nothing else', () => {
    expect(dwarfSilenceWindowKey('foreman', 'unattended')).toBe('unattended')
    expect(dwarfSilenceWindowKey('foreman', 'unknown')).toBe('attended')
    expect(dwarfSilenceWindowKey('worker', 'attended')).toBe('unattended')
    expect(dwarfSilenceWindowKey('worker2', 'attended')).toBe('unattended')
  })
})

/*
 * Issue #140. The renderer has no import path onto main/config/config.ts —
 * main and renderer are separate JS realms, and only this shared module and
 * the IPC wire cross between them — so the canonical KB boundaries the design
 * source fixes (foundations.md) have to live somewhere both sides can read
 * them without the renderer hand-typing four numbers that could drift from
 * main's. This pins the one copy both processes are meant to share.
 */
describe('TIER_WEIGHT_THRESHOLDS_KB', () => {
  it('names the documented KB boundaries, in ascending order', () => {
    expect(TIER_WEIGHT_THRESHOLDS_KB).toEqual({
      copperKb: 100,
      silverKb: 500,
      goldKb: 2048,
      uraniumKb: 8192
    })
    expect(TIER_WEIGHT_THRESHOLDS_KB.copperKb).toBeLessThan(TIER_WEIGHT_THRESHOLDS_KB.silverKb)
    expect(TIER_WEIGHT_THRESHOLDS_KB.silverKb).toBeLessThan(TIER_WEIGHT_THRESHOLDS_KB.goldKb)
    expect(TIER_WEIGHT_THRESHOLDS_KB.goldKb).toBeLessThan(TIER_WEIGHT_THRESHOLDS_KB.uraniumKb)
  })
})

/*
 * The two ends of a header drag (#296), as the preload has to recognise them:
 * main moves the window, so a phase it cannot read is one that would either
 * start a drag nobody asked for or leave one running with nothing to end it.
 * Same ruling isMessagePanelSurface carries — the bridge refuses to guess, and
 * an unrecognised value crosses as '' for main to refuse outright.
 */
describe('isMessagePanelDragPhase', () => {
  it('recognises the two phases a drag actually has', () => {
    for (const phase of ['start', 'end']) {
      expect(isMessagePanelDragPhase(phase)).toBe(true)
    }
  })

  it.each(['Start', 'START', 'move', 'dragging', '', ' end', 42, null, undefined, {}])(
    'refuses %j, which is not one of them',
    (value) => {
      // 'move' above is the one worth naming: main follows the cursor on its
      // own clock, so a renderer reporting each step is a phase this contract
      // never had (see MessagePanelDragPhase).
      expect(isMessagePanelDragPhase(value)).toBe(false)
    }
  )
})

/*
 * Settings' Audio section (#174, #173), and why its parser lives on the wire
 * boundary rather than in the renderer that mixes with it.
 *
 * Both processes read this document: main stores it and clamps on the way in,
 * the preload rebuilds it field by field on the way across, and the renderer's
 * engine mixes with it. One parser, one declaration point — the same rule the
 * providers table above holds.
 *
 * The asymmetry `config-layering` names is the whole shape of it: a bad
 * DOCUMENT degrades to the defaults, because a preference file is never worth
 * failing over, and a bad VALUE inside an otherwise readable document degrades
 * FIELD BY FIELD rather than taking the readable fields with it.
 */
describe('parseAudioPreferences', () => {
  it('reads a document it wrote itself', () => {
    expect(
      parseAudioPreferences({
        musicAtStartup: false,
        musicVolume: 0.4,
        ambienceVolume: 0.2,
        voiceVolume: 0.9
      })
    ).toEqual({
      musicAtStartup: false,
      musicVolume: 0.4,
      ambienceVolume: 0.2,
      voiceVolume: 0.9
    })
  })

  it('clamps a volume outside the range rather than discarding the whole document', () => {
    // A slider cannot mean "more than all of it", so the ends are the honest
    // reading of a value past them — not a reason to forget the other three.
    expect(parseAudioPreferences({ musicVolume: 4, ambienceVolume: -1 })).toEqual({
      ...DEFAULT_AUDIO_PREFERENCES,
      musicVolume: 1,
      ambienceVolume: 0
    })
  })

  it('falls back field by field, so one bad value cannot take the others with it', () => {
    expect(parseAudioPreferences({ musicAtStartup: 'yes', musicVolume: 0.25 })).toEqual({
      ...DEFAULT_AUDIO_PREFERENCES,
      musicVolume: 0.25
    })
  })

  it('keeps the two ends, which are real choices and not errors', () => {
    expect(parseAudioPreferences({ musicVolume: 0, voiceVolume: 1 })).toEqual({
      ...DEFAULT_AUDIO_PREFERENCES,
      musicVolume: 0,
      voiceVolume: 1
    })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, '0.8', null, {}, []])(
    'reads %j as no volume at all, because it is not a finite fraction',
    (value) => {
      expect(parseAudioPreferences({ musicVolume: value }).musicVolume).toBe(
        DEFAULT_AUDIO_PREFERENCES.musicVolume
      )
    }
  )

  it.each([null, undefined, [], 'music', 42])(
    'reads %j — a document that is not an object — as the defaults',
    (document) => {
      expect(parseAudioPreferences(document)).toEqual(DEFAULT_AUDIO_PREFERENCES)
    }
  )
})

describe('DEFAULT_AUDIO_PREFERENCES', () => {
  it('starts the music on, and quiet, which is what the first listen asked for', () => {
    // AMENDED for #323 (was: every channel at full, #174's own first guess).
    // The maintainer heard it: the music dominated and the dwarfs barked over
    // everything, so a first run gets music at 10% and the effects at 70%. The
    // ambience is a reading of the crew and stays where it was.
    expect(DEFAULT_AUDIO_PREFERENCES).toEqual({
      musicAtStartup: true,
      musicVolume: 0.1,
      ambienceVolume: 1,
      voiceVolume: 0.7
    })
  })
})

/*
 * Typography preferences (#370) — APPENDED, nothing above changed.
 *
 * Two independent choices behind one document, and the asymmetry
 * `config-layering` names applies to it exactly as it does to the audio
 * document above: a bad DOCUMENT reads as the defaults, and a bad VALUE inside
 * a readable one degrades FIELD BY FIELD.
 *
 * The one rule that is not shared with any other preference: Tiny5 is a legal
 * interface face and an illegal messaging one. The design's reasoning (#347,
 * carried forward by #370) is that Tiny5 has a single display weight, and a
 * message paragraph needs real bold — so the exclusion is enforced at the
 * BOUNDARY rather than only hidden in the Settings UI, because a document
 * hand-edited under userData reaches the renderer through this parser too.
 */
describe('INTERFACE_FONTS and MESSAGING_FONTS', () => {
  it('offers the four interface faces the design names, in its own order', () => {
    expect(INTERFACE_FONTS).toEqual(['tiny5', 'pixelify-sans', 'roboto', 'arial'])
  })

  it('offers the same faces for messaging minus Tiny5, which cannot carry a paragraph', () => {
    expect(MESSAGING_FONTS).toEqual(['pixelify-sans', 'roboto', 'arial'])
    expect(MESSAGING_FONTS).not.toContain('tiny5')
  })

  it('names no messaging face the interface cannot also use', () => {
    // One vocabulary with one exclusion, never two lists that could drift: a
    // face offered for messages and not for the interface would be a third
    // rule nobody wrote down.
    for (const font of MESSAGING_FONTS) expect(INTERFACE_FONTS).toContain(font)
  })
})

describe('isInterfaceFont and isMessagingFont', () => {
  it.each([...INTERFACE_FONTS])('reads %s as an interface face', (font) => {
    expect(isInterfaceFont(font)).toBe(true)
  })

  it('refuses Tiny5 as a messaging face, and everything else it does not know', () => {
    expect(isMessagingFont('tiny5')).toBe(false)
    expect(isInterfaceFont('tiny5')).toBe(true)
  })

  it.each([undefined, null, '', 'Tiny5', 'comic sans', 42, {}, []])(
    'reads %j as neither, because a face this build cannot draw is not a choice',
    (value) => {
      expect(isInterfaceFont(value)).toBe(false)
      expect(isMessagingFont(value)).toBe(false)
    }
  )
})

describe('parseTypographyPreferences', () => {
  it('reads a document it wrote itself', () => {
    expect(parseTypographyPreferences({ interfaceFont: 'roboto', messagingFont: 'arial' })).toEqual(
      { interfaceFont: 'roboto', messagingFont: 'arial' }
    )
  })

  it('keeps the two choices independent, which is the whole point of the feature', () => {
    expect(parseTypographyPreferences({ interfaceFont: 'tiny5', messagingFont: 'roboto' })).toEqual(
      { interfaceFont: 'tiny5', messagingFont: 'roboto' }
    )
  })

  it('refuses Tiny5 for messaging at the boundary, not only in the Settings UI', () => {
    // A document hand-edited under userData reaches the renderer through this
    // parser, so hiding the option in Settings would not be the enforcement.
    expect(parseTypographyPreferences({ interfaceFont: 'arial', messagingFont: 'tiny5' })).toEqual({
      interfaceFont: 'arial',
      messagingFont: DEFAULT_TYPOGRAPHY_PREFERENCES.messagingFont
    })
  })

  it('falls back field by field, so one unreadable face cannot take the other with it', () => {
    expect(
      parseTypographyPreferences({ interfaceFont: 'roboto', messagingFont: 'papyrus' })
    ).toEqual({
      interfaceFont: 'roboto',
      messagingFont: DEFAULT_TYPOGRAPHY_PREFERENCES.messagingFont
    })
  })

  it.each([null, undefined, [], 'roboto', 42])(
    'reads %j — a document that is not an object — as the defaults',
    (document) => {
      expect(parseTypographyPreferences(document)).toEqual(DEFAULT_TYPOGRAPHY_PREFERENCES)
    }
  )
})

describe('DEFAULT_TYPOGRAPHY_PREFERENCES', () => {
  it('preserves the look #347 settled, so nobody has to choose to keep it', () => {
    expect(DEFAULT_TYPOGRAPHY_PREFERENCES).toEqual({
      interfaceFont: 'tiny5',
      messagingFont: 'pixelify-sans'
    })
  })
})

/*
 * Message attachments (#408). The design's rule is that the limits are defined
 * ONCE at the wire boundary and surfaced in the UI, so these pin the numbers
 * and the rule that reads them — the composer and main/index.ts's boundary
 * parser both call the same function, and a second copy of the arithmetic is
 * exactly what this block exists to prevent.
 */
let mintedAttachments = 0
const attachment = (over: Partial<DwarfAttachment> = {}): DwarfAttachment => {
  const n = ++mintedAttachments
  return {
    path: `C:\\p\\shot-${n}.png`,
    name: `shot-${n}.png`,
    kind: 'image',
    bytes: 1024,
    ...over
  }
}

describe('attachmentKindFor', () => {
  it.each(DWARF_IMAGE_EXTENSIONS)('reads %s as an image, because only an image attaches', (ext) => {
    expect(attachmentKindFor(`shot${ext}`)).toBe('image')
  })

  it.each(['.PNG', '.JpG', '.WEBP'])('reads %s too — a name is not case', (ext) => {
    expect(attachmentKindFor(`shot${ext}`)).toBe('image')
  })

  it.each(['notes.txt', 'report.pdf', 'archive.tar.gz', 'Makefile', 'trap.png.txt'])(
    'reads %s as a plain file',
    (name) => {
      // Measured 2026-09-16 (#408): a non-image path inside a bracketed paste
      // arrives as TEXT, so calling one of these an image would promise bytes
      // the session never receives.
      expect(attachmentKindFor(name)).toBe('file')
    }
  )
})

describe('refuseAttachment', () => {
  it('accepts the first ordinary file', () => {
    expect(refuseAttachment(attachment(), [])).toBeNull()
  })

  it('refuses the one past the count limit, and not the one at it', () => {
    const accepted = Array.from({ length: MAX_DWARF_ATTACHMENTS - 1 }, () => attachment())
    expect(refuseAttachment(attachment(), accepted)).toBeNull()
    expect(refuseAttachment(attachment(), [...accepted, attachment()])).toBe('too-many')
  })

  it('refuses a file over the per-file limit, and not one exactly at it', () => {
    expect(refuseAttachment(attachment({ bytes: MAX_DWARF_ATTACHMENT_BYTES }), [])).toBeNull()
    expect(refuseAttachment(attachment({ bytes: MAX_DWARF_ATTACHMENT_BYTES + 1 }), [])).toBe(
      'file-too-large'
    )
  })

  it('refuses the file that would take the pending message over the total', () => {
    const accepted = [attachment({ bytes: MAX_DWARF_ATTACHMENTS_TOTAL_BYTES - 10 })]
    expect(refuseAttachment(attachment({ bytes: 10 }), accepted)).toBeNull()
    expect(refuseAttachment(attachment({ bytes: 11 }), accepted)).toBe('total-too-large')
  })

  it('names the count before the size, so the sentence matches the reason it stopped', () => {
    const accepted = Array.from({ length: MAX_DWARF_ATTACHMENTS }, () => attachment())
    expect(refuseAttachment(attachment({ bytes: MAX_DWARF_ATTACHMENT_BYTES + 1 }), accepted)).toBe(
      'too-many'
    )
  })

  it('refuses the same path twice: a chip the person already has is not a second file', () => {
    const already = attachment()
    expect(refuseAttachment({ ...already }, [already])).toBe('already-attached')
  })

  /*
   * Issue #417. Only an IMAGE's bytes ever reach the API — a `file` attachment
   * travels as a path main hands to the agent's own file-reading tool, so its
   * size costs this message nothing. The two byte limits above must therefore
   * bind on `kind: 'image'` alone; a `file` is bounded by the count limit only.
   */
  it('never refuses a plain file for its size, however large — only its path travels', () => {
    const huge = attachment({
      kind: 'file',
      name: 'huge.bin',
      bytes: MAX_DWARF_ATTACHMENT_BYTES * 10
    })
    expect(refuseAttachment(huge, [])).toBeNull()
  })

  it("does not let a file's bytes count against the images' shared total", () => {
    const hugeFile = attachment({
      kind: 'file',
      name: 'huge.bin',
      bytes: MAX_DWARF_ATTACHMENTS_TOTAL_BYTES
    })
    const image = attachment({ bytes: MAX_DWARF_ATTACHMENT_BYTES })
    expect(refuseAttachment(image, [hugeFile])).toBeNull()
  })

  /*
   * The per-image ceiling is three quarters of the Anthropic API's own
   * documented per-image maximum for a base64-encoded image content block —
   * base64 costs a third more than the raw bytes it encodes, so the file this
   * app reads off disk must stay inside 3/4 of that encoded ceiling for the
   * block built from it to fit. See MAX_DWARF_ATTACHMENT_BYTES's own comment
   * for the docs citation.
   */
  it('sets the per-image byte limit to three quarters of the documented 10 MB API maximum', () => {
    expect(MAX_DWARF_ATTACHMENT_BYTES).toBe((10 * 1024 * 1024 * 3) / 4)
  })

  it('sets the images-together total to four times the per-image limit, one fewer than the count', () => {
    expect(MAX_DWARF_ATTACHMENTS_TOTAL_BYTES).toBe(MAX_DWARF_ATTACHMENT_BYTES * 4)
  })
})

describe('isDwarfAttachment', () => {
  it('admits the shape the wire declares', () => {
    expect(isDwarfAttachment(attachment())).toBe(true)
  })

  it.each([
    ['a missing path', { name: 'a.png', kind: 'image', bytes: 1 }],
    ['an empty path', attachment({ path: '' })],
    ['a missing name', { path: 'C:\\p\\a.png', kind: 'image', bytes: 1 }],
    ['an unknown kind', { ...attachment(), kind: 'folder' }],
    ['a negative size', attachment({ bytes: -1 })],
    ['a fractional size', attachment({ bytes: 1.5 })],
    ['a size that is not a number', { ...attachment(), bytes: '10' }],
    ['null', null],
    ['an array', []],
    ['a bare string', 'C:\\p\\a.png']
  ])('refuses %s', (_why, value) => {
    expect(isDwarfAttachment(value)).toBe(false)
  })
})

/*
 * The IPC boundary's own half (#408). main/index.ts's parseTextRequest calls
 * this, so the rule that a malformed or over-limit payload is REFUSED WHOLE —
 * never trimmed to what fits — is pinned here rather than inside a handler no
 * test can reach.
 */
describe('parseDwarfAttachments', () => {
  it('reads an absent field as no attachments, so every pre-#408 caller still parses', () => {
    expect(parseDwarfAttachments(undefined)).toEqual([])
  })

  it('keeps an accepted list in the order the composer held it', () => {
    const list = [attachment(), attachment({ kind: 'file', name: 'notes.txt' })]
    expect(parseDwarfAttachments(list)).toEqual(list)
  })

  it.each([
    ['a bare object', { path: 'C:\\p\\a.png' }],
    ['a string', 'C:\\p\\a.png'],
    ['null', null]
  ])('refuses %s, which is not a list at all', (_why, value) => {
    expect(parseDwarfAttachments(value)).toBeNull()
  })

  it('refuses the whole list when ONE member is malformed, never the rest of it', () => {
    // Delivering three of four files while reporting success is the exact
    // dishonesty #408 exists to prevent.
    expect(
      parseDwarfAttachments([attachment(), { path: 'C:\\p\\b.png', name: 'b.png' }])
    ).toBeNull()
  })

  it('refuses a list past the count limit rather than trimming it to fit', () => {
    const list = Array.from({ length: MAX_DWARF_ATTACHMENTS + 1 }, () => attachment())
    expect(parseDwarfAttachments(list)).toBeNull()
  })

  it('refuses a member over the per-file limit', () => {
    expect(
      parseDwarfAttachments([attachment({ bytes: MAX_DWARF_ATTACHMENT_BYTES + 1 })])
    ).toBeNull()
  })

  it('refuses a list whose members are each fine and together are not', () => {
    // Both ceilings genuinely bind, which is why there are two: the count
    // allows this many files and the per-file limit allows each of these sizes,
    // and the total still says no.
    const each = MAX_DWARF_ATTACHMENT_BYTES
    const needed = Math.floor(MAX_DWARF_ATTACHMENTS_TOTAL_BYTES / each) + 1
    expect(needed).toBeLessThanOrEqual(MAX_DWARF_ATTACHMENTS)
    const list = Array.from({ length: needed }, () => attachment({ bytes: each }))
    expect(parseDwarfAttachments(list.slice(0, needed - 1))).not.toBeNull()
    expect(parseDwarfAttachments(list)).toBeNull()
  })

  it('refuses the same path listed twice, on the same rule the composer uses', () => {
    const twice = attachment()
    expect(parseDwarfAttachments([twice, { ...twice }])).toBeNull()
  })

  it('accepts a plain file whose bytes would break both image limits, because only its path travels (#417)', () => {
    const list = [
      attachment({ kind: 'file', name: 'huge.bin', bytes: MAX_DWARF_ATTACHMENTS_TOTAL_BYTES * 2 })
    ]
    expect(parseDwarfAttachments(list)).toEqual(list)
  })
})

describe('channelCarriesAttachments', () => {
  it('names only the two channels measured to carry a file', () => {
    // Measured 2026-09-16 (#408): a bracketed paste by pid attaches an image to
    // an observed Claude session, and the Agent SDK takes image content blocks.
    expect(ATTACHMENT_CHANNELS).toEqual(['terminal', 'held-session'])
  })

  it("says a console can, whoever's session it is: the CLI reads the paste, not us", () => {
    expect(channelCarriesAttachments('terminal', 'claude')).toBe(true)
    expect(channelCarriesAttachments('terminal')).toBe(true)
  })

  it.each([
    'claude-relay',
    'foreman-relay',
    'codex-queue',
    'hosted-stdin',
    'launched-process'
  ] as const)('says %s cannot, rather than accepting a file it would drop', (channel) => {
    expect(channelCarriesAttachments(channel, 'claude')).toBe(false)
  })

  it('says no channel at all cannot', () => {
    expect(channelCarriesAttachments(null, 'claude')).toBe(false)
  })

  /*
   * A held session is the one channel where the PROTOCOL, not the channel,
   * decides. `held-session` covers every provider this app can hold, and only
   * the Agent SDK's stream has a measured image block; Antigravity's NDJSON
   * does not, so offering the control there would promise bytes its session
   * will never see.
   */
  it('says a held Claude session can, because the SDK takes image blocks', () => {
    expect(channelCarriesAttachments('held-session', 'claude')).toBe(true)
  })

  it('says a held Antigravity session cannot, because nothing has measured one', () => {
    expect(channelCarriesAttachments('held-session', 'antigravity')).toBe(false)
  })

  it('says a held session of NO stated provider cannot, rather than guessing', () => {
    // Absence is not a yes, the same direction every other unproven capability
    // in this file falls in.
    expect(channelCarriesAttachments('held-session')).toBe(false)
  })

  it('says a dwarf this panel holds over stdio cannot, being in no list at all', () => {
    expect(channelCarriesAttachments('held-session', PANEL_OBSERVER)).toBe(false)
  })

  it('names the providers whose held stream was measured, and nothing else', () => {
    expect(ATTACHMENT_HELD_PROVIDERS).toEqual(['claude'])
  })
})

/* --- Message length (#431) — one block, appended --------------------------- */

/*
 * Issue #431. `MAX_DWARF_TEXT_CHARS` used to be 4,000 because a message was
 * TYPED into a console key by key and a long one took the keyboard away for a
 * minute (#10). Nothing types any more (#371, #425), so these pin the bound
 * that is actually underneath: the command line every spawn-carried channel
 * has to fit inside.
 */
describe('the message ceilings', () => {
  it("cites Windows' own documented command-line bound rather than a round number", () => {
    expect(WINDOWS_COMMAND_LINE_LIMIT).toBe(32_767)
  })

  /*
   * AMENDED for #437 (was: 'derives the wire ceiling from that bound, halved
   * for worst-case quoting', asserting MAX_DWARF_TEXT_CHARS === 15,359 from
   * `(32_767 − 2_048 of relay argv and instruction) / 2`).
   *
   * The relay was the channel that made a command line the wire's bound, and it
   * does not carry the courier instruction in argv any more: the instruction is
   * written to the `claude -p` child's stdin, where length costs time and
   * nothing else. Measured live on 2026-09-16 (docs/console-hosting.md §6) — a
   * 40,000-character message reached the target session as ONE SendMessage,
   * whole and with the provenance line. So the wire ceiling stopped being an
   * argv derivation at all, and the test in its place says what it is instead.
   */
  it('makes the wire ceiling a sanity bound about memory, not a command line', () => {
    expect(MAX_DWARF_TEXT_CHARS).toBe(250_000)
    // Not derived from the command line any more: it is comfortably past it.
    expect(MAX_DWARF_TEXT_CHARS).toBeGreaterThan(WINDOWS_COMMAND_LINE_LIMIT)
  })

  it('keeps the argv derivation for the one channel that still has an argv', () => {
    // `codex queue --thread <uuid> --message <TEXT>` takes the message as argv
    // and nothing else: `codex queue --help` on 0.153.4, checked 2026-09-16,
    // names no stdin form. (32_767 − 2_048 of fixed argv) / 2 for worst-case
    // quoting — the same halving #431 measured, on the queue's own overhead.
    expect(MAX_CODEX_QUEUE_TEXT_CHARS).toBe(15_359)
    expect(MAX_CODEX_QUEUE_TEXT_CHARS).toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT)
  })

  /*
   * AMENDED for #433 (was: 'leaves the console tier a lower ceiling, because its
   * script carries the text base64', asserting MAX_CONSOLE_TEXT_CHARS === 6,541
   * and that it was under the wire ceiling; and 'still raises every channel well
   * past the keystroke budget it replaces', asserting it was over 4,000).
   *
   * Both pinned a constant that no longer exists. The console's own ceiling was
   * never the console's: it was the command line the SCRIPT was spawned in, and
   * #433 hands that script to PowerShell on stdin instead, where length costs
   * time and nothing else. The console tier answers the wire ceiling now, which
   * is what the two tests below say in the place these two stood.
   */
  it('leaves the console tier no ceiling of its own, since its script rides stdin', () => {
    // Measured live 2026-09-16 over that transport (docs/console-hosting.md §6):
    // a 30,000-code-point message — where 8,409 was refused before — was written
    // whole in 4,277 ms and the session's transcript carried all 30,000 points.
    expect(maxTextCharsFor('terminal')).toBe(MAX_DWARF_TEXT_CHARS)
  })

  it('still raises every channel well past the keystroke budget it replaces', () => {
    expect(MAX_DWARF_TEXT_CHARS).toBeGreaterThan(4_000)
  })
})

describe('maxTextCharsFor', () => {
  it('gives a console endpoint the wire ceiling, like every other endpoint', () => {
    // AMENDED for #433 (was: 'gives a console endpoint the console ceiling').
    expect(maxTextCharsFor('terminal')).toBe(MAX_DWARF_TEXT_CHARS)
  })

  /*
   * AMENDED for #437 (was: 'gives every other endpoint the wire ceiling', with
   * 'codex-queue' in the same list as the rest).
   *
   * The queue left the list because it is now the only endpoint with a bound of
   * its own: its message is an argv element, and Codex names no stdin form for
   * it. Every other endpoint — the relay included, since its instruction moved
   * to stdin — is bounded by the wire's sanity ceiling and by nothing nearer.
   */
  /*
   * AMENDED for #450: 'codex-exec-resume' joined the list.
   *
   * It is the second Codex channel and it is on the OTHER side of this split,
   * which is the whole reason it had to be a separate channel: `codex exec
   * resume <id> -` reads its prompt from stdin, so no command line bounds it
   * and the queue's argv-derived ceiling would refuse a message this route can
   * carry.
   */
  it('gives every endpoint but the Codex queue the wire ceiling', () => {
    for (const channel of [
      'claude-relay',
      'foreman-relay',
      'held-session',
      'hosted-stdin',
      'launched-process',
      'codex-exec-resume'
    ] as const) {
      expect(maxTextCharsFor(channel)).toBe(MAX_DWARF_TEXT_CHARS)
    }
  })

  it("gives the Codex queue its own command-line bound, which is nobody else's", () => {
    expect(maxTextCharsFor('codex-queue')).toBe(MAX_CODEX_QUEUE_TEXT_CHARS)
    expect(maxTextCharsFor('codex-queue')).toBeLessThan(MAX_DWARF_TEXT_CHARS)
  })

  it('answers the wire ceiling for no channel at all, rather than the tightest', () => {
    // Nothing is sent without a channel, so this number only ever feeds a
    // composer that is already disabled; guessing the tightest would make it
    // say a limit no send of this dwarf's would ever have met.
    expect(maxTextCharsFor(null)).toBe(MAX_DWARF_TEXT_CHARS)
  })
})

describe('messageTooLongReason', () => {
  it('names the length, the limit and what would have carried it', () => {
    const reason = messageTooLongReason(20_000, MAX_DWARF_TEXT_CHARS, 'terminal')
    expect(reason).toContain('20000')
    expect(reason).toContain(String(MAX_DWARF_TEXT_CHARS))
    expect(reason).toContain('console')
  })

  it('names a different carrier for a different channel', () => {
    expect(messageTooLongReason(20_000, MAX_DWARF_TEXT_CHARS, 'codex-queue')).toContain('queue')
  })

  /*
   * #450. The two Codex channels are different acts against the same session
   * and the refusal has to tell them apart, or a person reading it goes looking
   * for a queue that was never involved.
   */
  it('tells the two Codex channels apart by what would have carried the message', () => {
    const resumed = messageTooLongReason(20_000, MAX_DWARF_TEXT_CHARS, 'codex-exec-resume')
    expect(resumed).toContain('Codex')
    expect(resumed).not.toContain('queue')
  })

  it('says nothing was sent, because nothing was', () => {
    expect(messageTooLongReason(20_000, MAX_DWARF_TEXT_CHARS, null)).toContain('nothing was sent')
  })
})

/*
 * `heldRetainedText` and its `describe` block went with #436: the per-row cut
 * it applied existed only because a held conversation rode every poll's
 * snapshot, and #436 took the exchange off the wire entirely (see
 * `HELD_CONVERSATION_LIMIT` in contracts.ts). `heldSession.test.ts`'s
 * `retainHeldMessage` cases pin what replaced it — a held row retained whole,
 * however long.
 */
/* --- end of the #431 block ------------------------------------------------- */

describe('parseDwarfText', () => {
  it('takes a message inside the wire ceiling unchanged', () => {
    expect(parseDwarfText('hello')).toBe('hello')
    expect(parseDwarfText('x'.repeat(MAX_DWARF_TEXT_CHARS))).toHaveLength(MAX_DWARF_TEXT_CHARS)
  })

  it('takes an empty message, which is what an attachments-only send carries', () => {
    expect(parseDwarfText('')).toBe('')
  })

  it('refuses the whole request past the ceiling rather than cutting it to fit', () => {
    // The refusal #431 exists for: a payload trimmed here would reach a session
    // with its ending removed and be reported delivered.
    expect(parseDwarfText('x'.repeat(MAX_DWARF_TEXT_CHARS + 1))).toBeNull()
  })

  it.each([42, null, undefined, {}, ['hi']])('refuses %j, which is not a message', (value) => {
    expect(parseDwarfText(value)).toBeNull()
  })
})

/* --- The relay's prompt on stdin (#437) — one block, appended -------------- */

/*
 * Issue #437. The boundary's own bound used to be the command line, and
 * 40,000 characters was over it; the relay hands its instruction to `claude -p`
 * on stdin now, so the only thing left to refuse at the wire is a payload big
 * enough to be a mistake. The measurement that licensed this is in
 * docs/console-hosting.md §6.
 */
describe('a 40,000-character message', () => {
  const long = 'x'.repeat(40_000)

  it('passes the IPC boundary, which used to refuse it', () => {
    expect(parseDwarfText(long)).toHaveLength(40_000)
  })

  it('fits every route but the Codex queue', () => {
    for (const channel of [
      'terminal',
      'claude-relay',
      'foreman-relay',
      'held-session',
      'hosted-stdin'
    ] as const) {
      expect(long.length).toBeLessThanOrEqual(maxTextCharsFor(channel))
    }
  })

  it('is past what the Codex queue can put in a command line', () => {
    expect(long.length).toBeGreaterThan(maxTextCharsFor('codex-queue'))
  })

  it("is refused by the queue's sentence, which names the queue and its number", () => {
    const reason = messageTooLongReason(long.length, maxTextCharsFor('codex-queue'), 'codex-queue')
    expect(reason).toContain('40000')
    expect(reason).toContain(String(MAX_CODEX_QUEUE_TEXT_CHARS))
    expect(reason).toContain('queue')
  })
})
/* --- end of the #437 block ------------------------------------------------- */

/* --- The picker's Other row (#481) — one block, appended ------------------- */
/*
 * Issue #481. The one rule both processes act on about Claude Code's picker
 * "Other" row: which shape of ask has a MEASURED route to it. The renderer
 * decides whether to draw the box from it and main decides whether to build
 * the keys from it, so a second spelling would be the two sides disagreeing
 * about what the person may type.
 *
 * Measured by the maintainer on Claude Code 2.1.276, Windows Terminal,
 * 2026-09-18 — see main's textDelivery/questionKeys.ts for the gestures and
 * docs/console-hosting.md §6 for the register entry.
 */
function otherRowAsk(overrides: Partial<DwarfQuestion> = {}): DwarfQuestion {
  return {
    toolUseId: 'toolu_other',
    question: 'Which store?',
    channel: 'terminal',
    multiSelect: false,
    questionCount: 1,
    options: [{ label: 'Postgres' }, { label: 'SQLite' }],
    ...overrides
  }
}

describe('askHasAReachableOtherRow (#481)', () => {
  it('accepts the one shape measured: a single-question, single-select ask', () => {
    expect(askHasAReachableOtherRow(otherRowAsk())).toBe(true)
  })

  it('refuses a multi-select ask, whose Other row nobody has watched', () => {
    // Enter TOGGLES on a multi-select picker (#362 round 1), so what an Enter
    // behind typed text does there is a different gesture and an unmeasured one.
    expect(askHasAReachableOtherRow(otherRowAsk({ multiSelect: true }))).toBe(false)
  })

  it('refuses a call that carried several questions', () => {
    expect(askHasAReachableOtherRow(otherRowAsk({ questionCount: 2 }))).toBe(false)
  })

  it('accepts an ask with as many options as the picker numbers rows', () => {
    const nine = Array.from({ length: MAX_PICKER_NUMBERED_ROWS }, (_, index) => ({
      label: `Option ${index + 1}`
    }))
    expect(askHasAReachableOtherRow(otherRowAsk({ options: nine }))).toBe(true)
  })

  it('refuses one option more than that, where the rows scroll unwatched', () => {
    const ten = Array.from({ length: MAX_PICKER_NUMBERED_ROWS + 1 }, (_, index) => ({
      label: `Option ${index + 1}`
    }))
    expect(askHasAReachableOtherRow(otherRowAsk({ options: ten }))).toBe(false)
  })

  it('refuses an ask offering nothing, whose first row is not the Other one', () => {
    // Both routes to the row are counted off the options — the digit is N+1 and
    // the arrows are N of them — so an ask with none of them counts to a row
    // nobody has seen.
    expect(askHasAReachableOtherRow(otherRowAsk({ options: [] }))).toBe(false)
  })

  it('says nothing about the CHANNEL, which each caller already holds', () => {
    // The shape of the ask and where it is drawn are two facts. The card pairs
    // this with the prompt's own channel and main pairs it with the guard it
    // already runs; folding the channel in here would have given each of them a
    // second reading of something they know.
    expect(askHasAReachableOtherRow(otherRowAsk({ channel: 'held' }))).toBe(true)
  })

  it('numbers nine rows, which is what the picker was measured to number', () => {
    expect(MAX_PICKER_NUMBERED_ROWS).toBe(9)
  })
})
/* --- end of the #481 block ------------------------------------------------- */
