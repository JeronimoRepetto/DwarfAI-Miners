# OpenCode fixtures

Captured from **OpenCode 1.18.31** on Windows, 2026-09-17, and **sanitized** before being
committed: the account name is `j`, the store host is `placeholder-host`, project slugs are
`sample-project`/`Sample-Project`, session ids are `ses_placeholder_*` rather than the CLI's own
opaque ids, and every prompt/reply is short neutral English of the same _shape_ as what was
captured. Column names, JSON key names, key order and the timestamp format (epoch milliseconds)
are the real ones — that is the whole point of a fixture, and it is the half that must not be
invented. `docs/opencode-format.md` records the format these were read from, including the
negative rows (no `storage/` tree, no pid column, no per-session JSONL, no `permission` row and no
`session_message`/`session_input` row in the measured interactive turn).

**`session.agent` is a user-configured agent name, not a fixed identity.** The measured value
(`gentle-orchestrator`) was the maintainer's own configured agent nickname and is replaced here
with the same placeholder throughout, exactly as it would be for any other account-specific value.

| File                               | What it is                                                                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opencode-schema.sql`              | The measured DDL for the four tables this provider reads (`session`, `message`, `part`, `event`) plus their real indexes, foreign keys to unread tables (`project`, `event_sequence`) stripped so the fixture stands alone |
| `opencode-unknown-schema.sql`      | A synthetic database whose tables do not match the measured schema — the degradation fixture `opencode-store-evidence` requires, committed regardless of whether row 2 stayed positive                                     |
| `message-user.json`                | A `message.data` blob for a user turn: `role`, `time.created`, `agent`, `model {providerID, modelID}`                                                                                                                      |
| `message-assistant-streaming.json` | An assistant `message.data` blob with no `time.completed` — the still-streaming shape                                                                                                                                      |
| `message-assistant-toolcalls.json` | An assistant `message.data` blob whose `finish` is `"tool-calls"` — an intermediate step, not the end of the turn                                                                                                          |
| `message-assistant-stop.json`      | An assistant `message.data` blob whose `finish` is `"stop"` — the turn has ended                                                                                                                                           |
| `part-text.json`                   | A `part.data` blob of `type: "text"` — the agent's own words                                                                                                                                                               |
| `part-reasoning.json`              | A `part.data` blob of `type: "reasoning"` — the model's scratch, never shown as the agent's own words                                                                                                                      |
| `part-tool.json`                   | A `part.data` blob of `type: "tool"` — becomes one `activity` feed line                                                                                                                                                    |
| `part-step-start.json`             | A `part.data` blob of `type: "step-start"` — emits nothing in the feed                                                                                                                                                     |
| `part-step-finish.json`            | A `part.data` blob of `type: "step-finish"` — emits nothing in the feed                                                                                                                                                    |
| `part-unknown.json`                | A synthetic `part.data` blob of a `type` this build never wrote — the shape `parse.ts` must degrade to `null` for                                                                                                          |
| `session-parent.json`              | A `session` row for a root session (`parent_id: null`) that later spawns a subagent — the row-4 topology fixture                                                                                                           |
| `session-child.json`               | A `session` row for the subagent (`parent_id` naming the parent), same `directory`, its own tokens/cost, and a `model` JSON carrying the extra `variant` key a delegated child's model column carries                      |
| `part-task-tool.json`              | The parent's own `part.data` blob: a `type: "tool"` part with `tool: "task"` and `state.status: "completed"` — the corroborating evidence of the spawn                                                                     |

No JSON-tree (`storage/{session,message,part}`) fixtures are committed: the measured install wrote
SQLite only (Row 1, `docs/opencode-format.md`), and the maintainer decision this change follows is
SQLite-only — a fixture for a shape nothing reads would pin behaviour that does not exist.
