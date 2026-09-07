# Antigravity CLI fixtures

Captured from **Antigravity CLI 1.1.26** on Windows, 2026-09-07, and **sanitized** before being
committed: the account name is `j`, workspaces are `Sample-Project` and its siblings, conversation
ids are repeated-digit UUIDs, and every prompt and reply is short neutral English of the same
_shape_ as what was captured. Record types, field names, field order, `step_index` numbering (gaps
included) and the timestamp format are the real ones — that is the whole point of a fixture, and it
is the half that must not be invented. `transcript-tool-calls.jsonl` (issue #280) is generated
rather than hand-typed, but every tool name, arg name and the double-encoding of each value is real
— re-measured live against the same CLI version and the same three-conversation local store on
2026-09-07, alongside the other files here.

`docs/provider-formats.md` §3 records the format these were read from, and the version caveat: this
is a **private on-disk format** that has changed across CLI versions, so a parser reading it
degrades on an unknown record rather than throwing. §3.1.6 tabulates the tool-call measurement.

| File                            | What it is                                                                                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcript.jsonl`              | One finished conversation: both human turns, both displayable planner replies, tool output, a truncated record, a system message, an error message, one unknown record type, and three real `tool_calls` (`find_by_name`, `view_file`, `replace_file_content`)                    |
| `transcript-busy.jsonl`         | A conversation whose newest record is still `RUNNING` — the only positive busy evidence this store carries                                                                                                                                                                       |
| `transcript-partial-tail.jsonl` | The same shape with a half-written final line, which is what a reader racing the CLI's own append sees                                                                                                                                                                           |
| `transcript-tool-calls.jsonl`   | Issue #280: `run_command`, `list_dir`, `grep_search` and `write_to_file` calls, one tool this app has never mapped (`manage_subagents`), and one call whose subject the CLI's own truncation cut mid-string                                                                       |
| `history.jsonl`                 | The workspace map, including the records that carry no conversation id, no workspace, a duplicate id, and one line that is not JSON at all                                                                                                                                       |
| `held-stream.jsonl`             | The stdout of one **held** session over the official bidirectional `stream-json` protocol (#237, step 5): `init`, a chunked `agent_response`, a `tool` step seen twice, a per-turn `result`, and a second turn on the same conversation                                           |
| `held-stream-edges.jsonl`       | The same stream's awkward shapes: an `init` naming a model, a step type this build has no reading for, an `agent_response` that said nothing, a tool with no nameable subject, an unknown event type, a line that is not JSON, an `ERROR` result, and a half-written final line   |
| `models.txt`                    | `agy models`' own stdout, captured verbatim (#282): a status line with no tab, then one `<id>\t<display name>` line per model                                                                                                                                                    |

`models.txt` needed no sanitizing: model ids and labels are the CLI's own public vendor names, and
no account-specific text appears in this output. It is read by `providers/antigravity/models.ts`'s
`parseAgyModelsOutput`, off a plain `agy models` spawn — a different subject from the
transcript/history store above: one live CLI answer, not a file the observer polls, so
`docs/provider-formats.md` §3 (which documents that store's own on-disk schema) does not carry it.

## The two held-stream files

These are **stdout** too, and neither is a store on disk — captured on 2026-09-07 by running

```text
agy --input-format stream-json --output-format stream-json
```

in a scratch directory and driving two turns through its stdin, one NDJSON
`{"event":"user","message":{"content":"…"}}` per turn. Every event type, field name, `state` value,
`step_type` value and `usage` key is the real one; the conversation ids, the workspace, the tool
subject and the words on both sides are sanitized as above. `docs/provider-formats.md` §3.1.8
records the protocol these were read from.

Two facts about `held-stream.jsonl` are the reason it exists rather than a doc quote, and both were
measured rather than assumed:

- **`text_delta` is a true delta.** Step 1 arrives as three events — two `ACTIVE` chunks and a
  `DONE` carrying only the final `"."` — and concatenating all three is what equals the turn's
  `result.response`. A reader that published the `DONE` chunk alone would show one character.
- **`init` arrives once per PROCESS, not once per turn.** The second turn opens with a `user_input`
  step and no `init`, so nothing in this stream restates the model or marks a turn's start; only
  `result` marks one's end.

One difference from `transcript-tool-calls.jsonl` is worth reading side by side, because the same
CLI reports the same tool call two ways. In the private transcript each `args` value is a JSON
string needing a **second** `JSON.parse` (§3.1.6); on this official stream `tool_info.parameters`
carries plain values. The arg NAMES are the same either way — `CommandLine`, `AbsolutePath`,
`Query` — which is why `antigravityToolSubject` in `antigravity/parse.ts` owns the name mapping for
both readers and each supplies its own decoder.

One shape is deliberately **not** in either file: `subagent_info`. The official protocol names it on
`step_update`, and no live sample was seen across the probe's turns, so nothing here invents one —
see `antigravityHeldSession.ts` on why a crew is left unclaimed rather than parsed from a shape this
app has never observed.
