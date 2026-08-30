---
name: simulated-valley
description: >
  The development-only simulated provider, for seeing the panel under load without launching real agent sessions.
  Trigger: when asked to verify anything visual at scale, reproduce a layout or performance limit, or check behaviour that needs many concurrent sessions.
license: MIT
metadata:
  author: JeronimoRepetto
  version: '1.0'
  scope: [root]
  auto_invoke:
    - 'verifying visual or performance behaviour at scale'
    - 'reproducing a layout limit that needs many sessions'
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# Reach for the simulator, not for twenty real sessions

A development-only simulated provider exists. **Use it instead of asking the owner to launch real
agent sessions**, which costs quota and is not reproducible.

```bash
DWARFAI_SIMULATE=1 pnpm dev
```

[`docs/simulated-provider.md`](../../docs/simulated-provider.md) is the full document — the knobs,
the world model, and the limits it was built to reach. This page is only the part an agent needs at
the moment it is about to verify something.

## Why it is not a mock

It implements the same `Provider` interface the real providers implement, and is wired in where
they are wired in. So aggregation, the lifecycle grace window, the ledger, the publish gate, IPC
and the whole renderer run exactly the code they run in production. Its own comment makes the point
that this is precisely its value.

That is the transferable idea: when you need to exercise a system under conditions you cannot
easily create, implement the real interface rather than stubbing the boundary.

## It is seeded, so bugs reproduce

Nothing in the world is random. Every choice — a mine's name, a dwarf's shift, which rock it stands
at — is a pure function of a string key that includes the run's seed. Same seed, same valley, on
any machine and at any hour. **When you report something you saw in the simulator, report the
seed**, or the finding cannot be reproduced.

## Two gates, and only one of them protects a user

The switch is gated twice, and the gates are not equivalent — the repo's own document overstates
this in one line and corrects itself in another, so be precise:

- **Gate 1** keeps the switch out of the resolved config object, so the `userData` config file
  cannot carry it. A tripwire test asserts this. It closes the config-file vector only.
- **Gate 2** refuses to build the simulation in a packaged build at all, and warns loudly rather
  than failing silently. **This is the one a user is actually protected by** — a packaged app
  launched with the variable genuinely set in its environment passes gate 1 and is stopped here.

If you touch either gate, keep both, and keep the tests that assert them.

## What it is good for

It was built to reach limits that only appear at scale, and it is how five of them were
**reproduced and measured**: map site overflow, cave anchor sharing, the nugget pile cap, bubble
staggering, and poll cost at scale. Be accurate about the history if you cite it — most of those
were found and fixed before the simulator landed; it confirmed them at scale rather than
discovering them.

## Getting it wrong

- **Suggesting the owner launch real sessions** to see something at scale. That is the request this
  tool exists to make unnecessary.
- **Reporting a visual finding without the seed.** Nobody can reproduce it.
- **Routing the switch through normal configuration.** Its absence from the config object is
  deliberate — see [`config-layering`](../config-layering/SKILL.md).

## References

- [`docs/simulated-provider.md`](../../docs/simulated-provider.md) — the full document
- [`config-layering`](../config-layering/SKILL.md) — why this switch is deliberately not a setting
