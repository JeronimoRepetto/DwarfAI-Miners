---
name: skill-name-in-kebab-case
description: >
  What this skill covers, as a noun phrase, in one clause.
  Trigger: the moment an agent should reach for it.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '1.0'
  scope: [root]
  auto_invoke:
    - 'the action the agent is about to take'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# Skill title

One or two sentences: what goes wrong without this, stated concretely. If you cannot name the
failure, the skill is not warranted yet — delete this file.

## The rule

The imperative, first and short. An agent that reads only this heading should already behave
correctly.

## Why

The incident, the enforcement, or the invariant behind the rule. Rules with a scar behind them get
followed; invented best practices get skimmed. Name the issue number if there is one.

## How

The procedure, as steps or a checklist. Only the parts a competent contributor would get wrong
unprompted — everything else belongs in `CONTRIBUTING.md`, and this file should link there rather
than repeat it.

```bash
# the command, if there is one
```

## Getting it wrong

The failure mode that actually happens, and how to recognise it after the fact. This section is
what makes a skill worth re-reading.

## References

Paths below are relative to the skill's destination — `skills/{name}/SKILL.md` — so `../../`
reaches the repo root. They do not resolve from the template's own location; that is expected, and
they become correct the moment this file is copied into place.

- [`path/to/canonical.ts`](../../path/to/canonical.ts) — where the invariant is defined
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — the human-facing half
