# Antigravity CLI fixtures

Captured from **Antigravity CLI 1.1.26** on Windows, 2026-09-07, and **sanitized** before being
committed: the account name is `j`, workspaces are `Sample-Project` and its siblings, conversation
ids are repeated-digit UUIDs, and every prompt and reply is short neutral English of the same
_shape_ as what was captured. Record types, field names, field order, `step_index` numbering (gaps
included) and the timestamp format are the real ones — that is the whole point of a fixture, and it
is the half that must not be invented.

`docs/provider-formats.md` §3 records the format these were read from, and the version caveat: this
is a **private on-disk format** that has changed across CLI versions, so a parser reading it
degrades on an unknown record rather than throwing.

| File                            | What it is                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcript.jsonl`              | One finished conversation: both human turns, both displayable planner replies, tool output, a truncated record, a system message, an error message, and one unknown record type |
| `transcript-busy.jsonl`         | A conversation whose newest record is still `RUNNING` — the only positive busy evidence this store carries                                                                      |
| `transcript-partial-tail.jsonl` | The same shape with a half-written final line, which is what a reader racing the CLI's own append sees                                                                          |
| `history.jsonl`                 | The workspace map, including the records that carry no conversation id, no workspace, a duplicate id, and one line that is not JSON at all                                      |
