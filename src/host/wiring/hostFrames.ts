// Every frame the Host's UI endpoint advertises in `hello.ok.capabilities` (14 §1.3), in one list
// the composition root hands the endpoint (host/main.ts) and the L2 flows read (ISSUE-182): each
// module's frames join with the wiring that publishes them.
import type { HostFrameName } from '@dwarfai/contracts'
import { TRANSPORT_FRAMES } from '../transport/events/framePublisher'
import { BOARD_FRAMES } from '../transport/frames/board'
import { LEDGER_FRAMES } from '../transport/frames/ledger'
import { LIFECYCLE_FRAMES } from '../transport/lifecycle/hostState'
import { PREFERENCES_FRAMES } from '../transport/methods/preferences'
import { RESET_FRAMES } from '../transport/methods/resetMetrics'
import { SET_CLAUDE_HOOKS_FRAMES } from '../transport/methods/setClaudeHooks'
import { ASKING_FRAMES } from './routes/askingRoutes'
import { ATTENTION_FRAMES } from './routes/attentionTransport'
import { CONVERSATION_READ_FRAMES } from './routes/conversationFrames'
import { LAUNCHING_FRAMES } from './routes/launching'

export const HOST_FRAMES: readonly HostFrameName[] = Object.freeze([
  ...LIFECYCLE_FRAMES,
  ...TRANSPORT_FRAMES,
  ...PREFERENCES_FRAMES,
  ...SET_CLAUDE_HOOKS_FRAMES,
  ...RESET_FRAMES,
  ...BOARD_FRAMES,
  ...LEDGER_FRAMES,
  ...CONVERSATION_READ_FRAMES,
  // B-F12 `message.delivery`, the send path's marks (ISSUE-166).
  'message.delivery',
  ...ATTENTION_FRAMES,
  ...ASKING_FRAMES,
  ...LAUNCHING_FRAMES
])
