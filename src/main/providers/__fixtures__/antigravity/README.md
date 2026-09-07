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

| File                            | What it is                                                                                                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcript.jsonl`              | One finished conversation: both human turns, both displayable planner replies, tool output, a truncated record, a system message, an error message, one unknown record type, and three real `tool_calls` (`find_by_name`, `view_file`, `replace_file_content`) |
| `transcript-busy.jsonl`         | A conversation whose newest record is still `RUNNING` — the only positive busy evidence this store carries                                                                                                                                                     |
| `transcript-partial-tail.jsonl` | The same shape with a half-written final line, which is what a reader racing the CLI's own append sees                                                                                                                                                         |
| `transcript-tool-calls.jsonl`   | Issue #280: `run_command`, `list_dir`, `grep_search` and `write_to_file` calls, one tool this app has never mapped (`manage_subagents`), and one call whose subject the CLI's own truncation cut mid-string                                                    |
| `history.jsonl`                 | The workspace map, including the records that carry no conversation id, no workspace, a duplicate id, and one line that is not JSON at all                                                                                                                     |
| `models.txt`                    | `agy models`' own stdout, captured verbatim (#282): a status line with no tab, then one `<id>\t<display name>` line per model                                                                                                                                  |

`models.txt` needed no sanitizing: model ids and labels are the CLI's own public vendor names, and
no account-specific text appears in this output. It is read by `providers/antigravity/models.ts`'s
`parseAgyModelsOutput`, off a plain `agy models` spawn — a different subject from the
transcript/history store above: one live CLI answer, not a file the observer polls, so
`docs/provider-formats.md` §3 (which documents that store's own on-disk schema) does not carry it.
