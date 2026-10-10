// The asking module's wiring (05 §3.7, §4; 16 §4.7, §8.2, §8.3; 08 §2.7; ADR-010 items 1, 6, 11;
// ADR-018 items 2–3; ISSUE-140): the Host's one ask broker for every channel it owns, in two parts,
// as routes/crew.ts:
//
// - `serveAsking`, run by the composition root before the boot binds the endpoint: B-M30
//   `asking.answerQuestion`, B-M31 `asking.answerPermission`, B-M32 `asking.setStep` and the
//   snapshot's `asks` section, so every `hello.ok` lists them (14 §1.3); the ask frames
//   (`ASKING_FRAMES`) are advertised with the endpoint's frame list. They forward to the one
//   instance boot step 4 constructs; until then the dispatcher answers HOST_NOT_READY (14 §3.3).
// - `wire`, run by boot step 4 once suppliers, conversation, observation, crew, mines and attention
//   exist (16 §8.2): the broker over `SqliteAskRepository` (one instance for `open`, the answer
//   paths, the external resolutions and closing by death, so a resolution sees an answer in
//   flight), conversation's `AnswerRecords` and joined `ingest`, the `SessionCapabilities` binding,
//   the answer channels, the Claude hook ingress route, and the routes below. The routes are
//   subscribed ahead of the cut-1 routes (routes/cut1Routes.ts), so a departure closes the dwarf's
//   asks before conversation records its session end.
//
// Routes (05 §4; 08 §2.7), each through the target module's public API only (R4, R15):
// - Hook ingress evidence (`/hooks/claude/*`) → asking `open` / `resolveExternally`, the session
//   resolved to its dwarf first (routes/observedClaudeAsks.ts, ISSUE-134). The cut-1 observed-ask
//   route of ISSUE-120 never existed (routes/cut1Routes.ts): this is the one route.
// - `ObservedAskClosed` (observation) → `resolveExternally` (routes/askResolutions.ts, ISSUE-136).
// - `DwarfDeparted` (crew) → `closeForDwarf` (S6.14, S6.15; INV-77).
// - `AskOpened` → the `ask.opened` frame (transport/frames/askFrames.ts); crew `startAsking` for the
//   dwarf's front ask; conversation `noteAsk(opened)`; attention `onFact` with the ask's
//   `reannounce` (INV-103) and the names resolved at emit time: crew's `displayName` and the mine's
//   name (ISSUE-109 lead decision).
// - `AskClosed` → `ask.closed`; attention `onFactEnded`; for the dwarf's front ask, crew
//   `stopAsking` and conversation `noteAsk(closed)`, then, when another ask of the dwarf is open,
//   `startAsking` and `noteAsk(opened)` for that next front ask (lead decision 2026-10-10: the frozen
//   `stopAsking` has no next argument). An `auto-denied` ask never opened: its `AskClosed` moves
//   neither the dwarf's status nor its outcome line (07 S1.16) and holds no attention key.
// - `AskReopened`, `AskStepChanged` → their frames only: an `answering` ask is still `asking`
//   (INV-24), and a step changes no status.
// - At wiring time, every dwarf's front ask that is still open is replayed into crew: the open ask
//   is Host memory in crew (09 §4.2), the stored asks are the durable record (S1.18).
//
// Not here, and why:
// - Listening on the ingress and persisting its port (16 §8.2 step 6): ISSUE-209. `hookRoutes` is
//   the route that listener serves; until it listens, `app_meta.ingress_port` stays unset, so the
//   first-run step offers no Claude hooks before A-N32 is routed (ISSUE-141; PR #1269).
// - The hook decision channel (`hook-decision`): SP-11 has no passed record, so it is not composed
//   and its asks would answer `channel-unavailable` (fail closed). Driver channels: EPIC-10.
// - The real keystroke relay into an observed terminal: ISSUE-167. The Host binds
//   `NO_KEYSTROKE_RELAY` until then, so an in-app answer to an observed Claude permission refuses
//   `channel-unavailable` and the card keeps "Jump to terminal".
// - The closed-asks sweep (`askSweep.ts`) and the drain gate's asking blockers: not this issue's.
import type { AskId, DwarfId, HostEpoch, ProviderId } from '../../kernel/domain/values'
import { HostInvariantError } from '../../kernel/domain/errors'
import type { Clock } from '../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../kernel/ports/idGenerator'
import type { Scheduler } from '../../kernel/ports/scheduler'
import type { SqliteDatabase } from '../../kernel/ports/sqliteDatabase'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import type { Attention } from '../../modules/attention'
import {
  createAsking,
  createAskOpening,
  createAskQueries,
  createAskStep,
  type AskBroker,
  type AskingEvent,
  type AskRecord,
  type AskSession,
  type AskSnapshotQueries,
  type SessionCapabilities
} from '../../modules/asking'
import {
  ObservedClaudeKeystrokeChannel,
  type KeystrokeRelay
} from '../../modules/asking/adapters/observedClaude/ObservedClaudeKeystrokeChannel'
import { PermissionPromptRegistry } from '../../modules/asking/adapters/observedClaude/permissionPromptRegistry'
import type { TranscriptTail } from '../../modules/asking/adapters/observedClaude/transcriptTail'
import { SqliteAskRepository } from '../../modules/asking/adapters/SqliteAskRepository'
import type { AnswerRecordEvent, Conversation, ConversationEvent } from '../../modules/conversation'
import type { CrewCommands, CrewEvent, CrewQueries, DwarfDeparted } from '../../modules/crew'
import type { MinesQueries } from '../../modules/mines'
import type {
  ObservationAdapter,
  ObservationControl,
  ObservationEvent,
  ObservedAskClosed,
  ObservedSessionStore
} from '../../modules/observation'
import type { ChannelTokenStore, PreferencesQueries } from '../../modules/preferences'
import type { ProviderCapabilities, SupplierCatalogueQueries } from '../../modules/suppliers'
import { ChannelTokenCheck } from '../../transport/auth/channelTokenCheck'
import type { Dispatcher } from '../../transport/dispatcher'
import {
  ASK_FRAMES,
  publishAskFrames,
  type AskFramePublisher
} from '../../transport/frames/askFrames'
import { createClaudeHooksRoute } from '../../transport/ingress/claudeHooksRoute'
import type { IngressRoute } from '../../transport/ingress/httpIngress'
import { registerAskingAnswer } from '../../transport/methods/askingAnswer'
import { registerAskingSetStep } from '../../transport/methods/askingSetStep'
import { registerAsksSection } from '../../transport/snapshot/asksSection'
import type { SectionRegistry } from '../../transport/snapshot/sectionRegistry'
import { registerAskResolutions } from './askResolutions'
import { createObservedClaudeAsks, type ObservedClaudeAsks } from './observedClaudeAsks'

/** The ask frames (B-F15…B-F17), for `hello.ok.capabilities` (14 §1.3). */
export const ASKING_FRAMES = ASK_FRAMES

/** The events the asking wiring publishes or routes: one Host bus carries them all (16 §2.3). */
export type AskingRouteEvent =
  AskingEvent | AnswerRecordEvent | ConversationEvent | CrewEvent | ObservationEvent

/** The Host bus as the asking wiring uses it: the broker publishes; the routes subscribe. */
export type AskingWiringBus = DomainEventBus<AskingEvent> &
  DomainEventBus<AskingEvent | AnswerRecordEvent>

/** The same Host bus, for the two events of other modules the routes read (16 §2.3). */
export interface AskingRouteSources {
  /** Crew's departures (08 §2.2), for closing by death. */
  departures: Pick<DomainEventBus<DwarfDeparted>, 'subscribe'>
  /** Observation's trusted resolutions (08 §0 `ObservedAskClosed`). */
  resolutions: Pick<DomainEventBus<ObservedAskClosed>, 'subscribe'>
}

/** Until ISSUE-167 binds the observed-session relay: no key is ever pressed (fail closed). */
export const NO_KEYSTROKE_RELAY: KeystrokeRelay = { press: () => Promise.resolve('refused') }

export interface AskingServeDeps {
  /** The Host dispatcher (hostDispatcher.ts), where B-M30…B-M32 join. */
  dispatcher: Dispatcher
  /** The snapshot sections, where `asks` joins. */
  sections: SectionRegistry
}

export interface AskingWiringDeps {
  /** The Host's one writer (09 §8.1), opened by boot step 2. */
  db: SqliteDatabase
  /** Its transaction runner, also the bus's transaction scope (16 §2.2). */
  transactions: TransactionRunner & TransactionScope
  bus: AskingWiringBus
  /** The Host bus again, as the routes read other modules' events. */
  sources: AskingRouteSources
  clock: Clock
  /** Bounds each answer hand-over at 30 s (ADR-010 item 8). */
  scheduler: Scheduler
  ids: IdGenerator
  hostEpoch: HostEpoch
  log: DiagnosticsLog
  /** Where the ask frames go: the connection registry. */
  frames: AskFramePublisher
  /** The catalog id the Claude hook events report on. */
  claudeProviderId: ProviderId
  /** The asking → suppliers edge (05 §1.3): a launched session's capabilities (ADR-009 D2). */
  suppliers: { catalogue: Pick<SupplierCatalogueQueries, 'capabilities'> }
  /** The observation adapters the Host runs: an observed session's declared values (ADR-009 D3). */
  observed: readonly Pick<ObservationAdapter, 'providerId' | 'capabilities'>[]
  /** The asking → conversation edge: the answers records and the joined auto-denied line. */
  conversation: Pick<Conversation, 'answerRecords' | 'joinedEvents'> & {
    commands: Pick<Conversation['commands'], 'ingest' | 'noteAsk'>
  }
  /** The asking → crew edge: each dwarf's provider, origin, names and mine; the status route. */
  crew: {
    commands: Pick<CrewCommands, 'startAsking' | 'stopAsking'>
    queries: Pick<CrewQueries, 'get' | 'displayName'>
  }
  /** The mine's name on the attention fact. */
  mines: Pick<MinesQueries, 'get'>
  attention: Pick<Attention, 'inputs'>
  /** Observation's `ProviderIdentity → DwarfId` index (16 §4.3) and its nudge (05 §3.3). */
  observation: {
    sessions: Pick<ObservedSessionStore, 'byIdentity'>
    control: Pick<ObservationControl, 'nudge'>
  }
  /** The hook ingress's admission: the integration gate and the active channel token (05 §4). */
  preferences: {
    queries: Pick<PreferencesQueries, 'integrationState'>
    channelTokens: Pick<ChannelTokenStore, 'active'>
  }
  /** The observed-Claude keystroke channel's world (ADR-012 item 3). */
  keystrokes: {
    relay: KeystrokeRelay
    transcripts: TranscriptTail
    /** The one redaction rule (`contracts/logging` `redactSecrets`), bound here (05 R9). */
    redact(text: string): string
  }
}

export interface WiredAsking {
  /** The one broker (16 §4.7), every member but `snapshot`, which is `queries`. */
  broker: Omit<AskBroker, 'snapshot'>
  queries: AskSnapshotQueries
  /** The `/hooks/claude/*` route the ingress listener serves (later: ISSUE-209). */
  hookRoutes: readonly IngressRoute[]
  /** The hook evidence sink, and the promise of its work (tests; drain). */
  evidence: ObservedClaudeAsks
  /** Unsubscribes every route of this wiring (the clean exit). */
  stop(): void
}

export interface ServedAsking {
  /** Boot step 4: constructs the module the served members forward to. */
  wire(deps: AskingWiringDeps): WiredAsking
}

/** Serves the module's seam-B members before it exists; `wire` constructs it at boot step 4. */
export function serveAsking(serve: AskingServeDeps): ServedAsking {
  let served: WiredAsking | undefined
  const current = (): WiredAsking => {
    if (served === undefined) throw new HostInvariantError('asking is served from boot step 4 on')
    return served
  }
  registerAskingAnswer(serve.dispatcher, {
    broker: {
      answerQuestion: (askId, answers, requestId) =>
        current().broker.answerQuestion(askId, answers, requestId),
      answerPermission: (askId, decision, requestId) =>
        current().broker.answerPermission(askId, decision, requestId)
    }
  })
  registerAskingSetStep(serve.dispatcher, {
    broker: { setStep: (askId, step) => current().broker.setStep(askId, step) }
  })
  registerAsksSection(serve.sections, { asks: { snapshot: () => current().queries.snapshot() } })
  return {
    wire: (deps) => {
      if (served !== undefined) throw new HostInvariantError('asking is wired once')
      served = wireAsking(deps)
      return served
    }
  }
}

function wireAsking(deps: AskingWiringDeps): WiredAsking {
  const { bus, clock, conversation, crew, log } = deps
  const asks = new SqliteAskRepository({ db: deps.db, scope: deps.transactions, clock })
  const queries = createAskQueries({ asks, crew: crew.queries })

  const prompts = new PermissionPromptRegistry({
    transcripts: deps.keystrokes.transcripts,
    redact: deps.keystrokes.redact
  })
  const keystrokes = new ObservedClaudeKeystrokeChannel({
    prompts,
    transcripts: deps.keystrokes.transcripts,
    relay: deps.keystrokes.relay,
    log
  })
  // The composed answer channels: the observed-Claude keystroke channel only (see the header).
  const channelFor = (channel: AskRecord['channel']) =>
    channel === 'hook-keystroke' ? keystrokes : null
  const staleAnswerSafe = (channel: AskRecord['channel']): boolean =>
    channelFor(channel)?.capabilities.staleAnswerSafe ?? true

  const answering = createAsking({
    asks,
    records: conversation.answerRecords,
    channelFor,
    staleAnswerSafe,
    transactions: deps.transactions,
    bus,
    clock,
    scheduler: deps.scheduler,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch
  })
  const opening = createAskOpening({
    asks,
    sessions: sessionCapabilities(deps),
    lines: conversation.commands,
    joinedLines: conversation.joinedEvents,
    channelFor,
    transactions: deps.transactions,
    bus,
    clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch
  })
  const steps = createAskStep({
    asks,
    transactions: deps.transactions,
    bus,
    clock,
    ids: deps.ids,
    hostEpoch: deps.hostEpoch
  })
  const broker: WiredAsking['broker'] = {
    open: (dwarfId, input) => opening.open(dwarfId, input),
    setStep: (askId, step) => steps.setStep(askId, step),
    answerPermission: (askId, decision, requestId) =>
      answering.answers.answerPermission(askId, decision, requestId),
    answerQuestion: (askId, answers, requestId) =>
      answering.answers.answerQuestion(askId, answers, requestId),
    resolveExternally: (dwarfId, providerRequestId, by) =>
      answering.resolutions.resolveExternally(dwarfId, providerRequestId, by),
    closeForDwarf: (dwarfId) => answering.resolutions.closeForDwarf(dwarfId)
  }

  const evidence = createObservedClaudeAsks({
    providerId: deps.claudeProviderId,
    sessions: deps.observation.sessions,
    prompts,
    asks: broker,
    log
  })
  const hookRoute = createClaudeHooksRoute({
    tokens: new ChannelTokenCheck({ tokens: deps.preferences.channelTokens, log }),
    preferences: deps.preferences.queries,
    observation: deps.observation.control,
    evidence,
    log
  })

  const stops: Array<() => void> = []
  stops.push(publishAskFrames({ events: bus, asks: queries, frames: deps.frames }))
  stops.push(
    registerAskResolutions({
      bus: deps.sources.resolutions,
      sessions: deps.observation.sessions,
      asks: broker,
      log
    })
  )
  stops.push(
    deps.sources.departures.subscribe('DwarfDeparted', ({ payload }) =>
      broker.closeForDwarf(payload.dwarfId)
    )
  )
  stops.push(...routeAskStatus(deps, queries))

  return {
    broker,
    queries,
    hookRoutes: [hookRoute],
    evidence,
    stop: () => {
      for (const stop of stops.splice(0)) stop()
    }
  }
}

/**
 * The Claude hook channel's values for an observed Claude session while Claude Code instant updates
 * are `on-verified` (15 §2.5 row "Claude with DwarfAI hooks"; ADR-012 items 3, 6): the hook events
 * reveal its permission prompts, and the keystroke channel answers them from a card, Allow meaning
 * this once (15 §2.7). Questions still come from the transcript (the observing adapter's value).
 */
const CLAUDE_HOOK_CHANNEL: Pick<ProviderCapabilities, 'permission' | 'observedPermission'> = {
  permission: 'interactive',
  observedPermission: 'detected'
}

/**
 * `SessionCapabilities` (16 §4.7 row `open`; ADR-011 item 5), per session (15 §2.6): the dwarf's
 * provider and origin from crew; a launched session reads suppliers' capability data (the merged
 * ceiling and negotiated set, its answer-channel gate applied), an observed one the declaration of
 * the adapter observing it (ADR-009 D3, as routes/cut1Routes.ts reads `turnEnd`; an omitted field
 * fails closed), raised by the Claude hook channel while it is on. A dwarf crew does not know, or a
 * provider no adapter observes, reads fail-closed values (every answer path `none`). No launched
 * session reaches the Host before EPIC-10, whose driver sessions bring their negotiated set.
 */
function sessionCapabilities(deps: AskingWiringDeps): SessionCapabilities {
  const observedOf = (providerId: ProviderId): AskSession['capabilities'] => {
    const declared = deps.observed.find((adapter) => adapter.providerId === providerId)
    const values = declared?.capabilities() ?? {}
    const hooked =
      providerId === deps.claudeProviderId &&
      deps.preferences.queries.integrationState('claude-hooks') === 'on-verified'
    return {
      permission: hooked ? CLAUDE_HOOK_CHANNEL.permission : (values.permission ?? 'none'),
      question: values.question ?? 'none',
      observedPermission: hooked
        ? CLAUDE_HOOK_CHANNEL.observedPermission
        : (values.observedPermission ?? 'none'),
      observedQuestion: values.observedQuestion ?? 'none'
    }
  }
  return {
    sessionOf: (dwarfId: DwarfId): AskSession => {
      const dwarf = deps.crew.queries.get(dwarfId)
      const providerId = (dwarf?.providerId ?? '') as ProviderId
      if (dwarf === null || !dwarf.owned) {
        return { providerId, origin: 'observed', capabilities: observedOf(providerId) }
      }
      const launched = deps.suppliers.catalogue.capabilities(providerId)
      return {
        providerId,
        origin: 'launched',
        capabilities: {
          permission: launched.permission,
          question: launched.question,
          observedPermission: launched.observedPermission,
          observedQuestion: launched.observedQuestion
        }
      }
    }
  }
}

/** What the outcome line words of an opened ask (16 §4.6 `noteAsk`, amended B2). */
function questionCount(ask: Pick<AskRecord, 'kind' | 'payload'>): number {
  return ask.kind === 'question' ? (ask.payload as { steps: unknown[] }).steps.length : 0
}

/** The `ask.*` routes into crew, conversation and attention (08 §2.7). Returns the unsubscribes. */
function routeAskStatus(
  deps: AskingWiringDeps,
  queries: Pick<AskSnapshotQueries, 'openAskOf' | 'openAsks'>
): Array<() => void> {
  const { bus, crew, conversation, attention } = deps
  /** The ask each dwarf is `asking` for in crew and in its outcome line: its front ask. */
  const frontOf = new Map<DwarfId, string>()
  /** The attention keys handed to `onFact`, by ask, until the ask closes. */
  const keyOf = new Map<string, string>()

  const front = (ask: Pick<AskRecord, 'id' | 'dwarfId' | 'kind' | 'payload'>): void => {
    const dwarfId = ask.dwarfId as DwarfId
    frontOf.set(dwarfId, ask.id)
    crew.commands.startAsking(dwarfId, ask.kind)
    conversation.commands.noteAsk(dwarfId, {
      askId: ask.id as AskId,
      state: 'opened',
      kind: ask.kind,
      questionCount: questionCount(ask)
    })
  }

  // S1.18: the open asks a stopped Host left are replayed into crew's Host memory.
  for (const ask of queries.openAsks()) {
    const dwarfId = ask.dwarfId as DwarfId
    if (frontOf.has(dwarfId) || queries.openAskOf(dwarfId)?.id !== ask.id) continue
    frontOf.set(dwarfId, ask.id)
    crew.commands.startAsking(dwarfId, ask.kind)
  }

  return [
    bus.subscribe('AskOpened', ({ payload: { ask } }) => {
      const dwarfId = ask.dwarfId as DwarfId
      if (!frontOf.has(dwarfId)) front(ask)
      const dwarf = crew.queries.get(dwarfId)
      const mine = dwarf === null ? null : deps.mines.get(dwarf.mineId)
      if (dwarf === null || dwarf.departed || mine === null) return
      const key = `${dwarfId}:${ask.kind}:${ask.id}`
      keyOf.set(ask.id, key)
      attention.inputs.onFact(
        {
          key,
          kind: ask.kind,
          dwarfId,
          mineId: dwarf.mineId,
          at: ask.openedAt,
          reannounce: ask.reannounce
        },
        { displayName: crew.queries.displayName(dwarfId), mineName: mine.name }
      )
    }),
    bus.subscribe('AskClosed', ({ payload: { askId, dwarfId, reason } }) => {
      const key = keyOf.get(askId)
      if (key !== undefined) {
        keyOf.delete(askId)
        attention.inputs.onFactEnded(key)
      }
      // S1.16: an auto-denied ask never opened; only the front ask moves the status and the line.
      if (reason === 'auto-denied' || frontOf.get(dwarfId) !== askId) return
      frontOf.delete(dwarfId)
      crew.commands.stopAsking(dwarfId)
      conversation.commands.noteAsk(dwarfId, { askId, state: 'closed' })
      const next = queries.openAskOf(dwarfId)
      if (next !== null) front(next)
    })
  ]
}
