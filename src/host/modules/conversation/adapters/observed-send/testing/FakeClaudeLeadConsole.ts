// A double of a Claude Code 2.1.310 lead terminal for the observed-subagent route (AMENDMENT-29;
// 16 §2.8, 17 §2.2 `Fake<Port>` family): it implements the console-reading capability, the
// navigation keys and the text relay's `write`, keeps the TUI's state as the spike measured it
// (odd/handoff/spike-claude-subagent-terminal-input.md §2 keys table, §4 return, §5 shared input) and
// draws each screen in the measured layout of fixtures/claude/observer/2.1.310 (its validation-run
// appendix). It never starts a process.
//
// What it models: ↓ from the input enters the list on `main` (a multi-line draft keeps it in the
// input); ↓/↑ move the pointer; ↑ on `main` gives the input the focus; ↑ in the input recalls the last
// sent message (history); Enter on a row opens that view and keeps the list focus and the pointer;
// Enter in the input submits it to the open view; typed text goes into the one shared input, which
// takes the focus. Esc and every other key have no entry point: a route cannot press them here.
import type { ProcessIdentity } from '../../../../../kernel/domain/processIdentity'
import type { NavKey } from '../claudeAgentPlan'
import type { TextWriteOutcome } from '../ConsoleTextDelivery'
import type {
  ConsoleNavigator,
  ConsoleScreenReader,
  KeyOutcome,
  ScreenRead
} from '../WindowsConsoleScreen'

export interface FakeSubagent {
  description: string
  /** What its list row shows: the description at first, later an activity summary (spike §1). */
  row: string
  /** The elapsed-time and tokens column of its row. */
  timing: string
  agentType: string
}

/** One step the console took, in order: a key, a typed text, or a read. */
export type FakeConsoleEvent = { key: NavKey } | { typed: string } | { read: true }

/** The measured window: rules 138 wide, agent rows right-aligned to 136 (2026-10-24 captures). */
const WIDTH = 138
const ROW_WIDTH = 136
const RULE = '─'.repeat(WIDTH)
/** The scrubbed parts of the captures: the transcript area and the person's status line. */
const TRANSCRIPT = '⏺ (transcript scrubbed)'
const STATUS = '  (status line scrubbed)'
const HINT_INPUT = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const HINT_LEAD_MAIN = '  ↑/↓ to select'
const HINT_LEAD_AGENT = '  Enter to view · x to stop · ctrl+x ctrl+k to stop all agents'
const HINT_VIEW_MAIN = '  ↑/↓ to select · Enter to view'
const HINT_VIEW_AGENT = '  ↑/↓ to select · ctrl+x ctrl+k to stop all agents'

/** The longest label a rule shows whole: a longer one is cut short with `…` and fills the rule. */
const RULE_LABEL_MAX = WIDTH - 3

/**
 * The three agents of the validation run (2026-10-24): golf's row still shows its description,
 * hotel's an activity summary, and the long one's row and rule label are cut short.
 */
export function measuredSubagents(): FakeSubagent[] {
  return [
    {
      description: 'Run ping four times (golf)',
      row: 'Run ping four times (golf)',
      timing: '41s · ↓ 58.2k tokens',
      agentType: 'general-purpose'
    },
    {
      description: 'Run ping four times (hotel)',
      row: 'Running second ping delay',
      timing: '40s · ↓ 58.2k tokens',
      agentType: 'general-purpose'
    },
    {
      description:
        'Run ping four times then report back, this description is deliberately very long to see how the terminal label shows it in full or cut short (india)',
      row: 'Run ping four times then report back, this description is deliberately very long to see how t…',
      timing: '40s · ↓ 58.2k tokens',
      agentType: 'general-purpose'
    }
  ]
}

export class FakeClaudeLeadConsole implements ConsoleScreenReader, ConsoleNavigator {
  agents: FakeSubagent[]
  /** 0: the lead's own view; i: the view of `agents[i - 1]`. */
  view = 0
  focus: 'input' | 'list' = 'input'
  pointer = 0
  /** The one input line every view shares (spike §5). */
  input = ''
  /** The messages submitted, to `main` or to a subagent's description, in order. */
  readonly submitted: Array<{ to: string; text: string }> = []
  readonly events: FakeConsoleEvent[] = []
  /** Answers instead of a screen, per read, in order (`gone`, `not-targeted`, `failed`). */
  readonly readAnswers: Array<Exclude<ScreenRead, { kind: 'screen' }>> = []
  /** Answers instead of pressing, per key, in order. */
  readonly keyAnswers: Array<Exclude<KeyOutcome, 'pressed'>> = []
  /** What `write` answers; `written` types the text and submits it. */
  writeAnswer: TextWriteOutcome = 'written'
  /** Runs after each key or typed text: the world moving on meanwhile (an agent ends, the person types). */
  afterStep: ((console: FakeClaudeLeadConsole) => void) | null = null
  private readonly history: string[] = []

  constructor(agents: FakeSubagent[] = measuredSubagents()) {
    this.agents = agents
  }

  read(_target: ProcessIdentity): Promise<ScreenRead> {
    this.events.push({ read: true })
    const answer = this.readAnswers.shift()
    if (answer !== undefined) return Promise.resolve(answer)
    return Promise.resolve({ kind: 'screen', lines: this.render() })
  }

  press(_target: ProcessIdentity, key: NavKey): Promise<KeyOutcome> {
    const answer = this.keyAnswers.shift()
    if (answer !== undefined) return Promise.resolve(answer)
    this.events.push({ key })
    switch (key) {
      case 'down':
        if (this.focus === 'input') {
          if (!this.input.includes('\n')) {
            this.focus = 'list'
            this.pointer = 0
          }
        } else {
          this.pointer = Math.min(this.pointer + 1, this.agents.length)
        }
        break
      case 'up':
        if (this.focus === 'input') {
          this.input = this.history.at(-1) ?? this.input
        } else if (this.pointer === 0) {
          this.focus = 'input'
        } else {
          this.pointer -= 1
        }
        break
      case 'enter':
        if (this.focus === 'list') this.view = this.pointer
        else this.submit()
        break
      default: {
        const never: never = key
        throw new Error(`FakeClaudeLeadConsole: no key ${String(never)}`)
      }
    }
    this.afterStep?.(this)
    return Promise.resolve('pressed')
  }

  /** The text relay's `write` (ConsoleTextDelivery): the relay text into the input, then Enter. */
  write(_target: ProcessIdentity, text: string): Promise<TextWriteOutcome> {
    this.events.push({ typed: text })
    if (this.writeAnswer !== 'written') return Promise.resolve(this.writeAnswer)
    this.focus = 'input'
    this.input += text.replace(/\s+/g, ' ').trim()
    this.submit()
    this.afterStep?.(this)
    return Promise.resolve('written')
  }

  /** The keys pressed, in order (`type` for a text written). */
  keys(): string[] {
    return this.events.flatMap((event) =>
      'key' in event ? [event.key] : 'typed' in event ? ['type'] : []
    )
  }

  /** A subagent's run ends: its row leaves the list; the pointer follows the agent it was on. */
  finish(description: string): void {
    const index = this.agents.findIndex((agent) => agent.description === description)
    if (index < 0) return
    this.agents.splice(index, 1)
    if (this.pointer > index + 1 || this.pointer > this.agents.length) this.pointer -= 1
    if (this.view === index + 1) this.view = 0
    else if (this.view > index + 1) this.view -= 1
  }

  private submit(): void {
    if (this.input === '') return
    const to = this.view === 0 ? 'main' : this.agents[this.view - 1]!.description
    this.submitted.push({ to, text: this.input })
    this.history.push(this.input)
    this.input = ''
  }

  /** The visible window, in the layout of fixtures/claude/observer/2.1.310 (scrubbed parts included). */
  render(): string[] {
    const agent = this.view === 0 ? null : this.agents[this.view - 1]!
    const top = agent === null ? RULE : ruleLabelled(agent.description)
    const [first = '', ...more] = this.input.split('\n')
    const shown = first === '' && agent !== null ? `Message @${agent.agentType}…` : first
    const listed = this.focus === 'list'
    const hint = !listed
      ? HINT_INPUT
      : agent === null
        ? this.pointer === 0
          ? HINT_LEAD_MAIN
          : HINT_LEAD_AGENT
        : this.pointer === 0
          ? HINT_VIEW_MAIN
          : HINT_VIEW_AGENT
    const mark = (index: number) => (listed && this.pointer === index ? '❯ ' : '  ')
    const bullet = (index: number) => (this.view === index ? '●' : '◯')
    const list =
      this.agents.length === 0
        ? []
        : [
            '',
            `${mark(0)}${bullet(0)} main`,
            ...this.agents.map((row, index) => {
              const head = `${mark(index + 1)}${bullet(index + 1)} ${row.agentType}  ${row.row}`
              return `${head.padEnd(ROW_WIDTH - row.timing.length)}${row.timing}`
            })
          ]
    return [
      TRANSCRIPT,
      top,
      `❯ ${shown}`,
      ...more.map((line) => `  ${line}`),
      RULE,
      STATUS,
      hint,
      ...list
    ].map((line) => line.trimEnd())
  }
}

/** The top rule of a view: `── label ─`, or ` label… ─` when the label is cut short. */
function ruleLabelled(description: string): string {
  if (description.length <= RULE_LABEL_MAX) {
    return `${'─'.repeat(WIDTH - description.length - 3)} ${description} ─`
  }
  return ` ${description.slice(0, RULE_LABEL_MAX - 1)}… ─`
}
